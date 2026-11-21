'use strict';
// Opens the SQLite database (Node's built-in node:sqlite) and makes sure every table exists.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const A = require('./agentlib');
const F = require('./attach');

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      title        TEXT NOT NULL,
      notes        TEXT NOT NULL DEFAULT '',
      due          TEXT,
      priority     TEXT NOT NULL DEFAULT 'normal',
      owner        TEXT NOT NULL DEFAULT 'me',
      status       TEXT NOT NULL DEFAULT 'open',
      created_by   TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      completed_at TEXT,
      archived_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE TABLE IF NOT EXISTS task_events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      actor   TEXT NOT NULL,
      action  TEXT NOT NULL,
      detail  TEXT,
      at      TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  A.initAgentSchema(db);
  F.initAttachments(db);
}

// file === ':memory:' gives a throwaway database (used by the live demo, one per visitor).
function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  // The busy timeout must be set BEFORE switching to WAL: on a first run the web app and the worker start
  // together, and the one that loses the race has to wait for the other instead of failing.
  db.exec('PRAGMA busy_timeout = 10000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  initSchema(db);
  if (file !== ':memory:') { try { fs.chmodSync(file, 0o600); } catch { /* best effort */ } }
  return db;
}

module.exports = { openDb, initSchema };
