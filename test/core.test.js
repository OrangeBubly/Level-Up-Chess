"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { open, migrate } = require("../lib/db"), { createCore } = require("../lib/core"), R = require("../lib/rules"), C = require("../lib/content");

function setup(opts) {
  const db = open(":memory:"); migrate(db);
  const core = createCore(db, { now: () => 5000, ...opts });
  const mk = (name, ccName, wm = 1) => { const id = core.createUser(name, "s", "h"); db.prepare("UPDATE users SET cc=?, cc_player_id=?, watermark=? WHERE id=?").run(ccName, id, wm, id); return id; };
  return { db, core, mk };
}
const M = k => ({ t: "mat", k }), W3 = [null, M("shard"), null, null, M("essence"), null, null, M("shard"), null];
let n = 0;
const G = (white, black, res = "win", o = {}) => { n++; return { url: "g" + n, end_time: o.t || 1000 + n, rules: "chess", rated: o.rated !== false, time_control: o.tc || "600",
  pgn: Array(o.plies || 20).fill("e4").join(" "), white: { username: white, rating: o.wr || 1500, result: res }, black: { username: black, rating: o.br || 1500, result: res === "win" ? "checkmated" : "win" } }; };
const ledgerSum = (db, uid, kind) => db.prepare("SELECT COALESCE(SUM(delta),0) s FROM ledger WHERE user_id=? AND kind=?").get(uid, kind).s;
const bal = (db, uid, kind) => (db.prepare("SELECT qty FROM balances WHERE user_id=? AND kind=?").get(uid, kind) || { qty: 0 }).qty;

test("migrations are idempotent and refuse a pre-rebuild database", () => {
  const db = open(":memory:"); assert.deepEqual(migrate(db), [1, 2, 3, 4, 5]); assert.deepEqual(migrate(db), []);
  const old = open(":memory:"); old.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, owned TEXT)");
  assert.throws(() => migrate(old), /DB_FILE/);
});

test("a game can be claimed only once per player", () => {
  const { db, core, mk } = setup(), a = mk("alice", "alice"), g = G("alice", "bob");
  assert.equal(core.sync(a, [g]).count, 1);
  const xp = core.user(a).xp; assert.equal(xp, 20);
  assert.equal(core.sync(a, [g]).count, 0); assert.equal(core.user(a).xp, xp);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM claims WHERE user_id=?").get(a).n, 1);
});

test("both opponents of one game can each earn rewards", () => {
  const { core, mk } = setup(), a = mk("alice", "alice"), b = mk("bob", "bob"), g = G("alice", "bob");
  core.sync(a, [g]); core.sync(b, [g]);
  assert.equal(core.user(a).xp, 20); assert.equal(core.user(b).xp, 3);
});

test("more games than one batch are all processed across syncs, none skipped", () => {
  const { core, mk } = setup({ batch: 10 }), a = mk("alice", "alice"), games = [];
  for (let i = 0; i < 25; i++) games.push(G("alice", "opp" + i));
  assert.equal(core.sync(a, games).count, 10); assert.equal(core.sync(a, games).count, 10);
  assert.equal(core.sync(a, games).count, 5); assert.equal(core.sync(a, games).count, 0);
  assert.equal(core.user(a).games, 25);
});

test("unrated games, tiny games and over-played opponents do not pay out", () => {
  const { core, mk } = setup(), a = mk("alice", "alice");
  core.sync(a, [G("alice", "u1", "win", { rated: false })]); assert.equal(core.user(a).xp, 0);
  core.sync(a, [G("alice", "u2", "win", { plies: 4 })]); assert.equal(core.user(a).xp, 0);
  const many = []; for (let i = 0; i < 8; i++) many.push(G("alice", "friend", "win", { t: 2000 + i }));
  core.sync(a, many); assert.equal(core.user(a).games, R.PER_OPPONENT_DAILY);
});

test("underdog bonus uses the rating BEFORE the game, not after", () => {
  const { core, mk } = setup(), a = mk("alice", "alice");
  const g1 = G("alice", "x", "win", { wr: 1500, br: 1500, t: 1100 }), g2 = G("alice", "y", "win", { wr: 1510, br: 1700, t: 1200 });
  core.sync(a, [g1, g2]); // game 2 gap = 1700 - 1500 (previous rating) = 200 -> +20; streak 2 -> x1.1
  assert.equal(core.user(a).xp, 20 + Math.round((20 + 20) * 1.1));
});

test("shop: spending is checked, balances never go negative, ledger matches balances", () => {
  const { db, core, mk } = setup(), a = mk("alice", "alice");
  core.buy(a, "w1"); assert.equal(bal(db, a, "coins"), 150 + 25 - 100); // 25 = the Linked Up achievement reward
  assert.throws(() => core.buy(a, "w1"), e => e.code === "insufficient");
  assert.throws(() => core.buy(a, "w4"), e => e.code === "not_for_sale");
  assert.equal(bal(db, a, "coins"), ledgerSum(db, a, "coins"));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM items WHERE user_id=?").get(a).n, 1);
});

