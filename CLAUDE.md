# Level Up Chess: briefing for Claude Code

A website that turns a player's rated chess.com games into XP, loot, crafting and a leaderboard (a chess RPG).
Node 22+ (`better-sqlite3` 13 needs it), Express 5, SQLite (`better-sqlite3`), one static frontend file with no build step. It is live on Render.

## Commands
- `npm install`, then `npm start` (http://localhost:3000)
- `npm test` runs the automated tests (`node --test`, no network). **Run it before every commit.**
- Local testing without the real chess.com: set `CHESSCOM_API` to a fake server. Never set it in production (the server refuses to start).

## Where things live
- `server.js`: routes, sessions, rate limits, error handling. Keep it thin.
- `lib/core.js`: **the only place that changes balances, items, XP, claims, buffs and achievements.** Every change runs in one `BEGIN IMMEDIATE` transaction through `tx`/`mut`.
- `lib/rules.js`: pure reward and stat rules (no database, no network).
- `lib/content.js`: all game content as data: items, sets, recipes, potions, achievements.
- `lib/db.js`: numbered migrations. `lib/chesscom.js`: serial, cached chess.com client.
- `public/index.html`: the whole frontend (generated pixel art, synthesized sounds, all screens).
- `public/vendor/`: third-party files served as-is (Stockfish WASM under GPL-3.0, chess.js under BSD-2, the Lichess opening book under CC0); see its README. Keep the licence files with them. `tools/build-openings.js` rebuilds the opening book.
- `test/core.test.js`: the test suite.

## Rules that must not be broken
1. **Never reset, delete or rewrite production player data.** Schema changes are a NEW entry at the end of `MIGRATIONS` in `lib/db.js` (additive first). Never edit an old migration. The app backs up the database before applying a migration to existing data. The only exception: a player's own request, through `resetProgress`/`deleteAccount` in `lib/core.js` (password and typed confirmation required). Keep their `claims` on a reset so old games can't pay out twice.
2. **All balance and item changes go through `grant`/`spend`/`giveItem` in `lib/core.js`**, which write the `ledger`. Never `UPDATE balances` directly elsewhere. The ledger must always add up to the balances (a test checks this).
3. **The server decides rewards.** The browser only sends ids and intent, never amounts or game results.
4. **A player can claim a game once** (`claims` primary key). Rated, standard chess only. Keep the anti-farming limits in `lib/rules.js`.
5. **Fair play and no pay-to-win.** Equipment bonuses change website rewards only, never chess.com games. No paid loot boxes: resource chests are only earned by winning rated games (and admin testing), never sold for coins or money. Cosmetic-only monetization would need checking with Chess.com first (legal@chess.com).
6. **Be polite to the chess.com API:** one request at a time, use ETag caching, keep the contact email in the User-Agent. Don't copy chess.com's artwork or sounds, and don't use Minecraft's assets.
7. Every recipe needs a **unique pattern** and every material must stay consumable by a repeatable potion recipe (tests enforce both).
8. **Security habits** (from a penetration test): look up anything a player sends only in `table()` dictionaries from `lib/content.js` (or check with `Object.hasOwn`), so ids like `constructor` match nothing. New accounts start at a random session version (`freshSv`), because SQLite can reuse a deleted account's id. Admin usernames can never be signed up for. New usernames, clan names and clan tags go through `isOffensive()` in `lib/rules.js` (add words to its STRONG or SHORT lists). Keep the protective headers in `server.js` and the time limit on chess.com requests.

## Adding content
- The owner adds and edits items, recipes, textures, sets, achievements, quests, merchant offers, materials and chests from the **Admin tab** on the live site (no code needed). Those live in the `custom_items`, `custom_recipes`, `art` and `custom_content` tables and are layered over the built-ins by `applyCustom()` in `lib/content.js`. Don't overwrite them from code. Items players own are retired, never deleted.
- New built-in item (in code): add a row to `ROWS` in `lib/content.js`. The sprite is generated from slot, rarity and glyph. Items with price 0 need a recipe.
- New recipe, potion or achievement: add it in `lib/content.js` and extend the tests. Hidden recipes' patterns are only sent to the player after they are discovered.
- New feature that needs data: add a migration, put logic in `lib/core.js`, add routes in `server.js`, add tests, then the UI.

## Deployment (Render)
- Pushing to GitHub redeploys the site. Test locally and commit on a branch first.
- Environment variable names: `DB_FILE` (on the Render disk, e.g. `/var/data/levelup-v2.db`), `SESSION_SECRET`, `NODE_ENV=production`, `CONTACT_EMAIL`, `ADMIN_USERS` (optional; usernames with the admin testing tools). Never print or commit their values. `*.db`, `backups/` and `.secret` are git-ignored.
- Admin tools: only for `ADMIN_USERS`, checked in `server.js` on every call, and only on the admin's own account. Never add a way to grant admin from the website or to use admin tools on other players.
- Run a single instance only (the rate limiter is in memory and the database is one file).

## Working style
- The owner is new to programming: explain git and deployment steps in plain words and ask before anything destructive.
- Make small commits with clear messages. Do not rewrite working systems without a strong reason.

## Roadmap
Built: daily and weekly quests, the Wandering Merchant (rotating daily shop), merchant-only items, themes, a Profile page, sign-up that proves a chess.com account before the account exists, public profiles, friends and clans, resource chests, game review (Stockfish in the browser, XP for fully reviewing your own games, book moves and an opening repertoire), automatic syncing while the site is open, and admin database backups.
Not built yet: limited trading, community bosses, events. Details were planned in an earlier audit; keep each new system on the claim, ledger and migration foundations above.
