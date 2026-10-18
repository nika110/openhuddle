// Minimal globs for task areas: `**` crosses directories, `*` and `?` stay inside one.
// A glob without wildcards (or ending in `/`) names a file or a whole directory.
// Matching never uses regexes: globs come from other people, so a pattern like `*a*a*a*b`
// must not be able to stall the hub with backtracking. Cost is polynomial in the sizes.

function normalize(glob) {
  return String(glob ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
}

// `*` and `?` within one path segment, classic two-pointer wildcard match.
function matchSegment(pat, s) {
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    if (pi < pat.length && (pat[pi] === '?' || pat[pi] === s[si])) {
      pi++;
      si++;
    } else if (pi < pat.length && pat[pi] === '*') {
      star = pi++;
      mark = si;
    } else if (star !== -1) {
      pi = star + 1;
      si = ++mark;
    } else {
      return false;
    }
  }
  while (pi < pat.length && pat[pi] === '*') pi++;
  return pi === pat.length;
}

export function matchGlob(glob, path) {
  const g = normalize(glob);
  const p = String(path ?? '');
  if (!g || !p) return false;
  if (!/[*?]/.test(g)) {
    const base = g.replace(/\/+$/, '');
    return p === base || p.startsWith(base + '/');
  }
  const gs = g.replace(/\/+$/, g.endsWith('/') ? '/**' : '').split('/');
  const ps = p.split('/');
  // reach[j]: the glob segments seen so far match the first j path segments.
  let reach = new Array(ps.length + 1).fill(false);
  reach[0] = true;
  for (const seg of gs) {
    const next = new Array(ps.length + 1).fill(false);
    if (seg === '**') {
      let any = false;
      for (let j = 0; j <= ps.length; j++) {
        any = any || reach[j];
        next[j] = any;
      }
    } else {
      for (let j = 0; j < ps.length; j++) if (reach[j] && matchSegment(seg, ps[j])) next[j + 1] = true;
    }
    reach = next;
  }
  return reach[ps.length];
}

export function matchAny(globs, path) {
  if (!Array.isArray(globs) || !path) return false;
  return globs.some((g) => matchGlob(g, path));
}
