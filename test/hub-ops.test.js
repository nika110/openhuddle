import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, SCHEMA_VERSION } from '../src/hub/db.js';
import { Hub } from '../src/hub/hub.js';
import { makeHub, crew } from './helpers/hubcore.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'oh-ops-'));

test('db: a new database is stamped with the schema version', () => {
  const db = openDb(':memory:');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
});

test('db: a database from 0.1.0 (no version stamp) upgrades in place and keeps its data', () => {
  const dir = tmp();
  try {
    const file = join(dir, 'hub.db');
    const first = openDb(file);
    first.exec('PRAGMA user_version = 0');
    const hub = new Hub(first);
    const { token } = hub.createTeam({ team_name: 'old', member_name: 'ana' });
    first.close();

    const again = openDb(file);
    assert.equal(again.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(new Hub(again).auth(token).name, 'ana');
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('db: refuses a database written by a newer hub', () => {
  const dir = tmp();
  try {
    const file = join(dir, 'hub.db');
    const raw = new DatabaseSync(file);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    assert.throws(() => openDb(file), /newer version of OpenHuddle/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backup: writes a dated copy and keeps only the newest 7', () => {
  const dir = tmp();
  try {
    const { hub, clock } = makeHub();
    crew(hub, ['ana']);
    for (let i = 0; i < 9; i++) writeFileSync(join(dir, `hub-2026-01-0${i + 1}.db`), 'old');
    const file = hub.backup(dir);
    assert.match(file, /hub-2026-10-18\.db$/);
    const kept = readdirSync(dir).filter((f) => f.startsWith('hub-')).sort();
    assert.equal(kept.length, 7);
    assert.equal(kept.at(-1), 'hub-2026-10-18.db');
    const copy = new DatabaseSync(file);
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM teams').get().n, 1);
    copy.close();
    void clock;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retention: sweep deletes teams nobody touched for 90 days, keeps active ones', () => {
  const { hub, clock } = makeHub();
  const stale = crew(hub, ['ana', 'ben']);
  hub.plan(stale.auth(0), { tasks: [{ title: 'x' }] });
  clock.advance(60 * 24 * 3600_000);
  const active = crew(hub, ['cy']);
  clock.advance(31 * 24 * 3600_000);
  hub.auth(active.tokens[0]);
  hub.sweep();
  assert.throws(() => hub.auth(stale.tokens[0]));
  assert.equal(hub.get('SELECT COUNT(*) AS n FROM tasks').n, 0, 'their data goes too');
  assert.equal(hub.get('SELECT COUNT(*) AS n FROM events WHERE team_id = ?', stale.created.team_id).n, 0);
  assert.equal(hub.auth(active.tokens[0]).name, 'cy');
});

test('retention: 0 days turns it off', () => {
  const { hub, clock } = makeHub();
  hub.retentionDays = 0;
  const old = crew(hub, ['ana']);
  clock.advance(400 * 24 * 3600_000);
  hub.sweep();
  assert.equal(hub.auth(old.tokens[0]).name, 'ana');
});

test('server: backs up on start when a backup dir is set, and passes retention through', async () => {
  const { startHub } = await import('../src/hub/server.js');
  const dir = tmp();
  try {
    const started = await startHub({ port: 0, host: '127.0.0.1', backupDir: dir, retentionDays: 0, log: () => {} });
    try {
      assert.equal(readdirSync(dir).filter((f) => /^hub-.*\.db$/.test(f)).length, 1);
      assert.equal(started.hub.retentionDays, 0);
    } finally {
      await started.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('state reports the hub version so clients can notice updates', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana']);
  assert.match(hub.state(auth(0)).hub_version, /^\d+\.\d+\.\d+/);
});
