"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { open, migrate } = require("../lib/db"), { createCore } = require("../lib/core"), R = require("../lib/rules"), C = require("../lib/content");

function setup(opts) {
  const db = open(":memory:"); migrate(db);
  const core = createCore(db, { now: () => 5000, ...opts });
  const mk = (name, ccName, wm = 1) => { const id = core.createUser(name, "s", "h"); db.prepare("UPDATE users SET cc=?, cc_player_id=?, watermark=? WHERE id=?").run(ccName, id, wm, id); return id; };
  return { db, core, mk };
}
let n = 0;
const G = (white, black, res = "win", o = {}) => { n++; return { url: "g" + n, end_time: o.t || 1000 + n, rules: "chess", rated: o.rated !== false, time_control: "600",
  pgn: Array(o.plies || 20).fill("e4").join(" "), white: { username: white, rating: o.wr || 1500, result: res }, black: { username: black, rating: o.br || 1500, result: res === "win" ? "checkmated" : "win" } }; };
const ledgerSum = (db, uid, kind) => db.prepare("SELECT COALESCE(SUM(delta),0) s FROM ledger WHERE user_id=? AND kind=?").get(uid, kind).s;
const bal = (db, uid, kind) => (db.prepare("SELECT qty FROM balances WHERE user_id=? AND kind=?").get(uid, kind) || { qty: 0 }).qty;

test("migrations are idempotent and refuse a pre-rebuild database", () => {
  const db = open(":memory:"); assert.deepEqual(migrate(db), [1]); assert.deepEqual(migrate(db), []);
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
  core.buy(a, "w1"); assert.equal(bal(db, a, "coins"), 50);
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
  assert.throws(() => core.craft(a, "w3"), e => e.code === "insufficient"); // not enough materials yet
  assert.equal(db.prepare("SELECT COUNT(*) n FROM items WHERE id=?").get(i2).n, 0);
  core._grant(a, "shard", 100, "test"); core._grant(a, "essence", 10, "test");
  core.upgrade(a, i1); assert.equal(db.prepare("SELECT level FROM items WHERE id=?").get(i1).level, 2);
  core.craft(a, "w3"); assert.equal(db.prepare("SELECT COUNT(*) n FROM items WHERE user_id=? AND def='w3'").get(a).n, 1);
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
