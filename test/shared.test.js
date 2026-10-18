import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrub } from '../src/shared/scrub.js';
import { globToRegExp, matchAny } from '../src/shared/glob.js';
import { toRepoPath, cleanRelPath } from '../src/shared/paths.js';
import { newId, newToken, newSecret, sha256 } from '../src/shared/ids.js';

test('scrub: redacts sk-, ghp_, github_pat_, AKIA, xox, AIza, JWT, PEM private key, vc_ token', () => {
  const samples = [
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123',
    'AKIAABCDEFGHIJKLMNOP',
    'xoxb-1234567890-abcdefghij',
    'AIzaSyA1234567890abcdefghijklmnopqrstuv',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
    'vc_' + 'a'.repeat(43),
  ];
  for (const s of samples) {
    const out = scrub(`before ${s} after`);
    assert.ok(!out.includes(s), `not redacted: ${s}`);
    assert.match(out, /^before \[redacted\] after$/);
  }
});

test('scrub: key=value keeps the key name', () => {
  assert.equal(scrub('API_KEY=abcd1234efgh'), 'API_KEY=[redacted]');
  assert.equal(scrub('password: "hunter2hunter2"'), 'password: "[redacted]"');
});

test('scrub: leaves normal prose alone', () => {
  const prose = 'I finished the login API, the token check now uses JWT. Next: payments.';
  assert.equal(scrub(prose), prose);
});

test('glob: ** crosses dirs, * does not', () => {
  assert.ok(globToRegExp('src/**/*.ts').test('src/a/b.ts'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/b.ts'));
  assert.ok(!globToRegExp('src/*.ts').test('src/a/b.ts'));
  assert.ok(globToRegExp('src/*.ts').test('src/b.ts'));
  assert.ok(globToRegExp('src/?.ts').test('src/b.ts'));
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
