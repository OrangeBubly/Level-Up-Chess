# Level Up Chess (v2)

Turn chess.com games into XP, loot and glory. Accounts, verified chess.com linking, server-side rewards,
a Minecraft-style inventory and 3x3 crafting table with hidden pattern recipes, achievements that unlock
recipe hints, potions that give every material a use, generated pixel art, synthesized sounds, and a leaderboard.

## Run it
    npm install
    CONTACT_EMAIL=you@example.com npm start     # http://localhost:3000
    npm test                                    # 18 automated tests, no network needed

## Environment variables
| Name | Purpose |
|---|---|
| `DB_FILE` | SQLite file. **Use a new name for v2** (e.g. `/var/data/levelup-v2.db`); the app refuses to open a pre-v2 database. |
| `SESSION_SECRET` | Long random string that signs login cookies. |
| `NODE_ENV=production` | Secure cookies, and trusts one proxy hop (Render). |
| `CONTACT_EMAIL` | Sent to chess.com in the User-Agent, as they request. |
| `TRUST_PROXY` | Optional override for the number of proxy hops. |
| `BACKUP_DIR` | Optional. Pre-migration backups go here (default: `backups/` next to the database). |

## Layout
- `server.js`: HTTP routes, sessions, error handling, logging.
- `lib/core.js`: the only code that changes balances, items and XP (one transaction per action).
- `lib/rules.js`: pure reward and stat rules.  `lib/content.js`: items, sets, recipes as data.
- `lib/db.js`: numbered migrations (`schema_migrations`).  `lib/chesscom.js`: serial, cached chess.com client.
- `test/`: automated tests.  `public/index.html`: the frontend.

## How rewards stay fair
- Chess.com games are stored once; each player can claim a game once (database primary key).
- Rated standard chess only; at least 8 half-moves; max 6 rewarded games per opponent per 24 h;
  XP drops to 25% after 600 XP in 24 h. The underdog bonus uses your rating *before* the game.
- First sync sets a baseline, so earlier games never pay out. Every fresh game is eventually processed.
- Item bonuses (with caps) change website rewards only, never chess.com games.

## Materials, recipes and achievements
- Every rewarded game drops Iron Shards (win 3, draw 2, loss 1). Every 3rd win also drops Ember Essence and every 10th win a
  Relic Fragment. Drops pause once the daily soft cap is reached. Dismantling gear also returns materials.
- Recipes are patterns on a 3x3 table (the shape matters, the position does not). They are hidden until crafted once.
  Achievements unlock hints for the harder recipes. Gear recipes also use up spare gear; fees are paid in coins.
- Potions (Streak Shield, XP Tonic, Fortune Draught, Underdog Brew, Relic Catalyst) can be crafted again and again, so extra
  materials always have a use. A test checks that every material is consumed by at least one potion recipe.

## Adding content
Items, recipes, potions and achievements are rows in `lib/content.js`. A new recipe needs a unique pattern (a test enforces this)
and a new item needs a row in `ROWS`. The sprite is generated automatically from the item's slot, rarity and glyph.

## Your own art and sounds
Drop PNGs into `public/assets/items/` and MP3s into `public/assets/sfx/`, then list them in `public/assets/manifest.json`
(see `public/assets/README.txt`). Anything listed replaces the generated art or synthesized sound. Check licenses first, and never use
Minecraft's or Chess.com's own assets.

## Changing the database later
Add a new entry to `MIGRATIONS` in `lib/db.js`. Before applying a migration to a database that has data,
the app writes a backup copy to `BACKUP_DIR`.
