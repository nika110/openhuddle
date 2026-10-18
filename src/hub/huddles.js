// Huddles: the team thinks together, the way developers do in a room. A brainstorm, a design
// discussion, a review or a standup, open to everyone (or a few people). Agents add ideas and
// comments, back or push back on each other's ideas with a reason, and the starter (or the
// owner or lead) closes it with the decision.
import { LIMITS, HUDDLE_KINDS } from '../shared/protocol.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { cleanText, cleanName, parse } from './text.js';

const RECENT_CLOSED_MS = 7 * 24 * 3600_000;
const KEEP_CLOSED_MS = 30 * 24 * 3600_000;
const EVENT_TEXT = 500;
const TOP_IDEAS = 10;

function huddleKey(value) {
  const k = String(value ?? '').trim().toUpperCase();
  if (!k) throw badRequest('missing_huddle', 'Say which huddle (its id, like H2).');
  return k.slice(0, 16);
}

export function findHuddle(hub, teamId, id) {
  const key = huddleKey(id);
  const row = hub.get('SELECT * FROM huddles WHERE team_id = ? AND id = ?', teamId, key);
  if (!row) throw notFound('unknown_huddle', `There is no huddle ${key}.`);
  return row;
}

function openOnly(row) {
  if (row.status !== 'open') throw conflict('huddle_closed', `${row.id} is closed${row.decision ? ' with a decision' : ''}. Start a new huddle to reopen the topic.`);
}

// Who is expected to weigh in: the people it was started with, or the whole team.
function participants(hub, row, active) {
  const people = parse(row.people, []);
  const ids = active.map((m) => m.id);
  return people.length ? ids.filter((id) => people.includes(id) || id === row.started_by) : ids;
}

function contributors(hub, row) {
  const ids = hub.all(
    `SELECT member_id FROM huddle_posts WHERE team_id = ? AND huddle_id = ?
     UNION SELECT member_id FROM huddle_votes WHERE team_id = ? AND huddle_id = ?`,
    row.team_id,
    row.id,
    row.team_id,
    row.id,
  );
  return new Set(ids.map((r) => r.member_id));
}

// Everyone expected who has not said anything yet. Starting a huddle counts as speaking,
// except in a standup, where the starter gives their own update too.
function waitingOn(hub, row, active) {
  if (row.status !== 'open') return [];
  const spoke = contributors(hub, row);
  return participants(hub, row, active).filter((id) => !spoke.has(id) && (row.kind === 'standup' || id !== row.started_by));
}

// The most backed ideas, counted by SQLite so a busy huddle stays cheap to summarize.
function topIdeas(hub, row) {
  return hub.all(
    `SELECT p.seq, p.member_id, substr(p.text, 1, 300) AS text,
            COALESCE(SUM(v.value > 0), 0) AS up, COALESCE(SUM(v.value < 0), 0) AS down
     FROM huddle_posts p
     LEFT JOIN huddle_votes v ON v.team_id = p.team_id AND v.huddle_id = p.huddle_id AND v.seq = p.seq
     WHERE p.team_id = ? AND p.huddle_id = ? AND p.kind = 'idea'
     GROUP BY p.seq
     ORDER BY COALESCE(SUM(v.value), 0) DESC, p.seq
     LIMIT ?`,
    row.team_id,
    row.id,
    TOP_IDEAS,
  );
}

function summary(hub, row, active) {
  const counts = hub.get(
    "SELECT COUNT(*) AS posts, COALESCE(SUM(kind = 'idea'), 0) AS ideas FROM huddle_posts WHERE team_id = ? AND huddle_id = ?",
    row.team_id,
    row.id,
  );
  return {
    id: row.id,
    kind: row.kind,
    topic: row.topic,
    context: row.context || '',
    started_by: row.started_by,
    people: parse(row.people, []),
    status: row.status,
    post_count: counts.posts,
    ideas: topIdeas(hub, row),
    idea_count: counts.ideas,
    waiting_on: waitingOn(hub, row, active),
    decision: row.decision || null,
    why: row.why || null,
    closed_by: row.closed_by || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    closed_at: row.closed_at ?? null,
  };
}

