"use strict";
// All game content lives here as data. Adding an item = adding one row (no other code changes).
const RARITY = ["Common", "Uncommon", "Rare", "Epic", "Legendary", "Mythic"];
const SLOTS = [["weapon", "Weapon"], ["armor", "Armor"], ["helmet", "Helmet"], ["boots", "Boots"], ["ring", "Ring"], ["amulet", "Amulet"], ["aura", "Aura"], ["title", "Banner"]];
const MATS = { shard: "Iron Shards", essence: "Ember Essence", relic: "Relic Fragments" };
const NAMES = { coins: "coins", shield: "Streak Shields", ...MATS };
const MAX_LEVEL = 5, WELCOME_COINS = 150;
const CAPS = { xp: 75, coin: 75, upset: 100, streak: 40 };       // total bonus caps (percent)
const P = "\u2659\uFE0E".replace("\u2659", "\u265F");              // text-style pawn glyph
// [id, name, slot, rarity 0-5, shop price (0 = craft only), stats, glyph, flavor, set]
const ROWS = [
  ["w1", "Pawn Pike", "weapon", 0, 100, { xp: 3 }, P, "A humble start. Every legend carries one."],
  ["w2", "Knight's Lance", "weapon", 1, 260, { upset: 10 }, "♞", "Charges at anything rated higher.", "cavalry"],
  ["w3", "Bishop's Blade", "weapon", 2, 0, { upset: 16, xp: 3 }, "♝", "Cuts diagonally through the favorites."],
  ["w4", "Queen's Edge", "weapon", 4, 0, { xp: 8, upset: 20 }, "♛", "She never loses a tempo."],
  ["a1", "Pawn Wall Mail", "armor", 0, 110, { streak: 2 }, P, "Stronger together."],
  ["a2", "Rook Plate", "armor", 1, 280, { streak: 4 }, "♜", "Holds the line.", "fortress"],
  ["a3", "Castle Aegis", "armor", 3, 0, { streak: 6, xp: 4 }, "♜", "Castled in lava.", "fortress"],
  ["h1", "Iron Visor", "helmet", 0, 90, { coin: 3 }, "♚", "Keeps your eyes on the board."],
  ["h2", "Knight's Helm", "helmet", 1, 250, { coin: 5, upset: 5 }, "♞", "Horse not included.", "cavalry"],
  ["h3", "Crown of Tempo", "helmet", 4, 0, { xp: 10, coin: 6 }, "♛", "Always one move ahead."],
  ["b1", "Pawn Stompers", "boots", 0, 90, { coin: 3 }, P, "One square at a time."],
  ["b2", "Forking Greaves", "boots", 1, 240, { upset: 6, streak: 2 }, "♞", "Two targets, one step.", "cavalry"],
  ["b3", "Zugzwang Treads", "boots", 3, 0, { streak: 5, coin: 5 }, "♜", "Every move hurts them.", "fortress"],
  ["r1", "Tempo Ring", "ring", 1, 220, { xp: 4 }, "◎", "Worn by players who never hang pieces."],
  ["r2", "Signet of the Fork", "ring", 2, 0, { upset: 14 }, "◎", "Stamps a double attack."],
  ["r3", "Ring of Endgames", "ring", 5, 0, { xp: 12, coin: 10, streak: 6 }, "◎", "Forged from a thousand won endings."],
  ["m1", "Fianchetto Charm", "amulet", 1, 230, { coin: 6 }, "✦", "The long diagonal pays well."],
  ["m2", "Zwischenzug Amulet", "amulet", 3, 0, { xp: 7, upset: 10 }, "✦", "The in-between move nobody saw."],
  ["m3", "Heart of the Grandmaster", "amulet", 5, 0, { xp: 14, coin: 12, upset: 12 }, "❖", "Still beats 1500s on a bad day."],
  ["x1", "Ember Aura", "aura", 1, 300, { xp: 2 }, "🔥", "Victories burst into flames."],
  ["x2", "Blood Moon Aura", "aura", 4, 0, { xp: 5, coin: 6 }, "🌑", "Rises when you win."],
  ["t1", "Tactician", "title", 0, 100, {}, "✦", "A banner for your profile."],
  ["t2", "Blunder Survivor", "title", 0, 100, {}, "✦", "Lost the queen. Won the game."],
  ["t3", "Endgame Wizard", "title", 1, 200, {}, "✦", "Turns a pawn up into a trophy."],
  // crafted
  ["b4", "Long Castle Sabatons", "boots", 4, 0, { streak: 7, coin: 6 }, "♜", "They step two squares and never look back."],
  ["a4", "Endgame Bastion", "armor", 4, 0, { streak: 8, xp: 5 }, "♜", "Nothing gets through in the final phase.", "fortress"],
  ["x3", "Aurora Aura", "aura", 3, 0, { xp: 4, coin: 4 }, "✧", "The northern lights follow every brilliancy."],
  // sold only by the Wandering Merchant (see MERCHANT_ITEMS)
  ["w5", "Gambit Dagger", "weapon", 3, 0, { upset: 12, coin: 4 }, "♝", "Give a pawn, take the game.", null, { merchant: 1 }],
  ["w6", "Opening Book", "weapon", 2, 0, { xp: 5 }, "♚", "Memorized to move twenty.", null, { merchant: 1 }],
  ["a5", "Wanderer's Cloak", "armor", 2, 0, { coin: 4, streak: 3 }, "♞", "Smells of rain and distant tournaments.", "wanderer", { merchant: 1 }],
  ["h4", "Merchant's Monocle", "helmet", 2, 0, { coin: 7 }, "♚", "Spots a bargain at forty paces.", "wanderer", { merchant: 1 }],
  ["b5", "Traveler's Boots", "boots", 2, 0, { coin: 5, xp: 2 }, "♞", "Worn thin by a thousand away games.", "wanderer", { merchant: 1 }],
  ["r4", "Ring of Many Roads", "ring", 3, 0, { xp: 5, coin: 5 }, "◎", "Every road leads to the endgame.", null, { merchant: 1 }],
  ["m4", "Compass Amulet", "amulet", 2, 0, { xp: 4, coin: 3 }, "✦", "Always points toward the enemy king.", "wanderer", { merchant: 1 }],
  ["x4", "Lantern Aura", "aura", 3, 0, { xp: 4, streak: 3 }, "✧", "A small light for long games.", null, { merchant: 1 }],
  ["t4", "Wayfarer", "title", 1, 0, {}, "✦", "Seen the world, one board at a time.", null, { merchant: 1 }],
  ["t5", "Bargain Hunter", "title", 1, 0, {}, "✦", "Never paid full price for anything.", null, { merchant: 1 }],
];
const SETS = {
  cavalry: { name: "Cavalry", bonus: { 2: { upset: 8 }, 3: { upset: 15, xp: 5 } } },
  fortress: { name: "Fortress", bonus: { 2: { streak: 4 }, 3: { streak: 8, coin: 5 } } },
  wanderer: { name: "Wanderer", bonus: { 2: { coin: 5 }, 3: { coin: 8, xp: 3 }, 4: { coin: 12, xp: 5 } } },
};
const ITEMS = ROWS.map(([id, name, slot, r, price, stats, g, f, set, o]) => ({ id, name, slot, r, price, stats, g, f, set: set || null, merchant: !!(o && o.merchant) }));
const ITEM = Object.fromEntries(ITEMS.map(i => [i.id, i]));
const SHIELD = { id: "shield", name: "Streak Shield", price: 80, g: "🛡", f: "Your next loss won’t break your streak." };

