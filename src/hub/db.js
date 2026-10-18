// node:sqlite still prints an ExperimentalWarning on some Node versions; keep the hub log clean.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  if (type === 'ExperimentalWarning' && String(warning).includes('SQLite')) return;
  return emitWarning.call(process, warning, ...rest);
};
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = emitWarning;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_url TEXT,
  settings TEXT NOT NULL,
  invite_secret TEXT NOT NULL,
  invite_expires_at INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  next_task INTEGER NOT NULL DEFAULT 1,
  next_ask INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  tool TEXT,
  strengths TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT,
  last_seen INTEGER,
  joined_at INTEGER NOT NULL,
  removed_at INTEGER
);
CREATE INDEX IF NOT EXISTS members_team ON members(team_id);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL,
  member_id TEXT,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_team ON events(team_id, id);
CREATE TABLE IF NOT EXISTS prompt_versions (
  team_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  sections TEXT NOT NULL,
  author_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, version)
);
CREATE TABLE IF NOT EXISTS tasks (
  team_id TEXT NOT NULL,
  key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  area TEXT NOT NULL DEFAULT '[]',
  depends_on TEXT NOT NULL DEFAULT '[]',
  acceptance TEXT,
  status TEXT NOT NULL,
  assignee_id TEXT,
  proposed_id TEXT,
  branch TEXT,
  note TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, key)
);
CREATE TABLE IF NOT EXISTS claims (
  team_id TEXT NOT NULL,
  path TEXT NOT NULL,
  member_id TEXT NOT NULL,
  task_key TEXT,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, path)
);
CREATE TABLE IF NOT EXISTS asks (
  team_id TEXT NOT NULL,
  id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER,
  PRIMARY KEY (team_id, id)
);
`;

// Schema changes are appended here, never edited: entry N upgrades a database from N-1 to N.
// Version 1 is the 0.1.0 schema; databases from 0.1.0 carry no stamp (0) and upgrade in place.
const MIGRATIONS = [null, SCHEMA];
export const SCHEMA_VERSION = MIGRATIONS.length - 1;

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current > SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `This database was written by a newer version of OpenHuddle (schema ${current}, this hub knows ${SCHEMA_VERSION}). Upgrade the hub instead of downgrading.`,
    );
  }
  for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      db.close();
      throw err;
    }
  }
  return db;
}
