import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main, parseInvite, browserCommand, resolveHub } from '../src/client/cli.js';
import { VERSION, DEFAULT_HUB } from '../src/shared/protocol.js';
import { makeRepo, makeHome, tempDir, cleanup, git, safeEnv } from './helpers/client.js';
import { startTestHub } from './helpers/hub.js';

const BIN = fileURLToPath(new URL('../bin/openhuddle.js', import.meta.url));

let hub;
let home;
let origin;
let repoA;
let repoB;
let invite;
const FAKE = 'https://example.invalid/vc/pizza.git';

// Runs the real bin without blocking this process (the hub lives in this process).
function runBin(args, { cwd, input = '', env }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const timer = setTimeout(() => child.kill(), 15000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function capture(cwd, extra = {}) {
  const io = { cwd, home, stdout: '', stderr: '', env: { ...process.env, OPENHUDDLE_NO_CLAUDE_CLI: '1' }, ...extra };
  io.out = (s) => {
    io.stdout += s;
  };
  io.err = (s) => {
    io.stderr += s;
  };
  return io;
}

before(async () => {
  home = makeHome();
  process.env.OPENHUDDLE_HOME = join(home, '.openhuddle');
  process.env.OPENHUDDLE_NO_CLAUDE_CLI = '1';
  delete process.env.CODEX_HOME;
  hub = await startTestHub();
  // A clonable "remote" for the team repo.
  const seed = makeRepo();
  origin = join(tempDir('vc-origin-'), 'pizza.git');
  git(seed, 'clone', '-q', '--bare', seed, origin);
  cleanup(seed);
  repoA = makeRepo({ origin: FAKE });
  repoB = makeRepo({ origin: FAKE });
});

after(async () => {
  await hub?.close();
  cleanup(home, repoA, repoB);
});

test('cli: --version and help', async () => {
  const io = capture(repoA);
  assert.equal(await main(['--version'], io), 0);
  assert.equal(io.stdout.trim(), VERSION);
  const h = capture(repoA);
  assert.equal(await main([], h), 0);
  assert.ok(h.stdout.includes('npx openhuddle join'));
  const bad = capture(repoA);
  assert.equal(await main(['frobnicate'], bad), 1);
});

test('cli: parseInvite', () => {
  assert.deepEqual(parseInvite('https://hub.example.com/join/tabc.SECRET_x-1'), { hub: 'https://hub.example.com', code: 'tabc.SECRET_x-1' });
  assert.deepEqual(parseInvite('http://localhost:8787/base/join/tabc.S/'), { hub: 'http://localhost:8787/base', code: 'tabc.S' });
  assert.equal(parseInvite('nonsense'), null);
});

test('cli: resolveHub prefers --hub, then OPENHUDDLE_HUB, then the public hub', () => {
  assert.equal(resolveHub('https://a.example/', 'https://b.example', 'https://c.example'), 'https://a.example');
  assert.equal(resolveHub(undefined, 'https://b.example', 'https://c.example'), 'https://b.example');
  assert.equal(resolveHub(undefined, undefined, 'https://c.example'), 'https://c.example');
  assert.throws(() => resolveHub(undefined, undefined, ''), /npx openhuddle hub/);
});

test('cli: the public hub is the default', () => {
  assert.match(DEFAULT_HUB, /^https:\/\//);
});

test('cli: create outside git repo exits 1 with hint', async () => {
  const dir = tempDir();
  const io = capture(dir);
  assert.equal(await main(['create', '--hub', hub.url], io), 1);
  assert.ok(io.stderr.includes('git init'));
  cleanup(dir);
});

test('cli: create prints invite and writes config', async () => {
  const io = capture(repoA);
  const code = await main(['create', '--hub', hub.url, '--as', 'alice', '--name', 'pizza-app'], io);
  assert.equal(code, 0, io.stderr);
  const m = io.stdout.match(/npx openhuddle join (\S+)/);
  assert.ok(m, io.stdout);
  invite = m[1];
  assert.match(invite, /^http:\/\/(localhost|127\.0\.0\.1):\d+\/join\/t[a-z2-7]+\./);
  const cfg = JSON.parse(readFileSync(join(repoA, '.openhuddle', 'config.json'), 'utf8'));
  assert.equal(cfg.member_name, 'alice');
  assert.equal(cfg.hub, hub.url);
  assert.ok(cfg.token.startsWith('vc_'));
  assert.ok(existsSync(join(repoA, '.claude', 'settings.local.json')));
  assert.ok(io.stdout.includes('/t/'));
  assert.equal(git(repoA, 'status', '--porcelain'), '');
  const again = capture(repoA);
  assert.equal(await main(['create', '--hub', hub.url], again), 1);
  assert.ok(again.stderr.includes('already in the team'));
});

test('cli: dash builds the URL locally and ignores a hostile dashboard_url', async () => {
  const file = join(repoA, '.openhuddle', 'config.json');
  const original = readFileSync(file, 'utf8');
  const cfg = JSON.parse(original);
  assert.equal(cfg.dashboard_url, undefined, 'hub-provided URLs are not stored');
  try {
    writeFileSync(file, JSON.stringify({ ...cfg, dashboard_url: 'https://x/t/y" & calc & "' }));
    const io = capture(repoA);
    assert.equal(await main(['dash', '--no-open'], io), 0, io.stderr);
    assert.ok(io.stdout.includes(`${hub.url}/t/${cfg.team_id}#k=${cfg.token}`), io.stdout);
    assert.ok(!io.stdout.includes('calc'));
    writeFileSync(file, JSON.stringify({ ...cfg, hub: 'file:///etc' }));
    const bad = capture(repoA);
    assert.equal(await main(['dash', '--no-open'], bad), 1);
  } finally {
    writeFileSync(file, original);
  }
});

test('cli: parseInvite only accepts http(s) links', () => {
  assert.equal(parseInvite('file:///join/tabc.secret'), null);
  assert.equal(parseInvite('javascript:alert(1)//join/tabc.secret'), null);
  assert.equal(parseInvite('https://crew.example.com/join/tabc.secret').hub, 'https://crew.example.com');
});

test('cli: browser opens without a shell', () => {
  const url = 'https://x.example/t/tabc#k=vc_x';
  assert.deepEqual(browserCommand(url, 'win32'), ['rundll32', ['url.dll,FileProtocolHandler', url]]);
  assert.deepEqual(browserCommand(url, 'darwin'), ['open', [url]]);
  assert.deepEqual(browserCommand(url, 'linux'), ['xdg-open', [url]]);
});

test('cli: hub explains when node:sqlite is missing', async () => {
  const io = capture(tempDir(), {
    importModule: async (m) => {
      if (m === 'node:sqlite') throw new Error('No such built-in module: node:sqlite');
      return import(m);
    },
  });
  assert.equal(await main(['hub', '--port', '0'], io), 1);
  assert.match(io.stderr, /Node 22\.13 or newer/);
  cleanup(io.cwd);
});

test('cli: join with invite writes config for second member', async () => {
  const io = capture(repoB);
  const code = await main(['join', invite, '--as', 'bob'], io);
  assert.equal(code, 0, io.stderr);
  const cfg = JSON.parse(readFileSync(join(repoB, '.openhuddle', 'config.json'), 'utf8'));
  assert.equal(cfg.member_name, 'bob');
  assert.equal(cfg.team_name, 'pizza-app');
  assert.ok(io.stdout.includes('Joined the team "pizza-app"'));
});

test('cli: join outside a repo clones the team repo', async () => {
  const dir = tempDir();
  // Point the team's https URL at the local bare repo, only for this clone.
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = `url.${origin.replace(/\\/g, '/')}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = FAKE;
  try {
    const io = capture(dir);
    const code = await main(['join', invite, '--as', 'carol'], io);
    delete process.env.GIT_CONFIG_COUNT;
    assert.equal(code, 0, io.stderr);
    const cloned = join(dir, 'pizza');
    assert.ok(existsSync(join(cloned, 'README.md')));
    const cfg = JSON.parse(readFileSync(join(cloned, '.openhuddle', 'config.json'), 'utf8'));
    assert.equal(cfg.member_name, 'carol');
    assert.equal(await main(['leave'], capture(cloned)), 0);
  } finally {
    delete process.env.GIT_CONFIG_COUNT;
    delete process.env.GIT_CONFIG_KEY_0;
    delete process.env.GIT_CONFIG_VALUE_0;
    cleanup(dir);
  }
});

test('cli: bad invite fails cleanly', async () => {
  const dir = makeRepo();
  try {
    const io = capture(dir);
    assert.equal(await main(['join', `${hub.url}/join/tzzzzzzzzzz.nope`], io), 1);
    assert.ok(io.stderr.length > 0);
    assert.ok(!existsSync(join(dir, '.openhuddle')));
  } finally {
    cleanup(dir);
  }
});

test('cli: status shows both members', async () => {
  const io = capture(repoA);
  assert.equal(await main(['status'], io), 0, io.stderr);
  assert.ok(io.stdout.includes('bob'));
  assert.ok(io.stdout.includes('pizza-app'));
  const outside = tempDir();
  const none = capture(outside);
  assert.equal(await main(['status'], none), 1);
  assert.ok(none.stderr.includes('npx openhuddle join'));
  cleanup(outside);
});

test('cli: invite and doctor', async () => {
  const io = capture(repoA);
  assert.equal(await main(['invite'], io), 0, io.stderr);
  assert.ok(io.stdout.includes('/join/'));
  const doc = capture(repoA);
  const code = await main(['doctor'], doc);
  assert.ok(doc.stdout.includes('hub'), doc.stdout);
  assert.ok(doc.stdout.includes('membership is valid'), doc.stdout);
  assert.equal(code, 0, doc.stdout);
  // Projects set up by older versions get the token-guarding .gitignore on --fix.
  rmSync(join(repoA, '.openhuddle', '.gitignore'), { force: true });
  assert.equal(await main(['doctor', '--fix'], capture(repoA)), 0);
  assert.equal(readFileSync(join(repoA, '.openhuddle', '.gitignore'), 'utf8').trim(), '*');
});

test('cli: hook exits 0 on garbage stdin', async () => {
  const io = capture(repoA, { stdin: 'garbage{' });
  assert.equal(await main(['hook', 'prompt'], io), 0);
  const unknown = capture(repoA, { stdin: '{}' });
  assert.equal(await main(['hook', 'no-such-hook'], unknown), 0);
  assert.equal(unknown.stdout, '');
});

test('cli: real process hook exits fast with empty stdin', async () => {
  const t0 = Date.now();
  const r = await runBin(['hook', 'prompt'], { cwd: tempDir(), env: safeEnv(home) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`);
});

test('cli: real process hook in a team repo prints hook JSON', async () => {
  const r = await runBin(['hook', 'session-start'], {
    cwd: repoB,
    input: JSON.stringify({ cwd: repoB, hook_event_name: 'SessionStart' }),
    env: safeEnv(home),
  });
  assert.equal(r.status, 0, r.stderr);
  const json = JSON.parse(r.stdout);
  assert.equal(json.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(json.hookSpecificOutput.additionalContext.includes('alice'));
});

test('cli: real mcp server answers over stdio and exits when stdin closes', async () => {
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'team_sync', arguments: {} } },
  ];
  const r = await runBin(['mcp', '--dir', repoB], {
    cwd: tempDir(),
    input: msgs.map((m) => JSON.stringify(m)).join('\n') + '\n',
    env: safeEnv(home),
  });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.find((l) => l.id === 1).result.serverInfo.name, 'openhuddle');
  const sync = lines.find((l) => l.id === 2).result;
  assert.equal(sync.isError, false, sync.content[0].text);
  assert.ok(sync.content[0].text.includes('alice'));
});

