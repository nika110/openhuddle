import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, makeHome, cleanup, git } from './helpers/client.js';

let home;
before(() => {
  home = makeHome();
  process.env.OPENHUDDLE_HOME = join(home, '.openhuddle');
  process.env.OPENHUDDLE_NO_CLAUDE_CLI = '1';
  delete process.env.CODEX_HOME;
});
after(() => cleanup(home));

const wire = await import('../src/client/wire.js');
const CMD = '"C:/nodejs/node.exe" "C:/Users/x/.openhuddle/app/bin/openhuddle.js"';

function ourCommands(settings) {
  const out = [];
  for (const groups of Object.values(settings.hooks || {})) {
    for (const g of groups) for (const h of g.hooks || []) if (/openhuddle/.test(h.command) && / hook /.test(h.command)) out.push(h.command);
  }
  return out;
}

test('wire: claude settings merge keeps foreign hooks', () => {
  const foreign = {
    permissions: { allow: ['Bash(ls)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo foreign' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
    },
  };
  const merged = wire.mergeClaudeSettings(foreign, CMD);
  assert.deepEqual(merged.permissions, { allow: ['Bash(ls)'] });
  assert.equal(merged.hooks.PreToolUse.find((g) => g.matcher === 'Bash').hooks[0].command, 'echo foreign');
  assert.ok(merged.hooks.Stop.some((g) => g.hooks.some((h) => h.command === 'say done')));
  const ours = ourCommands(merged);
  assert.equal(ours.length, 5);
  for (const name of ['session-start', 'prompt', 'pre-edit', 'post-edit', 'stop']) {
    assert.ok(ours.includes(`${CMD} hook ${name}`), name);
  }
  const pre = merged.hooks.PreToolUse.find((g) => g.hooks.some((h) => h.command.endsWith('hook pre-edit')));
  assert.equal(pre.matcher, 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell');
  // input untouched
  assert.equal(foreign.hooks.PreToolUse.length, 1);
});

test('wire: claude settings merge is idempotent', () => {
  const once = wire.mergeClaudeSettings({}, CMD);
  const twice = wire.mergeClaudeSettings(once, CMD);
  assert.deepEqual(twice, once);
  const moved = wire.mergeClaudeSettings(once, '"D:/node.exe" "D:/vc/openhuddle.js"');
  assert.equal(ourCommands(moved).length, 5);
  assert.ok(ourCommands(moved).every((c) => c.startsWith('"D:/')));
});

test('wire: unmerge removes only ours', () => {
  const foreign = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] }, model: 'x' };
  const merged = wire.mergeClaudeSettings(foreign, CMD);
  const back = wire.unmergeClaudeSettings(merged);
  assert.deepEqual(back, foreign);
  assert.deepEqual(wire.unmergeClaudeSettings(wire.mergeClaudeSettings({}, CMD)), {});
});

test('wire: codex toml append, replace in place, unmerge', () => {
  const server = { command: 'C:/nodejs/node.exe', args: ['C:/Users/x/.openhuddle/app/bin/openhuddle.js', 'mcp'] };
  const base = 'model = "o4"\n\n[mcp_servers.other]\ncommand = "other"\n\n[profiles.fast]\nmodel = "mini"\n';
  const added = wire.mergeCodexToml(base, server);
  assert.ok(added.includes('[mcp_servers.other]'));
  assert.ok(added.includes('[profiles.fast]'));
  assert.ok(added.includes('[mcp_servers.openhuddle]'));
  assert.ok(added.includes('command = "C:/nodejs/node.exe"'));
  assert.ok(added.includes('args = ["C:/Users/x/.openhuddle/app/bin/openhuddle.js","mcp"]'));
  const again = wire.mergeCodexToml(added, { ...server, command: 'D:/node.exe' });
  assert.equal(again.match(/\[mcp_servers\.openhuddle\]/g).length, 1);
  assert.ok(again.includes('command = "D:/node.exe"'));
  assert.ok(!again.includes('C:/nodejs/node.exe'));
  // in place: stays before [profiles.fast] when it was there
  const mid = 'a = 1\n[mcp_servers.openhuddle]\ncommand = "old"\n[mcp_servers.openhuddle.env]\nX = "1"\n[profiles.fast]\nmodel = "mini"\n';
  const replaced = wire.mergeCodexToml(mid, server);
  assert.ok(replaced.indexOf('[mcp_servers.openhuddle]') < replaced.indexOf('[profiles.fast]'));
  assert.ok(!replaced.includes('command = "old"'));
  assert.ok(!replaced.includes('[mcp_servers.openhuddle.env]'));
  const removed = wire.unmergeCodexToml(added);
  assert.ok(!removed.includes('openhuddle'));
  assert.ok(removed.includes('[mcp_servers.other]'));
  assert.ok(removed.includes('model = "mini"'));
  // backslashes survive as valid TOML escapes
  const win = wire.mergeCodexToml('', { command: 'C:\\node.exe', args: ['x'] });
  assert.ok(win.includes('command = "C:\\\\node.exe"'));
});

