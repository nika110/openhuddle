import { timingSafeEqual } from 'node:crypto';
import { newId, newToken, newSecret, sha256 } from '../shared/ids.js';
import {
  DEFAULTS,
  ASSIGN_MODES,
  APPROVAL_RULES,
  CLAIM_MODES,
  LIMITS,
  ONLINE_MS,
  INVITE_TTL_MS,
  URGENT_KINDS,
  PROMPT_SECTIONS,
} from '../shared/protocol.js';
import { HubError, badRequest, forbidden, notFound, conflict } from './errors.js';
import { cleanText, cleanName, parse } from './text.js';
import * as prompt from './prompt.js';
import * as work from './tasks.js';
import * as claims from './claims.js';
import * as asks from './asks.js';

const EVENTS_KEPT = 20000;

function cleanRepoUrl(value) {
  if (!value) return null;
  let s = String(value).trim().slice(0, 300);
  s = s.replace(/^(https?:\/\/)[^@/]+@/i, '$1');
  if (!/^(https?:\/\/|git@|ssh:\/\/)/i.test(s)) return null;
  return s;
}

function sameSecret(a, b) {
  const x = Buffer.from(sha256(a));
  const y = Buffer.from(sha256(b));
  return timingSafeEqual(x, y);
}

export class Hub {
  constructor(db, { publicUrl = 'http://localhost:8787', now = Date.now } = {}) {
    this.db = db;
    this.publicUrl = publicUrl.replace(/\/+$/, '');
    this.now = now;
    this.subs = new Map();
    this.streams = new Map();
    this.waiters = new Map();
    this.editSeen = new Map();
    this.stmts = new Map();
    this.txDepth = 0;
    this.pending = [];
  }

  // ---- plumbing -------------------------------------------------------------