test("equip: one item per slot, replacing works, other players' items are off limits", () => {
  const { db, core, mk } = setup(), a = mk("alice", "alice"), b = mk("bob", "bob");
  core._grant(a, "coins", 1000, "test"); core.buy(a, "w1"); core.buy(a, "w2"); core.buy(b, "w1");
  const [i1, i2] = db.prepare("SELECT id FROM items WHERE user_id=? ORDER BY id").all(a).map(r => r.id);
  core.equip(a, i1); core.equip(a, i2);
  assert.deepEqual(db.prepare("SELECT item_id FROM equipment WHERE user_id=?").all(a).map(r => r.item_id), [i2]);
  const theirs = db.prepare("SELECT id FROM items WHERE user_id=?").get(b).id;
  assert.throws(() => core.equip(a, theirs), e => e.code === "not_found");
  assert.throws(() => core.dismantle(a, i2), e => e.code === "equipped");
  core.equip(a, i2); assert.equal(db.prepare("SELECT COUNT(*) n FROM equipment WHERE user_id=?").get(a).n, 0);
});

test("workshop: dismantle, upgrade and craft are atomic and audited", () => {
  const { db, core, mk } = setup(), a = mk("alice", "alice");
  core._grant(a, "coins", 5000, "test"); core.buy(a, "w2"); core.buy(a, "w2");
  const [i1, i2] = db.prepare("SELECT id FROM items WHERE user_id=? ORDER BY id").all(a).map(r => r.id);
  core.dismantle(a, i2); assert.equal(bal(db, a, "shard"), 6);
  assert.throws(() => core.craft(a, W3), e => e.code === "insufficient"); // not enough materials yet
  assert.equal(db.prepare("SELECT COUNT(*) n FROM items WHERE id=?").get(i2).n, 0);
  core._grant(a, "shard", 100, "test"); core._grant(a, "essence", 10, "test");
  core.upgrade(a, i1); assert.equal(db.prepare("SELECT level FROM items WHERE id=?").get(i1).level, 2);
  core.craft(a, W3); assert.equal(db.prepare("SELECT COUNT(*) n FROM items WHERE user_id=? AND def='w3'").get(a).n, 1);
  for (const k of ["coins", "shard", "essence"]) assert.equal(bal(db, a, k), ledgerSum(db, a, k), k);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM items WHERE user_id=?").get(a).n, ledgerSum(db, a, "item:w2") + ledgerSum(db, a, "item:w3"));
});

test("rules: parsing, set bonuses and caps", () => {
  assert.equal(R.plies('[Event "x"]\n\n1. e4 {[%clk 0:10:00]} e5 2. Nf3 1-0'), 3);
  assert.equal(R.tclass("60"), "bullet"); assert.equal(R.tclass("300+2"), "blitz"); assert.equal(R.tclass("1/86400"), "daily");
  const b = R.bonusOf([{ def: "w2", level: 1 }, { def: "h2", level: 1 }]); assert.equal(b.stats.upset, 10 + 5 + 8); assert.equal(b.active.length, 1);
  const all = R.bonusOf(C.ITEMS.map(d => ({ def: d.id, level: 5 }))).stats;
  for (const k in all) assert.ok(all[k] <= C.CAPS[k], k);
});

test("the first sync only sets a baseline: games seen then never pay out later", () => {
  const { core, mk } = setup(), a = mk("alice", "alice", 0), old = G("alice", "bob", "win", { t: 3000 }), fresh = G("alice", "carl", "win", { t: 3100 });
  assert.equal(core.sync(a, [old]).count, 0); assert.equal(core.user(a).xp, 0);
  assert.equal(core.sync(a, [old, fresh]).count, 1); assert.equal(core.user(a).xp, 20);
});

test("migrating a database that already has players keeps them and makes a backup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luc-")), file = path.join(dir, "t.db"), db = open(file);
  migrate(db, { upTo: 1 });
  db.prepare("INSERT INTO users(username,salt,hash,xp) VALUES('old','s','h',321)").run();
  assert.deepEqual(migrate(db, { file, backupDir: path.join(dir, "bk") }), [2, 3, 4, 5]);
  assert.equal(db.prepare("SELECT xp FROM users WHERE username='old'").get().xp, 321);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='recipes_known'").get());
  const bk = fs.readdirSync(path.join(dir, "bk")); assert.equal(bk.length, 1);
  assert.equal(open(path.join(dir, "bk", bk[0])).prepare("SELECT xp FROM users").get().xp, 321);
});