const DISMANTLE = [{ shard: 3 }, { shard: 6 }, { shard: 12, essence: 1 }, { shard: 25, essence: 4 }, { essence: 12, relic: 1 }, { essence: 30, relic: 4 }];
const upgradeCost = (d, L) => L >= MAX_LEVEL ? null : { coins: 40 * L * (d.r + 1), shard: 3 * L * (d.r + 1) };
const dismantleYield = (d, L) => Object.fromEntries(Object.entries(DISMANTLE[d.r]).map(([k, v]) => [k, v * L]));

// Consumables: crafted from materials, so every material always has somewhere to go. Activated ones add a short buff.
const CONS = {
  shield: { name: "Streak Shield", desc: "Used automatically: your next loss won’t break your streak." },
  tonic: { name: "XP Tonic", desc: "Drink for +30% XP on your next 5 rewarded games.", games: 5, stats: { xp: 30 } },
  draught: { name: "Fortune Draught", desc: "Drink for +40% coins on your next 5 rewarded games.", games: 5, stats: { coin: 40 } },
  brew: { name: "Underdog Brew", desc: "Drink for +50% underdog bonus on your next 3 rewarded games.", games: 3, stats: { upset: 50 } },
  catalyst: { name: "Relic Catalyst", desc: "Activate for +25% XP and coins on your next 10 rewarded games.", games: 10, stats: { xp: 25, coin: 25 } },
};
const MAX_BUFF_GAMES = 30;
Object.assign(NAMES, Object.fromEntries(Object.entries(CONS).map(([k, c]) => [k, c.name + "s"])));

