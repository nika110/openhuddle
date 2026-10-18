// Connects vibecrew to the AI tools on this machine. Every merge is idempotent and leaves
// other people's entries alone; unwiring removes only what we added.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, renameSync, chmodSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { excludeFromGit } from './config.js';
import { gitRoot, hooksDir, isTracked } from './git.js';

const PKG_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const EDIT_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';
// Shell tools can write files too; the pre-edit hook only calls the hub when a command looks like a write.
const GUARD_MATCHER = `${EDIT_MATCHER}|Bash|PowerShell`;
const HOOKS = [
  ['SessionStart', null, 'session-start'],
  ['UserPromptSubmit', null, 'prompt'],
  ['PreToolUse', GUARD_MATCHER, 'pre-edit'],
  ['PostToolUse', EDIT_MATCHER, 'post-edit'],
  ['Stop', null, 'stop'],
];
const GIT_BEGIN = '# >>> vibecrew (tells your crew about commits)';
const GIT_END = '# <<< vibecrew';

const fwd = (p) => String(p).replace(/\\/g, '/');
const samePath = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

export function vibecrewHome(home = homedir()) {
  return process.env.VIBECREW_HOME || join(home, '.vibecrew');
}

function codexDir(home) {
  if (home === homedir() && process.env.CODEX_HOME) return process.env.CODEX_HOME;
  return join(home, '.codex');
}

// Copies the running package to ~/.vibecrew/app so hooks and the MCP server keep working
// after npx cleans its cache. Returns the absolute path of the installed bin script.
export function installApp({ home = homedir() } = {}) {
  const dest = join(vibecrewHome(home), 'app');
  const bin = join(dest, 'bin', 'vibecrew.js');
  if (samePath(PKG_ROOT, dest)) return bin;
  const tmp = `${dest}.new-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (const part of ['bin', 'src', 'package.json']) cpSync(join(PKG_ROOT, part), join(tmp, part), { recursive: true });
  try {
    rmSync(dest, { recursive: true, force: true });
    renameSync(tmp, dest);
  } catch {
    // A file in the old copy is busy (Windows): overwrite in place instead.
    cpSync(tmp, dest, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
  return bin;
}

export function appCommand(appBin, { execPath = process.execPath } = {}) {
  return `"${fwd(execPath)}" "${fwd(appBin)}"`;
}

function mcpServer(appBin, { execPath = process.execPath, dir } = {}) {
  const args = [fwd(appBin), 'mcp'];
  if (dir) args.push('--dir', fwd(dir));
  return { command: fwd(execPath), args };
}

// ---- Claude Code settings (.claude/settings.local.json) ----

const isOurHook = (h) => typeof h?.command === 'string' && /vibecrew/i.test(h.command) && / hook /.test(h.command);

function stripOurHooks(hooks) {
  const out = {};
  for (const [event, groups] of Object.entries(hooks || {})) {
    if (!Array.isArray(groups)) {
      out[event] = groups;
      continue;
    }
    const kept = [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) {
        kept.push(g);
        continue;
      }
      const hs = g.hooks.filter((h) => !isOurHook(h));
      if (hs.length) kept.push({ ...g, hooks: hs });
    }
    if (kept.length) out[event] = kept;
  }
  return out;
}

export function mergeClaudeSettings(obj, cmd) {
  const base = obj && typeof obj === 'object' ? structuredClone(obj) : {};
  const hooks = stripOurHooks(base.hooks);
  for (const [event, matcher, name] of HOOKS) {
    const entry = [{ type: 'command', command: `${cmd} hook ${name}`, shell: 'bash', timeout: 10 }];
    hooks[event] = [...(hooks[event] || []), matcher ? { matcher, hooks: entry } : { hooks: entry }];
  }
  base.hooks = hooks;
  return base;
}

export function unmergeClaudeSettings(obj) {
  const base = obj && typeof obj === 'object' ? structuredClone(obj) : {};
  if (!base.hooks) return base;
  const hooks = stripOurHooks(base.hooks);
  if (Object.keys(hooks).length) base.hooks = hooks;
  else delete base.hooks;
  return base;
}

function claudeSettingsPath(root) {
  return join(root, '.claude', 'settings.local.json');
}

function readJson(file) {
  if (!existsSync(file)) return { ok: true, value: null };
  try {
    const text = readFileSync(file, 'utf8');
    return { ok: true, value: text.trim() ? JSON.parse(text) : {} };
  } catch {
    return { ok: false, value: null };
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

// ---- Claude Code MCP via its own CLI ----

function quoteArg(a) {
  return /^[A-Za-z0-9_\-./:=@]+$/.test(a) ? a : `"${String(a).replace(/"/g, '\\"')}"`;
}

