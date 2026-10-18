// Per-project local state: .openhuddle/config.json (who you are on which hub) and
// .openhuddle/state.json (feed cursors, cached settings). Never committed.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, appendFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const DIR_NAME = '.openhuddle';
const STATE_FILE = 'state.json';
const MACHINE_FILE = 'machine';
const SHOWN_MAX = 200;
const NUDGED_MAX = 200;

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function openhuddleHome(home = homedir()) {
  return process.env.OPENHUDDLE_HOME ? resolve(process.env.OPENHUDDLE_HOME) : join(home, '.openhuddle');
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

// A random id made once per machine (~/.openhuddle/machine). Every config.json written here
// carries it, and only a config that carries it is trusted: a .openhuddle/config.json that
// arrived inside a cloned repository or an archive must not be able to point this machine's
// hooks and agent at a stranger's hub.
let machineCache = null;
export function machineId({ create = false } = {}) {
  const file = join(openhuddleHome(), MACHINE_FILE);
  if (machineCache && machineCache.file === file) return machineCache.id;
  let id = null;
  try {
    const text = readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{32}$/.test(text)) id = text;
  } catch {}
  if (!id && create) {
    id = randomBytes(16).toString('hex');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${id}\n`, { mode: 0o600 });
  }
  if (id) machineCache = { file, id };
  return id;
}

// Whether git tracks anything at .openhuddle in `root` (a file, a submodule or a symlink, in
// any letter case, since the file system may not care about case while git does).
// 'tracked' | 'untracked' (a repo that tracks nothing there) | 'unknown' (no repo, no git).
export function gitTracking(root) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', `:(icase)${DIR_NAME}`], { cwd: root, stdio: 'ignore', timeout: 5000, windowsHide: true });
    return 'tracked';
  } catch (err) {
    return err?.status === 1 ? 'untracked' : 'unknown';
  }
}

// Why a config found on disk is, or is not, one this machine made. Only 'machine' is trusted.
//  - 'machine': stamped by OpenHuddle 0.4.1+ on this machine.
//  - 'other_machine': stamped elsewhere, or with something that is not this machine's id.
//  - 'committed': unstamped and git tracks it, so it came with the repository.
//  - 'legacy': unstamped, inside a git repo that does not track it (probably written by an
//    older OpenHuddle here; `doctor --fix` stamps it after the user says it is theirs).
//  - 'unverified': unstamped, outside any git repo.
export function configTrust(root, config) {
  if ('machine' in config) {
    const mine = machineId();
    return typeof config.machine === 'string' && mine && config.machine === mine ? 'machine' : 'other_machine';
  }
  const tracking = gitTracking(root);
  if (tracking === 'tracked') return 'committed';
  return tracking === 'untracked' ? 'legacy' : 'unverified';
}

export function trusted(reason) {
  return reason === 'machine';
}

function readConfigAt(dir) {
  const file = join(dir, DIR_NAME, 'config.json');
  if (!existsSync(file)) return undefined;
  try {
    const config = JSON.parse(readFileSync(file, 'utf8'));
    if (config && typeof config === 'object' && !Array.isArray(config) && config.hub && config.token) return config;
  } catch {}
  return null;
}

// The nearest trusted .openhuddle/config.json at or above `start`; failing that, the nearest
// one of any kind (so the CLI can say why it is ignored); null when there is none.
export function findConfig(start) {
  let dir = resolve(process.env.OPENHUDDLE_DIR || start || process.cwd());
  let untrusted = null;
  for (;;) {
    const config = readConfigAt(dir);
    if (config) {
      const found = { root: dir, dir: join(dir, DIR_NAME), config, trust: configTrust(dir, config) };
      if (trusted(found.trust)) return found;
      untrusted ??= found;
    }
    const parent = dirname(dir);
    if (parent === dir) return untrusted;
    dir = parent;
  }
}

// The project this folder belongs to, or null. A config this machine did not make is ignored
// as if it were not there, so hooks and the MCP server stay inert in a stranger's repository.
export function findProject(start) {
  const found = findConfig(start);
  if (!found || !trusted(found.trust)) return null;
  const { trust, ...project } = found;
  return project;
}

export function saveConfig(root, config) {
  const dir = join(root, DIR_NAME);
  mkdirSync(dir, { recursive: true });
  const stamped = { ...config, machine: machineId({ create: true }) };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(stamped, null, 2) + '\n', { mode: 0o600 });
  // Keeps the token out of git even if the folder only becomes a repo later.
  writeFileSync(join(dir, '.gitignore'), '*\n');
  excludeFromGit(root, `${DIR_NAME}/`);
  return { root, dir, config: stamped };
}

export function removeConfig(root) {
  rmSync(join(root, DIR_NAME), { recursive: true, force: true });
}

// Reads .openhuddle/state.json. Hooks run in parallel, so a read can land while another hook
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
// if it is further along. Personal preferences (auto_respond) are only changed by a caller that
// says so ({ prefs: true }); everyone else keeps what is on disk, so a hook holding an old copy
// cannot undo a setting changed meanwhile.
export function saveState(dir, state, { prefs = false } = {}) {
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
    const nudged = new Set([...(Array.isArray(onDisk.nudged) ? onDisk.nudged : []), ...(Array.isArray(next.nudged) ? next.nudged : [])]);
    if (nudged.size) next.nudged = [...nudged].slice(-NUDGED_MAX);
    if (!prefs) {
      if (onDisk.auto_respond !== undefined) next.auto_respond = onDisk.auto_respond;
      else delete next.auto_respond;
    }
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