// Crafting patterns. rows: 3 columns max, "." = empty cell. key: letter -> material kind or item id.
// Every filled material cell costs `mult` of that material; item cells use up one spare item; `fee` is coins.
// hintAch: the achievement that unlocks this recipe's hint (null = hint is free).
const RECIPES = [
  { id: "w3", out: ["item", "w3"], rows: [".S.", ".E.", ".S."], key: { S: "shard", E: "essence" }, mult: 3, fee: 250, hint: "A blade is a line: shards at both ends, a spark of essence between.", hintAch: null },
  { id: "r2", out: ["item", "r2"], rows: ["S.S", ".E."], key: { S: "shard", E: "essence" }, mult: 3, fee: 250, hint: "Two shards that split apart, meeting on a single point of essence.", hintAch: null },
  { id: "a3", out: ["item", "a3"], rows: ["SSS", "ESE", "S.S"], key: { S: "shard", E: "essence" }, mult: 4, fee: 600, hint: "A fortress of shards, with essence guarding both gates.", hintAch: "streak5" },
  { id: "b3", out: ["item", "b3"], rows: ["E.E", "S.S", "S.S"], key: { S: "shard", E: "essence" }, mult: 4, fee: 600, hint: "Boots take two steps: essence at the ankles, shards below.", hintAch: "lvl5" },
  { id: "m2", out: ["item", "m2"], rows: [".E.", "ESE", ".E."], key: { S: "shard", E: "essence" }, mult: 3, fee: 600, hint: "Essence on every side of a single shard, like a compass.", hintAch: "games100" },
  { id: "w4", out: ["item", "w4"], rows: [".E.", "EBE", ".R."], key: { E: "essence", R: "relic", B: "w3" }, mult: 6, fee: 1500, hint: "A Bishop’s Blade wrapped in essence, with one relic at the point.", hintAch: "fullgear" },
  { id: "h3", out: ["item", "h3"], rows: ["R.R", "EBE"], key: { E: "essence", R: "relic", B: "h2" }, mult: 5, fee: 1500, hint: "A Knight’s Helm between two essences, crowned by two relics.", hintAch: "lvl10" },
  { id: "x2", out: ["item", "x2"], rows: [".R.", "RER", ".R."], key: { E: "essence", R: "relic" }, mult: 4, fee: 1500, hint: "Four relics in a cross around a heart of essence.", hintAch: "craft10" },
  { id: "r3", out: ["item", "r3"], rows: ["RRR", "RBR", "RRR"], key: { R: "relic", B: "r2" }, mult: 1, fee: 5000, hint: "Eight relics circle the Signet of the Fork.", hintAch: "legend" },
  { id: "m3", out: ["item", "m3"], rows: ["RER", "EBE", "RER"], key: { R: "relic", E: "essence", B: "m2" }, mult: 2, fee: 5000, hint: "The Zwischenzug Amulet, bound in relics and essence.", hintAch: "epic" },
  { id: "b4", out: ["item", "b4"], rows: ["RBR", ".E."], key: { R: "relic", E: "essence", B: "b3" }, mult: 3, fee: 1500, hint: "Zugzwang Treads flanked by relics, standing on essence.", hintAch: "streak5" },
  { id: "a4", out: ["item", "a4"], rows: ["ERE", "RBR", "ERE"], key: { R: "relic", E: "essence", B: "a3" }, mult: 2, fee: 3000, hint: "The Castle Aegis, walled in by relics with essence at the corners.", hintAch: "legend" },
  { id: "x3", out: ["item", "x3"], rows: ["E.E", ".E.", "S.S"], key: { S: "shard", E: "essence" }, mult: 3, fee: 600, hint: "Essence falls in a V onto two shards below.", hintAch: null },
  { id: "shield", out: ["cons", "shield"], qty: 2, rows: ["SSS", "S.S"], key: { S: "shard" }, mult: 2, fee: 0, hint: "An arch of shards makes a shield.", hintAch: null },
  { id: "tonic", out: ["cons", "tonic"], rows: [".E.", "SES"], key: { S: "shard", E: "essence" }, mult: 2, fee: 40, hint: "A drop of essence above a shard-bound pair.", hintAch: null },
  { id: "draught", out: ["cons", "draught"], rows: ["E.E", ".S."], key: { S: "shard", E: "essence" }, mult: 3, fee: 60, hint: "Two essences pour into one shard.", hintAch: null },
  { id: "brew", out: ["cons", "brew"], rows: ["EEE", "E.E"], key: { E: "essence" }, mult: 3, fee: 80, hint: "A cauldron of pure essence, open at the bottom.", hintAch: "setbonus" },
  { id: "catalyst", out: ["cons", "catalyst"], rows: ["R.R", ".R."], key: { R: "relic" }, mult: 2, fee: 200, hint: "Three relics in a V, like a chalice.", hintAch: "alchemist" },
];
// Canonical text for a grid, ignoring empty rows/columns around it, so a pattern works anywhere on the 3x3 table.
function canon(g) {
  const ys = [], xs = [];
  g.forEach((r, y) => r.forEach((t, x) => { if (t) { ys.push(y); xs.push(x); } }));
  if (!ys.length) return "";
  const out = [];
  for (let y = Math.min(...ys); y <= Math.max(...ys); y++) { const row = []; for (let x = Math.min(...xs); x <= Math.max(...xs); x++) row.push(g[y][x] || "_"); out.push(row.join(",")); }
  return out.join("/");
}
const BY_PATTERN = new Map(RECIPES.map(r => [canon(r.rows.map(row => [...row.padEnd(3, ".")].map(ch => ch === "." ? null : r.key[ch]))), r]));
const matchRecipe = g9 => BY_PATTERN.get(canon([0, 1, 2].map(i => g9.slice(i * 3, i * 3 + 3)))) || null;

