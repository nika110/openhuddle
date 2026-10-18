import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHub, crew } from './helpers/hubcore.js';
import { HubError } from '../src/hub/errors.js';

const fails = (fn, status, code) =>
  assert.throws(fn, (err) => err instanceof HubError && err.status === status && err.code === code);

const task = (hub, member, key) => hub.listTasks(member.team_id).find((t) => t.key === key);

function twoTaskPlan(hub, auth) {
  return hub.plan(auth(0), {
    tasks: [
      { key: 'T1', title: 'Skeleton', area: ['package.json', 'src/shared'], assignee: 'ana' },
      { key: 'T2', title: 'Login API', area: ['src/api/auth'], depends_on: ['T1'], assignee: 'ben' },
    ],
  });
}

test('plan: hybrid proposes, accept assigns', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben']);
  const { tasks } = twoTaskPlan(hub, auth);
  assert.deepEqual(tasks.map((t) => [t.key, t.status, t.proposed_id]), [
    ['T1', 'proposed', auth(0).id],
    ['T2', 'proposed', auth(1).id],
  ]);
  const urgent = hub.events(auth(1), { since: 0, urgent: true }).events;
  assert.deepEqual(urgent.map((e) => [e.kind, e.data.key]), [['task_proposed', 'T2']]);
  const { task: t2 } = hub.taskAction(auth(1), { action: 'accept', key: 't2' });
  assert.equal(t2.status, 'assigned');
  assert.equal(t2.assignee_id, auth(1).id);
  fails(() => hub.taskAction(auth(1), { action: 'accept', key: 'T1' }), 409, 'not_proposed_to_you');
});

test('plan: self mode leaves tasks open; agent mode assigns', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben']);
  hub.settings(auth(0), { assign_mode: 'self' });
  let { tasks } = hub.plan(auth(0), { tasks: [{ title: 'A', assignee: 'ben' }] });
  assert.equal(tasks[0].status, 'open');
  hub.settings(auth(0), { assign_mode: 'agent' });
  ({ tasks } = hub.plan(auth(0), { tasks: [{ title: 'B', assignee: 'ben' }] }));
  assert.equal(tasks[0].status, 'assigned');
  assert.equal(tasks[0].assignee_id, auth(1).id);
});

test('plan: keys auto-number and local refs resolve', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana']);
  hub.plan(auth(0), { tasks: [{ key: 'T1', title: 'one' }] });
  const { tasks } = hub.plan(auth(0), {
    tasks: [
      { key: 'T1', title: 'clashing key' },
      { title: 'depends on the first of this plan', depends_on: ['T1', '#1'] },
    ],
  });
  assert.equal(tasks[0].key, 'T2', 'clashing key gets a fresh number');
  assert.deepEqual(tasks[1].depends_on, ['T2'], 'T1 here means the local task, #1 too');
});

test('plan: unknown dependency 400', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana']);
  fails(() => hub.plan(auth(0), { tasks: [{ title: 'x', depends_on: ['T9'] }] }), 400, 'unknown_dependency');
  assert.equal(hub.listTasks(auth(0).team_id).length, 0, 'nothing half-written');
});

test('plan: cycle 400', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana']);
  fails(
    () =>
      hub.plan(auth(0), {
        tasks: [
          { key: 'A', title: 'a', depends_on: ['B'] },
          { key: 'B', title: 'b', depends_on: ['A'] },
        ],
      }),
    400,
    'dependency_cycle',
  );
});

test('plan: sets lead and emits lead_changed', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben']);
  hub.plan(auth(1), { tasks: [{ title: 'x' }] });
  assert.equal(hub.state(auth(0)).team.settings.lead_id, auth(1).id);
  const kinds = hub.events(auth(0), { since: 0 }).events.map((e) => e.kind);
  assert.ok(kinds.includes('plan_created'));
  assert.equal(kinds.at(-1), 'lead_changed');
});

test('plan: replace removes only unstarted tasks', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana']);
  hub.settings(auth(0), { assign_mode: 'self' });
  hub.plan(auth(0), { tasks: [{ key: 'T1', title: 'keep' }, { key: 'T2', title: 'drop' }] });
  hub.taskAction(auth(0), { action: 'take', key: 'T1' });
  const { tasks } = hub.plan(auth(0), { tasks: [{ title: 'new' }], replace: true });
  assert.deepEqual(hub.listTasks(auth(0).team_id).map((t) => t.title), ['keep', 'new']);
  assert.equal(tasks.length, 1);
});