function claudeCliAllowed(opt) {
  if (opt === false) return false;
  return process.env.VIBECREW_NO_CLAUDE_CLI !== '1';
}

function runClaude(args, cwd) {
  const win = process.platform === 'win32';
  const r = win
    ? spawnSync(['claude', ...args].map(quoteArg).join(' '), { cwd, shell: true, encoding: 'utf8', timeout: 30000, windowsHide: true })
    : spawnSync('claude', args, { cwd, encoding: 'utf8', timeout: 30000 });
  return r.status === 0;
}

function claudeMcpArgs(appBin, root, execPath) {
  const s = mcpServer(appBin, { execPath, dir: root });
  return ['mcp', 'add', '--scope', 'local', 'vibecrew', '--', s.command, ...s.args];
}

export function claudeMcpCommand(appBin, root, { execPath = process.execPath } = {}) {
  return ['claude', ...claudeMcpArgs(appBin, root, execPath)].map(quoteArg).join(' ');
}

// ---- Codex (~/.codex/config.toml) ----

const CODEX_HEADER = /^\s*\[\s*mcp_servers\s*\.\s*(?:vibecrew|"vibecrew")\s*(?:\.[^\]]*)?\]\s*(?:#.*)?$/;
const ANY_HEADER = /^\s*\[/;

function stripCodex(text) {
  const kept = [];
  let at = -1;
  let inBlock = false;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (CODEX_HEADER.test(line)) {
      inBlock = true;
      if (at === -1) at = kept.length;
      continue;
    }
    if (ANY_HEADER.test(line)) inBlock = false;
    if (!inBlock) kept.push(line);
  }
  return { kept, at };
}

function tidy(lines) {
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n*$/, '\n');
}

export function mergeCodexToml(text, { command, args }) {
  const { kept, at } = stripCodex(text);
  const block = ['[mcp_servers.vibecrew]', `command = ${JSON.stringify(command)}`, `args = ${JSON.stringify(args)}`, ''];
  if (at === -1) {
    while (kept.length && kept[kept.length - 1] === '') kept.pop();
    if (kept.length) kept.push('');
    kept.push(...block);
  } else {
    kept.splice(at, 0, ...block);
  }
  return tidy(kept);
}

export function unmergeCodexToml(text) {
  const { kept } = stripCodex(text);
  const out = tidy(kept);
  return out.trim() ? out : '';
}

// ---- Cursor (.cursor/mcp.json) ----

export function mergeCursorJson(obj, server) {
  const base = obj && typeof obj === 'object' ? structuredClone(obj) : {};
  base.mcpServers = { ...(base.mcpServers || {}), vibecrew: server };
  return base;
}

export function unmergeCursorJson(obj) {
  const base = obj && typeof obj === 'object' ? structuredClone(obj) : {};
  if (base.mcpServers) {
    delete base.mcpServers.vibecrew;
    if (!Object.keys(base.mcpServers).length) delete base.mcpServers;
  }
  return base;
}

// ---- git post-commit hook ----

function stripGitBlock(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let skip = false;
  for (const line of lines) {
    if (line.startsWith('# >>> vibecrew')) {
      skip = true;
      continue;
    }
    if (skip && line.startsWith(GIT_END)) {
      skip = false;
      continue;
    }
    if (!skip) out.push(line);
  }
  return out.join('\n');
}