  q(sql) {
    let st = this.stmts.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.stmts.set(sql, st);
    }
    return st;
  }

  get(sql, ...params) {
    const row = this.q(sql).get(...params);
    return row ? { ...row } : null;
  }

  all(sql, ...params) {
    return this.q(sql).all(...params).map((r) => ({ ...r }));
  }

  run(sql, ...params) {
    return this.q(sql).run(...params);
  }

  tx(fn) {
    if (this.txDepth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth++;
    let result;
    try {
      result = fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      this.pending = [];
      throw err;
    } finally {
      this.txDepth--;
    }
    this.flush();
    return result;
  }

  flush() {
    const pending = this.pending;
    this.pending = [];
    for (const ev of pending) {
      const set = this.subs.get(ev.team_id);
      if (!set) continue;
      const { team_id, ...out } = ev;
      for (const fn of set) {
        try {
          fn(out);
        } catch {
          // a broken subscriber must not break the hub
        }
      }
    }
  }

  emit(teamId, memberId, kind, data = {}) {
    const at = this.now();
    const res = this.run(
      'INSERT INTO events (team_id, member_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)',
      teamId,
      memberId ?? null,
      kind,
      JSON.stringify(data),
      at,
    );
    const id = Number(res.lastInsertRowid);
    if (id % 1000 === 0) {
      this.run('DELETE FROM events WHERE team_id = ? AND id <= ?', teamId, id - EVENTS_KEPT);
    }
    const ev = { id, team_id: teamId, kind, member_id: memberId ?? null, data, created_at: at };
    this.pending.push(ev);
    if (this.txDepth === 0) this.flush();
    const { team_id, ...out } = ev;
    return out;
  }

  subscribe(teamId, fn) {
    let set = this.subs.get(teamId);
    if (!set) this.subs.set(teamId, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (!set.size) this.subs.delete(teamId);
    };
  }

  streamOpened(memberId) {
    this.streams.set(memberId, (this.streams.get(memberId) || 0) + 1);
  }

  streamClosed(memberId) {
    const n = (this.streams.get(memberId) || 1) - 1;
    if (n > 0) this.streams.set(memberId, n);
    else this.streams.delete(memberId);
  }

  lastEventId(teamId) {
    return this.get('SELECT MAX(id) AS id FROM events WHERE team_id = ?', teamId)?.id ?? 0;
  }

  // ---- teams and members ------------------------------------------------------

  team(teamId) {
    const row = this.get('SELECT * FROM teams WHERE id = ?', teamId);
    if (!row) throw notFound('unknown_team', 'This team does not exist.');
    row.settings = { ...structuredClone(DEFAULTS), ...parse(row.settings, {}) };
    row.prompt = parse(row.prompt, null);
    return row;
  }

  saveSettings(teamId, settings) {
    this.run('UPDATE teams SET settings = ? WHERE id = ?', JSON.stringify(settings), teamId);
  }

  activeMembers(teamId) {
    return this.all(
      'SELECT * FROM members WHERE team_id = ? AND removed_at IS NULL ORDER BY joined_at, rowid',
      teamId,
    );
  }

  findMember(teamId, ref) {
    const key = String(ref ?? '').trim();
    if (!key) throw badRequest('missing_member', 'Say which teammate (name or id).');
    const members = this.activeMembers(teamId);
    const lower = key.toLowerCase();
    const prefixed = members.filter((m) => m.name.toLowerCase().startsWith(lower));
    const hit =
      members.find((m) => m.id === key) ||
      members.find((m) => m.name.toLowerCase() === lower) ||
      (prefixed.length === 1 ? prefixed[0] : null);
    if (!hit) {
      const names = members.map((m) => m.name).join(', ');
      throw notFound('unknown_member', `No teammate called "${key}". Team: ${names}.`);
    }
    return hit;
  }

  isOnline(member) {
    if (this.streams.get(member.id) > 0) return true;
    return member.last_seen != null && this.now() - member.last_seen < ONLINE_MS;
  }

  publicMember(m, tasks = []) {
    return {
      id: m.id,
      name: m.name,
      role: m.role,
      tool: m.tool || null,
      strengths: m.strengths || null,
      online: this.isOnline(m),
      last_seen: m.last_seen ?? null,
      status: parse(m.status, {}),
      current_tasks: tasks
        .filter((t) => t.assignee_id === m.id && (t.status === 'assigned' || t.status === 'in_progress'))
        .map((t) => t.key),
    };
  }

  uniqueName(teamId, wanted) {
    const base = cleanName(wanted) || 'crewmate';
    const taken = new Set(this.activeMembers(teamId).map((m) => m.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; ; i++) {
      const name = `${base}-${i}`;
      if (!taken.has(name.toLowerCase())) return name;
    }
  }

  addMember(teamId, { name, role, tool }) {
    const token = newToken();
    const member = {
      id: newId('m'),
      team_id: teamId,
      name: this.uniqueName(teamId, name),
      role,
      tool: cleanName(tool, 30) || null,
      token_hash: sha256(token),
      joined_at: this.now(),
    };
    this.run(
      'INSERT INTO members (id, team_id, name, role, tool, token_hash, last_seen, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      member.id,
      member.team_id,
      member.name,
      member.role,
      member.tool,
      member.token_hash,
      member.joined_at,
      member.joined_at,
    );
    return { member, token };
  }

  inviteUrl(team) {
    return `${this.publicUrl}/join/${team.id}.${team.invite_secret}`;
  }

  dashboardUrl(teamId, token) {
    return `${this.publicUrl}/t/${teamId}#k=${token}`;
  }

  createTeam({ team_name, member_name, tool, repo_url } = {}) {
    const memberName = cleanName(member_name);
    if (!memberName) throw badRequest('missing_name', 'member_name is required.');
    return this.tx(() => {
      const at = this.now();
      const team = {
        id: newId('t'),
        name: cleanName(team_name, 60) || 'My crew',
        repo_url: cleanRepoUrl(repo_url),
        invite_secret: newSecret(),
        invite_expires_at: at + INVITE_TTL_MS,
      };
      const promptState = prompt.initialPrompt(PROMPT_SECTIONS);
      this.run(
        'INSERT INTO teams (id, name, repo_url, settings, invite_secret, invite_expires_at, prompt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        team.id,
        team.name,
        team.repo_url,
        JSON.stringify({}),
        team.invite_secret,
        team.invite_expires_at,
        JSON.stringify(promptState),
        at,
      );
      const { member, token } = this.addMember(team.id, { name: memberName, role: 'owner', tool });
      this.saveSettings(team.id, { ...structuredClone(DEFAULTS), lead_id: member.id });
      this.emit(team.id, member.id, 'joined', { name: member.name, tool: member.tool });
      return {
        team_id: team.id,
        team_name: team.name,
        member_id: member.id,
        member_name: member.name,
        token,
        invite_url: this.inviteUrl(team),
        dashboard_url: this.dashboardUrl(team.id, token),
      };
    });
  }

  join({ code, member_name, tool } = {}) {
    const raw = String(code ?? '').trim().replace(/^.*\/join\//, '');
    const dot = raw.indexOf('.');
    const invalid = forbidden('invalid_invite', 'This invite link is not valid or has expired. Ask a teammate for a fresh one.');
    if (dot < 1) throw invalid;
    const teamId = raw.slice(0, dot);
    const secret = raw.slice(dot + 1);
    const row = this.get('SELECT id FROM teams WHERE id = ?', teamId);
    if (!row) throw invalid;
    const team = this.team(teamId);
    if (!sameSecret(secret, team.invite_secret) || this.now() > team.invite_expires_at) throw invalid;
    const memberName = cleanName(member_name);
    if (!memberName) throw badRequest('missing_name', 'member_name is required.');
    return this.tx(() => {
      if (this.activeMembers(teamId).length >= LIMITS.members) {
        throw conflict('team_full', `A team can have at most ${LIMITS.members} members.`);
      }
      const { member, token } = this.addMember(teamId, { name: memberName, role: 'member', tool });
      this.emit(teamId, member.id, 'joined', { name: member.name, tool: member.tool });
      return {
        team_id: teamId,
        team_name: team.name,
        member_id: member.id,
        member_name: member.name,
        token,
        repo_url: team.repo_url,
        dashboard_url: this.dashboardUrl(teamId, token),
      };
    });
  }

  auth(token) {
    if (!token) throw new HubError(401, 'missing_token', 'Missing token. Run `npx vibecrew join <invite-link>` first.');
    const member = this.get('SELECT * FROM members WHERE token_hash = ? AND removed_at IS NULL', sha256(token));
    if (!member) throw new HubError(401, 'bad_token', 'This token is not valid (removed from the team?).');
    member.last_seen = this.now();
    this.run('UPDATE members SET last_seen = ? WHERE id = ?', member.last_seen, member.id);
    return member;
  }

  state(member) {
    const team = this.team(member.team_id);
    const tasks = work.listTasks(this, member.team_id);
    return {
      me: { id: member.id, name: member.name, role: member.role },
      team: {
        id: team.id,
        name: team.name,
        repo_url: team.repo_url,
        settings: team.settings,
        invite_expires_at: team.invite_expires_at,
      },
      members: this.activeMembers(member.team_id).map((m) => this.publicMember(m, tasks)),
      prompt: prompt.getPrompt(this, member.team_id),
      tasks,
      claims: claims.activeClaims(this, member.team_id),
      asks_for_me: asks.asksFor(this, member),
      last_event_id: this.lastEventId(member.team_id),
    };
  }

  isUrgentFor(ev, memberId) {
    if (!URGENT_KINDS.includes(ev.kind)) return false;
    if (ev.member_id === memberId) return false;
    if (ev.kind === 'prompt_submitted' || ev.kind === 'prompt_locked') return true;
    const d = ev.data || {};
    return d.to_id === memberId || d.proposed_id === memberId || d.assignee_id === memberId || d.member_id === memberId;
  }

  events(member, { since = 0, limit = 100, urgent = false, tail = 0 } = {}) {
    const tailN = Math.min(Math.max(0, Number(tail) || 0), 500);
    if (tailN) {
      const events = this.all(
        'SELECT id, member_id, kind, data, created_at FROM events WHERE team_id = ? ORDER BY id DESC LIMIT ?',
        member.team_id,
        tailN,
      )
        .map((r) => ({ ...r, data: parse(r.data, {}) }))
        .reverse();
      return { events, last_event_id: this.lastEventId(member.team_id) };
    }
    const from = Math.max(0, Number(since) || 0);
    const cap = Math.min(Math.max(1, Number(limit) || 100), 500);
    const window = urgent ? 500 : cap;
    const rows = this.all(
      'SELECT id, member_id, kind, data, created_at FROM events WHERE team_id = ? AND id > ? ORDER BY id LIMIT ?',
      member.team_id,
      from,
      window,
    ).map((r) => ({ ...r, data: parse(r.data, {}) }));
    let events = urgent ? rows.filter((ev) => this.isUrgentFor(ev, member.id)) : rows;
    let last = rows.length === window ? rows[rows.length - 1].id : this.lastEventId(member.team_id);
    if (events.length > cap) {
      events = events.slice(0, cap);
      last = events[cap - 1].id;
    }
    return { events, last_event_id: Math.max(last, from) };
  }

  heartbeat(member, status) {
    if (status && typeof status === 'object') {
      const prev = parse(member.status, {});
      const next = { ...prev };
      if (status.branch !== undefined) next.branch = cleanName(status.branch, 100) || null;
      if (status.activity !== undefined) next.activity = cleanText(status.activity, 200) || null;
      if (status.last_commit !== undefined) {
        const c = status.last_commit;
        next.last_commit = c && c.sha ? { sha: cleanName(c.sha, 40), message: cleanText(c.message, 200) } : null;
      }
      this.run('UPDATE members SET status = ? WHERE id = ?', JSON.stringify(next), member.id);
    }
    claims.extendClaims(this, member);
    return { ok: true, last_event_id: this.lastEventId(member.team_id) };
  }

  post(member, { kind, text, why } = {}) {
    if (kind !== 'update' && kind !== 'decision') throw badRequest('bad_kind', 'kind must be "update" or "decision".');
    const body = cleanText(text);
    if (!body) throw badRequest('missing_text', 'text is required.');
    const data = kind === 'decision' ? { text: body, why: cleanText(why) || null } : { text: body };
    if (kind === 'update') {
      const status = { ...parse(member.status, {}), activity: body.slice(0, 200) };
      this.run('UPDATE members SET status = ? WHERE id = ?', JSON.stringify(status), member.id);
    }
    const ev = this.emit(member.team_id, member.id, kind, data);
    return { event_id: ev.id };
  }

  settings(member, changes = {}) {
    return this.tx(() => {
      const team = this.team(member.team_id);
      const settings = { ...team.settings, approvals: { ...team.settings.approvals } };
      const applied = {};
      for (const [key, value] of Object.entries(changes || {})) {
        if (value === undefined || value === null) continue;
        if (key === 'assign_mode') {
          if (!ASSIGN_MODES.includes(value)) throw badRequest('bad_setting', `assign_mode must be one of ${ASSIGN_MODES.join(', ')}.`);
          settings.assign_mode = applied.assign_mode = value;
        } else if (key === 'approvals') {
          const rule = value?.master_prompt;
          if (!APPROVAL_RULES.includes(rule)) throw badRequest('bad_setting', `approvals.master_prompt must be one of ${APPROVAL_RULES.join(', ')}.`);
          settings.approvals.master_prompt = rule;
          applied.approvals = { master_prompt: rule };
        } else if (key === 'claim_mode') {
          if (!CLAIM_MODES.includes(value)) throw badRequest('bad_setting', `claim_mode must be one of ${CLAIM_MODES.join(', ')}.`);
          settings.claim_mode = applied.claim_mode = value;
        } else if (key === 'claim_ttl_min') {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 5 || n > 240) throw badRequest('bad_setting', 'claim_ttl_min must be a whole number from 5 to 240.');
          settings.claim_ttl_min = applied.claim_ttl_min = n;
        } else if (key === 'lead') {
          const lead = this.findMember(member.team_id, value);
          if (settings.lead_id !== lead.id) {
            settings.lead_id = lead.id;
            this.emit(member.team_id, member.id, 'lead_changed', { lead_id: lead.id });
          }
        } else if (key === 'my_strengths') {
          const strengths = cleanText(value, 200) || null;
          this.run('UPDATE members SET strengths = ? WHERE id = ?', strengths, member.id);
        } else {
          throw badRequest('unknown_setting', `Unknown setting "${key}".`);
        }
      }
      this.saveSettings(member.team_id, settings);
      if (Object.keys(applied).length) this.emit(member.team_id, member.id, 'settings_changed', { changes: applied });
      return { settings };
    });
  }

  invite(member, { rotate = false } = {}) {
    return this.tx(() => {
      let team = this.team(member.team_id);
      if (rotate && member.role !== 'owner') throw forbidden('owner_only', 'Only the team owner can reset the invite link.');
      if (rotate || this.now() > team.invite_expires_at) {
        const secret = newSecret();
        const expires = this.now() + INVITE_TTL_MS;
        this.run('UPDATE teams SET invite_secret = ?, invite_expires_at = ? WHERE id = ?', secret, expires, team.id);
        team = this.team(member.team_id);
      }
      return { invite_url: this.inviteUrl(team), expires_at: team.invite_expires_at };
    });
  }

  dropMember(target) {
    this.run('UPDATE members SET removed_at = ? WHERE id = ?', this.now(), target.id);
    claims.releaseAll(this, target);
    work.unassignAll(this, target);
  }

  removeMember(member, { member: ref } = {}) {
    if (member.role !== 'owner') throw forbidden('owner_only', 'Only the team owner can remove members.');
    return this.tx(() => {
      const target = this.findMember(member.team_id, ref);
      if (target.id === member.id) throw badRequest('remove_self', 'Use leave to remove yourself.');
      this.dropMember(target);
      this.emit(member.team_id, member.id, 'member_removed', { member_id: target.id, name: target.name });
      return { ok: true };
    });
  }

  leave(member) {
    return this.tx(() => {
      if (member.role === 'owner') {
        const next = this.activeMembers(member.team_id).find((m) => m.id !== member.id);
        if (next) this.run("UPDATE members SET role = 'owner' WHERE id = ?", next.id);
      }
      this.dropMember(member);
      this.emit(member.team_id, member.id, 'left', { name: member.name });
      return { ok: true };
    });
  }

  // ---- delegated domain ---------------------------------------------------------

  getPrompt(teamId) {
    return prompt.getPrompt(this, teamId);
  }
  promptEdit(member, args) {
    return this.tx(() => prompt.promptEdit(this, member, args || {}));
  }
  promptSubmit(member) {
    return this.tx(() => prompt.promptSubmit(this, member));
  }
  promptVote(member, args) {
    return this.tx(() => prompt.promptVote(this, member, args || {}));
  }
  plan(member, args) {
    return this.tx(() => work.plan(this, member, args || {}));
  }
  taskAction(member, args) {
    return this.tx(() => work.taskAction(this, member, args || {}));
  }
  listTasks(teamId) {
    return work.listTasks(this, teamId);
  }
  claims(member, args) {
    return this.tx(() => claims.claims(this, member, args || {}));
  }
  fileEdit(member, args) {
    return this.tx(() => claims.fileEdit(this, member, args || {}));
  }
  commit(member, args) {
    return this.tx(() => claims.commit(this, member, args || {}));
  }
  ask(member, args) {
    return this.tx(() => asks.ask(this, member, args || {}));
  }
  waitAnswer(teamId, askId, ms) {
    return asks.waitAnswer(this, teamId, askId, ms);
  }
  reply(member, args) {
    return this.tx(() => asks.reply(this, member, args || {}));
  }
}
