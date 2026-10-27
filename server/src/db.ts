import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshots (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id          TEXT NOT NULL,
  commit_sha       TEXT NOT NULL,
  repo_path        TEXT,
  source_mode      TEXT,
  schema_version   TEXT NOT NULL,
  analyzer_version TEXT,
  engine           TEXT,
  started_at       TEXT,
  finished_at      TEXT,
  loaded_at        TEXT NOT NULL,
  scope_json       TEXT NOT NULL,
  stats_json       TEXT NOT NULL,
  UNIQUE (repo_id, commit_sha, scope_json)
);
CREATE TABLE IF NOT EXISTS nodes (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  fqn         TEXT,
  signature   TEXT,
  module      TEXT,
  package     TEXT,
  file_path   TEXT,
  line_start  INTEGER,
  line_end    INTEGER,
  in_scope    INTEGER NOT NULL,
  attrs_json  TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, id)
);
CREATE TABLE IF NOT EXISTS edges (
  snapshot_id   INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  kind          TEXT NOT NULL,
  src           TEXT NOT NULL,
  dst           TEXT NOT NULL,
  resolution    TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  attrs_json    TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, id)
);
CREATE INDEX IF NOT EXISTS edges_by_src ON edges (snapshot_id, src, kind);
CREATE INDEX IF NOT EXISTS edges_by_dst ON edges (snapshot_id, dst, kind);
CREATE INDEX IF NOT EXISTS nodes_by_kind ON nodes (snapshot_id, kind);
CREATE INDEX IF NOT EXISTS nodes_by_file ON nodes (snapshot_id, file_path);
CREATE TABLE IF NOT EXISTS diagnostics (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  severity    TEXT NOT NULL,
  code        TEXT NOT NULL,
  message     TEXT NOT NULL,
  file_path   TEXT,
  line        INTEGER
);
CREATE INDEX IF NOT EXISTS diagnostics_by_code ON diagnostics (snapshot_id, code);
-- Published snapshot per repository and PENDING (loaded, not yet validated) snapshots; see snapshots.ts.
CREATE TABLE IF NOT EXISTS current_snapshots (
  repo_id      TEXT PRIMARY KEY,
  snapshot_id  INTEGER NOT NULL REFERENCES snapshots(id),
  published_at TEXT NOT NULL,
  published_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshot_state (
  snapshot_id INTEGER PRIMARY KEY REFERENCES snapshots(id) ON DELETE CASCADE,
  state       TEXT NOT NULL CHECK (state IN ('PENDING')),
  created_at  TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  snapshot_id UNINDEXED, node_id UNINDEXED, kind UNINDEXED, name, terms, file_path,
  tokenize = "unicode61 tokenchars '_'"
);
`;

export function openDb(file: string): DB {
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
