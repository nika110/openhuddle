import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runHook } from '../src/client/hooks.js';
import { saveConfig, findProject } from '../src/client/config.js';
import { makeRepo, cleanup, git, tempDir } from './helpers/client.js';
import { startTestHub, makeCrew, projectFor, apiFor } from './helpers/hub.js';

let hub;
let crew;
let repoA;
let repoB;
let A;
let B;
let apiA;
let apiB;
const outputs = [];

async function hook(name, input, project) {
  const out = await runHook(name, input, { project });
  outputs.push(out);
  return out;
}

before(async () => {
  hub = await startTestHub();
  crew = await makeCrew(hub.url);
  repoA = makeRepo();
  repoB = makeRepo();
  A = projectFor(repoA, hub.url, crew.owner);
  B = projectFor(repoB, hub.url, crew.member);
  apiA = apiFor(hub.url, crew.owner);
  apiB = apiFor(hub.url, crew.member);
});

after(async () => {
  await hub?.close();
  cleanup(repoA, repoB);
});

test('hooks: session-start injects briefing', async () => {
  const out = await hook('session-start', { cwd: repoA, hook_event_name: 'SessionStart' }, A);
  const json = JSON.parse(out);
  assert.equal(json.hookSpecificOutput.hookEventName, 'SessionStart');
  const ctx = json.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('<team-data'));
  assert.ok(ctx.includes('pizza-app'));
  assert.ok(ctx.includes('bob'));
});

