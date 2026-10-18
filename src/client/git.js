// Small read-only git helpers. All of them return null instead of throwing.
import { execFileSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';

function run(cwd, args, timeout = 5000) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout,
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

export function gitRoot(cwd = process.cwd()) {
  const top = run(cwd, ['rev-parse', '--show-toplevel']);
  return top ? resolve(top) : null;
}

export function currentBranch(root) {
  return run(root, ['symbolic-ref', '--short', '-q', 'HEAD']) || run(root, ['rev-parse', '--short', 'HEAD']);
}

export function gitInfo(root) {
  const branch = currentBranch(root);
  const log = run(root, ['log', '-1', '--format=%h%x00%s']);
  let last_commit = null;
  if (log) {
    const [sha, message] = log.split('\0');
    last_commit = { sha, message: message || '' };
  }
  return { branch: branch || null, last_commit };
}

// The commit that was just made, for the post-commit hook.
export function lastCommit(root) {
  const out = run(root, ['log', '-1', '--name-only', '--format=%h%x00%s']);
  if (!out) return null;
  const [head, ...files] = out.split(/\r?\n/);
  const [sha, message] = head.split('\0');
  return { sha, message: message || '', branch: currentBranch(root), files: files.filter(Boolean).slice(0, 50) };
}

export function stripCredentials(url) {
  if (!url) return null;
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, '$1');
}

export function originUrl(root) {
  return stripCredentials(run(root, ['remote', 'get-url', 'origin']));
}

export function hooksDir(root) {
  const p = run(root, ['rev-parse', '--git-path', 'hooks']);
  if (!p) return join(root, '.git', 'hooks');
  return isAbsolute(p) ? p : join(root, p);
}

export function gitUserName(cwd = process.cwd()) {
  return run(cwd, ['config', 'user.name']);
}

export function isTracked(root, relPath) {
  return run(root, ['ls-files', '--error-unmatch', relPath]) !== null;
}

// Only plain network remotes are cloned automatically (no local paths, no ext:: transports).
export function isCloneableUrl(url) {
  return typeof url === 'string' && /^(https?:\/\/|ssh:\/\/|git@[\w.-]+:)[^\s]+$/i.test(url);
}

export function clone(url, dest, cwd) {
  if (!isCloneableUrl(url)) throw new Error(`refusing to clone ${url}`);
  execFileSync('git', ['clone', '--', url, dest], { cwd, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
}
