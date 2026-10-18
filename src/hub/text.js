import { scrub } from '../shared/scrub.js';
import { LIMITS } from '../shared/protocol.js';
import { plainText } from '../shared/plain.js';

// Free text from clients: capped, terminal escapes and invisible characters removed (first,
// so they cannot split a key in two for the scrubber), secrets redacted, trimmed.
export function cleanText(value, max = LIMITS.text) {
  if (value == null) return '';
  let s = String(value);
  if (s.length > max) s = s.slice(0, max);
  return scrub(plainText(s)).trim();
}

// Short labels (names, branches, titles of sections): one line, no control characters.
export function cleanName(value, max = 40) {
  return plainText(String(value ?? ''), { newlines: false })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// Names of people and teams reach other people's agents, so they get a tight alphabet:
// letters (any script), digits, space and . _ ' - only.
export function safeName(value, max = 40) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N} ._'-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

export function parse(json, fallback) {
  if (json == null) return fallback;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}