test('task: start blocked until deps done', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben']);
  twoTaskPlan(hub, auth);
  hub.taskAction(auth(1), { action: 'accept', key: 'T2' });
  fails(() => hub.taskAction(auth(1), { action: 'start', key: 'T2' }), 409, 'blocked');
  assert.equal(task(hub, auth(1), 'T2').ready, false);
});

test('task: done unblocks dependent and notifies its assignee', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben']);
  twoTaskPlan(hub, auth);
  hub.taskAction(auth(0), { action: 'accept', key: 'T1' });
  hub.taskAction(auth(1), { action: 'accept', key: 'T2' });
  hub.taskAction(auth(0), { action: 'start', key: 'T1', branch: 'feat/skeleton' });
  const { last_event_id } = hub.events(auth(1), { since: 0 });
  hub.taskAction(auth(0), { action: 'done', key: 'T1', note: 'types in src/shared' });
  const urgent = hub.events(auth(1), { since: last_event_id, urgent: true }).events;
  assert.deepEqual(urgent.map((e) => [e.kind, e.data.key]), [['task_unblocked', 'T2']]);
  assert.equal(task(hub, auth(1), 'T2').ready, true);
  const { task: t2 } = hub.taskAction(auth(1), { action: 'start', key: 'T2' });
  assert.equal(t2.status, 'in_progress');
});

test("task: take of someone else's assigned task 409", () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben']);
  twoTaskPlan(hub, auth);
  hub.taskAction(auth(1), { action: 'accept', key: 'T2' });
  fails(() => hub.taskAction(auth(0), { action: 'take', key: 'T2' }), 409, 'already_assigned');
  const { task: t1 } = hub.taskAction(auth(1), { action: 'take', key: 'T1' });
  assert.equal(t1.assignee_id, auth(1).id, 'a proposed task can be taken by someone else');
});

test("task: release frees task claims", () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben']);
  twoTaskPlan(hub, auth);
  hub.taskAction(auth(0), { action: 'accept', key: 'T1' });
  hub.taskAction(auth(0), { action: 'start', key: 'T1' });
  hub.fileEdit(auth(0), { path: 'src/shared/types.ts' });
  assert.equal(hub.state(auth(0)).claims[0].task_key, 'T1');
  hub.taskAction(auth(0), { action: 'release', key: 'T1' });
  assert.equal(hub.state(auth(0)).claims.length, 0);
  assert.equal(task(hub, auth(0), 'T1').status, 'open');
});

test('claims: second member conflicts', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben']);
  const first = hub.claims(auth(0), { action: 'claim', paths: ['src/app.ts'] });
  const second = hub.claims(auth(1), { action: 'claim', paths: ['src/app.ts', 'src/other.ts'] });
  assert.deepEqual(first.claimed, ['src/app.ts']);
  assert.deepEqual(second.claimed, ['src/other.ts']);
  assert.equal(second.conflicts.length, 1);
  assert.equal(second.conflicts[0].member_name, 'ana');
  const { conflict } = hub.fileEdit(auth(1), { path: 'src\\app.ts' });
  assert.equal(conflict.member_name, 'ana');
});

test('claims: expired claim is free', () => {
  const { hub, clock } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben']);
  hub.claims(auth(0), { action: 'claim', paths: ['src/app.ts'] });
  clock.advance(31 * 60_000);
  assert.deepEqual(hub.claims(auth(1), { action: 'claim', paths: ['src/app.ts'] }).claimed, ['src/app.ts']);
});

test('claims: heartbeat extends', () => {
  const { hub, clock } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben']);
  hub.claims(auth(0), { action: 'claim', paths: ['src/app.ts'] });
  clock.advance(20 * 60_000);
  hub.heartbeat(auth(0), { branch: 'main' });
  clock.advance(20 * 60_000);
  assert.equal(hub.claims(auth(1), { action: 'check', paths: ['src/app.ts'] }).conflicts.length, 1);
});

test('claims: bad path 400', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana']);
  fails(() => hub.claims(auth(0), { action: 'claim', paths: ['/etc/passwd'] }), 400, 'bad_path');
  fails(() => hub.claims(auth(0), { action: 'claim', paths: ['../x'] }), 400, 'bad_path');
  fails(() => hub.claims(auth(0), { action: 'claim', paths: [] }), 400, 'missing_paths');
});

test('claims: check reports area overlaps with teammates tasks', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben']);
  twoTaskPlan(hub, auth);
  hub.taskAction(auth(1), { action: 'accept', key: 'T2' });
  const { overlaps } = hub.claims(auth(0), { action: 'check', paths: ['src/api/auth/login.ts'] });
  assert.deepEqual(overlaps, [{ path: 'src/api/auth/login.ts', task_key: 'T2', member_id: auth(1).id }]);
});

