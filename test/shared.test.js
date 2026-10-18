import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrub } from '../src/shared/scrub.js';
import { matchGlob, matchAny } from '../src/shared/glob.js';
import { toRepoPath, cleanRelPath } from '../src/shared/paths.js';
import { newId, newToken, newSecret, sha256 } from '../src/shared/ids.js';

// Fake credentials are assembled at run time, so no file in the repo contains a key-shaped
// string (secret scanners would rightly flag one).
const k = (...parts) => parts.join('');

test('scrub: redacts sk-, ghp_, github_pat_, AKIA, xox, AIza, JWT, PEM private key, vc_ token', () => {
  const samples = [
    k('sk', '-ant-api03-', 'x'.repeat(30)),
    k('gh', 'p_', 'x'.repeat(36)),
    k('github', '_pat_', '11', 'X'.repeat(40)),
    k('AK', 'IA', 'ABCDEFGHIJKLMNOP'),
    k('xo', 'xb-', '1234567890-abcdefghij'),
    k('AI', 'za', 'S'.repeat(35)),
    k('ey', 'J', 'x'.repeat(16), '.', 'ey', 'J', 'y'.repeat(16), '.', 'z'.repeat(16)),
    k('-----BEGIN RSA ', 'PRIVATE KEY-----\nMIIEow\n-----END RSA ', 'PRIVATE KEY-----'),
    k('vc', '_', 'a'.repeat(43)),
  ];
  for (const s of samples) {
    const out = scrub(`before ${s} after`);
    assert.ok(!out.includes(s), `not redacted: ${s}`);
    assert.match(out, /^before \[redacted\] after$/);
  }
});

test('scrub: key=value keeps the key name', () => {
  assert.equal(scrub(k('API', '_KEY=', 'abcd1234efgh')), 'API_KEY=[redacted]');
  assert.equal(scrub(k('pass', 'word: "', 'hunter2hunter2', '"')), 'password: "[redacted]"');
});

test('scrub: leaves normal prose alone', () => {
  const prose = 'I finished the login API, the token check now uses JWT. Next: payments.';
  assert.equal(scrub(prose), prose);
});

test('glob: ** crosses dirs, * does not', () => {
  assert.ok(matchGlob('src/**/*.ts', 'src/a/b.ts'));
  assert.ok(matchGlob('src/**/*.ts', 'src/b.ts'));
  assert.ok(!matchGlob('src/*.ts', 'src/a/b.ts'));
  assert.ok(matchGlob('src/*.ts', 'src/b.ts'));
  assert.ok(matchGlob('src/?.ts', 'src/b.ts'));
});

test('glob: pathological patterns stay fast (no regex backtracking)', () => {
  const started = Date.now();
  assert.equal(matchGlob('*a*a*a*a*a*a*a*a*a*a*a*a*b', 'a'.repeat(400)), false);
  assert.equal(matchGlob('**/**/**/**/**/**/x', 'a/'.repeat(200) + 'y'), false);
  assert.ok(Date.now() - started < 200, `took ${Date.now() - started}ms`);
  assert.ok(matchGlob('**', 'any/thing.ts'));
  assert.ok(matchGlob('src/**', 'src'));
  assert.ok(matchGlob('src/*/', 'src/a/b/c.ts'));
  assert.ok(matchGlob('*.test.js', 'a.test.js'));
  assert.ok(!matchGlob('*.test.js', 'dir/a.test.js'));
});

test('paths: very long paths are rejected', () => {
  assert.equal(cleanRelPath('a/'.repeat(300) + 'b'), null);
  assert.equal(cleanRelPath('x'.repeat(513)), null);
  assert.equal(cleanRelPath('x'.repeat(512)), 'x'.repeat(512));
});

test('glob: bare dir matches children', () => {
  assert.ok(matchAny(['src/auth'], 'src/auth/x.ts'));
  assert.ok(matchAny(['src/auth/'], 'src/auth/deep/x.ts'));
  assert.ok(matchAny(['src/auth'], 'src/auth'));
  assert.ok(!matchAny(['src/auth'], 'src/authz/x.ts'));
  assert.ok(!matchAny([], 'src/x.ts'));
});

test('paths: windows absolute path', () => {
  assert.equal(toRepoPath('C:\\Users\\A B\\proj\\src\\x.ts', 'c:/Users/A B/proj'), 'src/x.ts');
  assert.equal(toRepoPath('/c/Users/A B/proj/src/x.ts', 'C:\\Users\\A B\\proj'), 'src/x.ts');
  assert.equal(toRepoPath('/home/a/proj/src/x.ts', '/home/a/proj/'), 'src/x.ts');
  assert.equal(toRepoPath('src\\x.ts', '/home/a/proj'), 'src/x.ts');
});

test('paths: outside root is null', () => {
  assert.equal(toRepoPath('/home/a/other/x.ts', '/home/a/proj'), null);
  assert.equal(toRepoPath('/home/a/project2/x.ts', '/home/a/proj'), null);
  assert.equal(toRepoPath('../x.ts', '/home/a/proj'), null);
  assert.equal(cleanRelPath('/etc/passwd'), null);
  assert.equal(cleanRelPath('a/../../b'), null);
  assert.equal(cleanRelPath('./a//b/./c'), 'a/b/c');
});

test('ids: formats', () => {
  assert.match(newId('t'), /^t[a-z2-7]{10}$/);
  assert.match(newToken(), /^vc_[A-Za-z0-9_-]{43}$/);
  assert.match(newSecret(), /^[A-Za-z0-9_-]{22}$/);
  assert.equal(sha256('x').length, 64);
});
