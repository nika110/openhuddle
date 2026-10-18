// Redacts things that look like credentials before text leaves the machine or gets stored.
const R = '[redacted]';

const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bvc_[A-Za-z0-9_-]{40,}/g,
];

const KEY_VALUE = /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|passw(?:or)?d|token|auth)[A-Za-z0-9_]*)(\s*[:=]\s*)(['"]?)([^\s'"]{8,})\3/gi;

export function scrub(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, R);
  out = out.replace(KEY_VALUE, (_, key, sep, q) => `${key}${sep}${q}${R}${q}`);
  return out;
}
