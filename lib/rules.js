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
module.exports = { tclass, plies, resultOf, bonusOf, calcReward, MIN_PLIES, PER_OPPONENT_DAILY, DAY_SOFT_CAP };
