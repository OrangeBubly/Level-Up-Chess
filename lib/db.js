"use strict";
// Database connection + numbered migrations. Every schema change is a new entry in MIGRATIONS.
const Database = require("better-sqlite3"), fs = require("fs"), path = require("path");

const MIGRATIONS = [{
  id: 1, name: "foundation",
  up: `
  CREATE TABLE users(
    id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL,
    sv INTEGER NOT NULL DEFAULT 1,
    cc TEXT UNIQUE, cc_player_id INTEGER UNIQUE, cc_pending TEXT, cc_code TEXT, watermark INTEGER NOT NULL DEFAULT 0,
    xp INTEGER NOT NULL DEFAULT 0 CHECK(xp >= 0), streak INTEGER NOT NULL DEFAULT 0, best INTEGER NOT NULL DEFAULT 0,
    games INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')));
  CREATE INDEX users_xp ON users(xp DESC);
  -- coins, materials and consumables all live here; the CHECK makes negative balances impossible
  CREATE TABLE balances(user_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL,
    qty INTEGER NOT NULL DEFAULT 0 CHECK(qty >= 0), PRIMARY KEY(user_id, kind));
  -- append-only audit trail of every balance or item change
  CREATE TABLE ledger(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, delta INTEGER NOT NULL,
    reason TEXT NOT NULL, ref TEXT, at INTEGER NOT NULL);
  CREATE INDEX ledger_user ON ledger(user_id, id);
  -- one row per item the player owns
  CREATE TABLE items(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), def TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 1, at INTEGER NOT NULL DEFAULT (strftime('%s','now')));
  CREATE INDEX items_user ON items(user_id);
  CREATE TABLE equipment(user_id INTEGER NOT NULL REFERENCES users(id), slot TEXT NOT NULL,
    item_id INTEGER NOT NULL UNIQUE REFERENCES items(id), PRIMARY KEY(user_id, slot));
  -- every Chess.com game we have seen, stored once and shared by all players
  CREATE TABLE games(key TEXT PRIMARY KEY, end_time INTEGER NOT NULL, rules TEXT, rated INTEGER NOT NULL, tclass TEXT,
    plies INTEGER NOT NULL, w_user TEXT, w_rating INTEGER, w_result TEXT, b_user TEXT, b_rating INTEGER, b_result TEXT);
  CREATE INDEX games_w ON games(w_user, end_time);
  CREATE INDEX games_b ON games(b_user, end_time);
  -- a player can claim a game at most once; the primary key is what guarantees it
  CREATE TABLE claims(user_id INTEGER NOT NULL REFERENCES users(id), game_key TEXT NOT NULL REFERENCES games(key),
    xp INTEGER NOT NULL, coins INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(user_id, game_key));
  CREATE INDEX claims_recent ON claims(user_id, at);`,
}];

function open(file) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL"); db.pragma("foreign_keys = ON"); db.pragma("busy_timeout = 5000");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(id INTEGER PRIMARY KEY, name TEXT NOT NULL, at INTEGER NOT NULL DEFAULT (strftime('%s','now')))");
  return db;
}

function migrate(db, { file, backupDir } = {}) {
  const done = new Set(db.prepare("SELECT id FROM schema_migrations").all().map(r => r.id));
  const todo = MIGRATIONS.filter(m => !done.has(m.id));
  const hasUsers = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (!done.size && hasUsers) throw new Error("This database predates the v2 rebuild. Set DB_FILE to a NEW file name (for example levelup-v2.db) so the old data is left untouched.");
  if (!todo.length) return [];
  if (done.size && file && backupDir) { // safety copy before changing a database that already has data
    fs.mkdirSync(backupDir, { recursive: true });
    const dest = path.join(backupDir, `pre-migration-${Date.now()}.db`);
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  }
  for (const m of todo) db.transaction(() => {
    db.exec(m.up); db.prepare("INSERT INTO schema_migrations(id, name) VALUES(?, ?)").run(m.id, m.name);
  }).immediate();
  return todo.map(m => m.id);
}
module.exports = { open, migrate, MIGRATIONS };
