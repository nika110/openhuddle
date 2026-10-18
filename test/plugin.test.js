// The repo doubles as a Claude Code plugin and its own marketplace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { HOOK_NAMES } from '../src/client/hooks.js';
import { EDIT_MATCHER, GUARD_MATCHER } from '../src/client/wire.js';

const root = new URL('../', import.meta.url);
const json = (p) => JSON.parse(readFileSync(new URL(p, root), 'utf8'));
const pkg = json('package.json');
const BIN = '${CLAUDE_PLUGIN_ROOT}/bin/openhuddle.js';

test('plugin: manifest names the package and matches its version', () => {
  const plugin = json('.claude-plugin/plugin.json');
  assert.equal(plugin.name, 'openhuddle');
  assert.equal(plugin.version, pkg.version);
  assert.match(plugin.description, /multiplayer/i);
  assert.equal(plugin.repository, 'https://github.com/nika110/openhuddle');
});

test('plugin: hooks mirror what the CLI wires into a project', () => {
  const { hooks } = json('.claude-plugin/plugin.json');
  const expected = {
    SessionStart: [null, 'session-start'],
    UserPromptSubmit: [null, 'prompt'],
    PreToolUse: [GUARD_MATCHER, 'pre-edit'],
    PostToolUse: [EDIT_MATCHER, 'post-edit'],
    Stop: [null, 'stop'],
  };
  assert.deepEqual(Object.keys(hooks).sort(), Object.keys(expected).sort());
  for (const [event, [matcher, name]] of Object.entries(expected)) {
    const [group] = hooks[event];
    assert.equal(group.matcher, matcher ?? undefined, `${event} matcher`);
    const command = group.hooks[0].command;
    assert.ok(command.includes(BIN), `${event} runs the plugin's own copy`);
    assert.ok(command.endsWith(` hook ${name}`), `${event} -> ${name}`);
    assert.ok(HOOK_NAMES.includes(name));
  }
});

test('plugin: MCP server runs the bundled CLI (inline, so the repo itself has no .mcp.json)', () => {
  const { mcpServers } = json('.claude-plugin/plugin.json');
  assert.equal(mcpServers.openhuddle.command, 'node');
  assert.deepEqual(mcpServers.openhuddle.args, [BIN, 'mcp']);
  assert.equal(existsSync(new URL('.mcp.json', root)), false);
});

test('plugin: the repo is its own marketplace', () => {
  const market = json('.claude-plugin/marketplace.json');
  assert.equal(market.name, 'openhuddle');
  assert.deepEqual(
    market.plugins.map((p) => [p.name, p.source]),
    [['openhuddle', './']],
  );
});

test('plugin: slash commands exist with descriptions and use the published CLI', () => {
  for (const name of ['create', 'join', 'status']) {
    const file = new URL(`commands/${name}.md`, root);
    assert.ok(existsSync(file), `commands/${name}.md`);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /^---\n[\s\S]*?description: .+\n[\s\S]*?---\n/, `${name} frontmatter`);
  }
  // The commands run the plugin's own copy: no download, no pre-approved shell access.
  for (const name of ['create', 'join']) {
    const text = readFileSync(new URL(`commands/${name}.md`, root), 'utf8');
    assert.ok(text.includes(`node "${BIN}" ${name} $ARGUMENTS`), `${name} runs the bundled CLI`);
    assert.ok(!/allowed-tools/.test(text), `${name} pre-approves nothing`);
    assert.ok(!/npx/.test(text.split('```')[1]), `${name} downloads nothing`);
  }
});

test('mcp registry: server.json matches package.json', () => {
  const server = json('server.json');
  assert.equal(server.name, pkg.mcpName);
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages[0].identifier, pkg.name);
  assert.equal(server.packages[0].version, pkg.version);
  assert.ok(server.description.length <= 100, `description is ${server.description.length} chars`);
});