// [id, name, description, coin reward, rule, target, options]
const ACH = [
  ["linked", "Linked Up", "Verify your chess.com account.", 25, "linked", 1], ["first_win", "First Blood", "Win your first rated game.", 25, "wins", 1],
  ["streak3", "On a Roll", "Win 3 rated games in a row.", 50, "best", 3], ["streak5", "Unstoppable", "Win 5 rated games in a row.", 100, "best", 5],
  ["games25", "Regular", "Play 25 rated games.", 50, "games", 25], ["games100", "Veteran", "Play 100 rated games.", 150, "games", 100],
  ["lvl5", "Rising Star", "Reach level 5.", 75, "level", 5], ["lvl10", "Contender", "Reach level 10.", 150, "level", 10],
  ["first_craft", "Apprentice Smith", "Craft something at the crafting table.", 50, "crafts", 1], ["craft10", "Journeyman", "Craft 10 times.", 100, "crafts", 10],
  ["salvage", "Salvage", "Dismantle an item.", 25, "dismantles", 1], ["sharpened", "Sharpened", "Upgrade an item.", 25, "upgrades", 1],
  ["fullgear", "Fully Equipped", "Fill all six gear slots.", 100, "gear", 6], ["setbonus", "Matching Set", "Activate a set bonus.", 50, "set", 1],
  ["rare", "Rare Find", "Own a Rare or better item.", 50, "rarity", 2], ["epic", "Epic Find", "Own an Epic or better item.", 100, "rarity", 3],
  ["legend", "Legendary", "Own a Legendary or better item.", 200, "rarity", 4], ["mythic", "Myth Made", "Own a Mythic item.", 500, "rarity", 5],
  ["potion", "Bottoms Up", "Use a consumable.", 25, "uses", 1], ["alchemist", "Alchemist", "Discover 5 recipes.", 100, "known", 5],
  ["giant", "Giant Slayer", "Beat a player rated 200+ higher.", 100, "special", 1, { hidden: 1 }],
  ["hoard", "Hoarder", "Hold 200 Iron Shards.", 50, "shards", 200, { hidden: 1 }],
  ["collector", "Collector", "Own 12 different items.", 150, "distinct", 12, { hidden: 1 }],
  ["quests10", "Quest Giver", "Claim 10 quests.", 100, "quests", 10],
  ["wins50", "Seasoned", "Win 50 rated games.", 150, "wins", 50], ["wins250", "Warlord", "Win 250 rated games.", 500, "wins", 250],
  ["merchant5", "Regular Customer", "Buy 5 offers from the Wandering Merchant.", 75, "merchant", 5],
  ["wanderer", "Well Travelled", "Wear 4 pieces of the Wanderer set.", 200, "wanderer", 4, { hidden: 1 }],
].map(([id, name, desc, reward, rule, n, o]) => ({ id, name, desc, reward, rule, n, hidden: !!(o && o.hidden) }));
const ACHIEVEMENT = Object.fromEntries(ACH.map(a => [a.id, a]));

