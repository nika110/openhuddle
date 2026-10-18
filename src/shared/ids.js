import { createHash, randomBytes } from 'node:crypto';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function newId(prefix, len = 10) {
  const bytes = randomBytes(len);
  let out = prefix;
  for (const b of bytes) out += BASE32[b & 31];
  return out;
}

export function newToken() {
  return 'vc_' + randomBytes(32).toString('base64url');
}

export function newSecret() {
  return randomBytes(16).toString('base64url');
}

export function sha256(s) {
  return createHash('sha256').update(String(s)).digest('hex');
}
