"use strict";
// Balance check: simulates a few kinds of player for 30 days on a throwaway in-memory database, through the real game
// code (lib/core.js), and prints what they earned and how soon they could afford things.
// Usage: node tools/balance-sim.js [days, default 30]
const { open, migrate } = require("../lib/db"), { createCore } = require("../lib/core"), C = require("../lib/content");
const DAYS = +process.argv[2] || 30;
// [name, games a day, win rate, draw rate, time controls played]
const PLAYERS = [["casual", 4, 0.5, 0.05, ["rapid"]], ["regular", 10, 0.5, 0.05, ["blitz", "rapid"]], ["grinder", 30, 0.5, 0.05, ["bullet", "blitz", "rapid"]]];
const TC = { bullet: "60", blitz: "180", rapid: "600", daily: "1/86400" };
// how much a chest stack is worth when choosing which 2 to take (coins per unit; quality counts a bit extra)
const VALUE = { coins: 1, oak: 6, copper: 7, leather: 8, iron: 9, silk: 35, gem: 120 };
let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

for (const [name, perDay, win, draw, tcs] of PLAYERS) {
  let t = Date.UTC(2026, 0, 5) / 1000; const db = open(":memory:"); migrate(db);
  const core = createCore(db, { now: () => t, rand: rnd });
  const id = core.createUser(name, "s", "h"); db.prepare("UPDATE users SET cc=?, cc_player_id=?, watermark=1 WHERE id=?").run(name, id, id);
  let n = 0, chests = 0; const firsts = {};
  const total = () => { const v = core.view(id), m = {}; for (const k in v.mats) m[k] = v.mats[k].reduce((a, b) => a + b, 0); return { coins: v.coins, ...m, q: v.mats }; };
  for (let day = 1; day <= DAYS; day++) {
    const games = [];
    for (let g = 0; g < perDay; g++) {
      const r = rnd(), res = r < win ? "win" : r < win + draw ? "agreed" : "loss", me = res === "win" ? "win" : res, opp = res === "win" ? "checkmated" : res === "agreed" ? "agreed" : "win";
      games.push({ url: name + "-g" + (n++), end_time: t + 60 + g * 600, rules: "chess", rated: true, time_control: TC[tcs[g % tcs.length]], pgn: Array(30).fill("e4").join(" "),
        white: { username: name, rating: 1500, result: me }, black: { username: "opp" + (g % 9), rating: 1450 + Math.floor(rnd() * 120), result: opp } });
    }
    t += 60 + perDay * 600; core.sync(id, games); t = Date.UTC(2026, 0, 5) / 1000 + day * 86400; // on to the next day
    // claim finished quests, open every chest and take the 2 most valuable stacks
    for (const kind of ["daily", "weekly"]) for (const q of core.quests(id)[kind].list) if (q.cur >= q.n && !q.claimed) core.claimQuest(id, q.id);
    for (;;) {
      const v = core.view(id), c = C.CHESTS.find(x => v.chests[x.id] > 0); if (!c) break;
      core.openChest(id, c.id); chests++;
      for (let p = 0; p < C.CHEST_PICKS; p++) {
        const d = core.view(id).chestDraw; if (!d) break;
        const best = d.slots.map((s, i) => [s, i]).filter(([s]) => s && !s.taken).sort(([a], [b]) => VALUE[b.id] * b.n * (1 + 0.5 * ((b.q || 1) - 1)) - VALUE[a.id] * a.n * (1 + 0.5 * ((a.q || 1) - 1)))[0];
        core.pickChest(id, best[1]);
      }
    }
    const tot = total();
    // the first day each goal was affordable (counting everything earned, as if nothing was spent)
    const can = (label, cost) => { if (!firsts[label] && Object.entries(cost).every(([k, v]) => (tot[k] || 0) >= v)) firsts[label] = day; };
    const rc = id2 => { const r = C.RECIPES.find(x => x.id === id2), cost = { coins: r.fee }; for (const row of r.rows) for (const ch of row) if (ch !== "." && C.MATS[r.key[ch]]) cost[r.key[ch]] = (cost[r.key[ch]] || 0) + r.mult; return cost; };
    can("a shop item (260 coins)", { coins: 260 }); can("Bishop's Blade (rare)", rc("w3")); can("Castle Aegis (epic)", rc("a3")); can("Blood Moon Aura (legendary)", rc("x2"));
    can("Queen's Edge (legendary, + a blade)", rc("w4")); can("Ring of Endgames (mythic, + a signet)", rc("r3")); can("XP Tonic", rc("tonic")); can("Underdog Brew", rc("brew"));
    if (day === 7 || day === DAYS) {
      const q3 = Object.values(tot.q).reduce((s, a) => s + a[2], 0), all = Object.values(tot.q).reduce((s, a) => s + a[0] + a[1] + a[2], 0);
      console.log(`${name.padEnd(8)} day ${String(day).padStart(2)}: ${String(tot.coins).padStart(6)} coins | ` + Object.keys(C.MATS).map(k => `${k} ${tot[k]}`).join(", ") + ` | ★★★ share ${Math.round(q3 / all * 100)}% | chests ${chests}`);
    }
  }
  console.log(`${"".padEnd(8)} first affordable on day: ` + Object.entries(firsts).map(([k, d]) => `${k} ${d}`).join("; ") + "\n");
}