test('cli: remove is owner only', async () => {
  const code = decodeURIComponent(new URL(invite).pathname.split('/join/')[1]);
  await fetch(`${hub.url}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, member_name: 'dave' }),
  });
  const asMember = capture(repoB);
  assert.equal(await main(['remove', 'dave'], asMember), 1);
  assert.match(asMember.stderr, /owner/i);
  const asOwner = capture(repoA);
  assert.equal(await main(['remove', 'dave'], asOwner), 0, asOwner.stderr);
  assert.match(asOwner.stdout, /dave/);
  const st = capture(repoA);
  await main(['status'], st);
  assert.ok(!/dave/.test(st.stdout), st.stdout);
  const usage = capture(repoA);
  assert.equal(await main(['remove'], usage), 1);
});

test('cli: leave unwires and removes config', async () => {
  const io = capture(repoB);
  assert.equal(await main(['leave'], io), 0, io.stderr);
  assert.ok(!existsSync(join(repoB, '.openhuddle')));
  assert.ok(!existsSync(join(repoB, '.claude', 'settings.local.json')));
  assert.ok(!existsSync(join(repoB, '.git', 'hooks', 'post-commit')));
  const st = capture(repoA);
  await main(['status'], st);
  assert.ok(!/bob \(/.test(st.stdout), st.stdout);
});

test('cli: delete-team needs --yes, then deletes the team and the local setup', async () => {
  const repo = makeRepo();
  try {
    const io = capture(repo);
    assert.equal(await main(['create', '--hub', hub.url, '--as', 'zoe', '--name', 'doomed'], io), 0, io.stderr);
    const careful = capture(repo);
    assert.equal(await main(['delete-team'], careful), 1);
    assert.match(careful.stderr, /--yes/);
    assert.ok(existsSync(join(repo, '.openhuddle', 'config.json')), 'nothing happens without --yes');
    const sure = capture(repo);
    assert.equal(await main(['delete-team', '--yes'], sure), 0, sure.stderr);
    assert.match(sure.stdout, /doomed/);
    assert.ok(!existsSync(join(repo, '.openhuddle')), 'local setup removed');
  } finally {
    cleanup(repo);
  }
});
