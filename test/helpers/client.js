// Test helpers for client tests: temp git repos and temp homes. Never touches the real home.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export function tempDir(prefix = 'vc-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// A fresh git repo with one commit. Returns its absolute path.
export function makeRepo({ origin, commit = true } = {}) {
  const dir = tempDir('vc-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  if (origin) git(dir, 'remote', 'add', 'origin', origin);
  if (commit) {
    writeFileSync(join(dir, 'README.md'), '# test\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'initial commit');
  }
  return dir;
}

// A temp home with OPENHUDDLE_HOME inside it; sets process.env for in-process code.
export function makeHome() {
  const home = tempDir('vc-home-');
  mkdirSync(join(home, '.openhuddle'), { recursive: true });
  return home;
}

export function cleanup(...dirs) {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
}

// Env for child processes so nothing reaches the real user config.
export function safeEnv(home, extra = {}) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    OPENHUDDLE_HOME: join(home, '.openhuddle'),
    OPENHUDDLE_NO_CLAUDE_CLI: '1',
    ...extra,
  };
}
