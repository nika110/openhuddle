import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHub, crew } from './helpers/hubcore.js';
import { openDb, SCHEMA_VERSION } from '../src/hub/db.js';
import { Hub } from '../src/hub/hub.js';
import { HubError } from '../src/hub/errors.js';
import { LIMITS } from '../src/shared/protocol.js';
import { huddleText, eventLine, byId, briefing } from '../src/client/format.js';

const fails = (fn, status, code) =>
  assert.throws(fn, (err) => err instanceof HubError && err.status === status && err.code === code);

const urgentKinds = (hub, member) => hub.events(member, { since: 0, urgent: true }).events.map((e) => e.kind);
const k = (...parts) => parts.join('');

test('huddle: a brainstorm waits on the whole team and reaches them right away', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub);
  const { huddle } = hub.huddleStart(auth(0), { kind: 'brainstorm', topic: 'How do we store sessions?', context: 'Login lands this week' });
  assert.equal(huddle.id, 'H1');
  assert.equal(huddle.status, 'open');
  assert.deepEqual(huddle.waiting_on, [auth(1).id, auth(2).id], 'the starter has spoken by starting it');
  assert.deepEqual(urgentKinds(hub, auth(1)), ['huddle_started']);
  assert.deepEqual(urgentKinds(hub, auth(0)), [], 'not news to the starter');
  assert.deepEqual(hub.state(auth(1)).huddles_for_me.map((x) => x.id), ['H1']);
  assert.deepEqual(hub.state(auth(0)).huddles_for_me, []);
  assert.equal(hub.huddleStart(auth(1), { topic: 'Second' }).huddle.id, 'H2', 'ids count up per team');
});

test('huddle: design needs a proposal, which becomes idea #1', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub);
  fails(() => hub.huddleStart(auth(0), { kind: 'design', topic: 'Sessions' }), 400, 'missing_proposal');
  fails(() => hub.huddleStart(auth(0), { kind: 'party', topic: 'x' }), 400, 'bad_kind');
  fails(() => hub.huddleStart(auth(0), { kind: 'brainstorm', topic: '   ' }), 400, 'missing_topic');
  const { huddle } = hub.huddleStart(auth(0), { kind: 'design', topic: 'Sessions', proposal: 'Signed cookies, no server state' });
  assert.deepEqual(huddle.posts.map((p) => [p.seq, p.kind, p.member_id]), [[1, 'idea', auth(0).id]]);
  assert.equal(huddle.idea_count, 1);
});

test('huddle: people narrows who is expected and who is told', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub);
  const { huddle } = hub.huddleStart(auth(0), { topic: 'Pick a CSS approach', people: ['ben'] });
  assert.deepEqual(huddle.people, [auth(1).id]);
  assert.deepEqual(huddle.waiting_on, [auth(1).id]);
  assert.deepEqual(urgentKinds(hub, auth(1)), ['huddle_started']);
  assert.deepEqual(urgentKinds(hub, auth(2)), [], 'cy was not asked');
  fails(() => hub.huddleStart(auth(0), { topic: 'x', people: ['nobody'] }), 404, 'unknown_member');
  // anyone may still chime in
  assert.equal(hub.huddlePost(auth(2), { id: 'H1', kind: 'idea', text: 'Plain CSS modules' }).seq, 1);
});