// Quests: each player gets QUESTS_PER_PERIOD of each kind, picked from these pools. They count rewarded games only.
// goal types: play, win, wd (win or draw), upset (beat a higher-rated opponent); tc limits it to one time class.
// [id, description, goal type, target, time class or null, reward]
const QUESTS_PER_PERIOD = 3;
const QUEST_ROWS = {
  daily: [
    ["d_play3", "Play 3 rated games", "play", 3, null, { coins: 40, shard: 3 }],
    ["d_play5", "Play 5 rated games", "play", 5, null, { coins: 70, shard: 6 }],
    ["d_win2", "Win 2 games", "win", 2, null, { coins: 60, shard: 5 }],
    ["d_wd3", "Win or draw 3 games", "wd", 3, null, { coins: 50, shard: 4 }],
    ["d_upset", "Beat a higher-rated opponent", "upset", 1, null, { coins: 70, essence: 1 }],
    ["d_blitz", "Win a blitz game", "win", 1, "blitz", { coins: 50, shard: 4 }],
    ["d_rapid", "Win a rapid game", "win", 1, "rapid", { coins: 50, shard: 4 }],
    ["d_bullet", "Play 3 bullet games", "play", 3, "bullet", { coins: 40, shard: 3 }],
  ],
  weekly: [
    ["w_play25", "Play 25 rated games", "play", 25, null, { coins: 250, essence: 2 }],
    ["w_play40", "Play 40 rated games", "play", 40, null, { coins: 400, relic: 1 }],
    ["w_win12", "Win 12 games", "win", 12, null, { coins: 300, essence: 3 }],
    ["w_wd15", "Win or draw 15 games", "wd", 15, null, { coins: 250, essence: 2 }],
    ["w_upset3", "Beat 3 higher-rated opponents", "upset", 3, null, { coins: 300, relic: 1 }],
    ["w_rapid5", "Win 5 rapid games", "win", 5, "rapid", { coins: 250, essence: 2 }],
    ["w_blitz8", "Win 8 blitz games", "win", 8, "blitz", { coins: 250, essence: 2 }],
  ],
};
const QUESTS = Object.fromEntries(Object.entries(QUEST_ROWS).map(([kind, rows]) =>
  [kind, rows.map(([id, desc, type, n, tc, reward]) => ({ id, kind, desc, type, n, tc, reward }))]));
