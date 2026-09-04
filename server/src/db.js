"use strict";
/* SQLite storage. Node 22.5+ ships a SQLite driver, so the server needs no
   third-party packages at all. One database file holds every workspace; every
   query is scoped by workspace_id. */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { config } = require("./config");

/* Connection settings. These cannot run inside a transaction, so they are
   applied when the database is opened rather than as part of a migration. */
const PRAGMAS = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS server_meta (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

/* Staff. Credentials never leave this table. */
CREATE TABLE IF NOT EXISTS users (
  workspace_id TEXT NOT NULL,
  id           TEXT NOT NULL,
  name         TEXT NOT NULL,
  name_lc      TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'salesman',
  perms        TEXT NOT NULL DEFAULT '[]',
  branch       TEXT NOT NULL DEFAULT '',
  active       INTEGER NOT NULL DEFAULT 1,
  pin_hash     TEXT,
  pin_salt     TEXT,
  extra        TEXT NOT NULL DEFAULT '{}',
  version      INTEGER NOT NULL DEFAULT 1,
  deleted      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS users_name_unique
  ON users (workspace_id, name_lc) WHERE deleted = 0;

/* Every other business record, stored in the shape the app reads back. */
CREATE TABLE IF NOT EXISTS records (
  workspace_id TEXT NOT NULL,
  field        TEXT NOT NULL,
  id           TEXT NOT NULL,
  json         TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  deleted      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, field, id)
);
CREATE INDEX IF NOT EXISTS records_by_field
  ON records (workspace_id, field, deleted);

/* Workspace-wide singletons: settings and the document-number counters. */
CREATE TABLE IF NOT EXISTS kv (
  workspace_id TEXT NOT NULL,
  key          TEXT NOT NULL,
  json         TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  device_label TEXT NOT NULL DEFAULT '',
  platform     TEXT NOT NULL DEFAULT '',
  issued_at    TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS refresh_by_hash ON refresh_tokens (token_hash);

/* Replay protection for POST /v1/client/operations. */
CREATE TABLE IF NOT EXISTS idempotency (
  workspace_id TEXT NOT NULL,
  key          TEXT NOT NULL,
  response     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
);

/* Traceability for stock movements the app asks us to record. */
CREATE TABLE IF NOT EXISTS stock_ledger (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  branch_id    TEXT NOT NULL DEFAULT '',
  product_id   TEXT NOT NULL DEFAULT '',
  delta        REAL NOT NULL DEFAULT 0,
  reason       TEXT NOT NULL DEFAULT '',
  by_user      TEXT NOT NULL DEFAULT '',
  at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS stock_by_product
  ON stock_ledger (workspace_id, product_id);

/* Failed sign-in attempts, for lockout. */
CREATE TABLE IF NOT EXISTS login_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scope        TEXT NOT NULL,
  at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS login_attempts_scope ON login_attempts (scope, at);
`;

/* Schema changes, in order, applied once each.

   SQLite records which have run in `user_version`, so a database that already
   holds a year of invoices gets upgraded in place rather than needing to be
   rebuilt. To change the schema later, append an entry — never edit or reorder
   an existing one, because the databases in the field have already run it.

   Adding a column:
     `ALTER TABLE records ADD COLUMN locked INTEGER NOT NULL DEFAULT 0`
   Back the file up first (see the README) and the change is reversible. */
const MIGRATIONS = [
  // 1 — the starting schema.
  SCHEMA,

  // 2 — which branches a person may work in. Empty means all of them, which is
  // how the app reads it too, so existing staff keep the access they had.
  `ALTER TABLE users ADD COLUMN branches TEXT NOT NULL DEFAULT '[]';`,
];

function migrate(d) {
  const current = d.prepare("PRAGMA user_version").get().user_version;
  if (current >= MIGRATIONS.length) return;

  for (let version = current; version < MIGRATIONS.length; version += 1) {
    d.exec("BEGIN IMMEDIATE");
    try {
      d.exec(MIGRATIONS[version]);
      // PRAGMA will not take a bound parameter, and this is a loop counter.
      d.exec("PRAGMA user_version = " + (version + 1));
      d.exec("COMMIT");
      if (current > 0) console.log("Applied database migration " + (version + 1));
    } catch (err) {
      try { d.exec("ROLLBACK"); } catch (_) { /* already unwound */ }
      throw new Error("Database migration " + (version + 1) + " failed: " + err.message);
    }
  }
}

let db = null;

function open() {
  if (db) return db;
  const dir = path.dirname(config.dbFile);
  fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(config.dbFile);
  db.exec(PRAGMAS);
  migrate(db);
  return db;
}

/* Read a server-level setting, creating it from `make` the first time. */
function meta(key, make) {
  const d = open();
  const row = d.prepare("SELECT value FROM server_meta WHERE key = ?").get(key);
  if (row) return row.value;
  const value = make();
  d.prepare("INSERT INTO server_meta (key, value) VALUES (?, ?)").run(key, value);
  return value;
}

/* The access-token signing key. Supplied by the environment in production;
   otherwise generated once and kept so restarts do not sign out every device. */
function jwtSecret() {
  if (config.jwtSecret) return config.jwtSecret;
  return meta("jwt_secret", () => crypto.randomBytes(48).toString("base64url"));
}

/* Run `fn` inside a transaction, rolling back if it throws. */
function transaction(fn) {
  const d = open();
  d.exec("BEGIN IMMEDIATE");
  try {
    const out = fn(d);
    d.exec("COMMIT");
    return out;
  } catch (err) {
    try { d.exec("ROLLBACK"); } catch (_) { /* already unwound */ }
    throw err;
  }
}

module.exports = { open, transaction, meta, jwtSecret };