test('huddle: ideas, comments and backing, with the right people told', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub);
  hub.huddleStart(auth(0), { kind: 'design', topic: 'Sessions', proposal: 'Signed cookies' });
  const since = hub.lastEventId(auth(0).team_id);
  assert.equal(hub.huddlePost(auth(1), { id: 'h1', kind: 'idea', text: 'Redis sessions' }).seq, 2);
  hub.huddlePost(auth(2), { id: 'H1', kind: 'comment', text: 'Redis is one more thing to run', on: 2 });
  const toBen = hub.events(auth(1), { since, urgent: true }).events;
  assert.deepEqual(toBen.map((e) => [e.kind, e.member_id]), [['huddle_post', auth(2).id]], 'a comment on your idea reaches you');
  const toAna = hub.events(auth(0), { since, urgent: true }).events;
  assert.equal(toAna.length, 2, 'the starter hears every post');

  fails(() => hub.huddlePost(auth(1), { id: 'H1', text: 'x', on: 9 }), 404, 'unknown_idea');
  fails(() => hub.huddlePost(auth(1), { id: 'H1', text: 'x', on: 3 }), 404, 'unknown_idea');
  fails(() => hub.huddlePost(auth(1), { id: 'H1', kind: 'idea', text: 'x', on: 1 }), 400, 'bad_on');
  fails(() => hub.huddlePost(auth(1), { id: 'H1', kind: 'rant', text: 'x' }), 400, 'bad_kind');
  fails(() => hub.huddlePost(auth(1), { id: 'H1', text: '  ' }), 400, 'missing_text');
  fails(() => hub.huddlePost(auth(1), { id: 'H9', text: 'x' }), 404, 'unknown_huddle');

  fails(() => hub.huddleVote(auth(1), { id: 'H1', idea: 2, vote: 'up' }), 400, 'own_idea');
  fails(() => hub.huddleVote(auth(1), { id: 'H1', idea: 1, vote: 'maybe' }), 400, 'bad_vote');
  fails(() => hub.huddleVote(auth(1), { id: 'H1', idea: 3, vote: 'up' }), 404, 'unknown_idea');
  hub.huddleVote(auth(1), { id: 'H1', idea: 1, vote: 'up', note: 'no infra' });
  hub.huddleVote(auth(2), { id: 'H1', idea: 2, vote: 'down', note: 'ops cost' });
  hub.huddleVote(auth(2), { id: 'H1', idea: 2, vote: 'up', note: 'changed my mind' });
  const detail = hub.huddle(auth(0), { id: 'H1' });
  const idea2 = detail.posts.find((p) => p.seq === 2);
  assert.deepEqual(idea2.votes, [{ member_id: auth(2).id, value: 1, note: 'changed my mind' }], 'a second vote replaces the first');
  assert.equal(detail.posts.find((p) => p.seq === 3).on, 2);
  assert.deepEqual(detail.waiting_on, [], 'everyone has spoken');
  const summary = hub.state(auth(0)).huddles[0];
  assert.deepEqual(summary.ideas.map((i) => [i.seq, i.up, i.down]), [[1, 1, 0], [2, 1, 0]]);
});

test('huddle: closing records the decision and tells everyone involved', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub);
  hub.huddleStart(auth(1), { kind: 'brainstorm', topic: 'Where do images live?' });
  hub.huddlePost(auth(2), { id: 'H1', kind: 'idea', text: 'S3 with signed URLs' });
  fails(() => hub.huddleClose(auth(2), { id: 'H1', decision: 'S3' }), 403, 'not_your_huddle');
  fails(() => hub.huddleClose(auth(1), { id: 'H1' }), 400, 'missing_decision');
  const since = hub.lastEventId(auth(0).team_id);
  const { huddle } = hub.huddleClose(auth(1), { id: 'H1', decision: 'S3 with signed URLs', why: 'cheap and we know it' });
  assert.equal(huddle.status, 'closed');
  assert.equal(huddle.decision, 'S3 with signed URLs');
  assert.equal(huddle.closed_by, auth(1).id);
  assert.deepEqual(huddle.waiting_on, []);
  for (const i of [0, 2]) assert.deepEqual(hub.events(auth(i), { since, urgent: true }).events.map((e) => e.kind), ['huddle_closed']);
  fails(() => hub.huddlePost(auth(0), { id: 'H1', text: 'late' }), 409, 'huddle_closed');
  fails(() => hub.huddleVote(auth(0), { id: 'H1', idea: 1, vote: 'up' }), 409, 'huddle_closed');
  fails(() => hub.huddleClose(auth(1), { id: 'H1', decision: 'again' }), 409, 'huddle_closed');
  // the owner (ana) may close anyone's huddle
  hub.huddleStart(auth(2), { topic: 'Tabs or spaces' });
  assert.equal(hub.huddleClose(auth(0), { id: 'H2', decision: 'Prettier decides' }).huddle.status, 'closed');
  // the lead may not: anyone can make themselves lead, so that would open every huddle to anyone
  hub.huddleStart(auth(2), { topic: 'Monorepo?' });
  hub.settings(auth(1), { lead: 'ben' });
  fails(() => hub.huddleClose(auth(1), { id: 'H3', decision: 'Yes' }), 403, 'not_your_huddle');
});

test('huddle: naming only yourself is refused, not turned into a whole-team huddle', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub);
  fails(() => hub.huddleStart(auth(0), { topic: 'Me, myself', people: ['ana'] }), 400, 'no_people');
  assert.deepEqual(hub.huddleStart(auth(0), { topic: 'With ben', people: ['ana', 'ben'] }).huddle.people, [auth(1).id]);
});

