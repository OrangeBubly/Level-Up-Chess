"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { open, migrate } = require("../lib/db"), { createCore } = require("../lib/core"), R = require("../lib/rules"), C = require("../lib/content");

function setup(opts) {
  const db = open(":memory:"); migrate(db);
  const core = createCore(db, { now: () => 5000, rand: () => 0.999, ...opts }); // rand 0.999: no chest drops unless a test asks
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
  const db = open(":memory:"); assert.deepEqual(migrate(db), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]); assert.deepEqual(migrate(db), []);
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
  assert.deepEqual(migrate(db, { file, backupDir: path.join(dir, "bk") }), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
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
  assert.equal(core.view(a).mode, "dark"); core.setMode(a, "light"); assert.equal(core.view(a).mode, "light");
  assert.throws(() => core.setMode(a, "dim"), e => e.code === "bad_mode");
  assert.throws(() => core.setTheme(a, "light"), e => e.code === "not_found"); // Daylight is a mode now, not a theme
  assert.throws(() => core.setTheme(a, "emerald"), e => e.code === "locked");
  assert.throws(() => core.setTheme(a, "nope"), e => e.code === "not_found");
  db.prepare("UPDATE users SET wins=10 WHERE id=?").run(a); core.setTheme(a, "emerald"); assert.equal(core.view(a).theme, "emerald");
  assert.equal(core.view(a).mode, "light"); // the colour and light mode are independent
  assert.throws(() => core.setTheme(a, "royal"), e => e.code === "locked");
});

