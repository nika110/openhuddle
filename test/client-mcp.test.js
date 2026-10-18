import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { runMcp } from '../src/client/mcp.js';
import { makeRepo, cleanup } from './helpers/client.js';
import { startTestHub, makeCrew, projectFor, apiFor, delay } from './helpers/hub.js';

async function rpc(project, messages) {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (c) => chunks.push(c));
  const done = runMcp({ input, output, project, heartbeatMs: 0, log: () => {} });
  for (const m of messages) input.write((typeof m === 'string' ? m : JSON.stringify(m)) + '\n');
  input.end();
  await done;
  const out = Buffer.concat(chunks).toString('utf8');
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const call = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const byId = (msgs, id) => msgs.find((m) => m.id === id);

test('mcp: initialize echoes supported version', async () => {
  const res = await rpc(null, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
    { jsonrpc: '2.0', id: 3, method: 'ping' },
  ]);
  assert.equal(res.length, 3, 'notifications get no response');
  const init = byId(res, 1).result;
  assert.equal(init.protocolVersion, '2025-03-26');
  assert.equal(init.serverInfo.name, 'openhuddle');
  assert.deepEqual(init.capabilities, { tools: {} });
  assert.ok(init.instructions.includes('team_sync'));
  assert.ok(init.instructions.includes('skeleton'));
  assert.equal(byId(res, 2).result.protocolVersion, '2025-06-18');
  assert.deepEqual(byId(res, 3).result, {});
});

test('mcp: tools/list has 9 tools', async () => {
  const [res] = await rpc(null, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  const names = res.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['claim', 'master_prompt', 'plan', 'task', 'team_ask', 'team_post', 'team_reply', 'team_settings', 'team_sync']);
  for (const t of res.result.tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.description.length > 40, t.name);
  }
});

test('mcp: unknown method -32601', async () => {
  const res = await rpc(null, [{ jsonrpc: '2.0', id: 7, method: 'resources/list' }, '{not json']);
  assert.equal(byId(res, 7).error.code, -32601);
  assert.equal(res.find((m) => m.id === null).error.code, -32700);
});

test('mcp: no project → join hint', async () => {
  const [res] = await rpc(null, [call(1, 'team_sync')]);
  assert.equal(res.result.isError, false);
  assert.ok(res.result.content[0].text.includes('npx openhuddle join'));
  const [bad] = await rpc(null, [call(2, 'no_such_tool')]);
  assert.equal(bad.result.isError, true);
});

let hub;
let crew;
let repoA;
let repoB;
let A;
let B;

before(async () => {
  hub = await startTestHub();
  crew = await makeCrew(hub.url);
  repoA = makeRepo();
  repoB = makeRepo();
  A = projectFor(repoA, hub.url, crew.owner);
  B = projectFor(repoB, hub.url, crew.member);
});

after(async () => {
  await hub?.close();
  cleanup(repoA, repoB);
});

test('mcp: team_sync returns framed briefing', async () => {
  const [res] = await rpc(A, [call(1, 'team_sync')]);
  const text = res.result.content[0].text;
  assert.equal(res.result.isError, false, text);
  assert.ok(text.startsWith('<team-data'));
  assert.ok(text.includes('pizza-app'));
  assert.ok(text.includes('bob'));
  assert.ok(text.includes('Master prompt'));
});

test('mcp: master_prompt edit and plan create round trip', async () => {
  const res = await rpc(B, [call(1, 'master_prompt', { action: 'edit', section: 'Idea', text: 'Pizza ordering for friends' })]);
  assert.equal(res[0].result.isError, false, res[0].result.content[0].text);
  assert.ok(res[0].result.content[0].text.includes('Pizza ordering for friends'));
  const plan = await rpc(A, [
    call(2, 'plan', {
      action: 'create',
      tasks: [
        { key: 'T1', title: 'skeleton', area: ['package.json', 'src/shared/**'] },
        { key: 'T2', title: 'menu page', area: ['web/**'], depends_on: ['T1'], assignee: 'bob' },
      ],
    }),
  ]);
  const text = plan[0].result.content[0].text;
  assert.equal(plan[0].result.isError, false, text);
  assert.ok(text.includes('T1'));
  assert.ok(text.includes('menu page'));
});

test('mcp: hub error surfaces as isError', async () => {
  const [res] = await rpc(A, [call(1, 'task', { action: 'start', key: 'T999' })]);
  assert.equal(res.result.isError, true);
  assert.ok(res.result.content[0].text.startsWith('openhuddle:'));
  const [missing] = await rpc(A, [call(2, 'team_post', { kind: 'update' })]);
  assert.equal(missing.result.isError, true);
  assert.ok(missing.result.content[0].text.includes('text'));
});

test('mcp: hub error text reaches the agent framed', async () => {
  const [res] = await rpc(A, [call(1, 'team_ask', { to: 'zed', question: 'hi' })]);
  const text = res.result.content[0].text;
  assert.equal(res.result.isError, true);
  assert.ok(text.startsWith('openhuddle:'), text);
  assert.ok(text.includes('<team-data'), text);
  assert.ok(text.includes('zed'), text);
});

test('mcp: team_sync shows the latest news, not the oldest', async () => {
  await rpc(A, [call(1, 'team_sync')]);
  const apiB = apiFor(hub.url, crew.member);
  for (let i = 1; i <= 120; i++) await apiB.post('/api/post', { kind: 'update', text: `sync #${i}` });
  const [res] = await rpc(A, [call(2, 'team_sync')]);
  const news = res.result.content[0].text.split('What changed since you last looked:')[1] || '';
  assert.match(news, /^- .*sync #120(?!\d)/m, 'the newest update is in the news list');
  assert.doesNotMatch(news, /sync #1(?!\d)/);
  assert.match(news, /older updates/);
});

test('mcp: team_ask returns snapshot of teammate', async () => {
  const apiB = apiFor(hub.url, crew.member);
  await apiB.post('/api/claims', { action: 'claim', paths: ['web/menu.tsx'] });
  const askP = rpc(A, [call(1, 'team_ask', { to: 'bob', question: 'what are you working on?' })]);
  let replied = false;
  for (let i = 0; i < 80 && !replied; i++) {
    const st = await apiB.get('/api/state');
    if (st.asks_for_me.length) {
      const q = st.asks_for_me[0];
      await apiB.post('/api/reply', { ask_id: q.id ?? q.ask_id, answer: 'Building the menu header.' });
      replied = true;
    } else {
      await delay(100);
    }
  }
  assert.ok(replied, 'bob saw the question');
  const [res] = await askP;
  const text = res.result.content[0].text;
  assert.equal(res.result.isError, false, text);
  assert.ok(text.startsWith('<team-data'));
  assert.ok(text.includes('bob'));
  assert.ok(text.includes('web/menu.tsx'));
  assert.ok(text.includes('Building the menu header.'));
});

test('mcp: claim converts absolute paths and reports conflicts', async () => {
  const { join } = await import('node:path');
  const [res] = await rpc(A, [call(1, 'claim', { action: 'check', paths: [join(repoA, 'web', 'menu.tsx')] })]);
  const text = res.result.content[0].text;
  assert.equal(res.result.isError, false, text);
  assert.ok(text.includes('web/menu.tsx'));
  assert.ok(text.includes('bob'));
});