test('huddle: post limits per huddle and per team, closed huddles make way', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben']);
  const perHuddle = LIMITS.huddle_posts;
  const huddles = LIMITS.huddle_posts_per_team / perHuddle;
  for (let h = 1; h <= huddles; h++) {
    hub.huddleStart(auth(0), { topic: `t${h}` });
    for (let i = 0; i < perHuddle; i++) hub.huddlePost(auth(1), { id: `H${h}`, text: `p${i}` });
  }
  fails(() => hub.huddlePost(auth(1), { id: 'H1', text: 'one more' }), 409, 'huddle_full');
  hub.huddleStart(auth(0), { topic: 'fresh' });
  const fresh = `H${huddles + 1}`;
  fails(() => hub.huddlePost(auth(1), { id: fresh, text: 'no room' }), 409, 'huddles_full');
  hub.huddleClose(auth(0), { id: 'H1', decision: 'done' });
  assert.equal(hub.huddlePost(auth(1), { id: fresh, text: 'room now' }).seq, 1);
  fails(() => hub.huddle(auth(0), { id: 'H1' }), 404, 'unknown_huddle');
  assert.equal(hub.get('SELECT COUNT(*) AS n FROM huddle_posts WHERE team_id = ?', auth(0).team_id).n, LIMITS.huddle_posts_per_team - perHuddle + 1);
});

test('huddle: only the newest closed huddles are kept', () => {
  const { hub, clock } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben']);
  const n = LIMITS.huddles_closed_kept + 2;
  for (let i = 1; i <= n; i++) {
    hub.huddleStart(auth(0), { topic: `t${i}` });
    hub.huddlePost(auth(1), { id: `H${i}`, text: 'idea', kind: 'idea' });
    clock.advance(1000);
    hub.huddleClose(auth(0), { id: `H${i}`, decision: 'ok' });
  }
  const kept = hub.all('SELECT id FROM huddles WHERE team_id = ?', auth(0).team_id).map((r) => r.id);
  assert.equal(kept.length, LIMITS.huddles_closed_kept);
  assert.ok(!kept.includes('H1') && !kept.includes('H2') && kept.includes(`H${n}`));
  assert.equal(hub.get("SELECT COUNT(*) AS n FROM huddle_posts WHERE huddle_id IN ('H1', 'H2')").n, 0);
});

test('huddle: the summary carries only the most backed ideas, clipped', () => {
  const { hub } = makeHub();
  const names = Array.from({ length: 20 }, (_, i) => `m${i}`);
  const { auth } = crew(hub, names);
  hub.huddleStart(auth(0), { topic: 'Big one' });
  for (let i = 0; i < 200; i++) hub.huddlePost(auth(1 + (i % 19)), { id: 'H1', kind: 'idea', text: 'x'.repeat(2000) });
  for (let m = 0; m < 20; m++) for (let s = 1; s <= 200; s += 3) {
    try {
      hub.huddleVote(auth(m), { id: 'H1', idea: s, vote: m % 2 ? 'up' : 'down' });
    } catch {}
  }
  const s = hub.state(auth(0)).huddles[0];
  assert.equal(s.ideas.length, 10);
  assert.ok(s.ideas.every((i) => i.text.length <= 300));
  assert.ok(s.ideas[0].up - s.ideas[0].down >= s.ideas[9].up - s.ideas[9].down, 'most backed first');
});

test('huddle: a standup waits on the starter too and closes without a decision', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben']);
  const { huddle } = hub.huddleStart(auth(0), { kind: 'standup' });
  assert.equal(huddle.topic, 'Standup');
  assert.deepEqual(huddle.waiting_on, [auth(0).id, auth(1).id]);
  hub.huddlePost(auth(0), { id: 'H1', text: 'Done: skeleton. Next: auth. Blocked: nothing.' });
  assert.deepEqual(hub.huddle(auth(0), { id: 'H1' }).waiting_on, [auth(1).id]);
  assert.equal(hub.huddleClose(auth(0), { id: 'H1' }).huddle.decision, null);
});