test("recipes: patterns are unique, every material has a repeatable consumable sink, hints are reachable", () => {
  assert.equal(C.BY_PATTERN.size, C.RECIPES.length);
  for (const m of Object.keys(C.MATS)) assert.ok(C.RECIPES.some(r => r.out[0] === "cons" && Object.values(r.key).includes(m)), "no consumable uses " + m);
  for (const r of C.RECIPES) { assert.ok(r.hintAch === null || C.ACHIEVEMENT[r.hintAch], r.id); if (r.out[0] === "item") assert.ok(C.ITEM[r.out[1]], r.id); else assert.ok(C.CONS[r.out[1]], r.id); }
  for (const d of C.ITEMS) if (d.price === 0 && d.slot !== "title" && !d.merchant) assert.ok(C.RECIPES.some(r => r.out[1] === d.id), "no recipe for " + d.id);
});

test("crafting table: shape matters, position does not, discovery is recorded", () => {
  const { db, core, mk } = setup(), a = mk("alice", "alice");
  core._grant(a, "coins", 1000, "t"); core._grant(a, "shard", 50, "t"); core._grant(a, "essence", 50, "t");
  const shifted = [M("shard"), null, null, M("essence"), null, null, M("shard"), null, null];       // the blade pattern, moved to the left column
  assert.deepEqual(core.preview(a, shifted).out, { type: "item", id: "w3", qty: 1 });
  assert.equal(core.preview(a, [M("shard"), M("shard"), null, null, null, null, null, null, null]).match, false);
  assert.throws(() => core.craft(a, [M("shard"), null, null, null, null, null, null, null, null]), e => e.code === "no_recipe");
  const r = core.craft(a, shifted); assert.equal(r.discovered, true); assert.ok(r.ach.includes("first_craft"));
  assert.equal(core.craft(a, W3).discovered, false);
  assert.equal(db.prepare("SELECT times FROM recipes_known WHERE user_id=? AND recipe='w3'").get(a).times, 2);
  assert.equal(bal(db, a, "shard"), 50 - 12); assert.equal(bal(db, a, "essence"), 50 - 6);
});

test("crafting table: spare gear is consumed, equipped or duplicated gear is refused", () => {
  const { db, core, mk } = setup(), a = mk("alice", "alice");
  for (const k of ["coins", "shard", "essence", "relic"]) core._grant(a, k, 5000, "t");
  core._grant(a, "coins", 0, "t"); core.craft(a, W3); // a Bishop's Blade
  const blade = db.prepare("SELECT id FROM items WHERE def='w3'").get().id, E = M("essence"), R_ = M("relic"), B = { t: "item", id: blade };
  const w4 = [null, E, null, E, B, E, null, R_, null];
  core.equip(a, blade); assert.throws(() => core.craft(a, w4), e => e.code === "equipped"); core.equip(a, blade);
  assert.throws(() => core.craft(a, [null, E, null, E, B, B, null, R_, null]), e => e.code === "bad_grid");
  core.craft(a, w4);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM items WHERE def='w3'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM items WHERE def='w4'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM items WHERE user_id=?").get(a).n, ledgerSum(db, a, "item:w3") + ledgerSum(db, a, "item:w4"));
});

test("consumables: crafted from materials, activated for a buff that applies to the next games", () => {
  const { db, core, mk } = setup(), a = mk("alice", "alice");
  for (const k of ["coins", "shard", "essence"]) core._grant(a, k, 100, "t");
  assert.throws(() => core.use(a, "tonic"), e => e.code === "insufficient");
  core.craft(a, [null, M("essence"), null, M("shard"), M("essence"), M("shard"), null, null, null]); assert.equal(bal(db, a, "tonic"), 1);
  assert.ok(core.use(a, "tonic").ach.includes("potion")); assert.equal(db.prepare("SELECT games_left FROM buffs WHERE user_id=?").get(a).games_left, 5);
  core.sync(a, [G("alice", "p1")]); assert.equal(core.user(a).xp, Math.round(20 * 1.3));
  assert.equal(db.prepare("SELECT games_left FROM buffs WHERE user_id=?").get(a).games_left, 4);
  assert.throws(() => core.use(a, "shield"), e => e.code === "not_usable");
});

test("material drops: guaranteed per rewarded game, relics and essence on win milestones", () => {
  const { db, core, mk } = setup(), a = mk("alice", "alice"), games = [];
  for (let i = 0; i < 10; i++) games.push(G("alice", "o" + i, "win"));
  const r = core.sync(a, games);
  assert.equal(bal(db, a, "shard"), 30); assert.equal(bal(db, a, "essence"), 3); assert.equal(bal(db, a, "relic"), 1);
  assert.deepEqual(r.drops, { shard: 30, essence: 3, relic: 1 });
  for (const k of ["shard", "essence", "relic"]) assert.equal(bal(db, a, k), ledgerSum(db, a, k));
});