// Open huddles first (newest activity first), then a few recently closed ones.
export function listHuddles(hub, teamId) {
  const active = hub.activeMembers(teamId);
  const open = hub.all("SELECT * FROM huddles WHERE team_id = ? AND status = 'open' ORDER BY updated_at DESC", teamId);
  const closed = hub.all(
    "SELECT * FROM huddles WHERE team_id = ? AND status = 'closed' AND closed_at > ? ORDER BY closed_at DESC LIMIT 5",
    teamId,
    hub.now() - RECENT_CLOSED_MS,
  );
  return [...open, ...closed].map((row) => summary(hub, row, active));
}

export function huddlesFor(member, list) {
  return list.filter((h) => h.status === 'open' && h.waiting_on.includes(member.id)).map((h) => ({ id: h.id, kind: h.kind, topic: h.topic, started_by: h.started_by }));
}

function touch(hub, row) {
  hub.run('UPDATE huddles SET updated_at = ? WHERE team_id = ? AND id = ?', hub.now(), row.team_id, row.id);
}

function nextSeq(hub, row) {
  const { next_post } = hub.get('SELECT next_post FROM huddles WHERE team_id = ? AND id = ?', row.team_id, row.id);
  if (next_post > LIMITS.huddle_posts) throw conflict('huddle_full', `${row.id} has ${LIMITS.huddle_posts} posts. Close it and start a new one.`);
  makeRoom(hub, row.team_id);
  hub.run('UPDATE huddles SET next_post = next_post + 1 WHERE team_id = ? AND id = ?', row.team_id, row.id);
  return next_post;
}

function dropHuddle(hub, teamId, id) {
  for (const table of ['huddle_votes', 'huddle_posts']) hub.run(`DELETE FROM ${table} WHERE team_id = ? AND huddle_id = ?`, teamId, id);
  hub.run('DELETE FROM huddles WHERE team_id = ? AND id = ?', teamId, id);
}

// A team's huddles hold at most LIMITS.huddle_posts_per_team posts. When full, the oldest closed
// huddles make way; with nothing closed to drop, the post is refused.
function makeRoom(hub, teamId) {
  for (;;) {
    const { n } = hub.get('SELECT COUNT(*) AS n FROM huddle_posts WHERE team_id = ?', teamId);
    if (n < LIMITS.huddle_posts_per_team) return;
    const oldest = hub.get("SELECT id FROM huddles WHERE team_id = ? AND status = 'closed' ORDER BY closed_at, created_at LIMIT 1", teamId);
    if (!oldest) throw conflict('huddles_full', 'The team’s open huddles are full of posts. Close some huddles first.');
    dropHuddle(hub, teamId, oldest.id);
  }
}

// Keeps the newest closed huddles; older ones go, with their posts and votes.
function trimClosed(hub, teamId) {
  const old = hub.all(
    "SELECT id FROM huddles WHERE team_id = ? AND status = 'closed' ORDER BY closed_at DESC, created_at DESC LIMIT -1 OFFSET ?",
    teamId,
    LIMITS.huddles_closed_kept,
  );
  for (const { id } of old) dropHuddle(hub, teamId, id);
}

function addPost(hub, member, row, kind, text, onSeq = null) {
  const seq = nextSeq(hub, row);
  hub.run(
    'INSERT INTO huddle_posts (team_id, huddle_id, seq, member_id, kind, text, on_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    row.team_id,
    row.id,
    seq,
    member.id,
    kind,
    text,
    onSeq,
    hub.now(),
  );
  touch(hub, row);
  return seq;
}

const others = (ids, member) => [...new Set(ids)].filter((id) => id && id !== member.id);