test('hooks: prompt shows only new events then nothing', async () => {
  await hook('prompt', { cwd: repoA }, A); // drain anything older
  await apiB.post('/api/post', { kind: 'update', text: 'menu page skeleton compiles' });
  const out = await hook('prompt', { cwd: repoA, prompt: 'hi' }, A);
  const json = JSON.parse(out);
  assert.equal(json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(json.hookSpecificOutput.additionalContext.includes('menu page skeleton compiles'));
  assert.equal(await hook('prompt', { cwd: repoA }, A), '');
});

test('hooks: pre-edit on teammate\'s file → ask', async () => {
  await apiB.post('/api/claims', { action: 'claim', paths: ['src/menu.ts'] });
  const out = await hook('pre-edit', { cwd: repoA, tool_name: 'Edit', tool_input: { file_path: join(repoA, 'src', 'menu.ts') } }, A);
  const json = JSON.parse(out);
  assert.equal(json.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(json.hookSpecificOutput.permissionDecision, 'ask');
  assert.ok(json.hookSpecificOutput.permissionDecisionReason.includes('bob'));
  assert.ok(json.hookSpecificOutput.permissionDecisionReason.includes('src/menu.ts'));
});

test('hooks: pre-edit on free file → empty', async () => {
  assert.equal(await hook('pre-edit', { cwd: repoA, tool_name: 'Write', tool_input: { file_path: join(repoA, 'src', 'free.ts') } }, A), '');
  assert.equal(await hook('pre-edit', { cwd: repoA, tool_name: 'Write', tool_input: { file_path: join(tempDir(), 'outside.ts') } }, A), '');
});

test('hooks: pre-edit with block mode → deny', async () => {
  await apiA.post('/api/settings', { claim_mode: 'block' });
  await hook('prompt', { cwd: repoA }, A); // refreshes cached settings
  const out = await hook('pre-edit', { cwd: repoA, tool_name: 'Edit', tool_input: { file_path: join(repoA, 'src', 'menu.ts') } }, A);
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, 'deny');
  await apiA.post('/api/settings', { claim_mode: 'warn' });
  await hook('prompt', { cwd: repoA }, A);
  assert.equal(await hook('pre-edit', { cwd: repoA, tool_name: 'Edit', tool_input: { file_path: join(repoA, 'src', 'menu.ts') } }, A), '');
  await apiA.post('/api/settings', { claim_mode: 'ask' });
  await hook('prompt', { cwd: repoA }, A);
});

test('hooks: post-edit claims file and surfaces question for me', async () => {
  await hook('prompt', { cwd: repoA }, A);
  assert.equal(await hook('post-edit', { cwd: repoA, tool_name: 'Edit', tool_input: { file_path: join(repoA, 'src', 'cart.ts') } }, A), '');
  const check = await apiB.post('/api/claims', { action: 'check', paths: ['src/cart.ts'] });
  assert.equal(check.conflicts.length, 1);
  assert.equal(check.conflicts[0].member_id, crew.owner.member_id);
  await apiB.post('/api/ask', { to: 'alice', question: 'is the cart API stable yet?', wait_s: 0 });
  const out = await hook('post-edit', { cwd: repoA, tool_name: 'Edit', tool_input: { file_path: join(repoA, 'src', 'cart.ts') } }, A);
  const json = JSON.parse(out);
  assert.equal(json.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(json.hookSpecificOutput.additionalContext.includes('is the cart API stable yet?'));
  // shown once, not again on the next edit
  assert.equal(await hook('post-edit', { cwd: repoA, tool_name: 'Edit', tool_input: { file_path: join(repoA, 'src', 'cart.ts') } }, A), '');
  // the pending question keeps showing on prompts until answered
  const p = await hook('prompt', { cwd: repoA }, A);
  assert.ok(JSON.parse(p).hookSpecificOutput.additionalContext.includes('team_reply'));
});

test('hooks: git-commit posts the commit', async () => {
  writeFileSync(join(repoA, 'cart.txt'), 'cart\n');
  git(repoA, 'add', '-A');
  git(repoA, 'commit', '-q', '-m', 'add cart stub');
  assert.equal(await hook('git-commit', {}, A), '');
  const ev = await apiB.get('/api/events?since=0&limit=200');
  const commit = ev.events.find((e) => e.kind === 'commit');
  assert.ok(commit);
  assert.equal(commit.data.message, 'add cart stub');
});

test('hooks: no project → empty', async () => {
  const dir = tempDir();
  assert.equal(await runHook('prompt', { cwd: dir }), '');
  cleanup(dir);
});

test('hooks: dead hub fails open fast', async () => {
  const repo = makeRepo();
  try {
    saveConfig(repo, { hub: 'http://10.255.255.1:9', team_id: 't', member_id: 'm', member_name: 'x', token: 'vc_x' });
    const project = findProject(repo);
    for (const name of ['session-start', 'prompt', 'pre-edit', 'post-edit', 'stop']) {
      const t0 = Date.now();
      const out = await runHook(name, { cwd: repo, tool_input: { file_path: join(repo, 'a.ts') } }, { project });
      assert.equal(out, '', name);
      assert.ok(Date.now() - t0 < 3500, `${name} took ${Date.now() - t0}ms`);
    }
  } finally {
    cleanup(repo);
  }
});

test('hooks: hanging hub times out under 3.5s', async () => {
  const net = await import('node:net');
  const sockets = [];
  const server = net.createServer((s) => sockets.push(s)); // accepts, never answers
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const repo = makeRepo();
  try {
    saveConfig(repo, { hub: `http://127.0.0.1:${server.address().port}`, team_id: 't', member_id: 'm', member_name: 'x', token: 'vc_x' });
    const project = findProject(repo);
    for (const name of ['prompt', 'pre-edit']) {
      const t0 = Date.now();
      const out = await runHook(name, { cwd: repo, tool_input: { file_path: join(repo, 'a.ts') } }, { project });
      const took = Date.now() - t0;
      assert.equal(out, '', name);
      assert.ok(took >= 2000 && took < 3500, `${name} took ${took}ms`);
    }
  } finally {
    for (const s of sockets) s.destroy();
    server.close();
    cleanup(repo);
  }
});

test('hooks: never emits allow', () => {
  for (const out of outputs) assert.ok(!/"permissionDecision":"allow"/.test(out));
  const src = readFileSync(new URL('../src/client/hooks.js', import.meta.url), 'utf8');
  assert.ok(!/['"]allow['"]/.test(src));
});