test("achievements: unlock once, pay their reward, and the hidden Giant Slayer needs a 200+ upset", () => {
  const { db, core, mk } = setup(), a = mk("alice", "alice");
  const r = core.sync(a, [G("alice", "big", "win", { wr: 1500, br: 1750 })]);
  assert.ok(r.ach.includes("first_win") && r.ach.includes("giant"));
  assert.equal(core.sync(a, [G("alice", "big", "win", { wr: 1500, br: 1750 })]).ach.includes("first_win"), false);
  assert.equal(bal(db, a, "coins"), ledgerSum(db, a, "coins")); assert.equal(core.view(a).ach.giant.name, "Giant Slayer");
  const v = core.view(mk("bob", "bob")); assert.deepEqual(v.ach.giant, {}); assert.equal(v.recipes.find(x => x.id === "a3").hint, null);
});

test("quest periods: days start at midnight UTC, weeks on Monday", () => {
  const thu = Date.UTC(2026, 9, 22, 15) / 1000; // Thursday 2026-10-22, 15:00 UTC
  assert.deepEqual(R.periodOf("daily", thu), { key: "d2026-10-22", start: Date.UTC(2026, 9, 22) / 1000, end: Date.UTC(2026, 9, 23) / 1000 });
  assert.deepEqual(R.periodOf("weekly", thu), { key: "w2026-10-19", start: Date.UTC(2026, 9, 19) / 1000, end: Date.UTC(2026, 9, 26) / 1000 });
  assert.equal(R.periodOf("weekly", Date.UTC(2026, 9, 19) / 1000).key, "w2026-10-19"); // Monday midnight starts a new week
  assert.equal(R.periodOf("weekly", Date.UTC(2026, 9, 19) / 1000 - 1).key, "w2026-10-12");
});

test("quest picks: stable per player and period, distinct, at most one time-class quest", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) for (const kind of ["daily", "weekly"]) {
    const p = R.pickQuests(C.QUESTS[kind], "u" + i, 3);
    assert.deepEqual(p, R.pickQuests(C.QUESTS[kind], "u" + i, 3));
    assert.equal(new Set(p.map(q => q.id)).size, 3); assert.ok(p.filter(q => q.tc).length <= 1);
    seen.add(p.map(q => q.id).join());
  }
  assert.ok(seen.size > 20, "players should not all get the same quests");
});

test("quests: progress from rewarded games, claim once, rewards go through the ledger", () => {
  const { db, core, mk } = setup(), a = mk("alice", "alice"), games = [];
  for (let i = 0; i < 45; i++) games.push(G("alice", "q" + i, "win", { br: 1600, tc: ["60", "300", "600"][i % 3] }));
  games.push(G("alice", "u", "win", { rated: false })); // unrated: never counts
  assert.throws(() => core.claimQuest(a, core.quests(a).daily.list[0].id), e => e.code === "not_done");
  core.sync(a, games);
  const qs = core.quests(a), all = [...qs.daily.list, ...qs.weekly.list];
  assert.equal(all.length, 6); assert.ok(all.every(q => q.cur === q.n && !q.claimed), JSON.stringify(all));
  const coins0 = bal(db, a, "coins");
  for (const q of all) { assert.deepEqual(core.claimQuest(a, q.id).quest.reward, C.QUEST[q.id].reward); assert.throws(() => core.claimQuest(a, q.id), e => e.code === "claimed"); }
  assert.equal(bal(db, a, "coins"), coins0 + all.reduce((s, q) => s + C.QUEST[q.id].reward.coins, 0));
  for (const k of ["coins", "shard", "essence", "relic"]) assert.equal(bal(db, a, k), ledgerSum(db, a, k), k);
  assert.ok(core.quests(a).daily.list.every(q => q.claimed));
  const notMine = C.QUESTS.daily.find(q => !qs.daily.list.some(x => x.id === q.id));
  assert.throws(() => core.claimQuest(a, notMine.id), e => e.code === "not_found");
  assert.throws(() => core.claimQuest(a, "nope"), e => e.code === "not_found");
});

test("quests: a new day resets daily quests, old games stop counting, the week carries on", () => {
  let t = 5000; const { core, mk } = setup({ now: () => t }), a = mk("alice", "alice");
  const games = []; for (let i = 0; i < 6; i++) games.push(G("alice", "r" + i, "win", { br: 1600 }));
  core.sync(a, games);
  const day1 = core.quests(a), q = day1.daily.list.find(x => x.cur === x.n); core.claimQuest(a, q.id);
  t += 86400;
  const day2 = core.quests(a);
  assert.notEqual(day2.daily.key, day1.daily.key); assert.equal(day2.weekly.key, day1.weekly.key);
  assert.ok(day2.daily.list.every(x => x.cur === 0 && !x.claimed));
  assert.deepEqual(day2.weekly.list.map(x => x.cur), day1.weekly.list.map(x => x.cur));
});