export function start(hub, member, { kind = 'brainstorm', topic, context, people, proposal }) {
  const k = String(kind ?? '').trim().toLowerCase();
  if (!HUDDLE_KINDS.includes(k)) throw badRequest('bad_kind', `kind must be one of ${HUDDLE_KINDS.join(', ')}.`);
  const t = cleanName(cleanText(topic, 400), 200) || (k === 'standup' ? 'Standup' : '');
  if (!t) throw badRequest('missing_topic', 'What is the huddle about? Give a topic.');
  const firstIdea = cleanText(proposal, LIMITS.huddle_text);
  if (k === 'design' && !firstIdea) throw badRequest('missing_proposal', 'A design huddle starts from a proposal: describe the approach you suggest.');
  const { n } = hub.get("SELECT COUNT(*) AS n FROM huddles WHERE team_id = ? AND status = 'open'", member.team_id);
  if (n >= LIMITS.huddles_open) throw conflict('too_many_huddles', `The team has ${LIMITS.huddles_open} open huddles. Close some first.`);
  const names = Array.isArray(people) ? people : people ? [people] : [];
  const ids = [...new Set(names.slice(0, LIMITS.members).map((p) => hub.findMember(member.team_id, p).id))].filter((id) => id !== member.id);
  if (names.length && !ids.length) throw badRequest('no_people', 'Name teammates other than yourself, or leave people out to huddle with the whole team.');
  const { next_huddle } = hub.get('SELECT next_huddle FROM teams WHERE id = ?', member.team_id);
  hub.run('UPDATE teams SET next_huddle = next_huddle + 1 WHERE id = ?', member.team_id);
  const at = hub.now();
  const row = {
    team_id: member.team_id,
    id: `H${next_huddle}`,
    kind: k,
    topic: t,
    context: cleanText(context, LIMITS.huddle_text) || null,
    started_by: member.id,
    people: JSON.stringify(ids),
    status: 'open',
  };
  hub.run(
    'INSERT INTO huddles (team_id, id, kind, topic, context, started_by, people, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    row.team_id,
    row.id,
    row.kind,
    row.topic,
    row.context,
    row.started_by,
    row.people,
    row.status,
    at,
    at,
  );
  if (firstIdea) addPost(hub, member, row, 'idea', firstIdea);
  const notify = others(participants(hub, row, hub.activeMembers(member.team_id)), member);
  hub.emit(member.team_id, member.id, 'huddle_started', { huddle_id: row.id, kind: k, topic: t, people: ids, notify });
  return { huddle: detail(hub, member, { id: row.id }) };
}

