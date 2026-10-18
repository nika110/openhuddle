import { scrub } from '../shared/scrub.js';
import { LIMITS } from '../shared/protocol.js';

// Free text from clients: capped, secrets redacted, trimmed.
export function cleanText(value, max = LIMITS.text) {
  if (value == null) return '';
  let s = String(value);
  if (s.length > max) s = s.slice(0, max);
  return scrub(s).trim();
}

// Short labels (names, branches, titles of sections): one line, no control characters.
export function cleanName(value, max = 40) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function parse(json, fallback) {
  if (json == null) return fallback;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}
