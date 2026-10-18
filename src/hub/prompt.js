import { LIMITS } from '../shared/protocol.js';
import { badRequest, conflict } from './errors.js';
import { cleanText, cleanName } from './text.js';

const MAX_SECTIONS = 40;

export function initialPrompt(titles) {
  return {
    state: 'draft',
    version: 0,
    locked_version: null,
    sections: titles.map((title) => ({ title, body: '', updated_by: null, updated_at: null })),
    locked_sections: null,
    votes: {},
  };
}

function needed(rule, count) {
  if (rule === 'all') return count;
  if (rule === 'majority') return Math.floor(count / 2) + 1;
  return 1;
}

function save(hub, teamId, p) {
  hub.run('UPDATE teams SET prompt = ? WHERE id = ?', JSON.stringify(p), teamId);
}

export function getPrompt(hub, teamId) {
  const team = hub.team(teamId);
  const p = team.prompt;
  const active = hub.activeMembers(teamId);
  const rule = team.settings.approvals?.master_prompt || 'all';
  const votes = {};
  for (const m of active) if (p.votes[m.id]) votes[m.id] = p.votes[m.id];
  return {
    state: p.state,
    version: p.version,
    locked_version: p.locked_version,
    sections: p.sections,
    locked_sections: p.state === 'amending' ? p.locked_sections : null,
    votes,
    rule,
    needed: needed(rule, active.length),
  };
}

function maybeLock(hub, teamId, p) {
  const team = hub.team(teamId);
  const active = hub.activeMembers(teamId);
  const rule = team.settings.approvals?.master_prompt || 'all';
  const approvals = active.filter((m) => p.votes[m.id]?.approve === true).length;
  const rejects = active.filter((m) => p.votes[m.id]?.approve === false).length;
  const owner = active.find((m) => m.role === 'owner');
  let ok;
  if (rule === 'all') ok = approvals === active.length && rejects === 0;
  else if (rule === 'majority') ok = approvals > active.length / 2;
  else ok = Boolean(owner && p.votes[owner.id]?.approve === true);
  if (!ok) return false;
  p.state = 'locked';
  p.locked_version = p.version;
  p.locked_sections = structuredClone(p.sections);
  return true;
}

// A running vote can be decided by someone leaving or by the owner changing the rule.
export function recheckLock(hub, teamId) {
  const p = hub.team(teamId).prompt;
  if (p.state !== 'voting' || !maybeLock(hub, teamId, p)) return false;
  save(hub, teamId, p);
  hub.emit(teamId, null, 'prompt_locked', { version: p.version });
  return true;
}

export function promptEdit(hub, member, { section, text, mode = 'replace' }) {
  const title = cleanName(section, 80);
  const team = hub.team(member.team_id);
  const p = team.prompt;
  if (!title) {
    throw badRequest('missing_section', `Say which section to edit. Sections: ${p.sections.map((s) => s.title).join(', ')}.`);
  }
  if (mode !== 'replace' && mode !== 'append') throw badRequest('bad_mode', 'mode must be "replace" or "append".');
  const body = cleanText(text, LIMITS.section);
  if (mode === 'append' && !body) throw badRequest('missing_text', 'Nothing to append.');
  let s = p.sections.find((x) => x.title.toLowerCase() === title.toLowerCase());
  if (!s) {
    if (p.sections.length >= MAX_SECTIONS) throw conflict('too_many_sections', `The master prompt can have at most ${MAX_SECTIONS} sections.`);
    s = { title, body: '', updated_by: null, updated_at: null };
    p.sections.push(s);
  }
  const nextBody = mode === 'append' && s.body ? `${s.body}\n${body}`.slice(0, LIMITS.section) : body;
  const total = p.sections.reduce((n, x) => n + (x === s ? nextBody.length : x.body.length), 0);
  if (total > LIMITS.prompt_total) {
    throw conflict('prompt_too_long', `The master prompt can hold at most ${LIMITS.prompt_total} characters. Shorten another section first.`);
  }
  s.body = nextBody;
  s.updated_by = member.id;
  s.updated_at = hub.now();
  p.version += 1;
  if (p.state === 'voting') {
    p.state = p.locked_version != null ? 'amending' : 'draft';
    p.votes = {};
  } else if (p.state === 'locked') {
    p.state = 'amending';
    p.votes = {};
  }
  hub.run(
    'INSERT INTO prompt_versions (team_id, version, sections, author_id, created_at) VALUES (?, ?, ?, ?, ?)',
    member.team_id,
    p.version,
    JSON.stringify(p.sections),
    member.id,
    hub.now(),
  );
  hub.run(
    'DELETE FROM prompt_versions WHERE team_id = ? AND version <= ?',
    member.team_id,
    p.version - LIMITS.prompt_versions_kept,
  );
  save(hub, member.team_id, p);
  hub.emit(member.team_id, member.id, 'prompt_edit', { section: s.title, mode, version: p.version });
  return { prompt: getPrompt(hub, member.team_id) };
}

export function promptSubmit(hub, member) {
  const p = hub.team(member.team_id).prompt;
  if (p.state === 'voting') throw conflict('already_voting', 'The master prompt is already up for a vote.');
  if (p.state === 'locked') throw conflict('nothing_to_submit', `Version ${p.locked_version} is already locked. Edit it first to propose a change.`);
  if (!p.sections.some((s) => s.body)) throw conflict('empty_prompt', 'The master prompt is empty. Write at least the Idea section first.');
  p.state = 'voting';
  p.votes = { [member.id]: { approve: true, comment: null } };
  hub.emit(member.team_id, member.id, 'prompt_submitted', { version: p.version });
  if (maybeLock(hub, member.team_id, p)) {
    save(hub, member.team_id, p);
    hub.emit(member.team_id, member.id, 'prompt_locked', { version: p.version });
  } else {
    save(hub, member.team_id, p);
  }
  return { prompt: getPrompt(hub, member.team_id) };
}

export function promptVote(hub, member, { approve, comment }) {
  const p = hub.team(member.team_id).prompt;
  if (p.state !== 'voting') throw conflict('not_voting', 'There is no vote right now. Someone has to submit the master prompt first.');
  const vote = { approve: Boolean(approve), comment: cleanText(comment, 500) || null };
  p.votes[member.id] = vote;
  hub.emit(member.team_id, member.id, 'prompt_vote', { version: p.version, ...vote });
  if (maybeLock(hub, member.team_id, p)) {
    save(hub, member.team_id, p);
    hub.emit(member.team_id, member.id, 'prompt_locked', { version: p.version });
  } else {
    save(hub, member.team_id, p);
  }
  return { prompt: getPrompt(hub, member.team_id) };
}
