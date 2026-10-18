// Path helpers shared by client and hub. Claims always use repo-relative posix paths.

function slashes(p) {
  let s = String(p).replace(/\\/g, '/');
  // Git Bash style /c/Users/... -> c:/Users/...
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(s);
  if (m) s = `${m[1]}:/${m[2]}`;
  return s;
}

function isAbsolute(s) {
  return s.startsWith('/') || /^[a-zA-Z]:\//.test(s) || /^[a-zA-Z]:$/.test(s);
}

// Resolves `.` and `..`; returns null when the path climbs above its start.
function collapse(parts) {
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!out.length) return null;
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out;
}

export const MAX_PATH = 512;

// Cleans a path that must already be repo-relative. Rejects absolute paths, escapes and
// absurdly long paths.
export function cleanRelPath(p) {
  if (typeof p !== 'string' || !p.trim() || p.length > MAX_PATH) return null;
  const s = slashes(p.trim());
  if (isAbsolute(s)) return null;
  const parts = collapse(s.split('/'));
  if (!parts || !parts.length) return null;
  return parts.join('/');
}

// Turns an absolute or relative path into a path relative to `root`, or null if outside.
export function toRepoPath(p, root) {
  if (typeof p !== 'string' || !p.trim() || !root) return null;
  const s = slashes(p.trim());
  if (!isAbsolute(s)) return cleanRelPath(s);
  const r = slashes(root).replace(/\/+$/, '');
  const windows = /^[a-zA-Z]:/.test(s) || /^[a-zA-Z]:/.test(r);
  const sCmp = windows ? s.toLowerCase() : s;
  const rCmp = windows ? r.toLowerCase() : r;
  if (sCmp === rCmp) return null;
  if (!sCmp.startsWith(rCmp + '/')) return null;
  const rest = collapse(s.slice(r.length + 1).split('/'));
  if (!rest || !rest.length) return null;
  return rest.join('/');
}
