// Per-project local state: .vibecrew/config.json (who you are on which hub) and
// .vibecrew/state.json (feed cursors, cached settings). Never committed.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, appendFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const DIR_NAME = '.vibecrew';
const STATE_FILE = 'state.json';
const SHOWN_MAX = 200;

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The personal dashboard link, built only from local config. Hub responses never feed it, and
// anything that is not a plain http(s) hub, team id or token is refused.
export function dashboardUrl(config) {
  if (!config) return null;
  let u;
  try {
    u = new URL(String(config.hub));
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return null;
  const team = String(config.team_id ?? '');
  const token = String(config.token ?? '');
  if (!/^t[a-z2-7]+$/.test(team) || !/^vc_[A-Za-z0-9_-]+$/.test(token)) return null;
  const base = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  return `${base}/t/${team}#k=${token}`;
}

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
  // Keeps the token out of git even if the folder only becomes a repo later.
  writeFileSync(join(dir, '.gitignore'), '*\n');
  excludeFromGit(root, `${DIR_NAME}/`);
  return { root, dir, config };
}

export function removeConfig(root) {
  rmSync(join(root, DIR_NAME), { recursive: true, force: true });
}

// Reads .vibecrew/state.json. Hooks run in parallel, so a read can land while another hook
// replaces the file: transient failures are retried. A file that never existed comes back
// as { fresh: true }; one that stays unreadable as { unreadable: true }. Callers must not
// replay history from cursor 0 in either case.
export function loadState(dir) {
  const file = join(dir, STATE_FILE);
  let missing = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT' && ++missing >= 2) return { cursor: 0, urgent_cursor: 0, fresh: true };
      pause(5 + attempt * 5);
      continue;
    }
    try {
      const st = JSON.parse(text);
      if (st && typeof st === 'object' && !Array.isArray(st)) return { cursor: 0, urgent_cursor: 0, ...st };
    } catch {}
    pause(5 + attempt * 5);
  }
  return { cursor: 0, urgent_cursor: 0, unreadable: true };
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) break;
      pause(5 + attempt * 10);
    }
  }
  try {
    writeFileSync(file, text);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

// Saves state without ever moving a cursor backwards: whatever another hook already saved wins
// if it is further along.
export function saveState(dir, state) {
  try {
    mkdirSync(dir, { recursive: true });
    const disk = loadState(dir);
    const { fresh, unreadable, ...next } = state || {};
    const onDisk = disk.fresh || disk.unreadable ? { cursor: 0, urgent_cursor: 0 } : disk;
    next.cursor = Math.max(Number(next.cursor) || 0, Number(onDisk.cursor) || 0);
    next.urgent_cursor = Math.max(Number(next.urgent_cursor) || 0, Number(onDisk.urgent_cursor) || 0);
    const shown = new Set([...(Array.isArray(onDisk.shown) ? onDisk.shown : []), ...(Array.isArray(next.shown) ? next.shown : [])]);
    next.shown = [...shown].filter((id) => Number(id) > next.cursor).slice(-SHOWN_MAX);
    if (next.settings === undefined && onDisk.settings) next.settings = onDisk.settings;
    writeAtomic(join(dir, STATE_FILE), JSON.stringify(next) + '\n');
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
