import { LIMITS } from '../shared/protocol.js';
import { badRequest, conflict, notFound } from './errors.js';
import { cleanText, parse } from './text.js';
import { releaseTask } from './claims.js';

const KEY_RE = /^[A-Z][A-Z0-9_-]{0,15}$/;

function toTask(row, statusByKey) {
  const depends_on = parse(row.depends_on, []);
  return {
    key: row.key,
    title: row.title,
    description: row.description || '',
    area: parse(row.area, []),
    depends_on,
    acceptance: row.acceptance || '',
    status: row.status,
    assignee_id: row.assignee_id || null,
    proposed_id: row.proposed_id || null,
    branch: row.branch || null,
    note: row.note || null,
    ready: depends_on.every((k) => !statusByKey.has(k) || statusByKey.get(k) === 'done'),
    updated_at: row.updated_at,
  };
}

export function listTasks(hub, teamId) {
  const rows = hub.all('SELECT * FROM tasks WHERE team_id = ? ORDER BY seq', teamId);
  const status = new Map(rows.map((r) => [r.key, r.status]));
  return rows.map((r) => toTask(r, status));
}

// One task by key, with `ready` computed from just its own dependencies.
export function findTask(hub, teamId, key) {
  const k = String(key ?? '').trim().toUpperCase();
  if (!k) throw badRequest('missing_key', 'Say which task (its key, like T3).');
  const row = hub.get('SELECT * FROM tasks WHERE team_id = ? AND key = ?', teamId, k.slice(0, 16));
  if (!row) throw notFound('unknown_task', `There is no task ${k.slice(0, 16)}.`);
  const deps = parse(row.depends_on, []);
  const status = new Map();
  for (const d of deps) {
    const dep = hub.get('SELECT status FROM tasks WHERE team_id = ? AND key = ?', teamId, d);
    if (dep) status.set(d, dep.status);
  }
  return toTask(row, status);
}

// Tasks matching a SQL condition on status/assignee, without loading the whole board.
export function tasksWhere(hub, teamId, where, ...params) {
  return hub.all(`SELECT * FROM tasks WHERE team_id = ? AND ${where} ORDER BY seq`, teamId, ...params).map((r) => toTask(r, new Map()));
}