test("accounts saved with the old Daylight theme read as Crimson in light mode, until they change it", () => {
  const { db, core, mk } = setup(), a = mk("alice", "alice");
  db.prepare("UPDATE users SET theme='light' WHERE id=?").run(a);
  assert.deepEqual([core.view(a).theme, core.view(a).mode], ["dark", "light"]);
  db.prepare("UPDATE users SET wins=10 WHERE id=?").run(a); core.setTheme(a, "emerald");
  assert.deepEqual([core.view(a).theme, core.view(a).mode], ["emerald", "light"]); // still light
  db.prepare("UPDATE users SET theme='light', mode='dark' WHERE id=?").run(a); core.setMode(a, "dark");
  assert.deepEqual([core.user(a).theme, core.user(a).mode], ["dark", "dark"]);
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

test("content editor: new items work everywhere at once, input is checked, owned items can't be deleted", () => {
  const { db, core, mk } = setup(), a = mk("alice", "alice");
  const it = core.saveItem({ name: "Tempo Blade", slot: "weapon", r: 2, price: 300, stats: { xp: 6, upset: 4 }, g: "♝", f: "Fast.", set: "cavalry", merchantCost: null });
  assert.equal(it.id, "c1"); assert.ok(C.ITEM.c1.custom); assert.ok(C.ITEMS.some(i => i.id === "c1"));
  core.adminGive(a, "coins", 1000); core.buy(a, "c1"); assert.equal(core.view(a).items.find(i => i.def === "c1").up.coins, 120);
  assert.equal(R.bonusOf([{ def: "c1", level: 1 }]).stats.xp, 6);
  for (const bad of [{ name: "<b>x</b>" }, { slot: "pants" }, { r: 9 }, { price: -1 }, { stats: { xp: 99 } }, { stats: { luck: 1 } }, { g: "X" }, { set: "nope" }, { merchantCost: {} }])
    assert.throws(() => core.saveItem({ name: "Okay", slot: "ring", r: 1, price: 10, stats: {}, g: "◎", f: "", ...bad }), e => e.code.startsWith("bad_"), JSON.stringify(bad));
  assert.throws(() => core.saveItem({ ...it, slot: "ring" }), e => e.code === "bad_slot");
  assert.throws(() => core.deleteItem("c1"), e => e.code === "in_use");
  core.saveItem({ ...it, retired: true }); assert.equal(C.ITEM.c1.price, 0); assert.throws(() => core.buy(a, "c1"), e => e.code === "not_for_sale");
  assert.ok(core.view(a).items.some(i => i.def === "c1")); // still owned and usable
  const fresh = core.saveItem({ name: "Spare Ring", slot: "ring", r: 0, price: 50, stats: {}, g: "◎", f: "" });
  assert.deepEqual(core.deleteItem(fresh.id), { deleted: true }); assert.equal(C.ITEM[fresh.id], undefined);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM custom_items").get().n, 1);
});

test("content editor: edit and restore built-in items, merchant prices, and it all survives a restart", () => {
  const { db, core } = setup();
  core.saveItem({ ...C.ITEM.w1, name: "Better Pike", price: 120, merchantCost: { coins: 999 } });
  assert.equal(C.ITEM.w1.name, "Better Pike"); assert.ok(C.ITEM.w1.merchant); assert.deepEqual(C.MERCHANT_ITEMS.w1, { coins: 999 });
  createCore(db); assert.equal(C.ITEM.w1.name, "Better Pike"); // a new core on the same database loads the saved content
  assert.deepEqual(core.deleteItem("w1"), { restored: true }); assert.equal(C.ITEM.w1.name, "Pawn Pike"); assert.equal(C.MERCHANT_ITEMS.w1, undefined);
  const w5 = core.saveItem({ ...C.ITEM.w5, merchantCost: null }); assert.equal(w5.merchant, false); assert.equal(C.MERCHANT_ITEMS.w5, undefined);
});

test("content editor: recipes from a 3x3 grid, unique patterns, turning built-ins off and on", () => {
  const { core, mk } = setup(), a = mk("alice", "alice"), S_ = "shard", E = "essence";
  const it = core.saveItem({ name: "Glass Dagger", slot: "weapon", r: 1, price: 0, stats: { coin: 2 }, g: "♝", f: "" });
  const grid = [S_, null, S_, null, S_, null, S_, null, S_]; // an X of shards
  const r = core.saveRecipe({ out: ["item", it.id], grid, mult: 2, fee: 100, hint: "An X marks the spot.", hintAch: null });
  assert.equal(r.id, "cr1"); assert.deepEqual(C.matchRecipe(grid).out, ["item", it.id]);
  core.adminGive(a, "coins", 500); core.adminGive(a, "shard", 50);
  assert.ok(core.craft(a, grid.map(t => t && M(t))).discovered); assert.ok(core.view(a).items.some(i => i.def === it.id));
  const w3 = C.RECIPES.find(x => x.id === "w3"), w3grid = [null, S_, null, null, E, null, null, S_, null];
  assert.throws(() => core.saveRecipe({ out: ["cons", "tonic"], grid: w3grid, mult: 1, fee: 0, hint: "" }), e => e.code === "pattern_taken");
  for (const bad of [{ grid: [] }, { grid: Array(9).fill(null) }, { grid: ["gold", null, null, null, null, null, null, null, null] }, { out: ["item", "nope"] }, { mult: 0 }, { hintAch: "nope" }])
    assert.throws(() => core.saveRecipe({ out: ["cons", "tonic"], grid: [E, E, E, E, null, E, E, E, E], mult: 1, fee: 0, hint: "", ...bad }), e => e.code.startsWith("bad_"), JSON.stringify(bad));
  core.deleteRecipe("w3"); assert.equal(C.matchRecipe(w3grid), null); assert.ok(core.contentAdmin().recipes.find(x => x.id === "w3").off);
  core.restoreRecipe("w3"); assert.equal(C.matchRecipe(w3grid).id, "w3"); assert.ok(w3);
  core.deleteRecipe("cr1"); assert.equal(C.matchRecipe(grid), null);
  assert.equal(C.BY_PATTERN.size, C.RECIPES.length);
});

test("content editor: textures are stored per item and versioned", () => {
  const { core } = setup(), png = Buffer.from("89504e470d0a1a0a", "hex");
  core.setArt("w1", png); assert.ok(C.ART.w1); assert.ok(core.getArt("w1").png.equals(png)); assert.ok(C.catalog().art.w1);
  assert.throws(() => core.setArt("nope", png), e => e.code === "not_found"); core.setArt("shard", png); core.setArt("tonic", png);
  core.clearArt("w1"); assert.equal(C.ART.w1, undefined); assert.equal(core.getArt("w1"), undefined);
});

test("editor: sets can be created, edited, restored, and can't vanish while items use them", () => {
  const { core } = setup();
  const s = core.saveContent("set", { name: "Frost", bonus: { 2: { xp: 4 }, 4: { xp: 10, coin: 5 } } });
  assert.equal(s.id, "cs1"); assert.deepEqual(C.SETS.cs1.bonus, { 2: { xp: 4 }, 4: { xp: 10, coin: 5 } });
  const a = core.saveItem({ name: "Frost Helm", slot: "helmet", r: 2, price: 10, stats: {}, g: "♚", f: "", set: "cs1" });
  core.saveItem({ name: "Frost Boots", slot: "boots", r: 2, price: 10, stats: {}, g: "♟", f: "", set: "cs1" });
  assert.equal(R.bonusOf([{ def: a.id, level: 1 }, { def: "c2", level: 1 }]).stats.xp, 4);
  assert.throws(() => core.deleteContent("set", "cs1"), e => e.code === "in_use"); assert.ok(C.SETS.cs1); // rolled back
  core.saveContent("set", { id: "cavalry", name: "Lancers", bonus: { 2: { upset: 9 } } }); assert.equal(C.SETS.cavalry.name, "Lancers");
  core.restoreContent("set", "cavalry"); assert.equal(C.SETS.cavalry.name, "Cavalry");
  assert.throws(() => core.deleteContent("set", "cavalry"), e => e.code === "in_use");
  for (const bad of [{ name: "<x>" }, { bonus: {} }, { bonus: { 9: { xp: 1 } } }, { bonus: { 2: { xp: 99 } } }, { bonus: { 2: { luck: 1 } } }])
    assert.throws(() => core.saveContent("set", { name: "Okay", bonus: { 2: { xp: 1 } }, ...bad }), e => e.code.startsWith("bad_"), JSON.stringify(bad));
});

test("editor: new achievements count real stats and pay through the ledger; built-ins can be edited and turned off", () => {
  const { db, core, mk } = setup(), a = mk("alice", "alice");
  const ach = core.saveContent("ach", { name: "Shard Baron", desc: "Hold 50 Iron Shards.", reward: 40, rule: "shards", n: 50 });
  assert.ok(core.adminGive(a, "shard", 60).ach.includes(ach.id));
  assert.equal(bal(db, a, "coins"), ledgerSum(db, a, "coins")); assert.ok(C.catalog().ach.some(x => x.id === ach.id && x.name === "Shard Baron"));
  core.saveContent("ach", { id: "first_win", name: "First Win", desc: "Win once.", reward: 99, rule: "wins", n: 1 }); assert.equal(C.ACHIEVEMENT.first_win.reward, 99);
  core.saveContent("ach", { id: "giant", name: "Titan Slayer", desc: "Beat someone 200+ higher.", reward: 150, rule: "wins", n: 1, hidden: true });
  assert.equal(C.ACHIEVEMENT.giant.rule, "special"); // hand-coded rules can't be swapped
  core.deleteContent("ach", "games25"); assert.equal(C.ACHIEVEMENT.games25, undefined); assert.ok(core.contentAdmin().ach.find(x => x.id === "games25").off);
  core.restoreContent("ach", "games25"); assert.ok(C.ACHIEVEMENT.games25);
  assert.throws(() => core.deleteContent("ach", "streak5"), e => e.code === "in_use"); assert.ok(C.ACHIEVEMENT.streak5); // unlocks a recipe hint
  for (const bad of [{ rule: "special" }, { rule: "nope" }, { n: 0 }, { reward: -1 }, { desc: "" }])
    assert.throws(() => core.saveContent("ach", { name: "Okay", desc: "Fine.", reward: 1, rule: "wins", n: 1, ...bad }), e => e.code.startsWith("bad_"), JSON.stringify(bad));
});

test("editor: quests and merchant offers, with minimum pool sizes kept", () => {
  let t = 5000; const { core, mk } = setup({ now: () => t }), a = mk("alice", "alice");
  const q = core.saveContent("quest", { kind: "daily", desc: "Win 4 games", type: "win", n: 4, tc: null, reward: { coins: 100, relic: 1 } });
  assert.equal(C.QUEST[q.id].kind, "daily"); assert.ok(C.QUESTS.daily.some(x => x.id === q.id));
  core.saveContent("quest", { id: q.id, kind: "weekly", desc: "Win 4 games", type: "win", n: 4, reward: { coins: 1 } });
  assert.equal(C.QUEST[q.id].kind, "daily"); // a quest can't move between daily and weekly
  core.deleteContent("quest", "w_wd15"); core.deleteContent("quest", "w_upset3"); core.deleteContent("quest", "w_rapid5");
  core.deleteContent("quest", "w_blitz8");
  assert.equal(C.QUESTS.weekly.length, 3);
  core.saveContent("quest", { ...C.QUEST.w_win12, tc: "blitz" }); // 2 of 3 still free of a time control: fine
  assert.throws(() => core.saveContent("quest", { ...C.QUEST.w_play40, tc: "rapid" }), e => e.code === "too_few");
  assert.equal(C.QUEST.w_play40.tc, null); // the refused edit was rolled back
  assert.throws(() => core.deleteContent("quest", C.QUESTS.weekly[0].id), e => e.code === "too_few"); assert.equal(C.QUESTS.weekly.length, 3);
  assert.equal(core.quests(a).weekly.list.length, 3);
  const o = core.saveContent("offer", { give: { t: "mat", id: "relic", qty: 2 }, cost: { coins: 700 }, limit: 1 });
  assert.ok(C.MERCHANT_POOL.some(x => x.id === o.id && x.give.qty === 2));
  for (const id of C.MERCHANT_POOL.map(x => x.id).slice(0, -3)) core.deleteContent("offer", id);
  assert.throws(() => core.deleteContent("offer", C.MERCHANT_POOL[0].id), e => e.code === "too_few");
  assert.equal(core.merchant(a).offers.filter(x => x.kind === "pool").length, 3);
  for (const bad of [{ give: { t: "coins", id: "coins", qty: 1 } }, { give: { t: "mat", id: "gold", qty: 1 } }, { cost: {} }, { limit: 0 }])
    assert.throws(() => core.saveContent("offer", { give: { t: "mat", id: "shard", qty: 5 }, cost: { coins: 10 }, limit: 1, ...bad }), e => e.code.startsWith("bad_"), JSON.stringify(bad));
  assert.throws(() => core.saveContent("nope", {}), e => e.code === "bad_kind");
});

test("chest odds: rarest checked first, each gets exactly its chance, the rest is nothing", () => {
  const pick = r => (R.rollChest(C.CHESTS, r) || { id: "none" }).id;
  assert.equal(pick(0), "gold"); assert.equal(pick(0.0299), "gold"); assert.equal(pick(0.03), "iron"); assert.equal(pick(0.1299), "iron");
  assert.equal(pick(0.13), "wood"); assert.equal(pick(0.3799), "wood"); assert.equal(pick(0.38), "none"); assert.equal(pick(0.999), "none");
  const n = { gold: 0, iron: 0, wood: 0, none: 0 }; for (let i = 0; i < 10000; i++) n[pick(i / 10000)]++;
  assert.deepEqual(n, { gold: 300, iron: 1000, wood: 2500, none: 6200 });
});

test("chests: only rewarded wins drop them, they open for materials through the ledger, never empty", () => {
  let r = 0; const { db, core, mk } = setup({ rand: () => r }), a = mk("alice", "alice");
  core.sync(a, [G("alice", "l1", "loss"), G("alice", "w1", "win")]); // rand 0: the win drops a gold chest, the loss nothing
  assert.deepEqual(core.view(a).chests, { wood: 0, iron: 0, gold: 1 });
  core.sync(a, [G("alice", "u1", "win", { rated: false })]); assert.equal(core.view(a).chests.gold, 1); // unrated: nothing
  const before = core.view(a).mats, o = core.openChest(a, "gold");
  assert.deepEqual(o.opened.loot, { shard: 15, essence: 2, relic: 1 }); assert.ok(o.ach.includes("chest1")); // rand 0: every line hits, minimum amounts
  assert.equal(core.view(a).mats.shard, before.shard + 15); assert.equal(core.view(a).chests.gold, 0);
  assert.throws(() => core.openChest(a, "gold"), e => e.code === "insufficient"); assert.throws(() => core.openChest(a, "nope"), e => e.code === "not_found");
  for (const k of ["shard", "essence", "relic", "chest:gold"]) assert.equal(bal(db, a, k), ledgerSum(db, a, k), k);
  r = 0.999; assert.deepEqual(R.rollLoot(C.CHESTS.find(c => c.id === "wood"), () => r), { shard: 8 }); // 100% line always pays; top of 4-8
  assert.deepEqual(R.rollLoot({ loot: [{ id: "relic", min: 2, max: 5, chance: 10 }] }, () => 0.999), { relic: 2 }); // nothing came up: first line's minimum
  core.adminGive(a, "chest:wood", 3); assert.equal(core.openChest(a, "wood", 3).opened.n, 3); assert.equal(core.view(a).chests.wood, 0);
});

test("item locks: a locked item can't be dismantled or crafted away; duplicates keep the best copy", () => {
  const { db, core, mk } = setup(), a = mk("alice", "alice");
  for (const d of ["w2", "w2", "w2", "h2", "w1"]) core.adminItem(a, d);
  const ids = db.prepare("SELECT id FROM items WHERE user_id=? AND def='w2' ORDER BY id").all(a).map(x => x.id);
  db.prepare("UPDATE items SET level=3 WHERE id=?").run(ids[2]); // the best copy
  core.toggleLock(a, ids[0]); assert.ok(core.view(a).items.find(i => i.id === ids[0]).locked);
  assert.throws(() => core.dismantle(a, ids[0]), e => e.code === "locked");
  const p = core.dupesPreview(a); assert.equal(p.count, 1); assert.deepEqual(p.items.map(x => x.id), [ids[1]]); // locked and best are kept
  const shards = core.view(a).mats.shard, r = core.dismantleDupes(a);
  assert.equal(r.dupes.count, 1); assert.equal(core.view(a).mats.shard, shards + r.dupes.yield.shard);
  assert.deepEqual(db.prepare("SELECT id FROM items WHERE user_id=? AND def='w2' ORDER BY id").all(a).map(x => x.id), [ids[0], ids[2]]);
  assert.equal(core.dupesPreview(a).count, 0);
  core.toggleLock(a, ids[0]); core.dismantle(a, ids[0]); // unlocked again: fine
  assert.equal(bal(db, a, "shard"), ledgerSum(db, a, "shard"));
});

test("editor: new materials work in recipes, prices, quests and chest loot, and can't vanish while used or held", () => {
  const { core, mk } = setup({ rand: () => 0 }), a = mk("alice", "alice");
  const m = core.saveContent("mat", { name: "Moonstone", r: 3, color: "#88CCFF" });
  assert.equal(m.id, "cm1"); assert.equal(C.MATS.cm1, "Moonstone"); assert.equal(C.MAT_INFO.cm1.color, "#88ccff"); assert.equal(C.NAMES.cm1, "Moonstone");
  assert.equal(core.view(a).mats.cm1, 0);
  const ch = core.saveContent("chest", { name: "Moon Chest", color: "#334466", chance: 1, loot: [{ id: "cm1", min: 2, max: 3, chance: 100 }] });
  assert.ok(C.CHESTS.some(c => c.id === ch.id)); assert.equal(core.view(a).chests[ch.id], 0);
  core.sync(a, [G("alice", "mm1")]); assert.equal(core.view(a).chests[ch.id], 1); // rand 0: the rarest chest (1%) drops
  assert.deepEqual(core.openChest(a, ch.id).opened.loot, { cm1: 2 }); assert.equal(core.view(a).mats.cm1, 2);
  const it = core.saveItem({ name: "Moon Ring", slot: "ring", r: 3, price: 0, stats: { xp: 3 }, g: "◎", f: "" });
  core.saveRecipe({ out: ["item", it.id], grid: ["cm1", null, "cm1", null, null, null, null, null, null], mult: 1, fee: 0, hint: "" });
  core.craft(a, [{ t: "mat", k: "cm1" }, null, { t: "mat", k: "cm1" }, null, null, null, null, null, null]); assert.equal(core.view(a).mats.cm1, 0);
  assert.throws(() => core.deleteContent("mat", "cm1"), e => e.code === "in_use" && /recipe|Moon Chest/.test(e.message)); assert.ok(C.MATS.cm1);
  assert.throws(() => core.deleteContent("mat", "shard"), e => e.code === "in_use"); // built-ins stay
  core.saveContent("mat", { id: "shard", name: "Iron Bits", r: 0, color: "#7f8fa6" }); assert.equal(C.MATS.shard, "Iron Bits");
  core.restoreContent("mat", "shard"); assert.equal(C.MATS.shard, "Iron Shards");
  for (const bad of [{ name: "<b>" }, { r: 7 }, { color: "red" }]) assert.throws(() => core.saveContent("mat", { name: "Ok", r: 1, color: "#123456", ...bad }), e => e.code.startsWith("bad_"), JSON.stringify(bad));
});

test("editor: chest odds and loot are checked, and held chests can't be deleted", () => {
  const { core, mk } = setup(), a = mk("alice", "alice");
  core.saveContent("chest", { id: "wood", name: "Oak Chest", color: "#a0692e", chance: 40, loot: [{ id: "shard", min: 5, max: 9, chance: 100 }] });
  assert.equal(C.CHESTS.find(c => c.id === "wood").chance, 40);
  assert.throws(() => core.saveContent("chest", { id: "wood", name: "Oak Chest", color: "#a0692e", chance: 90, loot: [{ id: "shard", min: 1, max: 1, chance: 100 }] }), e => e.code === "too_many");
  assert.equal(C.CHESTS.find(c => c.id === "wood").chance, 40); // refused change rolled back
  assert.throws(() => core.deleteContent("chest", "wood"), e => e.code === "in_use");
  for (const bad of [{ loot: [] }, { loot: [{ id: "gold_ore", min: 1, max: 1, chance: 50 }] }, { loot: [{ id: "shard", min: 5, max: 2, chance: 50 }] }, { loot: [{ id: "shard", min: 1, max: 1, chance: 0 }] }, { chance: 101 }])
    assert.throws(() => core.saveContent("chest", { name: "Box", color: "#123456", chance: 1, loot: [{ id: "shard", min: 1, max: 1, chance: 50 }], ...bad }), e => e.code.startsWith("bad_"), JSON.stringify(bad));
  const c = core.saveContent("chest", { name: "Box", color: "#123456", chance: 0, loot: [{ id: "shard", min: 1, max: 1, chance: 50 }] });
  core.adminGive(a, "chest:" + c.id, 1); assert.throws(() => core.deleteContent("chest", c.id), e => e.code === "in_use");
  core.openChest(a, c.id); core.deleteContent("chest", c.id); assert.ok(!C.CHESTS.some(x => x.id === c.id));
  core.restoreContent("chest", "wood"); assert.equal(C.CHESTS.find(x => x.id === "wood").chance, 25);
});

test("reviews: only your own rewarded games, once each, XP for the first few each day, kept on a reset", () => {
  let t = 5000; const { db, core, mk } = setup({ now: () => t }), a = mk("alice", "alice"), b = mk("bob", "bob");
  const games = []; for (let i = 0; i < 5; i++) games.push(G("alice", "r" + i, "win", { t: 4000 + i }));
  core.sync(a, games); core.sync(b, [G("bob", "zz", "win", { t: 4100 })]);
  const list = core.reviewList(a); assert.equal(list.length, 5); assert.equal(list[0].key, games[4].url); // newest first
  assert.deepEqual([list[0].color, list[0].res, list[0].opp.name], ["white", "win", "r4"]);
  assert.throws(() => core.reviewTarget(a, core.reviewList(b)[0].key), e => e.code === "not_found"); // someone else's game
  assert.equal(core.reviewTarget(a, list[0].key).month, 1); // 1970-01, from the game's end time
  const xp0 = core.user(a).xp, r = core.completeReview(a, list[0].key, 87.25);
  assert.equal(r.review.xp, C.REVIEW_XP); assert.ok(r.ach.includes("review1")); assert.equal(core.user(a).xp, xp0 + C.REVIEW_XP);
  assert.throws(() => core.completeReview(a, list[0].key, 90), e => e.code === "already");
  assert.equal(core.reviewList(a)[0].accuracy, 87.3); assert.equal(core.reviewsLeft(a), C.REVIEWS_PER_DAY - 1);
  core.completeReview(a, list[1].key, 200); assert.equal(core.reviewList(a)[1].accuracy, null); // nonsense accuracy isn't stored
  core.completeReview(a, list[2].key); assert.equal(core.reviewsLeft(a), 0);
  assert.equal(core.completeReview(a, list[3].key).review.xp, 0); // over the daily limit: recorded, no XP
  t += 86401; assert.equal(core.completeReview(a, list[4].key).review.xp, C.REVIEW_XP); // a day later: paid again
  core.resetProgress(a); assert.ok(core.reviewList(a).every(g => g.reviewed)); // a reset can't re-earn review XP
  core.deleteAccount(a); assert.equal(db.prepare("SELECT COUNT(*) n FROM reviews").get().n, 0);
});

test("best game: the highest-accuracy reviewed win, shown on profiles that are visible", () => {
  const { db, core, mk } = setup(), a = mk("alice", "alice"), b = mk("bob", "bob");
  const g = [G("alice", "o1", "win", { t: 4001 }), G("alice", "o2", "win", { t: 4002 }), G("alice", "o3", "loss", { t: 4003 })];
  core.sync(a, g);
  assert.equal(core.publicProfile(b, "alice").bestGame, null); // nothing reviewed yet
  assert.throws(() => core.bestGameTarget(b, "alice"), e => e.code === "not_found");
  core.completeReview(a, g[0].url, 88); core.completeReview(a, g[1].url, 94.5); core.completeReview(a, g[2].url, 99);
  const best = core.publicProfile(b, "alice").bestGame;
  assert.equal(best.key, g[1].url); assert.equal(best.accuracy, 94.5); assert.equal(best.res, "win"); // the 99% loss doesn't beat a win
  assert.equal(best.opp.name, "o2"); assert.equal(core.bestGameTarget(b, "alice").owner, "alice");
  core.setPrivacy(a, "friends");
  assert.equal(core.publicProfile(b, "alice").bestGame, undefined); assert.throws(() => core.bestGameTarget(b, "alice"), e => e.code === "private");
  core.addFriend(b, "alice"); core.answerFriend(a, "bob", true); assert.equal(core.bestGameTarget(b, "alice").key, g[1].url);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reviews WHERE user_id=?").get(b).n, 0); // looking never creates a review
});

test("openings: read from chess.com's PGN headers, grouped into a repertoire for White and Black", () => {
  assert.deepEqual(R.openingOf('[ECO "C41"]\n[ECOUrl "https://www.chess.com/openings/Philidor-Defense-3.d4-Bg4"]\n\n1. e4 e5'), { eco: "C41", name: "Philidor Defense" });
  assert.equal(R.openingOf('[ECOUrl "https://www.chess.com/openings/Queens-Gambit-Declined-Exchange-Variation...5.Bg5"]').name, "Queen's Gambit Declined Exchange Variation");
  assert.equal(R.openingFamily("Sicilian Defense Najdorf Variation"), "Sicilian Defense"); assert.equal(R.openingFamily("Ruy Lopez Opening Morphy Defense"), "Ruy Lopez Opening");
  assert.equal(R.openingOf("1. e4 e5"), null);
  const { db, core, mk } = setup(), a = mk("alice", "alice");
  const tag = (g, url) => { g.pgn = `[ECO "B90"]\n[ECOUrl "https://www.chess.com/openings/${url}"]\n\n` + g.pgn; return g; };
  const games = [tag(G("alice", "x1", "win"), "Italian-Game-Two-Knights-Defense"), tag(G("alice", "x2", "loss"), "Italian-Game-Giuoco-Piano"),
    tag(G("alice", "x3", "agreed"), "Italian-Game"), tag(G("x4", "alice", "win"), "Sicilian-Defense-Najdorf-Variation-6.Be3")];
  games[3].white.result = "resigned"; games[3].black.result = "win"; // alice won with Black
  core.sync(a, games);
  const r = core.repertoire(a);
  assert.deepEqual(r.white, [{ name: "Italian Game", games: 3, win: 1, draw: 1, loss: 1, score: 50 }]);
  assert.deepEqual(r.black, [{ name: "Sicilian Defense", games: 1, win: 1, draw: 0, loss: 0, score: 100 }]);
  const plain = G("alice", "x5"); core.sync(a, [plain]); tag(plain, "French-Defense"); core.sync(a, [plain]); // seen again later with its opening
  assert.equal(db.prepare("SELECT opening FROM games WHERE key=?").get(plain.url).opening, "French Defense");
});

test("site tour: new accounts get the pop-up, the reward pays once and survives a reset", () => {
  const { db, core, mk } = setup(), old = mk("oldtimer", "oldtimer"), a = core.createLinkedUser("newbie", "s", "h", "newbiecc", 501);
  assert.equal(core.view(old).tutorial, 2); assert.equal(core.view(a).tutorial, 0); // only new sign-ups see the pop-up
  core.skipTour(a); assert.equal(core.view(a).tutorial, 2);
  const xp0 = core.user(a).xp, coins0 = bal(db, a, "coins"), r = core.completeTour(a); // "maybe later" can still claim it
  assert.deepEqual(r.tour, { xp: C.TOUR_XP, coins: C.TOUR_COINS, leveled: true }); assert.equal(core.user(a).xp, xp0 + C.TOUR_XP);
  assert.equal(bal(db, a, "coins"), coins0 + C.TOUR_COINS); assert.equal(bal(db, a, "coins"), ledgerSum(db, a, "coins"));
  assert.throws(() => core.completeTour(a), e => e.code === "already");
  core.resetProgress(a); assert.throws(() => core.completeTour(a), e => e.code === "already"); // a reset doesn't re-open it
  core.skipTour(a); assert.equal(core.view(a).tutorial, 1); // skipping after finishing changes nothing
  core.completeTour(old); assert.equal(core.view(old).tutorial, 1); // older accounts can take it for the reward too
});

test("security: a deleted account's old login can never open the next account that gets its id", () => {
  const { core } = setup(); core.createLinkedUser("alice", "s", "h", "alicecc", 1);
  const b = core.createLinkedUser("bob", "s", "h", "bobcc", 2), oldCookie = { id: b, sv: core.user(b).sv };
  core.deleteAccount(b); const c = core.createLinkedUser("carol", "s", "h", "carolcc", 3);
  assert.equal(c, b); // SQLite does reuse the id...
  assert.notEqual(core.user(c).sv, oldCookie.sv); // ...but the session version is new, so the old cookie is refused
});

test("security: built-in JavaScript names are never treated as game content", () => {
  const { core, mk } = setup(), a = mk("alice", "alice");
  for (const k of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    assert.throws(() => core.claimQuest(a, k), e => e.code === "not_found", "quest " + k);
    assert.throws(() => core.setTheme(a, k), e => e.code === "not_found", "theme " + k);
    assert.throws(() => core.buy(a, k), e => e.code === "not_for_sale", "buy " + k);
    assert.throws(() => core.use(a, k), e => e.code === "not_usable", "use " + k);
    assert.throws(() => core.openChest(a, k), e => e.code === "not_found", "chest " + k);
    assert.throws(() => core.craft(a, [{ t: "mat", k }, null, null, null, null, null, null, null, null]), e => e.code === "bad_grid", "craft " + k);
    assert.throws(() => core.saveContent(k, {}), e => e.code === "bad_kind", "content kind " + k);
  }
  assert.throws(() => core.saveItem({ name: "Odd", slot: "ring", r: 1, price: 1, g: "◎", f: "", stats: { toString: 5 } }), e => e.code === "bad_stats");
  assert.equal(core.view(a).theme, "dark");
});

test("security: a chess.com request that never answers times out, and the next one still runs", async () => {
  const { createChesscom } = require("../lib/chesscom");
  let calls = 0;
  const hang = (url, opts) => new Promise((ok, no) => { calls++; if (calls === 1) opts.signal.addEventListener("abort", () => no(new Error("aborted"))); else ok({ status: 200, ok: true, headers: { get: () => null }, json: async () => ({ username: "x" }) }); });
  const cc = createChesscom({ base: "http://x", fetchFn: hang, timeout: 50 });
  await assert.rejects(cc.profile("a"), e => e.code === "chesscom_unavailable");
  assert.deepEqual(await cc.profile("b"), { username: "x" }); // the queue keeps moving
});
