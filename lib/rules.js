"use strict";
// Pure game rules: no database, no network. Easy to unit test.
const C = require("./content");
const DAY_SOFT_CAP = 600, SOFT_RATE = 0.25, MIN_PLIES = 8, PER_OPPONENT_DAILY = 6;
const DRAWS = ["agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"];

function tclass(tc) {
  if (!tc || String(tc).includes("/")) return "daily";
  const base = +String(tc).split("+")[0];
  return base < 180 ? "bullet" : base < 600 ? "blitz" : "rapid";
}
function plies(pgn) { // number of half-moves in a PGN's movetext
  if (!pgn) return 0;
  const t = pgn.replace(/\[[^\]]*\]/g, " ").replace(/\{[^}]*\}/g, " ").replace(/\d+\.(\.\.)?/g, " ")
    .split(/\s+/).filter(x => x && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(x));
  return t.length;
}
const resultOf = r => r === "win" ? "win" : DRAWS.includes(r) ? "draw" : "loss";

// Stat bonuses from the equipped items [{def, level}], including set bonuses, capped.
function bonusOf(rows) {
  const b = { xp: 0, coin: 0, upset: 0, streak: 0 }, count = {}, active = [];
  for (const r of rows) {
    const d = C.ITEM[r.def]; if (!d) continue;
    const m = 1 + 0.2 * (r.level - 1);
    for (const k in d.stats) b[k] += d.stats[k] * m;
    if (d.set) count[d.set] = (count[d.set] || 0) + 1;
  }
  for (const [s, n] of Object.entries(count)) for (const [need, st] of Object.entries(C.SETS[s].bonus))
    if (n >= +need) { for (const k in st) b[k] += st[k]; active.push({ set: s, pieces: +need }); }
  for (const k in b) b[k] = Math.min(C.CAPS[k], Math.round(b[k] * 10) / 10);
  return { stats: b, active };
}

// o: {res, gap, streakAfter}; b: bonus stats; ctx: {dayXp}. Returns the XP and coins for one game.
function calcReward(o, b, ctx) {
  let x = o.res === "win" ? 20 : o.res === "draw" ? 8 : 3;
  if (o.res === "win" && o.gap > 0) x += Math.min(25, o.gap / 10) * (1 + b.upset / 100);
  if (o.res === "win") x *= 1 + Math.min(o.streakAfter - 1, 5) * (0.1 + b.streak / 100);
  x = Math.round(x * (1 + b.xp / 100));
  if (ctx.dayXp >= DAY_SOFT_CAP) x = Math.round(x * SOFT_RATE);
  return { xp: x, coins: Math.round(x * (1 + b.coin / 100)) };
}
// Quest periods, in UTC: a day starts at midnight, a week starts on Monday at midnight.
function periodOf(kind, t) {
  const day = Math.floor(t / 86400), first = kind === "weekly" ? day - (day + 3) % 7 : day; // 1970-01-01 was a Thursday
  const start = first * 86400, date = new Date(start * 1000).toISOString().slice(0, 10);
  return { key: (kind === "weekly" ? "w" : "d") + date, start, end: start + (kind === "weekly" ? 7 : 1) * 86400 };
}
// A shuffle that always gives the same order for the same seed.
function shuffled(pool, seed) {
  let h = 2166136261; for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return pool.map(q => { h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; return [h, q]; }).sort((a, b) => a[0] - b[0]).map(x => x[1]);
}
// The same player always gets the same quests in a period; at most one quest tied to a time class.
function pickQuests(pool, seed, n) {
  const out = []; for (const q of shuffled(pool, seed)) if (out.length < n && !(q.tc && out.some(o => o.tc))) out.push(q);
  return out;
}
// The Wandering Merchant's offers for one day: a deal on a shop item, a merchant-only item, then a few pool offers.
function merchantOffers(dayKey) {
  const seed = "merchant:" + dayKey;
  const deal = shuffled(C.ITEMS.filter(d => d.price > 0 && d.slot !== "title"), seed + ":deal")[0];
  const ex = shuffled(Object.keys(C.MERCHANT_ITEMS), seed + ":ex")[0];
  return [
    { id: "deal_" + deal.id, kind: "deal", give: { t: "item", id: deal.id, qty: 1 }, cost: { coins: Math.round(deal.price * (100 - C.DEAL_OFF) / 100) }, was: deal.price, limit: 1 },
    { id: "ex_" + ex, kind: "exclusive", give: { t: "item", id: ex, qty: 1 }, cost: C.MERCHANT_ITEMS[ex], limit: 1 },
    ...shuffled(C.MERCHANT_POOL, seed + ":pool").slice(0, C.MERCHANT_POOL_PICKS).map(o => ({ ...o, kind: "pool" })),
  ];
}
// Which chest a win drops, from one random number r in [0, 1): the rarest chest is checked first, so each chest gets
// exactly its own chance and the rest (100% minus all chances) is no chest.
function rollChest(chests, r) {
  let acc = 0;
  for (const c of [...chests].sort((a, b) => a.chance - b.chance)) { acc += c.chance; if (r * 100 < acc) return c; }
  return null;
}
// What one chest gives: each loot line has its own chance, then an amount from min to max. A chest is never empty:
// if nothing came up, the first line pays its minimum.
function rollLoot(chest, rand) {
  const out = {};
  for (const l of chest.loot) if (rand() * 100 < l.chance) out[l.id] = (out[l.id] || 0) + l.min + Math.floor(rand() * (l.max - l.min + 1));
  if (!Object.keys(out).length && chest.loot.length) out[chest.loot[0].id] = chest.loot[0].min;
  return out;
}
// games: [{res, tclass, upset}] for the player's rewarded games in the period
const questProgress = (q, games) => Math.min(q.n, games.filter(g => (!q.tc || g.tclass === q.tc) &&
  (q.type === "play" || (q.type === "win" && g.res === "win") || (q.type === "wd" && g.res !== "loss") || (q.type === "upset" && g.res === "win" && g.upset))).length);
module.exports = { tclass, plies, resultOf, bonusOf, calcReward, periodOf, pickQuests, merchantOffers, questProgress, rollChest, rollLoot, MIN_PLIES, PER_OPPONENT_DAILY, DAY_SOFT_CAP };
