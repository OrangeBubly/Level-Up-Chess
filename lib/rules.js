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
// Offensive-name filter for usernames and clan names. Numbers and symbols standing in for letters are undone first
// (sh1t, @ss), and stretched letters are allowed for (fuuuck). STRONG words are blocked anywhere inside a name. SHORT words
// are only blocked as a whole word (between underscores, spaces or digits), so assassin, classic, cocktail, titan and
// therapist stay allowed.
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", 9: "g", "@": "a", $: "s", "!": "i", "|": "l", "+": "t" };
const STRONG = ["fuck", "fuk", "fck", "fvck", "fvk", "phuck", "phuk", "shit", "bitch", "cunt", "nigg", "fagot", "faggot", "retard", "whore", "slut", "hitler", "pussy", "porn", "wank",
  "twat", "bastard", "tranny", "jizz", "asshole", "motherf", "cocksuck", "dildo", "penis", "vagina", "bollock", "blowjob", "handjob", "cuck"]
  .map(w => new RegExp(w.split("").map(ch => ch + "+").join(""))); // each letter may repeat
const SHORT = new Set(["ass", "arse", "cum", "tit", "tits", "hoe", "hoes", "dick", "cock", "sex", "rape", "rapist", "spic", "chink", "dyke", "fag", "fags",
  "boob", "boobs", "piss", "nazi", "kike", "clit", "homo", "negro", "coon", "gook", "jap", "slag", "prick", "anus", "nig", "nigga", "niga"]);
const unleet = s => [...s].map(ch => LEET[ch] || ch).join("");
function isOffensive(text) {
  const raw = String(text || "").toLowerCase(), letters = unleet(raw).replace(/[^a-z]/g, "");
  if (STRONG.some(re => re.test(letters))) return true;
  return raw.split(/[^a-z0-9@$!|+]+/).filter(Boolean).some(tok => {
    const a = unleet(tok).replace(/[^a-z]/g, ""), b = tok.replace(/[^a-z]/g, ""), squash = s => s.replace(/(.)\1+/g, "$1$1");
    return [a, b, squash(a), a.replace(/(.)\1+/g, "$1")].some(v => SHORT.has(v));
  });
}
// The opening chess.com tagged a game with, from its PGN headers: [ECO "C41"] and [ECOUrl ".../openings/Philidor-Defense-3.d4-Bg4"].
// name drops the move list at the end of the link; family is the main opening ("Sicilian Defense" for any Sicilian).
const FIX = { Queens: "Queen's", Kings: "King's", Bishops: "Bishop's", Alekhines: "Alekhine's", Petrovs: "Petrov's", Owens: "Owen's", Birds: "Bird's" };
function openingOf(pgn) {
  const eco = (/\[ECO "([A-E]\d\d)"\]/.exec(pgn || "") || [])[1] || null, url = (/\[ECOUrl "[^"]*\/openings\/([^"?#]+)"\]/.exec(pgn || "") || [])[1];
  if (!url) return eco ? { eco, name: null } : null;
  const words = []; // the moves start at a word beginning with a digit, or after "..." glued to the previous word
  for (const part of url.split("-")) { if (/^\d|^\.\.\./.test(part)) break; const w = part.split("...")[0]; words.push(FIX[w] || w); if (part.includes("...")) break; }
  return { eco, name: words.join(" ").slice(0, 80) || null };
}
function openingFamily(name) {
  const w = String(name || "").split(" "), i = w.findIndex(x => /^(Defense|Game|Opening|Attack|Gambit|System)$/.test(x));
  return (i >= 0 ? w.slice(0, i + 1) : w.slice(0, 2)).join(" ");
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
module.exports = { tclass, plies, resultOf, bonusOf, calcReward, periodOf, pickQuests, merchantOffers, questProgress, rollChest, rollLoot, openingOf, openingFamily, isOffensive, MIN_PLIES, PER_OPPONENT_DAILY, DAY_SOFT_CAP };
