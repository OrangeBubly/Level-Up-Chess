"use strict";
// The single authoritative place where balances, items and rewards change.
// Every mutation runs inside one BEGIN IMMEDIATE transaction and re-reads what it needs inside it.
const C = require("./content"), R = require("./rules"), { AppError } = require("./errors");
const lvl = xp => Math.floor(Math.sqrt(xp / 50)) + 1, need = l => 50 * (l - 1) * (l - 1);

function createCore(db, opts = {}) {
  const BATCH = opts.batch || 200, now = opts.now || (() => Math.floor(Date.now() / 1000)), log = opts.log || (() => {});
  const tx = f => db.transaction(f).immediate();
  const get = (sql, ...a) => db.prepare(sql).get(...a), all = (sql, ...a) => db.prepare(sql).all(...a), run = (sql, ...a) => db.prepare(sql).run(...a);
  const qty = (uid, k) => (get("SELECT qty FROM balances WHERE user_id=? AND kind=?", uid, k) || { qty: 0 }).qty;
  const user = id => get("SELECT * FROM users WHERE id=?", id);
  const ledger = (uid, kind, d, reason, ref) => run("INSERT INTO ledger(user_id,kind,delta,reason,ref,at) VALUES(?,?,?,?,?,?)", uid, kind, d, reason, ref == null ? null : String(ref), now());

  function grant(uid, kind, d, reason, ref) {
    if (!d) return;
    run("INSERT INTO balances(user_id,kind,qty) VALUES(?,?,0) ON CONFLICT DO NOTHING", uid, kind);
    run("UPDATE balances SET qty=qty+? WHERE user_id=? AND kind=?", d, uid, kind); // CHECK(qty>=0) backs this up
    ledger(uid, kind, d, reason, ref);
  }
  function spend(uid, cost, reason, ref) {
    for (const [k, v] of Object.entries(cost)) if (qty(uid, k) < v) throw new AppError("insufficient", `Not enough ${C.NAMES[k]}.`);
    for (const [k, v] of Object.entries(cost)) grant(uid, k, -v, reason, ref);
  }
  const giveItem = (uid, def, reason) => {
    const id = Number(run("INSERT INTO items(user_id,def) VALUES(?,?)", uid, def).lastInsertRowid);
    ledger(uid, "item:" + def, 1, reason, id); return id;
  };
  function owned(uid, iid) {
    const it = Number.isInteger(iid) ? get("SELECT * FROM items WHERE id=? AND user_id=?", iid, uid) : null;
    if (!it) throw new AppError("not_found", "Item not found.", 404);
    return it;
  }

  function createUser(username, salt, hash) {
    return tx(() => {
      const id = Number(run("INSERT INTO users(username,salt,hash) VALUES(?,?,?)", username, salt, hash).lastInsertRowid);
      grant(id, "coins", C.WELCOME_COINS, "welcome", null); return id;
    });
  }
  const bumpSession = uid => run("UPDATE users SET sv=sv+1 WHERE id=?", uid);

  // ---- chess.com account linking ----
  function startLink(uid, cc, code) {
    if (get("SELECT 1 FROM users WHERE cc=? AND id<>?", cc, uid)) throw new AppError("cc_taken", "Another account already verified that chess.com username.", 409);
    run("UPDATE users SET cc_pending=?, cc_code=? WHERE id=?", cc, code, uid);
  }
  function finishLink(uid, playerId) {
    try {
      tx(() => {
        const u = user(uid);
        if (u.cc !== u.cc_pending) run("UPDATE users SET watermark=0 WHERE id=?", uid);
        run("UPDATE users SET cc=cc_pending, cc_player_id=?, cc_pending=NULL, cc_code=NULL WHERE id=?", playerId, uid);
      });
    } catch (e) { if (/UNIQUE/.test(e.message)) throw new AppError("cc_taken", "Another account already verified that chess.com username.", 409); throw e; }
  }
  const unlink = uid => run("UPDATE users SET cc=NULL, cc_player_id=NULL, watermark=0 WHERE id=?", uid);

  // ---- game ingestion + idempotent claims ----
  function ingest(games) {
    const ins = db.prepare("INSERT OR IGNORE INTO games(key,end_time,rules,rated,tclass,plies,w_user,w_rating,w_result,b_user,b_rating,b_result) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
    let noRated = 0;
    for (const g of games) {
      if (!g || !g.url || !g.white || !g.black || !g.end_time) continue;
      if (g.rated === undefined) noRated++;
      ins.run(g.url, g.end_time, g.rules || "", g.rated === true ? 1 : 0, R.tclass(g.time_control), R.plies(g.pgn),
        String(g.white.username).toLowerCase(), g.white.rating, g.white.result, String(g.black.username).toLowerCase(), g.black.rating, g.black.result);
    }
    if (noRated) log("warn", { msg: "games without a rated field", count: noRated });
  }
  const equippedRows = uid => all("SELECT i.def, i.level FROM equipment e JOIN items i ON i.id=e.item_id WHERE e.user_id=?", uid);

  function sync(uid, games) {
    return tx(() => {
      const u = user(uid); ingest(games);
      if (!u.watermark) { // first sync: baseline only, so old games never pay out
        const w = Math.max(0, ...games.map(g => g.end_time || 0)) || now();
        run("UPDATE users SET watermark=? WHERE id=?", w, uid);
        // mark every game seen so far as claimed-for-0, so none of them can pay out later
        run("INSERT OR IGNORE INTO claims(user_id,game_key,xp,coins,at) SELECT ?, key, 0, 0, ? FROM games WHERE (w_user=? OR b_user=?) AND end_time<=?", uid, now(), u.cc, u.cc, w);
        return { msg: "Baseline set. Play some rated games, then sync again to earn XP!", count: 0, gained: 0, coinsGained: 0, leveled: false, won: 0 };
      }
      const cc = u.cc, since = now() - 86400;
      const fresh = db.prepare(`SELECT * FROM games g WHERE (w_user=@cc OR b_user=@cc) AND end_time>=@wm AND rated=1 AND rules='chess'
        AND NOT EXISTS(SELECT 1 FROM claims c WHERE c.user_id=@uid AND c.game_key=g.key) ORDER BY end_time, key LIMIT @n`).all({ cc, wm: u.watermark, uid, n: BATCH });
      const b = R.bonusOf(equippedRows(uid)).stats;
      let { xp, streak, best, games: gm, wins } = u, dayXp = get("SELECT COALESCE(SUM(xp),0) s FROM claims WHERE user_id=? AND at>?", uid, since).s;
      let gained = 0, coinsGained = 0, won = 0;
      const prevQ = db.prepare(`SELECT CASE WHEN w_user=@cc THEN w_rating ELSE b_rating END r FROM games WHERE (w_user=@cc OR b_user=@cc) AND tclass=@tc AND end_time<@et ORDER BY end_time DESC LIMIT 1`);
      const oppQ = db.prepare(`SELECT COUNT(*) n FROM claims c JOIN games x ON x.key=c.game_key WHERE c.user_id=@uid AND c.at>@since AND c.xp>0 AND (CASE WHEN x.w_user=@cc THEN x.b_user ELSE x.w_user END)=@opp`);
      for (const g of fresh) {
        const white = g.w_user === cc, me = white ? { r: g.w_rating, res: g.w_result } : { r: g.b_rating, res: g.b_result };
        const opp = white ? { n: g.b_user, r: g.b_rating } : { n: g.w_user, r: g.w_rating };
        let rx = 0, rc = 0;
        if (g.plies >= R.MIN_PLIES && oppQ.get({ uid, since, cc, opp: opp.n }).n < R.PER_OPPONENT_DAILY) {
          const res = R.resultOf(me.res), prev = prevQ.get({ cc, tc: g.tclass, et: g.end_time });
          if (res === "win") { streak++; best = Math.max(best, streak); won++; wins++; }
          else if (res === "loss") { if (qty(uid, "shield") > 0) grant(uid, "shield", -1, "shield_used", g.key); else streak = 0; }
          const r = R.calcReward({ res, gap: opp.r - (prev ? prev.r : me.r), streakAfter: streak }, b, { dayXp });
          rx = r.xp; rc = r.coins; xp += rx; dayXp += rx; gm++; gained += rx; coinsGained += rc;
        }
        run("INSERT INTO claims(user_id,game_key,xp,coins,at) VALUES(?,?,?,?,?)", uid, g.key, rx, rc, now());
        grant(uid, "coins", rc, "game", g.key);
      }
      const wm = fresh.length ? fresh[fresh.length - 1].end_time : u.watermark;
      run("UPDATE users SET xp=?, streak=?, best=?, games=?, wins=?, watermark=? WHERE id=?", xp, streak, best, gm, wins, wm, uid);
      return { count: fresh.length, gained, coinsGained, leveled: lvl(xp) > lvl(u.xp), won };
    });
  }

  // ---- shop, inventory, workshop ----
  const buy = (uid, id) => tx(() => {
    if (id === "shield") { spend(uid, { coins: C.SHIELD.price }, "buy", "shield"); grant(uid, "shield", 1, "buy", "shield"); return; }
    const d = C.ITEM[id]; if (!d || !d.price) throw new AppError("not_for_sale", "That item can’t be bought.", 404);
    spend(uid, { coins: d.price }, "buy", id); giveItem(uid, id, "buy");
  });
  const equip = (uid, iid) => tx(() => {
    const it = owned(uid, iid), d = C.ITEM[it.def], cur = get("SELECT item_id FROM equipment WHERE user_id=? AND slot=?", uid, d.slot);
    run("DELETE FROM equipment WHERE user_id=? AND slot=?", uid, d.slot);
    if (cur && cur.item_id === it.id) { if (d.slot === "title") run("UPDATE users SET title='' WHERE id=?", uid); return; }
    run("INSERT INTO equipment(user_id,slot,item_id) VALUES(?,?,?)", uid, d.slot, it.id);
    if (d.slot === "title") run("UPDATE users SET title=? WHERE id=?", d.name, uid);
  });
  const upgrade = (uid, iid) => tx(() => {
    const it = owned(uid, iid), cost = C.upgradeCost(C.ITEM[it.def], it.level);
    if (!cost) throw new AppError("max_level", "That item is already at max level.");
    spend(uid, cost, "upgrade", iid); run("UPDATE items SET level=level+1 WHERE id=?", it.id);
  });
  const dismantle = (uid, iid) => tx(() => {
    const it = owned(uid, iid), d = C.ITEM[it.def];
    if (get("SELECT 1 FROM equipment WHERE item_id=?", it.id)) throw new AppError("equipped", "Unequip that item first.");
    run("DELETE FROM items WHERE id=?", it.id); ledger(uid, "item:" + it.def, -1, "dismantle", it.id);
    for (const [k, v] of Object.entries(C.dismantleYield(d, it.level))) grant(uid, k, v, "dismantle", it.id);
  });
  const craft = (uid, id) => tx(() => {
    const d = C.ITEM[id]; if (!C.craftable(d)) throw new AppError("not_craftable", "That can’t be crafted.", 404);
    spend(uid, C.CRAFT_COST[d.r], "craft", id); giveItem(uid, id, "craft");
  });

  // ---- read models ----
  function view(uid) {
    const u = user(uid), bal = Object.fromEntries(all("SELECT kind, qty FROM balances WHERE user_id=?", uid).map(r => [r.kind, r.qty]));
    const rows = all("SELECT i.id, i.def, i.level, e.slot FROM items i LEFT JOIN equipment e ON e.item_id=i.id WHERE i.user_id=? ORDER BY i.id", uid);
    const b = R.bonusOf(rows.filter(r => r.slot)), L = lvl(u.xp);
    return { username: u.username, cc: u.cc, pending: u.cc_pending, code: u.cc_code, xp: u.xp, level: L, lo: need(L), hi: need(L + 1),
      streak: u.streak, best: u.best, games: u.games, wins: u.wins, title: u.title, coins: bal.coins || 0, shield: bal.shield || 0,
      mats: { shard: bal.shard || 0, essence: bal.essence || 0, relic: bal.relic || 0 }, bonus: b.stats, sets: b.active,
      items: rows.map(r => { const d = C.ITEM[r.def]; return { id: r.id, def: r.def, level: r.level, slot: r.slot || null, up: C.upgradeCost(d, r.level), dis: C.dismantleYield(d, r.level) }; }) };
  }
  function leaderboard() {
    const rows = all("SELECT id, username, xp, wins, best, title FROM users WHERE cc IS NOT NULL ORDER BY xp DESC, id ASC LIMIT 20");
    return rows.map(r => {
      const eq = all("SELECT i.def FROM equipment e JOIN items i ON i.id=e.item_id WHERE e.user_id=?", r.id).map(x => C.ITEM[x.def]);
      const top = eq.sort((a, b) => b.r - a.r)[0];
      return { username: r.username, xp: r.xp, level: lvl(r.xp), wins: r.wins, best: r.best, title: r.title, g: top ? top.g : "♟\uFE0E" };
    });
  }
  return { user, createUser, bumpSession, startLink, finishLink, unlink, sync, buy, equip, upgrade, dismantle, craft, view, leaderboard, _grant: grant, _tx: tx };
}
module.exports = { createCore, lvl, need };