function postCommitPath(root) {
  const dir = resolve(root, hooksDir(root));
  const rel = relative(resolve(root), dir);
  const r = fwd(rel);
  const inWorkTree = !!r && !r.startsWith('..') && !isAbsolute(rel) && r !== '.git' && !r.startsWith('.git/');
  return { file: join(dir, 'post-commit'), dir, inWorkTree };
}

export function installGitHook(root, cmd) {
  if (!gitRoot(root)) return { installed: false, reason: 'not a git repository, so commits are not shared' };
  const { file, dir, inWorkTree } = postCommitPath(root);
  if (inWorkTree) return { installed: false, reason: 'git hooks live inside the repo (core.hooksPath); not touching them' };
  const block = `${GIT_BEGIN}\n${cmd} hook git-commit >/dev/null 2>&1 &\n${GIT_END}`;
  let text;
  if (existsSync(file)) {
    const current = stripGitBlock(readFileSync(file, 'utf8'));
    const lines = current.split('\n');
    if (lines[0].startsWith('#!')) text = [lines[0], block, ...lines.slice(1)].join('\n');
    else text = [block, ...lines].join('\n');
  } else {
    text = `#!/bin/sh\n${block}\n`;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, text);
  try {
    chmodSync(file, 0o755);
  } catch {}
  return { installed: true, file };
}