test("quests: claiming 10 unlocks Quest Giver", () => {
  const { db, core, mk } = setup(), a = mk("alice", "alice"), games = [];
  for (let i = 0; i < 6; i++) games.push(G("alice", "s" + i, "win", { br: 1600 }));
  core.sync(a, games);
  for (let i = 0; i < 9; i++) db.prepare("INSERT INTO quest_claims(user_id,period,quest,at) VALUES(?,?,?,0)").run(a, "d1970-01-0" + (i + 2), "d_play3");
  const q = core.quests(a).daily.list.find(x => x.cur === x.n);
  assert.ok(core.claimQuest(a, q.id).ach.includes("quests10"));
});

test("achievement progress: counts show real counts, rarity tiers show 0 / 1 until owned", () => {
  const { core, mk } = setup(), a = mk("alice", "alice");
  core.buy(a, "w1"); // a Common item: rarity tier 0
  const v = core.view(a);
  assert.deepEqual(v.ach.rare, { cur: 0, max: 1 }); assert.deepEqual(v.ach.mythic, { cur: 0, max: 1 });
  assert.deepEqual(v.ach.games25, { cur: 0, max: 25 }); assert.deepEqual(v.ach.linked, { done: 1 });
});

test("usernames are unique", () => {
  const { core } = setup(); core.createUser("alice", "s", "h");
  assert.throws(() => core.createUser("alice", "s", "h"), /UNIQUE/);
});

test("merchant: same offers for everyone each day, a deal, a merchant-only item and pool offers", () => {
  const a = R.merchantOffers("d2026-10-23"), b = R.merchantOffers("d2026-10-24"), days = new Set();
  assert.deepEqual(a, R.merchantOffers("d2026-10-23")); assert.equal(a.length, 2 + C.MERCHANT_POOL_PICKS);
  assert.deepEqual(a.map(o => o.kind), ["deal", "exclusive", "pool", "pool", "pool"]);
  const deal = a[0], d = C.ITEM[deal.give.id]; assert.ok(d.price > 0); assert.equal(deal.cost.coins, Math.round(d.price * 0.75));
  assert.ok(C.ITEM[a[1].give.id].merchant); assert.equal(new Set(a.map(o => o.id)).size, a.length);
  for (let i = 1; i <= 28; i++) days.add(R.merchantOffers("d2026-11-" + String(i).padStart(2, "0")).map(o => o.id).join());
  assert.ok(days.size > 20, "offers should change from day to day"); assert.notDeepEqual(a, b);
});

test("merchant content: every merchant-only item has a price, isn't in the shop, and can't be crafted", () => {
  const ids = C.ITEMS.filter(d => d.merchant).map(d => d.id);
  assert.deepEqual(ids.sort(), Object.keys(C.MERCHANT_ITEMS).sort());
  for (const id of ids) { assert.equal(C.ITEM[id].price, 0); assert.ok(!C.RECIPES.some(r => r.out[1] === id), id); }
  for (const o of C.MERCHANT_POOL) assert.ok(C.MATS[o.give.id] || C.CONS[o.give.id], o.id);
});

test("merchant: buying spends and gives through the ledger, daily limits hold, a new day restocks", () => {
  let t = 5000; const { db, core, mk } = setup({ now: () => t }), a = mk("alice", "alice");
  for (const k of ["coins", "shard", "essence", "relic"]) core._grant(a, k, 10000, "t");
  const { key, offers } = core.merchant(a);
  for (const o of offers) {
    for (let i = 0; i < o.limit; i++) assert.deepEqual(core.buyOffer(a, o.id).bought, o.give);
    assert.throws(() => core.buyOffer(a, o.id), e => e.code === "sold_out");
  }
  assert.ok(core.merchant(a).offers.every(o => o.left === 0));
  for (const k of ["coins", "shard", "essence", "relic", "tonic", "draught", "brew", "shield", "catalyst"]) assert.equal(bal(db, a, k), ledgerSum(db, a, k), k);
  const ex = offers.find(o => o.kind === "exclusive").give.id;
  assert.equal(db.prepare("SELECT COUNT(*) n FROM items WHERE user_id=? AND def=?").get(a, ex).n, 1);
  assert.throws(() => core.buy(a, ex), e => e.code === "not_for_sale");
  t += 86400; const next = core.merchant(a);
  assert.notEqual(next.key, key); assert.ok(next.offers.every(o => o.left === o.limit));
  const gone = offers.find(o => !next.offers.some(x => x.id === o.id));
  if (gone) assert.throws(() => core.buyOffer(a, gone.id), e => e.code === "not_found");
});

test("merchant: not enough coins means nothing changes", () => {
  const { db, core, mk } = setup(), a = mk("alice", "alice"), o = core.merchant(a).offers.find(x => x.kind === "exclusive");
  const before = bal(db, a, "coins");
  assert.throws(() => core.buyOffer(a, o.id), e => e.code === "insufficient");
  assert.equal(bal(db, a, "coins"), before); assert.equal(core.merchant(a).offers.find(x => x.id === o.id).left, 1);
});