function cleanArea(area) {
  if (!Array.isArray(area)) return [];
  return area
    .map((g) => String(g ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter((g) => g && g.length <= 200 && !g.startsWith('/') && !/^[a-zA-Z]:/.test(g) && !g.split('/').includes('..'))
    .slice(0, 20);
}

function findCycle(graph) {
  const state = new Map();
  const visit = (k, trail) => {
    if (state.get(k) === 2) return null;
    if (state.get(k) === 1) return [...trail, k];
    state.set(k, 1);
    for (const d of graph.get(k) || []) {
      if (!graph.has(d)) continue;
      const c = visit(d, [...trail, k]);
      if (c) return c;
    }
    state.set(k, 2);
    return null;
  };
  for (const k of graph.keys()) {
    const c = visit(k, []);
    if (c) return c;
  }
  return null;
}

function update(hub, teamId, key, fields) {
  const cols = Object.keys(fields);
  const sets = cols.map((c) => `${c} = ?`).join(', ');
  hub.run(
    `UPDATE tasks SET ${sets}, updated_at = ? WHERE team_id = ? AND key = ?`,
    ...cols.map((c) => fields[c] ?? null),
    hub.now(),
    teamId,
    key,
  );
}

export function plan(hub, member, { tasks: inputs, replace = false }) {
  if (!Array.isArray(inputs) || !inputs.length) throw badRequest('missing_tasks', 'Give at least one task.');
  if (inputs.length > LIMITS.tasks_per_plan) throw badRequest('too_many_tasks', `At most ${LIMITS.tasks_per_plan} tasks per plan.`);
  const teamId = member.team_id;
  const team = hub.team(teamId);
  const mode = team.settings.assign_mode;

  if (replace) {
    const gone = hub
      .all(`SELECT key FROM tasks WHERE team_id = ? AND status IN ('proposed', 'open')`, teamId)
      .map((r) => r.key);
    if (gone.length) {
      hub.run(`DELETE FROM tasks WHERE team_id = ? AND status IN ('proposed', 'open')`, teamId);
      for (const t of listTasks(hub, teamId)) {
        const deps = t.depends_on.filter((k) => !gone.includes(k));
        if (deps.length !== t.depends_on.length) update(hub, teamId, t.key, { depends_on: JSON.stringify(deps) });
      }
    }
  }

  const existing = new Map(listTasks(hub, teamId).map((t) => [t.key, t]));
  if (existing.size + inputs.length > LIMITS.tasks_per_team) {
    throw conflict('too_many_tasks', `A crew can have at most ${LIMITS.tasks_per_team} tasks on its board.`);
  }
  const used = new Set(existing.keys());
  let n = team.next_task;
  const local = new Map();
  const finals = inputs.map((input, i) => {
    const wanted = String(input?.key ?? '').trim().toUpperCase();
    let key;
    if (wanted && KEY_RE.test(wanted) && !used.has(wanted)) {
      key = wanted;
    } else {
      while (used.has(`T${n}`)) n++;
      key = `T${n}`;
    }
    used.add(key);
    const m = /^T(\d+)$/.exec(key);
    if (m) n = Math.max(n, Number(m[1]) + 1);
    if (wanted) local.set(wanted, key);
    local.set(`#${i + 1}`, key);
    return key;
  });

  const rows = inputs.map((input, i) => {
    const title = cleanText(input?.title, 200);
    if (!title) throw badRequest('missing_title', `Task #${i + 1} needs a title.`);
    const deps = (Array.isArray(input.depends_on) ? input.depends_on : []).map((d) => {
      const ref = String(d ?? '').trim().toUpperCase();
      const key = local.get(ref) ?? (existing.has(ref) ? ref : null);
      if (!key) throw badRequest('unknown_dependency', `Task "${title}" depends on "${d}", which is not a task in this plan or on the board.`);
      return key;
    });
    const assignee = input.assignee ? hub.findMember(teamId, input.assignee) : null;
    let status = 'open';
    let assignee_id = null;
    let proposed_id = null;
    if (assignee && mode === 'agent') {
      status = 'assigned';
      assignee_id = assignee.id;
    } else if (assignee && mode === 'hybrid') {
      status = 'proposed';
      proposed_id = assignee.id;
    }
    return {
      key: finals[i],
      title,
      description: cleanText(input.description, 4000),
      area: cleanArea(input.area),
      depends_on: [...new Set(deps)],
      acceptance: cleanText(input.acceptance, 1000),
      status,
      assignee_id,
      proposed_id,
    };
  });

  const graph = new Map([...existing.values()].map((t) => [t.key, t.depends_on]));
  for (const r of rows) graph.set(r.key, r.depends_on);
  const cycle = findCycle(graph);
  if (cycle) throw badRequest('dependency_cycle', `These tasks wait on each other in a circle: ${cycle.join(' -> ')}.`);

  const at = hub.now();
  let seq = (hub.get('SELECT MAX(seq) AS s FROM tasks WHERE team_id = ?', teamId)?.s ?? 0) + 1;
  for (const r of rows) {
    hub.run(
      `INSERT INTO tasks (team_id, key, seq, title, description, area, depends_on, acceptance, status, assignee_id, proposed_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      teamId,
      r.key,
      seq++,
      r.title,
      r.description,
      JSON.stringify(r.area),
      JSON.stringify(r.depends_on),
      r.acceptance,
      r.status,
      r.assignee_id,
      r.proposed_id,
      member.id,
      at,
      at,
    );
  }
  hub.run('UPDATE teams SET next_task = ? WHERE id = ?', n, teamId);

  hub.emit(teamId, member.id, 'plan_created', { keys: rows.map((r) => r.key), lead_id: member.id });
  for (const r of rows) {
    if (r.assignee_id) hub.emit(teamId, member.id, 'task_assigned', { key: r.key, title: r.title, assignee_id: r.assignee_id });
    if (r.proposed_id) hub.emit(teamId, member.id, 'task_proposed', { key: r.key, title: r.title, proposed_id: r.proposed_id });
  }
  if (team.settings.lead_id !== member.id) {
    hub.saveSettings(teamId, { ...team.settings, lead_id: member.id });
    hub.emit(teamId, member.id, 'lead_changed', { lead_id: member.id });
  }
  const keys = new Set(rows.map((r) => r.key));
  return { tasks: listTasks(hub, teamId).filter((t) => keys.has(t.key)) };
}

function mustBeAssignee(task, member) {
  if (task.assignee_id !== member.id) {
    throw conflict('not_your_task', `${task.key} is not assigned to you.`);
  }
}

export function taskAction(hub, member, { action, key, note, branch, assignee }) {
  const teamId = member.team_id;
  const task = findTask(hub, teamId, key);
  const clean = { note: cleanText(note, 2000) || null, branch: branch ? String(branch).trim().slice(0, 100) : null };
  const done = () => ({ task: findTask(hub, teamId, task.key) });
  const busyElsewhere = () =>
    task.assignee_id && task.assignee_id !== member.id && (task.status === 'assigned' || task.status === 'in_progress');
  const nameOf = (id) => hub.get('SELECT name FROM members WHERE id = ?', id)?.name ?? 'someone';

  switch (action) {
    case 'take': {
      if (task.status === 'done') throw conflict('task_done', `${task.key} is already done.`);
      if (busyElsewhere()) throw conflict('already_assigned', `${task.key} belongs to ${nameOf(task.assignee_id)}. Ask them, or use assign.`);
      update(hub, teamId, task.key, {
        assignee_id: member.id,
        proposed_id: null,
        status: task.status === 'in_progress' ? 'in_progress' : 'assigned',
      });
      hub.emit(teamId, member.id, 'task_assigned', { key: task.key, title: task.title, assignee_id: member.id });
      return done();
    }
    case 'accept': {
      if (task.status !== 'proposed' || task.proposed_id !== member.id) throw conflict('not_proposed_to_you', `${task.key} is not proposed to you.`);
      update(hub, teamId, task.key, { assignee_id: member.id, proposed_id: null, status: 'assigned' });
      hub.emit(teamId, member.id, 'task_assigned', { key: task.key, title: task.title, assignee_id: member.id });
      return done();
    }
    case 'decline': {
      if (task.status !== 'proposed' || task.proposed_id !== member.id) throw conflict('not_proposed_to_you', `${task.key} is not proposed to you.`);
      update(hub, teamId, task.key, { proposed_id: null, status: 'open', note: clean.note ?? task.note });
      hub.emit(teamId, member.id, 'task_released', { key: task.key, note: clean.note });
      return done();
    }
    case 'start': {
      if (task.status === 'done') throw conflict('task_done', `${task.key} is already done.`);
      if (busyElsewhere()) throw conflict('already_assigned', `${task.key} belongs to ${nameOf(task.assignee_id)}.`);
      if (!task.ready) {
        const tasks = listTasks(hub, teamId);
        const waiting = task.depends_on.filter((k) => tasks.find((t) => t.key === k)?.status !== 'done');
        throw conflict('blocked', `${task.key} waits for ${waiting.join(', ')} to be done first.`);
      }
      update(hub, teamId, task.key, {
        assignee_id: member.id,
        proposed_id: null,
        status: 'in_progress',
        branch: clean.branch ?? task.branch,
      });
      hub.emit(teamId, member.id, 'task_started', { key: task.key, branch: clean.branch ?? task.branch });
      return done();
    }
    case 'update': {
      mustBeAssignee(task, member);
      if (!clean.note && !clean.branch) throw badRequest('missing_note', 'Give a note (what changed).');
      update(hub, teamId, task.key, { note: clean.note ?? task.note, branch: clean.branch ?? task.branch });
      hub.emit(teamId, member.id, 'task_updated', { key: task.key, note: clean.note });
      return done();
    }
    case 'done': {
      mustBeAssignee(task, member);
      if (task.status === 'done') throw conflict('task_done', `${task.key} is already done.`);
      update(hub, teamId, task.key, {
        status: 'done',
        note: clean.note ?? task.note,
        branch: clean.branch ?? task.branch,
      });
      releaseTask(hub, teamId, member.id, task.key);
      hub.emit(teamId, member.id, 'task_done', { key: task.key, note: clean.note, branch: clean.branch ?? task.branch });
      for (const t of listTasks(hub, teamId)) {
        if (t.status === 'done' || !t.depends_on.includes(task.key) || !t.ready) continue;
        hub.emit(teamId, member.id, 'task_unblocked', { key: t.key, assignee_id: t.assignee_id || t.proposed_id || null });
      }
      return done();
    }
    case 'release': {
      mustBeAssignee(task, member);
      if (task.status === 'done') throw conflict('task_done', `${task.key} is already done.`);
      update(hub, teamId, task.key, { assignee_id: null, status: 'open', note: clean.note ?? task.note });
      releaseTask(hub, teamId, member.id, task.key);
      hub.emit(teamId, member.id, 'task_released', { key: task.key, note: clean.note });
      return done();
    }
    case 'assign': {
      if (task.status === 'done') throw conflict('task_done', `${task.key} is already done.`);
      const target = hub.findMember(teamId, assignee);
      update(hub, teamId, task.key, {
        assignee_id: target.id,
        proposed_id: null,
        status: task.status === 'in_progress' && task.assignee_id === target.id ? 'in_progress' : 'assigned',
      });
      hub.emit(teamId, member.id, 'task_assigned', { key: task.key, title: task.title, assignee_id: target.id });
      return done();
    }
    default:
      throw badRequest('bad_action', 'action must be one of take, accept, decline, start, update, done, release, assign.');
  }
}

// When someone leaves, their unfinished work goes back on the board.
export function unassignAll(hub, member) {
  const teamId = member.team_id;
  for (const t of listTasks(hub, teamId)) {
    if (t.status === 'done') continue;
    if (t.assignee_id === member.id) update(hub, teamId, t.key, { assignee_id: null, status: 'open' });
    else if (t.proposed_id === member.id) update(hub, teamId, t.key, { proposed_id: null, status: 'open' });
  }
}
