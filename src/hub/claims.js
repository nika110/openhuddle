import { cleanRelPath } from '../shared/paths.js';
import { matchAny } from '../shared/glob.js';
import { badRequest } from './errors.js';
import { cleanText, cleanName, parse } from './text.js';
import { listTasks } from './tasks.js';

const EDIT_EVENT_EVERY_MS = 10 * 60_000;
const MAX_PATHS = 100;

function ttlMs(hub, teamId) {
  return hub.team(teamId).settings.claim_ttl_min * 60_000;
}

function cleanPaths(paths) {
  const list = Array.isArray(paths) ? paths : paths ? [paths] : [];
  if (!list.length) throw badRequest('missing_paths', 'Give at least one file path.');
  if (list.length > MAX_PATHS) throw badRequest('too_many_paths', `At most ${MAX_PATHS} paths at once.`);
  return list.map((p) => {
    const clean = cleanRelPath(String(p ?? ''));
    if (!clean) throw badRequest('bad_path', `"${p}" is not a path inside the repo. Use paths relative to the repo root.`);
    return clean;
  });
}

export function activeClaims(hub, teamId) {
  return hub.all(
    'SELECT path, member_id, task_key, expires_at FROM claims WHERE team_id = ? AND expires_at > ? ORDER BY path',
    teamId,
    hub.now(),
  );
}

function conflictFor(hub, member, path) {
  const row = hub.get('SELECT * FROM claims WHERE team_id = ? AND path = ?', member.team_id, path);
  if (!row || row.member_id === member.id || row.expires_at <= hub.now()) return null;
  const owner = hub.get('SELECT name FROM members WHERE id = ?', row.member_id);
  return {
    path,
    member_id: row.member_id,
    member_name: owner?.name ?? 'a teammate',
    task_key: row.task_key || null,
    expires_at: row.expires_at,
  };
}

function upsert(hub, member, path, taskKey, ttl) {
  hub.run(
    `INSERT INTO claims (team_id, path, member_id, task_key, expires_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (team_id, path) DO UPDATE SET
       task_key = CASE WHEN claims.member_id = excluded.member_id THEN COALESCE(excluded.task_key, claims.task_key) ELSE excluded.task_key END,
       member_id = excluded.member_id,
       expires_at = excluded.expires_at`,
    member.team_id,
    path,
    member.id,
    taskKey ?? null,
    hub.now() + ttl,
  );
}

// The task an edit most likely belongs to: an in-progress task of mine whose area covers the file,
// or my only in-progress task.
function currentTaskFor(hub, member, path) {
  const mine = listTasks(hub, member.team_id).filter((t) => t.assignee_id === member.id && t.status === 'in_progress');
  const byArea = mine.find((t) => matchAny(t.area, path));
  if (byArea) return byArea.key;
  return mine.length === 1 ? mine[0].key : null;
}

export function claims(hub, member, { action = 'claim', paths, task_key }) {
  const teamId = member.team_id;
  if (action === 'release') {
    const list = Array.isArray(paths) ? paths : [];
    if (list.includes('*')) {
      const res = hub.run('DELETE FROM claims WHERE team_id = ? AND member_id = ?', teamId, member.id);
      return { released: Number(res.changes) };
    }
    let released = 0;
    for (const p of cleanPaths(list)) {
      released += Number(hub.run('DELETE FROM claims WHERE team_id = ? AND path = ? AND member_id = ?', teamId, p, member.id).changes);
    }
    return { released };
  }
  const list = cleanPaths(paths);
  if (action === 'claim') {
    const ttl = ttlMs(hub, teamId);
    const key = task_key ? String(task_key).trim().toUpperCase().slice(0, 16) : null;
    const claimed = [];
    const conflicts = [];
    for (const p of list) {
      const c = conflictFor(hub, member, p);
      if (c) conflicts.push(c);
      else {
        upsert(hub, member, p, key, ttl);
        claimed.push(p);
      }
    }
    return { claimed, conflicts };
  }
  if (action === 'check') {
    const conflicts = list.map((p) => conflictFor(hub, member, p)).filter(Boolean);
    const others = listTasks(hub, teamId).filter(
      (t) => t.assignee_id && t.assignee_id !== member.id && (t.status === 'assigned' || t.status === 'in_progress'),
    );
    const overlaps = [];
    for (const p of list) {
      for (const t of others) if (matchAny(t.area, p)) overlaps.push({ path: p, task_key: t.key, member_id: t.assignee_id });
    }
    return { conflicts, overlaps };
  }
  throw badRequest('bad_action', 'action must be claim, release or check.');
}

export function fileEdit(hub, member, { path, since }) {
  const [p] = cleanPaths([path]);
  const conflict = conflictFor(hub, member, p);
  let taskKey = null;
  if (!conflict) {
    taskKey = currentTaskFor(hub, member, p);
    upsert(hub, member, p, taskKey, ttlMs(hub, member.team_id));
  }
  const seenKey = `${member.team_id}|${member.id}|${p}`;
  const last = hub.editSeen.get(seenKey);
  if (!last || hub.now() - last >= EDIT_EVENT_EVERY_MS) {
    if (hub.editSeen.size > 10_000) hub.editSeen.clear();
    hub.editSeen.set(seenKey, hub.now());
    hub.emit(member.team_id, member.id, 'file_edit', { path: p, task_key: taskKey });
  }
  if (since == null) return { conflict, events: [], last_event_id: hub.lastEventId(member.team_id) };
  const { events, last_event_id } = hub.events(member, { since, urgent: true });
  return { conflict, events, last_event_id };
}

export function commit(hub, member, { sha, branch, message, files }) {
  const id = cleanName(sha, 40);
  if (!/^[0-9a-f]{4,40}$/i.test(id)) throw badRequest('missing_sha', 'sha must be a git commit hash.');
  const msg = cleanText(String(message ?? '').split('\n')[0], 200);
  const br = cleanName(branch, 100) || null;
  const status = { ...parse(member.status, {}), branch: br, last_commit: { sha: id.slice(0, 12), message: msg } };
  hub.run('UPDATE members SET status = ? WHERE id = ?', JSON.stringify(status), member.id);
  hub.emit(member.team_id, member.id, 'commit', {
    sha: id.slice(0, 12),
    branch: br,
    message: msg,
    files_count: Array.isArray(files) ? files.length : 0,
  });
  return { ok: true };
}

export function extendClaims(hub, member) {
  const now = hub.now();
  hub.run(
    'UPDATE claims SET expires_at = ? WHERE team_id = ? AND member_id = ? AND expires_at > ?',
    now + ttlMs(hub, member.team_id),
    member.team_id,
    member.id,
    now,
  );
}

export function releaseAll(hub, member) {
  hub.run('DELETE FROM claims WHERE team_id = ? AND member_id = ?', member.team_id, member.id);
}

export function releaseTask(hub, teamId, memberId, key) {
  hub.run('DELETE FROM claims WHERE team_id = ? AND member_id = ? AND task_key = ?', teamId, memberId, key);
}