test("themes: free ones always work, others unlock with wins", () => {
  const { db, core, mk } = setup(), a = mk("alice", "alice");
  core.setTheme(a, "light"); assert.equal(core.view(a).theme, "light");
  assert.throws(() => core.setTheme(a, "emerald"), e => e.code === "locked");
  assert.throws(() => core.setTheme(a, "nope"), e => e.code === "not_found");
  db.prepare("UPDATE users SET wins=10 WHERE id=?").run(a); core.setTheme(a, "emerald"); assert.equal(core.view(a).theme, "emerald");
  assert.throws(() => core.setTheme(a, "royal"), e => e.code === "locked");
});

test("changing the password logs out other sessions", () => {
  const { core, mk } = setup(), a = mk("alice", "alice"), sv = core.user(a).sv;
  core.setPassword(a, "s2", "h2"); const u = core.user(a);
  assert.equal(u.sv, sv + 1); assert.equal(u.hash, "h2");
});

test("Well Travelled: wearing all four Wanderer pieces", () => {
  const { db, core, mk } = setup(), a = mk("alice", "alice");
  for (const d of ["a5", "h4", "b5"]) core.equip(a, Number(db.prepare("INSERT INTO items(user_id,def) VALUES(?,?)").run(a, d).lastInsertRowid));
  const last = Number(db.prepare("INSERT INTO items(user_id,def) VALUES(?,?)").run(a, "m4").lastInsertRowid);
  assert.ok(core.equip(a, last).ach.includes("wanderer"));
  assert.deepEqual(R.bonusOf([{ def: "a5", level: 1 }, { def: "h4", level: 1 }, { def: "b5", level: 1 }, { def: "m4", level: 1 }]).active.map(x => x.pieces), [2, 3, 4]);
});

test("linked sign-up: the account is created already linked, and a chess.com account can only be used once", () => {
  const { db, core } = setup();
  const a = core.createLinkedUser("alice", "s", "h", "alicecc", 77), u = core.user(a);
  assert.equal(u.cc, "alicecc"); assert.equal(u.cc_player_id, 77); assert.equal(u.watermark, 0); // first sync still only sets a baseline
  assert.equal(bal(db, a, "coins"), C.WELCOME_COINS + C.ACHIEVEMENT.linked.reward); assert.equal(bal(db, a, "coins"), ledgerSum(db, a, "coins"));
  assert.throws(() => core.createLinkedUser("alice", "s", "h", "other", 78), e => e.code === "username_taken");
  assert.throws(() => core.createLinkedUser("bob", "s", "h", "alicecc", 79), e => e.code === "cc_taken");
  assert.throws(() => core.createLinkedUser("bob", "s", "h", "renamed", 77), e => e.code === "cc_taken"); // same chess.com account after a rename
  assert.equal(db.prepare("SELECT COUNT(*) n FROM users").get().n, 1);
});

test("friends: request, accept, crossed requests auto-accept, remove, and nobody befriends themselves", () => {
  const { core, mk } = setup(), a = mk("alice", "alice"), b = mk("bob", "bob"), c = mk("carl", "carl");
  assert.equal(core.addFriend(a, "Bob").friend, "sent"); // usernames are case-insensitive
  assert.deepEqual(core.view(b).social.received.map(x => x.username), ["alice"]); assert.deepEqual(core.view(a).social.sent.map(x => x.username), ["bob"]);
  assert.throws(() => core.answerFriend(a, "bob", true), e => e.code === "not_found"); // only the receiver can accept
  assert.ok(core.answerFriend(b, "alice", true).ach.includes("friend1"));
  assert.deepEqual(core.view(a).social.friends.map(x => x.username), ["bob"]); assert.equal(core.view(b).social.received.length, 0);
  assert.throws(() => core.addFriend(a, "bob"), e => e.code === "already");
  core.addFriend(a, "carl"); assert.equal(core.addFriend(c, "alice").friend, "accepted");
  core.addFriend(b, "carl"); core.answerFriend(c, "bob", false); assert.equal(core.view(b).social.sent.length, 0);
  core.removeFriend(a, "bob"); assert.deepEqual(core.view(b).social.friends, []); assert.deepEqual(core.view(a).social.friends.map(x => x.username), ["carl"]);
  assert.throws(() => core.addFriend(a, "alice"), e => e.code === "self"); assert.throws(() => core.addFriend(a, "nobody"), e => e.code === "not_found");
});

test("public profiles: show gear and achievements, hide everything when friends-only", () => {
  const { db, core, mk } = setup(), a = mk("alice", "alice"), b = mk("bob", "bob");
  core.buy(a, "w1"); core.equip(a, db.prepare("SELECT id FROM items WHERE user_id=?").get(a).id);
  const p = core.publicProfile(b, "alice");
  assert.equal(p.private, false); assert.equal(p.rel, "none"); assert.deepEqual(p.gear.map(g => g.def), ["w1"]); assert.ok(p.ach.some(x => x.id === "linked"));
  assert.equal(p.coins, undefined); assert.equal(p.hash, undefined);
  core.setPrivacy(a, "friends"); assert.deepEqual(Object.keys(core.publicProfile(b, "alice")).sort(), ["clan", "level", "private", "rel", "title", "username"]);
  assert.equal(core.publicProfile(a, "alice").private, false); // you can always see yourself
  core.addFriend(b, "alice"); core.answerFriend(a, "bob", true); assert.equal(core.publicProfile(b, "alice").private, false);
  assert.throws(() => core.setPrivacy(a, "secret"), e => e.code === "bad_privacy");
});