export function removeGitHook(root) {
  if (!gitRoot(root)) return false;
  const { file } = postCommitPath(root);
  if (!existsSync(file)) return false;
  const current = readFileSync(file, 'utf8');
  if (!current.includes('# >>> vibecrew')) return false;
  const rest = stripGitBlock(current);
  if (!rest.replace(/^#!.*$/m, '').trim()) unlinkSync(file);
  else writeFileSync(file, rest);
  return true;
}

// ---- project registry (so a global Codex entry survives while any project uses it) ----

function registryFile(home) {
  return join(vibecrewHome(home), 'projects.json');
}

function readRegistry(home) {
  const r = readJson(registryFile(home));
  return Array.isArray(r.value) ? r.value : [];
}

function writeRegistry(home, list) {
  writeJson(registryFile(home), list);
}

// ---- detection, wiring, status ----

export function detectTools({ home = homedir() } = {}) {
  return {
    claude: existsSync(join(home, '.claude')) || existsSync(join(home, '.claude.json')),
    codex: existsSync(codexDir(home)),
    cursor: existsSync(join(home, '.cursor')),
  };
}

export function wireAll(root, { home = homedir(), tools, claudeCli, execPath = process.execPath } = {}) {
  const lines = [];
  const appBin = installApp({ home });
  const cmd = appCommand(appBin, { execPath });
  const t = tools || detectTools({ home });
  const none = !t.claude && !t.codex && !t.cursor;
  if (none) lines.push('No AI tool detected, so vibecrew is set up for Claude Code. Installed Codex or Cursor later? Run `npx vibecrew doctor --fix`.');

  if (t.claude || none) {
    const file = claudeSettingsPath(root);
    const cur = readJson(file);
    if (!cur.ok) {
      lines.push('Claude Code: .claude/settings.local.json is not valid JSON, so hooks were not added. Fix the file and run `npx vibecrew doctor --fix`.');
    } else {
      writeJson(file, mergeClaudeSettings(cur.value, cmd));
      excludeFromGit(root, '.claude/settings.local.json');
      lines.push('Claude Code: live crew news and edit guards (hooks in .claude/settings.local.json)');
    }
    if (claudeCliAllowed(claudeCli)) {
      runClaude(['mcp', 'remove', '--scope', 'local', 'vibecrew'], root);
      if (runClaude(claudeMcpArgs(appBin, root, execPath), root)) lines.push('Claude Code: crew tools added (MCP server "vibecrew")');
      else lines.push(`Claude Code: could not add the crew tools automatically. Run this once here:\n    ${claudeMcpCommand(appBin, root, { execPath })}`);
    } else {
      lines.push(`Claude Code: to add the crew tools, run this once here:\n    ${claudeMcpCommand(appBin, root, { execPath })}`);
    }
  }

  if (t.codex) {
    const dir = codexDir(home);
    const file = join(dir, 'config.toml');
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, mergeCodexToml(text, mcpServer(appBin, { execPath })));
    lines.push('Codex: crew tools added (MCP server in ~/.codex/config.toml)');
  }

  if (t.cursor) {
    const file = join(root, '.cursor', 'mcp.json');
    const cur = readJson(file);
    if (existsSync(file) && isTracked(root, '.cursor/mcp.json')) {
      lines.push('Cursor: .cursor/mcp.json is committed in this repo, so it was left alone. Add vibecrew in Cursor > Settings > MCP: ' +
        `command ${JSON.stringify(fwd(execPath))}, args ${JSON.stringify(mcpServer(appBin, { execPath, dir: root }).args)}`);
    } else if (!cur.ok) {
      lines.push('Cursor: .cursor/mcp.json is not valid JSON, so it was left alone.');
    } else {
      writeJson(file, mergeCursorJson(cur.value, mcpServer(appBin, { execPath, dir: root })));
      excludeFromGit(root, '.cursor/mcp.json');
      lines.push('Cursor: crew tools added (.cursor/mcp.json)');
    }
  }

  const gh = installGitHook(root, cmd);
  lines.push(gh.installed ? 'Git: commits are shared with the crew (post-commit hook)' : `Git: ${gh.reason}`);

  const reg = readRegistry(home).filter((p) => !samePath(p, root));
  reg.push(resolve(root));
  writeRegistry(home, reg);
  return lines;
}

export function unwireAll(root, { home = homedir(), claudeCli } = {}) {
  const lines = [];
  const file = claudeSettingsPath(root);
  const cur = readJson(file);
  if (cur.ok && cur.value) {
    const next = unmergeClaudeSettings(cur.value);
    if (Object.keys(next).length) writeJson(file, next);
    else rmSync(file, { force: true });
    lines.push('Claude Code: hooks removed');
  }
  if (claudeCliAllowed(claudeCli) && runClaude(['mcp', 'remove', '--scope', 'local', 'vibecrew'], root)) lines.push('Claude Code: crew tools removed');

  const reg = readRegistry(home).filter((p) => !samePath(p, root));
  writeRegistry(home, reg);
  const codexFile = join(codexDir(home), 'config.toml');
  if (!reg.length && existsSync(codexFile)) {
    const text = readFileSync(codexFile, 'utf8');
    if (text.split(/\r?\n/).some((l) => CODEX_HEADER.test(l))) {
      writeFileSync(codexFile, unmergeCodexToml(text));
      lines.push('Codex: crew tools removed');
    }
  }

  const cursorFile = join(root, '.cursor', 'mcp.json');
  const cj = readJson(cursorFile);
  if (cj.ok && cj.value && cj.value.mcpServers && cj.value.mcpServers.vibecrew) {
    const next = unmergeCursorJson(cj.value);
    if (Object.keys(next).length) writeJson(cursorFile, next);
    else rmSync(cursorFile, { force: true });
    lines.push('Cursor: crew tools removed');
  }

  if (removeGitHook(root)) lines.push('Git: post-commit hook removed');
  return lines;
}

export function wiringStatus(root, { home = homedir() } = {}) {
  const s = readJson(claudeSettingsPath(root));
  const claude_hooks = !!(s.ok && s.value && JSON.stringify(s.value.hooks || {}).includes(' hook prompt'));
  const codexFile = join(codexDir(home), 'config.toml');
  const codex = existsSync(codexFile) ? readFileSync(codexFile, 'utf8').split(/\r?\n/).some((l) => CODEX_HEADER.test(l)) : null;
  const cursorFile = join(root, '.cursor', 'mcp.json');
  const cj = readJson(cursorFile);
  const cursor = existsSync(cursorFile) ? !!(cj.value && cj.value.mcpServers && cj.value.mcpServers.vibecrew) : null;
  const { file } = postCommitPath(root);
  const git_hook = existsSync(file) && readFileSync(file, 'utf8').includes('# >>> vibecrew');
  const app = existsSync(join(vibecrewHome(home), 'app', 'bin', 'vibecrew.js'));
  return { claude_hooks, codex, cursor, git_hook, app };
}
