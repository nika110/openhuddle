import { LIMITS } from '../shared/protocol.js';
import { badRequest, forbidden, notFound } from './errors.js';
import { cleanText, parse } from './text.js';
import { listTasks } from './tasks.js';

const PENDING_FOR_MS = 24 * 3600_000;

export function snapshot(hub, target) {
  const tasks = listTasks(hub, target.team_id).filter(
    (t) => t.status !== 'done' && (t.assignee_id === target.id || t.proposed_id === target.id),
  );
  const claims = hub
    .all(
      'SELECT path FROM claims WHERE team_id = ? AND member_id = ? AND expires_at > ? ORDER BY path LIMIT 30',
      target.team_id,
      target.id,
      hub.now(),
    )
    .map((r) => r.path);
  const recent = hub
    .all(
      'SELECT id, member_id, kind, data, created_at FROM events WHERE team_id = ? AND member_id = ? ORDER BY id DESC LIMIT 5',
      target.team_id,
      target.id,
    )
    .map((r) => ({ ...r, data: parse(r.data, {}) }));
  return {
    name: target.name,
    online: hub.isOnline(target),
    last_seen: target.last_seen ?? null,
    status: parse(target.status, {}),
    tasks,
    claims,
    recent,
  };
}

export function ask(hub, member, { to, question }) {
  const q = cleanText(question, LIMITS.text);
  if (!q) throw badRequest('missing_question', 'What do you want to ask?');
  const target = hub.findMember(member.team_id, to);
  if (target.id === member.id) throw badRequest('self_ask', 'That is you. Ask a teammate.');
  const { next_ask } = hub.get('SELECT next_ask FROM teams WHERE id = ?', member.team_id);
  const id = `Q${next_ask}`;
  hub.run('UPDATE teams SET next_ask = next_ask + 1 WHERE id = ?', member.team_id);
  hub.run(
    'INSERT INTO asks (team_id, id, from_id, to_id, question, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    member.team_id,
    id,
    member.id,
    target.id,
    q,
    hub.now(),
  );
  hub.emit(member.team_id, member.id, 'ask', { ask_id: id, to_id: target.id, question: q });
  return {
    ask_id: id,
    to: { id: target.id, name: target.name, online: hub.isOnline(target) },
    snapshot: snapshot(hub, target),
  };
}

export function waitAnswer(hub, teamId, askId, ms) {
  const row = hub.get('SELECT answer FROM asks WHERE team_id = ? AND id = ?', teamId, askId);
  if (!row) return Promise.resolve(null);
  if (row.answer != null) return Promise.resolve(row.answer);
  return new Promise((resolve) => {
    const key = `${teamId}|${askId}`;
    let set = hub.waiters.get(key);
    if (!set) hub.waiters.set(key, (set = new Set()));
    const finish = (answer) => {
      clearTimeout(timer);
      set.delete(finish);
      if (!set.size) hub.waiters.delete(key);
      resolve(answer);
    };
    const timer = setTimeout(() => finish(null), ms);
    set.add(finish);
  });
}

export function reply(hub, member, { ask_id, answer }) {
  const id = String(ask_id ?? '').trim().toUpperCase();
  const row = hub.get('SELECT * FROM asks WHERE team_id = ? AND id = ?', member.team_id, id);
  if (!row) throw notFound('unknown_ask', `There is no question ${id || '(missing ask_id)'}.`);
  if (row.to_id !== member.id) throw forbidden('not_your_question', `${id} was asked to someone else.`);
  const a = cleanText(answer, LIMITS.text);
  if (!a) throw badRequest('missing_answer', 'The answer is empty.');
  hub.run('UPDATE asks SET answer = ?, answered_at = ? WHERE team_id = ? AND id = ?', a, hub.now(), member.team_id, id);
  hub.emit(member.team_id, member.id, 'reply', { ask_id: id, to_id: row.from_id, answer: a });
  const waiting = hub.waiters.get(`${member.team_id}|${id}`);
  if (waiting) for (const finish of [...waiting]) finish(a);
  return { ok: true };
}

export function asksFor(hub, member) {
  return hub
    .all(
      `SELECT a.id, a.from_id, m.name AS from_name, a.question, a.created_at
       FROM asks a LEFT JOIN members m ON m.id = a.from_id
       WHERE a.team_id = ? AND a.to_id = ? AND a.answer IS NULL AND a.created_at > ?
       ORDER BY a.created_at DESC LIMIT 20`,
      member.team_id,
      member.id,
      hub.now() - PENDING_FOR_MS,
    );
}