test("clans: found for coins, unique name and tag, open join, invite-only requests, one clan each", () => {
  const { db, core, mk } = setup(), a = mk("alice", "alice"), b = mk("bob", "bob"), c = mk("carl", "carl");
  assert.throws(() => core.createClan(a, "Knights", "KN"), e => e.code === "insufficient"); // 175 coins < 500
  core._grant(a, "coins", 1000, "t"); core._grant(b, "coins", 1000, "t");
  assert.throws(() => core.createClan(a, "!!", "KN"), e => e.code === "bad_name"); assert.throws(() => core.createClan(a, "Knights", "K"), e => e.code === "bad_tag");
  assert.ok(core.createClan(a, "Knights  of  Tempo", "kn").ach.includes("clan1"));
  const k = core.view(a).clan.mine; assert.equal(k.name, "Knights of Tempo"); assert.equal(k.tag, "KN"); assert.ok(k.leader);
  assert.equal(bal(db, a, "coins"), ledgerSum(db, a, "coins"));
  assert.throws(() => core.createClan(b, "knights of tempo", "XY"), e => e.code === "name_taken"); assert.throws(() => core.createClan(b, "Other", "kn"), e => e.code === "tag_taken");
  assert.equal(core.joinClan(b, k.id).clanAction, "joined"); assert.throws(() => core.joinClan(b, k.id), e => e.code === "in_clan");
  assert.throws(() => core.setClanOpen(b, false), e => e.code === "not_leader");
  core.setClanOpen(a, false); assert.equal(core.joinClan(c, k.id).clanAction, "requested");
  assert.deepEqual(core.view(c).clan.requested, [k.id]); assert.deepEqual(core.view(a).clan.mine.requests.map(x => x.username), ["carl"]);
  assert.deepEqual(core.view(b).clan.mine.requests, []); // only the leader sees requests
  assert.deepEqual(core.view(b).clan.requested, []); // always present, even inside a clan (the page reads it)
  core.answerClan(a, "carl", true); assert.equal(core.view(c).clan.mine.members.length, 3);
  assert.equal(core.leaderboard().find(x => x.username === "carl").tag, "KN");
});

test("clans: kicking, leadership passes to the longest member, and an empty clan closes", () => {
  let t = 5000; const { db, core, mk } = setup({ now: () => t }), a = mk("alice", "alice"), b = mk("bob", "bob"), c = mk("carl", "carl");
  core._grant(a, "coins", 1000, "t"); core.createClan(a, "Rooks", "RK"); const id = core.view(a).clan.mine.id;
  t++; core.joinClan(b, id); t++; core.joinClan(c, id);
  assert.throws(() => core.kick(b, "carl"), e => e.code === "not_leader"); assert.throws(() => core.kick(a, "alice"), e => e.code === "self");
  core.kick(a, "carl"); assert.equal(core.view(c).clan.mine, null);
  core.leaveClan(a); assert.ok(core.view(b).clan.mine.leader); assert.equal(core.view(b).clan.mine.members.length, 1);
  core.leaveClan(b); assert.equal(db.prepare("SELECT COUNT(*) n FROM clans").get().n, 0);
  assert.throws(() => core.leaveClan(b), e => e.code === "no_clan");
});

test("clan leaderboard: ranked by XP members earned this week", () => {
  const { core, mk } = setup(), a = mk("alice", "alice"), b = mk("bob", "bob");
  core._grant(a, "coins", 1000, "t"); core._grant(b, "coins", 1000, "t");
  core.createClan(a, "Pawns", "PW"); core.createClan(b, "Bishops", "BI");
  core.sync(b, [G("bob", "z1"), G("bob", "z2")]); core.sync(a, [G("alice", "z3")]);
  const board = core.clanBoard(); assert.deepEqual(board.map(x => x.tag), ["BI", "PW"]); assert.ok(board[0].week > board[1].week);
});