// The Wandering Merchant: new offers every day at midnight UTC, the same for everyone, each with a daily limit per player.
// Every day: one deal (a shop item at DEAL_OFF percent off), one merchant-only item, and MERCHANT_POOL_PICKS from the pool.
const DEAL_OFF = 25, MERCHANT_POOL_PICKS = 3;
const MERCHANT_ITEMS = { // cost of each merchant-only item
  w5: { coins: 900, essence: 4 }, w6: { coins: 600, shard: 20 }, a5: { coins: 650, shard: 20 }, h4: { coins: 650, shard: 20 },
  b5: { coins: 650, shard: 20 }, r4: { coins: 950, essence: 4 }, m4: { coins: 650, shard: 20 }, x4: { coins: 1000, essence: 5 },
  t4: { coins: 300 }, t5: { coins: 300 },
};
// [id, gives [type, id, qty], cost, daily limit]
const MERCHANT_POOL = [
  ["ess1", ["mat", "essence", 1], { coins: 120 }, 3], ["ess3", ["mat", "essence", 3], { coins: 330 }, 1],
  ["relic1", ["mat", "relic", 1], { coins: 450 }, 1], ["shard15", ["mat", "shard", 15], { coins: 90 }, 2],
  ["swap_se", ["mat", "essence", 1], { shard: 20 }, 3], ["swap_er", ["mat", "relic", 1], { essence: 8 }, 1],
  ["tonic", ["cons", "tonic", 1], { coins: 150 }, 2], ["draught", ["cons", "draught", 1], { coins: 170 }, 2],
  ["brew", ["cons", "brew", 1], { coins: 200 }, 1], ["shields", ["cons", "shield", 2], { coins: 130 }, 1],
  ["catalyst", ["cons", "catalyst", 1], { coins: 600 }, 1],
].map(([id, [t, k, qty], cost, limit]) => ({ id, give: { t, id: k, qty }, cost, limit }));

// Themes for the site. Unlocked by total rated wins; the server checks before saving a choice.
const THEMES = [
  ["dark", "Midnight", 0], ["light", "Daylight", 0], ["emerald", "Emerald", 10], ["royal", "Royal", 25],
  ["ocean", "Ocean", 50], ["inferno", "Inferno", 100], ["gold", "Grandmaster Gold", 250],
].map(([id, name, wins]) => ({ id, name, wins }));
const THEME = Object.fromEntries(THEMES.map(t => [t.id, t]));
const QUEST = Object.fromEntries([...QUESTS.daily, ...QUESTS.weekly].map(q => [q.id, q]));

const catalog = () => ({ items: ITEMS, sets: SETS, themes: THEMES, slots: SLOTS, mats: MATS, maxLevel: MAX_LEVEL, rarities: RARITY, shield: SHIELD,
  cons: Object.fromEntries(Object.entries(CONS).map(([k, c]) => [k, { name: c.name, desc: c.desc, games: c.games || 0 }])),
  ach: ACH.map(a => a.hidden ? { id: a.id, hidden: true } : { id: a.id, name: a.name, desc: a.desc, reward: a.reward, n: a.n, hint: RECIPES.some(r => r.hintAch === a.id) }) });

module.exports = { RARITY, SLOTS, MATS, NAMES, MAX_LEVEL, WELCOME_COINS, CAPS, SETS, ITEMS, ITEM, SHIELD, CONS, MAX_BUFF_GAMES, RECIPES, BY_PATTERN, matchRecipe, ACH, ACHIEVEMENT, QUESTS, QUEST, QUESTS_PER_PERIOD, DEAL_OFF, MERCHANT_POOL_PICKS, MERCHANT_ITEMS, MERCHANT_POOL, THEMES, THEME, upgradeCost, dismantleYield, catalog };
