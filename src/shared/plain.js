// Text written by one person's agent ends up in other people's terminals and agents. These
// helpers remove what a terminal would obey instead of show: whole escape sequences (ANSI
// colours and cursor moves, title and clipboard commands), the remaining C0 and C1 control
// characters (carriage-return overwrites, bells), the Unicode direction overrides that make
// text read differently from how it is stored, and the invisible characters that can carry
// text an agent reads but a person never sees. Every pattern is linear in the text's length.

// OSC (ESC ] ... BEL | ESC \), CSI (ESC [ params final), charset and other nF sequences
// (ESC intermediates final), other two-byte ESC sequences (never across a newline), and the
// single-byte C1 forms of OSC (0x9d ... ST) and CSI (0x9b).
const ESCAPES =
  /\u001b\][^\u0007\u001b\u009c\n]*(?:\u0007|\u001b\\|\u009c)?|\u009d[^\u0007\u009c\n]*(?:\u0007|\u009c)?|\u001b\[[0-?]*[ -/]*[@-~]?|\u009b[0-?]*[ -/]*[@-~]?|\u001b[ -/]+[0-~]?|\u001b[^\n]?/g;
// \t and \n are kept (unless newlines: false); everything else from C0, DEL and C1 goes.
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
const CONTROLS_AND_NEWLINES = /[\u0000-\u001F\u007F-\u009F]/g;
// Direction embeddings, overrides and isolates (the "Trojan Source" characters). The plain
// direction marks (LRM, RLM, ALM) stay: right-to-left text needs them and they reorder nothing.
const BIDI = /[‪-‮⁦-⁩]/g;
// Soft hyphen, zero-width space and non-joiner, word joiner and the other invisible format
// characters, BOM, and the tag characters. The zero-width joiner and variation selectors stay
// (emoji need them).
const INVISIBLE = /[­​‌⁠-⁤⁪-⁯﻿\u{E0000}-\u{E007F}]/gu;

export function plainText(value, { newlines = true } = {}) {
  if (typeof value !== 'string') return value;
  return value
    .replace(ESCAPES, '')
    .replace(/\r\n?/g, newlines ? '\n' : ' ')
    .replace(newlines ? CONTROLS : CONTROLS_AND_NEWLINES, '')
    .replace(BIDI, '')
    .replace(INVISIBLE, '');
}

// The same for everything inside a JSON value from the hub (objects and arrays are walked,
// numbers and booleans pass through). Keys are left alone, except that a "__proto__" key is
// dropped so the result keeps the shape of plain data. Anything nested absurdly deep is cut.
export function plainJson(value, depth = 0) {
  if (typeof value === 'string') return plainText(value);
  if (!value || typeof value !== 'object') return value;
  if (depth > 32) return null;
  if (Array.isArray(value)) return value.map((v) => plainJson(v, depth + 1));
  const out = {};
  for (const k of Object.keys(value)) if (k !== '__proto__') out[k] = plainJson(value[k], depth + 1);
  return out;
}
