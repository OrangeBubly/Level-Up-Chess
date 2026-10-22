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
];
const SETS = {
  cavalry: { name: "Cavalry", bonus: { 2: { upset: 8 }, 3: { upset: 15, xp: 5 } } },
  fortress: { name: "Fortress", bonus: { 2: { streak: 4 }, 3: { streak: 8, coin: 5 } } },
};
const ITEMS = ROWS.map(([id, name, slot, r, price, stats, g, f, set]) => ({ id, name, slot, r, price, stats, g, f, set: set || null }));
const ITEM = Object.fromEntries(ITEMS.map(i => [i.id, i]));
const SHIELD = { id: "shield", name: "Streak Shield", price: 80, g: "🛡", f: "Your next loss won’t break your streak." };

const CRAFT_COST = [null, null, { coins: 250, shard: 30, essence: 3 }, { coins: 600, shard: 60, essence: 12 }, { coins: 1500, essence: 40, relic: 3 }, { coins: 5000, essence: 100, relic: 15 }];
const DISMANTLE = [{ shard: 3 }, { shard: 6 }, { shard: 12, essence: 1 }, { shard: 25, essence: 4 }, { essence: 12, relic: 1 }, { essence: 30, relic: 4 }];
const craftable = d => !!d && d.price === 0 && d.slot !== "title" && !!CRAFT_COST[d.r];
const upgradeCost = (d, L) => L >= MAX_LEVEL ? null : { coins: 40 * L * (d.r + 1), shard: 3 * L * (d.r + 1) };
const dismantleYield = (d, L) => Object.fromEntries(Object.entries(DISMANTLE[d.r]).map(([k, v]) => [k, v * L]));
const recipes = () => ITEMS.filter(craftable).map(d => ({ out: d.id, cost: CRAFT_COST[d.r] }));
const catalog = () => ({ items: ITEMS, sets: SETS, slots: SLOTS, mats: MATS, recipes: recipes(), maxLevel: MAX_LEVEL, shield: SHIELD, rarities: RARITY });

module.exports = { RARITY, SLOTS, MATS, NAMES, MAX_LEVEL, WELCOME_COINS, CAPS, SETS, ITEMS, ITEM, SHIELD, CRAFT_COST, craftable, upgradeCost, dismantleYield, recipes, catalog };