test('wire: cursor json merge keeps other servers', () => {
  const server = { command: 'node', args: ['vc.js', 'mcp'] };
  const merged = wire.mergeCursorJson({ mcpServers: { other: { command: 'x' } }, extra: 1 }, server);
  assert.deepEqual(merged.mcpServers.other, { command: 'x' });
  assert.deepEqual(merged.mcpServers.openhuddle, server);
  assert.equal(merged.extra, 1);
  const back = wire.unmergeCursorJson(merged);
  assert.deepEqual(back, { mcpServers: { other: { command: 'x' } }, extra: 1 });
  assert.deepEqual(wire.mergeCursorJson(null, server), { mcpServers: { openhuddle: server } });
});

test('wire: git hook appended to existing hook and idempotent', () => {
  const repo = makeRepo();
  try {
    const hook = join(repo, '.git', 'hooks', 'post-commit');
    writeFileSync(hook, '#!/bin/sh\necho existing\nexit 0\n');
    wire.installGitHook(repo, CMD);
    wire.installGitHook(repo, CMD);
    const text = readFileSync(hook, 'utf8');
    assert.ok(text.startsWith('#!/bin/sh\n'));
    assert.ok(text.includes('echo existing'));
    assert.equal(text.match(/# >>> openhuddle/g).length, 1);
    assert.ok(text.includes(`${CMD} hook git-commit >/dev/null 2>&1 &`));
    // our block runs before the existing `exit 0`
    assert.ok(text.indexOf('hook git-commit') < text.indexOf('exit 0'));
    if (process.platform !== 'win32') assert.ok(statSync(hook).mode & 0o100);
  } finally {
    cleanup(repo);
  }
});

test('wire: git hook removed cleanly', () => {
  const repo = makeRepo();
  try {
    const hook = join(repo, '.git', 'hooks', 'post-commit');
    wire.installGitHook(repo, CMD);
    assert.ok(existsSync(hook));
    wire.removeGitHook(repo);
    assert.ok(!existsSync(hook), 'hook we created alone is deleted');
    writeFileSync(hook, '#!/bin/sh\necho existing\n');
    wire.installGitHook(repo, CMD);
    wire.removeGitHook(repo);
    assert.equal(readFileSync(hook, 'utf8'), '#!/bin/sh\necho existing\n');
  } finally {
    cleanup(repo);
  }
});

test('wire: git hook leaves a non-shell post-commit hook alone', () => {
  for (const original of ['#!/usr/bin/env node\nconsole.log("hi");\n', '#!/usr/bin/python3\nprint(1)\n', 'echo no shebang\n']) {
    const repo = makeRepo();
    try {
      const hook = join(repo, '.git', 'hooks', 'post-commit');
      writeFileSync(hook, original);
      const res = wire.installGitHook(repo, CMD);
      assert.equal(res.installed, false, original);
      assert.match(res.reason, /not a shell script/);
      assert.equal(readFileSync(hook, 'utf8'), original);
      assert.equal(wire.wiringStatus(repo, { home }).git_hook, null, 'doctor should not flag it as broken');
    } finally {
      cleanup(repo);
    }
  }
});

test('wire: git hook inlines into sh, bash and zsh hooks', () => {
  for (const shebang of ['#!/bin/sh', '#!/usr/bin/env bash', '#!/bin/zsh', '#! /bin/dash']) {
    const repo = makeRepo();
    try {
      const hook = join(repo, '.git', 'hooks', 'post-commit');
      writeFileSync(hook, `${shebang}\necho existing\n`);
      assert.equal(wire.installGitHook(repo, CMD).installed, true, shebang);
      const text = readFileSync(hook, 'utf8');
      assert.ok(text.startsWith(`${shebang}\n# >>> openhuddle`), text);
      assert.equal(wire.wiringStatus(repo, { home }).git_hook, true);
    } finally {
      cleanup(repo);
    }
  }
});

test('wire: git hook skipped when hooks live in the work tree', () => {
  const repo = makeRepo();
  try {
    mkdirSync(join(repo, '.husky'));
    git(repo, 'config', 'core.hooksPath', '.husky');
    const res = wire.installGitHook(repo, CMD);
    assert.equal(res.installed, false);
    assert.ok(!existsSync(join(repo, '.husky', 'post-commit')));
  } finally {
    cleanup(repo);
  }
});

test('wire: command quoting with spaces', () => {
  const cmd = wire.appCommand('C:\\Users\\A B\\.openhuddle\\app\\bin\\openhuddle.js', { execPath: 'C:\\Program Files\\nodejs\\node.exe' });
  assert.equal(cmd, '"C:/Program Files/nodejs/node.exe" "C:/Users/A B/.openhuddle/app/bin/openhuddle.js"');
  assert.equal(wire.appCommand('/home/a/vc.js', { execPath: '/usr/bin/node' }), '"/usr/bin/node" "/home/a/vc.js"');
});

test('wire: installApp copies the package into OPENHUDDLE_HOME', () => {
  const bin = wire.installApp({ home });
  assert.ok(bin.replace(/\\/g, '/').endsWith('.openhuddle/app/bin/openhuddle.js'));
  assert.ok(bin.replace(/\\/g, '/').startsWith(home.replace(/\\/g, '/')));
  assert.ok(existsSync(bin));
  assert.ok(existsSync(join(home, '.openhuddle', 'app', 'src', 'client', 'wire.js')));
  assert.ok(existsSync(join(home, '.openhuddle', 'app', 'package.json')));
  // second install replaces cleanly
  assert.equal(wire.installApp({ home }), bin);
});

test('wire: wireAll + unwireAll in a temp repo with codex and cursor present', () => {
  const repo = makeRepo();
  try {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers.other]\ncommand = "x"\n');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    const tools = wire.detectTools({ home });
    assert.deepEqual(tools, { claude: false, codex: true, cursor: true });
    const lines = wire.wireAll(repo, { home, tools: { claude: true, codex: true, cursor: true } });
    assert.ok(lines.length >= 4);
    assert.ok(lines.some((l) => /claude mcp add/.test(l)), 'manual claude command shown when CLI disabled');
    const settings = JSON.parse(readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8'));
    assert.equal(ourCommands(settings).length, 5);
    assert.ok(readFileSync(join(home, '.codex', 'config.toml'), 'utf8').includes('[mcp_servers.openhuddle]'));
    const cursor = JSON.parse(readFileSync(join(repo, '.cursor', 'mcp.json'), 'utf8'));
    assert.deepEqual(cursor.mcpServers.openhuddle.args.slice(-3, -1), ['mcp', '--dir']);
    assert.ok(readFileSync(join(repo, '.git', 'hooks', 'post-commit'), 'utf8').includes('hook git-commit'));
    assert.equal(git(repo, 'status', '--porcelain'), '', 'nothing to commit after wiring');
    const status = wire.wiringStatus(repo, { home });
    assert.equal(status.claude_hooks, true);
    assert.equal(status.codex, true);
    assert.equal(status.git_hook, true);

    wire.unwireAll(repo, { home });
    assert.ok(!existsSync(join(repo, '.claude', 'settings.local.json')));
    const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    assert.ok(!toml.includes('openhuddle'));
    assert.ok(toml.includes('[mcp_servers.other]'));
    assert.ok(!existsSync(join(repo, '.cursor', 'mcp.json')));
    assert.ok(!existsSync(join(repo, '.git', 'hooks', 'post-commit')));
  } finally {
    cleanup(repo);
  }
});

test('wire: codex block stays while another project still uses openhuddle', () => {
  const a = makeRepo();
  const b = makeRepo();
  try {
    mkdirSync(join(home, '.codex'), { recursive: true });
    const tools = { claude: false, codex: true, cursor: false };
    wire.wireAll(a, { home, tools });
    wire.wireAll(b, { home, tools });
    wire.unwireAll(a, { home });
    assert.ok(readFileSync(join(home, '.codex', 'config.toml'), 'utf8').includes('[mcp_servers.openhuddle]'));
    wire.unwireAll(b, { home });
    assert.ok(!readFileSync(join(home, '.codex', 'config.toml'), 'utf8').includes('[mcp_servers.openhuddle]'));
  } finally {
    cleanup(a, b);
  }
});
