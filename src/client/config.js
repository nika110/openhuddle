// Per-project local state: .vibecrew/config.json (who you are on which hub) and
// .vibecrew/state.json (feed cursors, cached settings). Never committed.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';

export const DIR_NAME = '.vibecrew';

export function findProject(start) {
  let dir = resolve(process.env.VIBECREW_DIR || start || process.cwd());
  for (;;) {
    const file = join(dir, DIR_NAME, 'config.json');
    if (existsSync(file)) {
      try {
        const config = JSON.parse(readFileSync(file, 'utf8'));
        if (config && config.hub && config.token) return { root: dir, dir: join(dir, DIR_NAME), config };
      } catch {}
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function saveConfig(root, config) {
  const dir = join(root, DIR_NAME);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  excludeFromGit(root, `${DIR_NAME}/`);
  return { root, dir, config };
}

export function removeConfig(root) {
  rmSync(join(root, DIR_NAME), { recursive: true, force: true });
}

export function loadState(dir) {
  const defaults = { cursor: 0, urgent_cursor: 0 };
  try {
    const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    return st && typeof st === 'object' ? { ...defaults, ...st } : defaults;
  } catch {
    return defaults;
  }
}

export function saveState(dir, state) {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state) + '\n');
  } catch {}
}

// Adds a pattern to the repo's local exclude file (not .gitignore, so nothing to commit).
export function excludeFromGit(root, pattern) {
  let file;
  try {
    const p = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    file = isAbsolute(p) ? p : join(root, p);
  } catch {
    return false;
  }
  let current = '';
  try {
    current = readFileSync(file, 'utf8');
  } catch {}
  if (current.split(/\r?\n/).some((l) => l.trim() === pattern)) return true;
  mkdirSync(dirname(file), { recursive: true });
  const sep = current && !current.endsWith('\n') ? '\n' : '';
  appendFileSync(file, `${sep}${pattern}\n`);
  return true;
}