export function post(hub, member, { id, kind = 'comment', text, on }) {
  const row = findHuddle(hub, member.team_id, id);
  openOnly(row);
  const k = String(kind ?? '').trim().toLowerCase();
  if (k !== 'idea' && k !== 'comment') throw badRequest('bad_kind', 'kind must be "idea" or "comment".');
  const body = cleanText(text, LIMITS.huddle_text);
  if (!body) throw badRequest('missing_text', 'The post is empty.');
  let onSeq = null;
  let ideaAuthor = null;
  if (on != null && on !== '') {
    if (k !== 'comment') throw badRequest('bad_on', 'Only comments can point at an idea.');
    onSeq = Number(String(on).replace(/^#/, ''));
    const target = Number.isInteger(onSeq)
      ? hub.get("SELECT member_id FROM huddle_posts WHERE team_id = ? AND huddle_id = ? AND seq = ? AND kind = 'idea'", row.team_id, row.id, onSeq)
      : null;
    if (!target) throw notFound('unknown_idea', `${row.id} has no idea #${String(on).replace(/^#/, '').slice(0, 10)}.`);
    ideaAuthor = target.member_id;
  }
  const seq = addPost(hub, member, row, k, body, onSeq);
  const notify = others([row.started_by, ideaAuthor], member);
  hub.emit(member.team_id, member.id, 'huddle_post', {
    huddle_id: row.id,
    topic: row.topic,
    seq,
    post_kind: k,
    on: onSeq,
    text: body.slice(0, EVENT_TEXT),
    notify,
  });
  return { huddle_id: row.id, seq };
}

export function vote(hub, member, { id, idea, vote: choice, note }) {
  const row = findHuddle(hub, member.team_id, id);
  openOnly(row);
  const seq = Number(String(idea ?? '').replace(/^#/, ''));
  const target = Number.isInteger(seq)
    ? hub.get("SELECT member_id FROM huddle_posts WHERE team_id = ? AND huddle_id = ? AND seq = ? AND kind = 'idea'", row.team_id, row.id, seq)
    : null;
  if (!target) throw notFound('unknown_idea', `${row.id} has no idea #${String(idea ?? '').slice(0, 10) || '?'}.`);
  if (target.member_id === member.id) throw badRequest('own_idea', 'That is your own idea. Back or push back on teammates’ ideas.');
  const c = String(choice ?? '').trim().toLowerCase();
  if (c !== 'up' && c !== 'down') throw badRequest('bad_vote', 'vote must be "up" (back it) or "down" (push back).');
  const value = c === 'up' ? 1 : -1;
  const n = cleanText(note, 500) || null;
  hub.run(
    `INSERT INTO huddle_votes (team_id, huddle_id, seq, member_id, value, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (team_id, huddle_id, seq, member_id) DO UPDATE SET value = excluded.value, note = excluded.note, created_at = excluded.created_at`,
    row.team_id,
    row.id,
    seq,
    member.id,
    value,
    n,
    hub.now(),
  );
  touch(hub, row);
  hub.emit(member.team_id, member.id, 'huddle_vote', { huddle_id: row.id, seq, value, note: n ? n.slice(0, EVENT_TEXT) : null, idea_by: target.member_id });
  return { huddle_id: row.id, seq, value };
}

export function close(hub, member, { id, decision, why }) {
  const row = findHuddle(hub, member.team_id, id);
  openOnly(row);
  // Not the lead: anyone can make themselves lead, so that would let anyone close anything.
  if (member.id !== row.started_by && member.role !== 'owner') {
    throw forbidden('not_your_huddle', `${row.id} is closed by whoever started it or by the team owner.`);
  }
  const d = cleanText(decision, LIMITS.huddle_text) || null;
  const w = cleanText(why, LIMITS.huddle_text) || null;
  if (!d && row.kind !== 'standup') throw badRequest('missing_decision', 'Close it with the decision (what the team settled on), even if it is "no change".');
  const at = hub.now();
  hub.run(
    "UPDATE huddles SET status = 'closed', decision = ?, why = ?, closed_by = ?, closed_at = ?, updated_at = ? WHERE team_id = ? AND id = ?",
    d,
    w,
    member.id,
    at,
    at,
    row.team_id,
    row.id,
  );
  const active = hub.activeMembers(member.team_id);
  const notify = others([...participants(hub, row, active), ...contributors(hub, row)], member);
  hub.emit(member.team_id, member.id, 'huddle_closed', {
    huddle_id: row.id,
    kind: row.kind,
    topic: row.topic,
    decision: d ? d.slice(0, EVENT_TEXT * 2) : null,
    why: w ? w.slice(0, EVENT_TEXT) : null,
    notify,
  });
  const result = { huddle: detail(hub, member, { id: row.id }) };
  trimClosed(hub, member.team_id);
  return result;
}

// The whole discussion: every post in order, with the votes on each idea.
export function detail(hub, member, { id }) {
  const row = findHuddle(hub, member.team_id, id);
  const active = hub.activeMembers(member.team_id);
  const posts = hub.all(
    'SELECT seq, member_id, kind, text, on_seq, created_at FROM huddle_posts WHERE team_id = ? AND huddle_id = ? ORDER BY seq',
    row.team_id,
    row.id,
  );
  const votes = new Map();
  for (const v of hub.all(
    'SELECT seq, member_id, value, note FROM huddle_votes WHERE team_id = ? AND huddle_id = ? ORDER BY created_at',
    row.team_id,
    row.id,
  )) {
    if (!votes.has(v.seq)) votes.set(v.seq, []);
    votes.get(v.seq).push({ member_id: v.member_id, value: v.value, note: v.note });
  }
  const { ideas: _top, ...rest } = summary(hub, row, active);
  return {
    ...rest,
    posts: posts.map(({ on_seq, ...p }) => ({
      ...p,
      on: on_seq ?? null,
      votes: p.kind === 'idea' ? votes.get(p.seq) || [] : undefined,
    })),
  };
}

// Housekeeping: closed huddles go after a month, with their posts and votes, in one transaction.
export function sweep(hub) {
  const cutoff = hub.now() - KEEP_CLOSED_MS;
  const old = "SELECT team_id, id FROM huddles WHERE status = 'closed' AND closed_at < ?";
  hub.tx(() => {
    hub.run(`DELETE FROM huddle_votes WHERE (team_id, huddle_id) IN (${old})`, cutoff);
    hub.run(`DELETE FROM huddle_posts WHERE (team_id, huddle_id) IN (${old})`, cutoff);
    hub.run("DELETE FROM huddles WHERE status = 'closed' AND closed_at < ?", cutoff);
  });
}
