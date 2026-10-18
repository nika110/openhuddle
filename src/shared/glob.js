// Minimal globs for task areas: `**` crosses directories, `*` and `?` stay inside one.
// A glob without wildcards (or ending in `/`) names a file or a whole directory.
const cache = new Map();

export function globToRegExp(glob) {
  const g = String(glob).replace(/\\/g, '/').replace(/^\.\//, '');
  if (cache.has(g)) return cache.get(g);
  let re;
  if (!/[*?]/.test(g)) {
    const base = escape(g.replace(/\/+$/, ''));
    re = new RegExp(`^${base}(?:/.*)?$`);
  } else {
    let src = '';
    for (let i = 0; i < g.length; i++) {
      const c = g[i];
      if (c === '*' && g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          src += '(?:.*/)?';
          i += 2;
        } else {
          src += '.*';
          i += 1;
        }
      } else if (c === '*') {
        src += '[^/]*';
      } else if (c === '?') {
        src += '[^/]';
      } else {
        src += escape(c);
      }
    }
    if (g.endsWith('/')) src += '.*';
    re = new RegExp(`^${src}$`);
  }
  cache.set(g, re);
  return re;
}

export function matchAny(globs, path) {
  if (!Array.isArray(globs) || !path) return false;
  return globs.some((g) => globToRegExp(g).test(path));
}

function escape(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}