test("admin tools: give through the ledger, validate input, reset only today's limits", () => {
  let t = 5000; const { db, core, mk } = setup({ now: () => t }), a = mk("alice", "alice");
  core.adminGive(a, "coins", 5000); core.adminGive(a, "relic", 7); core.adminGive(a, "tonic", 2);
  assert.equal(bal(db, a, "relic"), 7); assert.equal(bal(db, a, "tonic"), 2);
  for (const k of ["coins", "relic", "tonic"]) assert.equal(bal(db, a, k), ledgerSum(db, a, k), k);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ledger WHERE user_id=? AND reason='admin'").get(a).n, 3);
  for (const [k, n] of [["xp", 5], ["coins", 0], ["coins", -5], ["coins", 1.5], ["coins", 100001], ["__proto__", 1]]) assert.throws(() => core.adminGive(a, k, n), e => e.code === "bad_kind" || e.code === "bad_amount", k + n);
  core.adminItem(a, "m3"); assert.equal(db.prepare("SELECT COUNT(*) n FROM items WHERE user_id=? AND def='m3'").get(a).n, 1);
  assert.throws(() => core.adminItem(a, "nope"), e => e.code === "bad_item");
  assert.ok(core.adminWins(a, 50).ach.includes("wins50")); assert.equal(core.user(a).wins, 50); assert.ok(core.user(a).games >= 50);
  core.setTheme(a, "ocean"); assert.throws(() => core.adminWins(a, -1), e => e.code === "bad_amount");
  core.adminGive(a, "shard", 500); core.adminGive(a, "essence", 50);
  const o = core.merchant(a).offers.find(x => x.kind === "pool"); core.buyOffer(a, o.id);
  db.prepare("INSERT INTO merchant_buys(user_id,period,offer,qty) VALUES(?,?,?,1)").run(a, "d1969-12-31", "old");
  core.adminResetDay(a);
  assert.equal(core.merchant(a).offers.find(x => x.id === o.id).left, o.limit);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM merchant_buys WHERE user_id=?").get(a).n, 1); // older days are kept
});

test("leaderboard can leave admin accounts off", () => {
  const { core, mk } = setup(), a = mk("alice", "alice"); mk("bob", "bob");
  core.sync(a, [G("alice", "zz")]);
  assert.deepEqual(core.leaderboard().map(x => x.username), ["alice", "bob"]);
  assert.deepEqual(core.leaderboard(new Set(["alice"])).map(x => x.username), ["bob"]);
});

test("clear save data: progress goes, login, link, friends and claimed games stay", () => {
  const { db, core, mk } = setup(), a = mk("alice", "alice"), b = mk("bob", "bob");
  core.adminGive(a, "coins", 5000); core.adminGive(a, "shard", 50); core.adminItem(a, "w2"); core.adminWins(a, 30); core.setTheme(a, "royal");
  core.addFriend(a, "bob"); core.answerFriend(b, "alice", true); core.createClan(a, "Reset Club", "RC");
  const g = G("alice", "q1"); core.sync(a, [g]); const claims = db.prepare("SELECT COUNT(*) n FROM claims WHERE user_id=?").get(a).n;
  core.resetProgress(a); const u = core.user(a), v = core.view(a);
  assert.equal(u.xp, 0); assert.equal(u.wins, 0); assert.equal(u.cc, "alice"); assert.equal(u.theme, "dark");
  assert.equal(v.items.length, 0); assert.equal(v.mats.shard, 0); assert.equal(v.coins, C.WELCOME_COINS + C.ACHIEVEMENT.linked.reward + C.ACHIEVEMENT.friend1.reward + C.ACHIEVEMENT.clan1.reward);
  assert.equal(bal(db, a, "coins"), ledgerSum(db, a, "coins"));
  assert.deepEqual(v.social.friends.map(x => x.username), ["bob"]); assert.equal(v.clan.mine.tag, "RC");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM claims WHERE user_id=?").get(a).n, claims);
  assert.equal(core.sync(a, [g]).count, 0); // the same game can't pay out twice
});

test("delete account: everything goes, others keep working, the names are free again", () => {
  const { db, core, mk } = setup(), a = mk("alice", "alice"), b = mk("bob", "bob");
  core.adminGive(a, "coins", 5000); core.adminItem(a, "w2"); core.equip(a, db.prepare("SELECT id FROM items WHERE user_id=?").get(a).id);
  core.addFriend(a, "bob"); core.answerFriend(b, "alice", true); core.createClan(a, "Gone Soon", "GS"); core.joinClan(b, core.view(a).clan.mine.id);
  core.sync(a, [G("alice", "q2")]); core.deleteAccount(a);
  assert.equal(core.user(a), undefined);
  const leftovers = ["balances", "ledger", "items", "equipment", "claims", "achievements", "quest_claims", "merchant_buys", "clan_members"]
    .filter(t => db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE user_id=?`).get(a).n);
  assert.deepEqual(leftovers, []);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM friends WHERE user_id=? OR friend_id=?").get(a, a).n, 0);
  const vb = core.view(b); assert.deepEqual(vb.social.friends, []); assert.ok(vb.clan.mine.leader); // bob now leads the clan
  assert.equal(db.prepare("SELECT COUNT(*) n FROM games").get().n, 1); // shared game records stay
  assert.ok(core.createLinkedUser("alice", "s", "h", "alice", 999));
});
