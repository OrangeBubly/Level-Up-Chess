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
},{
  id: 2, name: "recipes_achievements_buffs",
  up: `
  CREATE TABLE recipes_known(user_id INTEGER NOT NULL REFERENCES users(id), recipe TEXT NOT NULL, times INTEGER NOT NULL DEFAULT 1, at INTEGER NOT NULL, PRIMARY KEY(user_id, recipe));
  CREATE TABLE achievements(user_id INTEGER NOT NULL REFERENCES users(id), id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(user_id, id));
  CREATE TABLE buffs(user_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL, games_left INTEGER NOT NULL CHECK(games_left >= 0), PRIMARY KEY(user_id, kind));`,
},{
  id: 3, name: "quests",
  up: `
  -- a quest can be claimed once per period (for example d2026-10-23 or w2026-10-19); the primary key guarantees it
  CREATE TABLE quest_claims(user_id INTEGER NOT NULL REFERENCES users(id), period TEXT NOT NULL, quest TEXT NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY(user_id, period, quest));`,
},{
  id: 4, name: "merchant_and_themes",
  up: `
  -- how many of each Wandering Merchant offer a player bought that day; the daily limit is checked against qty
  CREATE TABLE merchant_buys(user_id INTEGER NOT NULL REFERENCES users(id), period TEXT NOT NULL, offer TEXT NOT NULL, qty INTEGER NOT NULL,
    PRIMARY KEY(user_id, period, offer));
  ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'dark';`,
},{
  id: 5, name: "friends_and_clans",
  up: `
  CREATE TABLE friend_requests(from_id INTEGER NOT NULL REFERENCES users(id), to_id INTEGER NOT NULL REFERENCES users(id), at INTEGER NOT NULL, PRIMARY KEY(from_id, to_id));
  CREATE INDEX friend_requests_to ON friend_requests(to_id);
  -- one row per direction, so "my friends" is a single lookup
  CREATE TABLE friends(user_id INTEGER NOT NULL REFERENCES users(id), friend_id INTEGER NOT NULL REFERENCES users(id), at INTEGER NOT NULL, PRIMARY KEY(user_id, friend_id));
  CREATE TABLE clans(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, tag TEXT NOT NULL UNIQUE COLLATE NOCASE,
    leader INTEGER NOT NULL REFERENCES users(id), open INTEGER NOT NULL DEFAULT 1, at INTEGER NOT NULL);
  -- user_id is the primary key, so a player can be in at most one clan
  CREATE TABLE clan_members(user_id INTEGER PRIMARY KEY REFERENCES users(id), clan_id INTEGER NOT NULL REFERENCES clans(id), joined_at INTEGER NOT NULL);
  CREATE INDEX clan_members_clan ON clan_members(clan_id);
  CREATE TABLE clan_requests(clan_id INTEGER NOT NULL REFERENCES clans(id), user_id INTEGER NOT NULL REFERENCES users(id), at INTEGER NOT NULL, PRIMARY KEY(clan_id, user_id));
  ALTER TABLE users ADD COLUMN privacy TEXT NOT NULL DEFAULT 'public';`,
},{
  id: 6, name: "admin_content",
  up: `
  -- items and recipes added or changed by admins on the website, as JSON, layered over the built-ins in content.js
  CREATE TABLE custom_items(id TEXT PRIMARY KEY, data TEXT NOT NULL, at INTEGER NOT NULL);
  CREATE TABLE custom_recipes(id TEXT PRIMARY KEY, data TEXT NOT NULL, at INTEGER NOT NULL);
  -- uploaded or painted textures (PNG) for items, materials and potions; at doubles as the cache-busting version
  CREATE TABLE art(id TEXT PRIMARY KEY, png BLOB NOT NULL, at INTEGER NOT NULL);`,
},{
  id: 7, name: "admin_content_more",
  up: `
  -- sets, achievements, quests and merchant offers added or changed by admins (kind = set, ach, quest or offer)
  CREATE TABLE custom_content(kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(kind, id));`,
},{
  id: 8, name: "item_locks",
  up: `
  -- a locked item can't be dismantled or used up in crafting
  ALTER TABLE items ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;`,
},{
  id: 9, name: "light_mode",
  up: `
  -- light or dark, separate from the colour theme so light mode works with every theme
  ALTER TABLE users ADD COLUMN mode TEXT NOT NULL DEFAULT 'dark';`,
},{
  id: 10, name: "game_reviews",
  up: `
  -- a player reviews each of their games at most once; xp is what that review paid (0 once the daily limit is reached).
  -- accuracy comes from the engine in the player's browser and is only shown back to them, never used for rewards.
  CREATE TABLE reviews(user_id INTEGER NOT NULL REFERENCES users(id), game_key TEXT NOT NULL REFERENCES games(key), xp INTEGER NOT NULL,
    accuracy REAL, at INTEGER NOT NULL, PRIMARY KEY(user_id, game_key));
  CREATE INDEX reviews_recent ON reviews(user_id, at);`,
},{
  id: 11, name: "game_openings",
  up: `
  -- the opening chess.com tagged each game with (filled in as games are synced), for the opening repertoire
  ALTER TABLE games ADD COLUMN eco TEXT;
  ALTER TABLE games ADD COLUMN opening TEXT;`,
},{
  id: 12, name: "site_tour",
  up: `
  -- the guided tour: 0 = not offered yet (new accounts get the welcome pop-up), 1 = finished and rewarded,
  -- 2 = no pop-up (said "maybe later", or the account is older than the tour). 2 can still take the tour for its reward.
  ALTER TABLE users ADD COLUMN tutorial INTEGER NOT NULL DEFAULT 2;`,
}];

function open(file) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL"); db.pragma("foreign_keys = ON"); db.pragma("busy_timeout = 5000");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(id INTEGER PRIMARY KEY, name TEXT NOT NULL, at INTEGER NOT NULL DEFAULT (strftime('%s','now')))");
  return db;
}

function migrate(db, { file, backupDir, upTo } = {}) {
  const done = new Set(db.prepare("SELECT id FROM schema_migrations").all().map(r => r.id));
  const todo = MIGRATIONS.filter(m => !done.has(m.id) && m.id <= (upTo || Infinity));
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