test('file-edit: debounced event', () => {
  const { hub, clock } = makeHub();
  const { auth } = crew(hub, ['ana']);
  hub.fileEdit(auth(0), { path: 'a.ts' });
  hub.fileEdit(auth(0), { path: 'a.ts' });
  clock.advance(11 * 60_000);
  hub.fileEdit(auth(0), { path: 'a.ts' });
  const edits = hub.events(auth(0), { since: 0 }).events.filter((e) => e.kind === 'file_edit');
  assert.equal(edits.length, 2);
});

test('file-edit: returns urgent events since cursor', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben']);
  const { last_event_id } = hub.events(auth(0), { since: 0 });
  hub.ask(auth(1), { to: 'ana', question: 'are you on the cart?' });
  const res = hub.fileEdit(auth(0), { path: 'cart.ts', since: last_event_id });
  assert.deepEqual(res.events.map((e) => e.data.question), ['are you on the cart?']);
  assert.ok(res.last_event_id > last_event_id);
});

test('commit: records status and event', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben']);
  hub.commit(auth(0), { sha: 'abcdef1234567890', branch: 'feat/x', message: 'add cart\n\nlong body', files: ['a', 'b'] });
  const ana = hub.state(auth(1)).members.find((m) => m.name === 'ana');
  assert.deepEqual(ana.status.last_commit, { sha: 'abcdef123456', message: 'add cart' });
  const ev = hub.events(auth(1), { since: 0 }).events.pop();
  assert.deepEqual(ev.data, { sha: 'abcdef123456', branch: 'feat/x', message: 'add cart', files_count: 2 });
  fails(() => hub.commit(auth(0), { sha: 'not a sha' }), 400, 'missing_sha');
});

test('ask: snapshot has tasks and claims', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben']);
  twoTaskPlan(hub, auth);
  hub.claims(auth(1), { action: 'claim', paths: ['src/api/auth/login.ts'] });
  hub.post(auth(1), { kind: 'update', text: 'wiring JWT' });
  const res = hub.ask(auth(0), { to: 'Ben', question: 'how is login going?' });
  assert.equal(res.ask_id, 'Q1');
  assert.equal(res.to.name, 'ben');
  assert.deepEqual(res.snapshot.tasks.map((t) => t.key), ['T2']);
  assert.deepEqual(res.snapshot.claims, ['src/api/auth/login.ts']);
  assert.equal(res.snapshot.status.activity, 'wiring JWT');
  assert.equal(res.snapshot.recent[0].kind, 'update');
  assert.deepEqual(hub.state(auth(1)).asks_for_me.map((a) => [a.id, a.from_name]), [['Q1', 'ana']]);
});

test('ask: waitAnswer resolves on reply', async () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben']);
  const { ask_id } = hub.ask(auth(0), { to: 'ben', question: 'jwt or sessions?' });
  const pending = hub.waitAnswer(auth(0).team_id, ask_id, 5000);
  hub.reply(auth(1), { ask_id: 'q1', answer: 'JWT, 15 min expiry' });
  assert.equal(await pending, 'JWT, 15 min expiry');
  assert.equal(hub.state(auth(1)).asks_for_me.length, 0);
  const reply = hub.events(auth(0), { since: 0, urgent: true }).events.pop();
  assert.equal(reply.kind, 'reply');
  assert.equal(reply.data.to_id, auth(0).id);
});

test('ask: waitAnswer null on timeout', async () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben']);
  const { ask_id } = hub.ask(auth(0), { to: 'ben', question: '?' });
  assert.equal(await hub.waitAnswer(auth(0).team_id, ask_id, 30), null);
  fails(() => hub.reply(auth(0), { ask_id, answer: 'me?' }), 403, 'not_your_question');
});

test('ask: cannot ask yourself 400', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben']);
  fails(() => hub.ask(auth(0), { to: 'ana', question: '?' }), 400, 'self_ask');
  fails(() => hub.ask(auth(0), { to: 'zed', question: '?' }), 404, 'unknown_member');
});

test('leaving puts unfinished work back on the board', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben']);
  twoTaskPlan(hub, auth);
  hub.taskAction(auth(1), { action: 'accept', key: 'T2' });
  hub.leave(auth(1));
  const t2 = task(hub, auth(0), 'T2');
  assert.equal(t2.status, 'open');
  assert.equal(t2.assignee_id, null);
});