test('huddle: limits, secrets and housekeeping', () => {
  const { hub, clock } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben']);
  const key = k('sk-', 'ant-', 'api03-', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD');
  hub.huddleStart(auth(0), { topic: 'Keys', context: `use ${key}` });
  hub.huddlePost(auth(1), { id: 'H1', text: `try ${key}` });
  const d = hub.huddle(auth(0), { id: 'H1' });
  assert.ok(!JSON.stringify(d).includes(key), 'secrets never stored');
  for (let i = 1; i < LIMITS.huddles_open; i++) hub.huddleStart(auth(0), { topic: `t${i}` });
  fails(() => hub.huddleStart(auth(0), { topic: 'one too many' }), 409, 'too_many_huddles');

  hub.huddleClose(auth(0), { id: 'H1', decision: 'Never paste keys' });
  clock.advance(31 * 24 * 3600_000);
  hub.sweep();
  fails(() => hub.huddle(auth(0), { id: 'H1' }), 404, 'unknown_huddle');
  assert.equal(hub.get('SELECT COUNT(*) AS n FROM huddle_posts WHERE huddle_id = ?', 'H1').n, 0);
  assert.ok(hub.huddle(auth(0), { id: 'H2' }), 'open huddles stay');

  hub.deleteOwnTeam(auth(0));
  assert.equal(hub.get('SELECT COUNT(*) AS n FROM huddles').n, 0);
});

test('huddle: a 0.3 database upgrades to huddles in place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oh-huddle-db-'));
  try {
    const file = join(dir, 'hub.db');
    const old = openDb(file);
    const { token } = new Hub(old).createTeam({ team_name: 'old', member_name: 'ana' });
    old.exec('DROP TABLE huddle_votes; DROP TABLE huddle_posts; DROP TABLE huddles; ALTER TABLE teams DROP COLUMN next_huddle; PRAGMA user_version = 1;');
    old.close();
    const db = openDb(file);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    const hub = new Hub(db);
    const ana = hub.auth(token);
    assert.equal(hub.huddleStart(ana, { topic: 'Still works' }).huddle.id, 'H1');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('huddle: text for agents shows the ask, the backing, the discussion and the decision', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub);
  hub.huddleStart(auth(0), { kind: 'design', topic: 'Sessions', proposal: 'Signed cookies', context: 'Login lands this week' });
  hub.huddlePost(auth(1), { id: 'H1', kind: 'idea', text: 'Redis sessions' });
  hub.huddleVote(auth(2), { id: 'H1', idea: 1, vote: 'up', note: 'no infra' });
  hub.huddlePost(auth(2), { id: 'H1', text: 'Redis adds ops work', on: 2 });
  const state = hub.state(auth(1));
  const members = byId(state.members);
  const open = huddleText(hub.huddle(auth(1), { id: 'H1' }), members);
  assert.match(open, /H1 · design · open: Sessions/);
  assert.match(open, /Context:\nLogin lands this week/);
  assert.match(open, /Back it, push back/);
  assert.match(open, /idea #1 by ana \(\+1\/-0\): Signed cookies/);
  assert.match(open, /cy backs it: no infra/);
  assert.match(open, /#3 cy on idea #2: Redis adds ops work/);
  assert.match(briefing(hub.state(auth(1))), /Open huddles: H1 design: Sessions/);

  // A huge discussion still fits an agent's tool output: newest posts first, the rest summarized.
  for (let i = 0; i < 60; i++) hub.huddlePost(auth(1 + (i % 2)), { id: 'H1', text: `${i} ${'long '.repeat(700)}` });
  const big = huddleText(hub.huddle(auth(1), { id: 'H1' }), members);
  assert.ok(big.length < 25_000, `${big.length} chars`);
  assert.match(big, /earlier posts not shown/);
  assert.match(big, /- #63 /, 'the newest post is there');

  hub.huddleClose(auth(0), { id: 'H1', decision: 'Signed cookies', why: 'nothing new to run' });
  const closed = huddleText(hub.huddle(auth(1), { id: 'H1' }), members);
  assert.match(closed, /Decision: Signed cookies\nWhy: nothing new to run/);
  const lines = hub.events(auth(1), { since: 0 }).events.filter((e) => e.kind.startsWith('huddle_')).map((e) => eventLine(e, members));
  assert.match(lines[0], /ana started a design huddle H1: Sessions/);
  assert.ok(lines.some((l) => /ben added idea #2 to H1: Redis sessions/.test(l)));
  assert.ok(lines.some((l) => /cy backed idea #1 in H1: no infra/.test(l)));
  assert.match(lines.at(-1), /ana closed H1 \(Sessions\) — decided: Signed cookies — why: nothing new to run/);
});
