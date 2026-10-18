// Two people, two repos, one hub: the whole flow through the real CLI, MCP tools and hooks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/client/cli.js';
import { findProject } from '../src/client/config.js';
import { makeContext, callTool } from '../src/client/tools.js';
import { runHook } from '../src/client/hooks.js';
import { Api } from '../src/client/api.js';
import { startTestHub, delay } from './helpers/hub.js';
import { makeRepo, makeHome, cleanup, git } from './helpers/client.js';

let hub;
const dirs = [];

before(async () => {
  hub = await startTestHub();
});

after(async () => {
  await hub.close();
  cleanup(...dirs);
});

async function run(argv, { cwd, home }) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    cwd,
    home,
    env: { OPENHUDDLE_NO_CLAUDE_CLI: '1' },
    out: (s) => (out += s),
    err: (s) => (err += s),
  });
  return { code, out, err };
}

function context(hookOutput) {
  if (!hookOutput) return '';
  return JSON.parse(hookOutput).hookSpecificOutput.additionalContext;
}

test('e2e: two friends go from create to a finished dependency', async () => {
  const origin = 'https://github.com/example/pizza.git';
  const repoA = makeRepo({ origin });
  const repoB = makeRepo({ origin });
  const homeA = makeHome();
  const homeB = makeHome();
  dirs.push(repoA, repoB, homeA, homeB);

  // 1. Ana creates the team, Ben joins with the printed link.
  const created = await run(['create', '--hub', hub.url, '--as', 'ana', '--name', 'pizza'], { cwd: repoA, home: homeA });
  assert.equal(created.code, 0, created.err);
  const invite = /npx openhuddle join (\S+)/.exec(created.out)?.[1];
  assert.ok(invite, created.out);
  const joined = await run(['join', invite, '--as', 'ben'], { cwd: repoB, home: homeB });
  assert.equal(joined.code, 0, joined.err);
  assert.ok(existsSync(join(repoB, '.claude', 'settings.local.json')), 'Claude Code hooks wired for Ben');
  assert.match(readFileSync(join(repoB, '.git', 'info', 'exclude'), 'utf8'), /\.openhuddle\//);

  const projA = findProject(repoA);
  const projB = findProject(repoB);
  const ana = makeContext(projA);
  const ben = makeContext(projB);

  // Ana's session starts with a briefing that already knows Ben.
  const brief = context(await runHook('session-start', { cwd: repoA }));
  assert.match(brief, /<team-data/);
  assert.match(brief, /ben/);

  // 2. Ben writes part of the master prompt; Ana's next prompt hears about it.
  await callTool(ben, 'master_prompt', { action: 'edit', section: 'Idea', text: 'A pizza ordering app for our street.' });
  const news = context(await runHook('prompt', { cwd: repoA }));
  assert.match(news, /ben/);
  assert.match(news, /Idea/);
  assert.equal(await runHook('prompt', { cwd: repoA }), '', 'nothing new the second time');

  // 3. Vote: Ana submits, Ben approves, it locks.
  await callTool(ana, 'master_prompt', { action: 'submit' });
  const voted = await callTool(ben, 'master_prompt', { action: 'vote', approve: true });
  assert.match(voted, /locked/i);

  // 4. Ana plans: the skeleton first, Ben's task waits on it.
  await callTool(ana, 'plan', {
    action: 'create',
    tasks: [
      { key: 'T1', title: 'Skeleton', area: ['src/shared'], assignee: 'ana' },
      { key: 'T2', title: 'Login API', area: ['src/api'], depends_on: ['T1'], assignee: 'ben' },
    ],
  });
  await callTool(ben, 'task', { action: 'accept', key: 'T2' });
  await assert.rejects(callTool(ben, 'task', { action: 'start', key: 'T2' }), /T1/);

  // 5. Ana builds the skeleton; her edit claims the file; finishing unblocks Ben.
  await callTool(ana, 'task', { action: 'accept', key: 'T1' });
  await callTool(ana, 'task', { action: 'start', key: 'T1' });
  await runHook('post-edit', { cwd: repoA, tool_input: { file_path: join(repoA, 'src', 'shared', 'types.ts') } });
  await runHook('prompt', { cwd: repoB });
  await callTool(ana, 'task', { action: 'done', key: 'T1', note: 'types in src/shared' });
  const benAfterEdit = context(
    await runHook('post-edit', { cwd: repoB, tool_input: { file_path: join(repoB, 'src', 'api', 'login.ts') } }),
  );
  assert.match(benAfterEdit, /T2/);
  assert.match(benAfterEdit, /unblocked|ready|can start/i);
  await callTool(ben, 'task', { action: 'start', key: 'T2' });

  // 6. Ana edits the README; Ben's agent touching it gets paused to ask the human.
  await runHook('post-edit', { cwd: repoA, tool_input: { file_path: join(repoA, 'README.md') } });
  const guard = await runHook('pre-edit', { cwd: repoB, tool_input: { file_path: join(repoB, 'README.md') } });
  const decision = JSON.parse(guard).hookSpecificOutput;
  assert.equal(decision.permissionDecision, 'ask');
  assert.match(decision.permissionDecisionReason, /ana/);
  assert.equal(await runHook('pre-edit', { cwd: repoB, tool_input: { file_path: join(repoB, 'src', 'api', 'x.ts') } }), '');

  // 7. Ana asks Ben's agent; Ben's next prompt shows the question and his agent answers live.
  const asking = callTool(ana, 'team_ask', { to: 'ben', question: 'Does login return the user too?' });
  let question = '';
  for (let i = 0; i < 50 && !/Q\d+/.test(question); i++) {
    question = context(await runHook('prompt', { cwd: repoB }));
    if (!/Q\d+/.test(question)) await delay(50);
  }
  const askId = /Q\d+/.exec(question)[0];
  await callTool(ben, 'team_reply', { ask_id: askId, answer: 'Yes: { user, token }' });
  const answer = await asking;
  assert.match(answer, /T2/, 'snapshot shows what Ben is on');
  assert.match(answer, /\{ user, token \}/);

  // 8. A real git commit in Ana's repo reaches the team through the post-commit hook.
  writeFileSync(join(repoA, 'menu.txt'), 'margherita\n');
  git(repoA, 'add', '-A');
  git(repoA, 'commit', '-q', '-m', 'add the menu');
  const api = new Api(hub.url, projB.config.token);
  let commit;
  for (let i = 0; i < 60 && !commit; i++) {
    const { events } = await api.get('/api/events?since=0&limit=500');
    commit = events.find((e) => e.kind === 'commit');
    if (!commit) await delay(100);
  }
  assert.ok(commit, 'commit event arrived');
  assert.equal(commit.data.message, 'add the menu');

  // 9. Both leave cleanly; config and hooks are gone.
  assert.equal((await run(['leave'], { cwd: repoB, home: homeB })).code, 0);
  assert.equal(findProject(repoB), null);
  assert.equal(existsSync(join(repoB, '.claude', 'settings.local.json')), false);
  assert.equal((await run(['leave'], { cwd: repoA, home: homeA })).code, 0);
});
