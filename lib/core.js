"use strict";
// The single authoritative place where balances, items and rewards change.
// Every mutation runs inside one BEGIN IMMEDIATE transaction and re-reads what it needs inside it.
const C = require("./content"), R = require("./rules"), { AppError } = require("./errors");
const lvl = xp => Math.floor(Math.sqrt(xp / 50)) + 1, need = l => 50 * (l - 1) * (l - 1);

function createCore(db, opts = {}) {
  const BATCH = opts.batch || 200, now = opts.now || (() => Math.floor(Date.now() / 1000)), log = opts.log || (() => {});
  const tx = f => db.transaction(f).immediate();
  // wraps a mutation: runs in one transaction, then checks achievements and returns any newly unlocked
  const mut = f => (uid, ...a) => tx(() => { const r = f(uid, ...a) || {}; return { ...r, ach: [...(r.ach || []), ...checkAch(uid)] }; });
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
      return tx(() => {
        const u = user(uid);
        if (u.cc !== u.cc_pending) run("UPDATE users SET watermark=0 WHERE id=?", uid);
        run("UPDATE users SET cc=cc_pending, cc_player_id=?, cc_pending=NULL, cc_code=NULL WHERE id=?", playerId, uid);
        return { ach: checkAch(uid) };
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
        return { msg: "Baseline set. Play some rated games, then sync again to earn XP!", count: 0, gained: 0, coinsGained: 0, leveled: false, won: 0, drops: {}, ach: [] };
      }
      const cc = u.cc, since = now() - 86400;
      const fresh = db.prepare(`SELECT * FROM games g WHERE (w_user=@cc OR b_user=@cc) AND end_time>=@wm AND rated=1 AND rules='chess'
        AND NOT EXISTS(SELECT 1 FROM claims c WHERE c.user_id=@uid AND c.game_key=g.key) ORDER BY end_time, key LIMIT @n`).all({ cc, wm: u.watermark, uid, n: BATCH });
      const b = R.bonusOf(equippedRows(uid)).stats;
      let { xp, streak, best, games: gm, wins } = u, dayXp = get("SELECT COALESCE(SUM(xp),0) s FROM claims WHERE user_id=? AND at>?", uid, since).s;
      let gained = 0, coinsGained = 0, won = 0; const drops = {}, ach = [];
      const buffs = Object.fromEntries(all("SELECT kind, games_left FROM buffs WHERE user_id=?", uid).map(r => [r.kind, r.games_left]));
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
          const gap = opp.r - (prev ? prev.r : me.r), eff = { ...b };
          for (const [k, n] of Object.entries(buffs)) if (n > 0) for (const st in C.CONS[k].stats) eff[st] += C.CONS[k].stats[st];
          const before = dayXp, r = R.calcReward({ res, gap, streakAfter: streak }, eff, { dayXp });
          rx = r.xp; rc = r.coins; xp += rx; dayXp += rx; gm++; gained += rx; coinsGained += rc;
          for (const k in buffs) if (buffs[k] > 0) buffs[k]--;
          if (res === "win" && gap >= 200) ach.push(...unlock(uid, "giant"));
          if (before < R.DAY_SOFT_CAP) { // material drops: guaranteed, transparent, and paused once the daily soft cap is hit
            const dr = { shard: res === "win" ? 3 : res === "draw" ? 2 : 1 };
            if (res === "win") { if (wins % 3 === 0) dr.essence = 1; if (wins % 10 === 0) dr.relic = 1; }
            for (const [k, v] of Object.entries(dr)) { grant(uid, k, v, "drop", g.key); drops[k] = (drops[k] || 0) + v; }
          }
        }
        run("INSERT INTO claims(user_id,game_key,xp,coins,at) VALUES(?,?,?,?,?)", uid, g.key, rx, rc, now());
        grant(uid, "coins", rc, "game", g.key);
      }
      const wm = fresh.length ? fresh[fresh.length - 1].end_time : u.watermark;
      run("UPDATE users SET xp=?, streak=?, best=?, games=?, wins=?, watermark=? WHERE id=?", xp, streak, best, gm, wins, wm, uid);
      for (const [k, n] of Object.entries(buffs)) { if (n > 0) run("UPDATE buffs SET games_left=? WHERE user_id=? AND kind=?", n, uid, k); else run("DELETE FROM buffs WHERE user_id=? AND kind=?", uid, k); }
      return { count: fresh.length, gained, coinsGained, leveled: lvl(xp) > lvl(u.xp), won, drops, ach: [...ach, ...checkAch(uid)] };
    });
  }

  // ---- shop, inventory, workshop ----
  const buy = mut((uid, id) => {
    if (id === "shield") { spend(uid, { coins: C.SHIELD.price }, "buy", "shield"); grant(uid, "shield", 1, "buy", "shield"); return; }
    const d = C.ITEM[id]; if (!d || !d.price) throw new AppError("not_for_sale", "That item can’t be bought.", 404);
    spend(uid, { coins: d.price }, "buy", id); giveItem(uid, id, "buy");
  });
  const equip = mut((uid, iid) => {
    const it = owned(uid, iid), d = C.ITEM[it.def], cur = get("SELECT item_id FROM equipment WHERE user_id=? AND slot=?", uid, d.slot);
    run("DELETE FROM equipment WHERE user_id=? AND slot=?", uid, d.slot);
    if (cur && cur.item_id === it.id) { if (d.slot === "title") run("UPDATE users SET title='' WHERE id=?", uid); return; }
    run("INSERT INTO equipment(user_id,slot,item_id) VALUES(?,?,?)", uid, d.slot, it.id);
    if (d.slot === "title") run("UPDATE users SET title=? WHERE id=?", d.name, uid);
  });
  const upgrade = mut((uid, iid) => {
    const it = owned(uid, iid), cost = C.upgradeCost(C.ITEM[it.def], it.level);
    if (!cost) throw new AppError("max_level", "That item is already at max level.");
    spend(uid, cost, "upgrade", iid); run("UPDATE items SET level=level+1 WHERE id=?", it.id);
  });
  const dismantle = mut((uid, iid) => {
    const it = owned(uid, iid), d = C.ITEM[it.def];
    if (get("SELECT 1 FROM equipment WHERE item_id=?", it.id)) throw new AppError("equipped", "Unequip that item first.");
    run("DELETE FROM items WHERE id=?", it.id); ledger(uid, "item:" + it.def, -1, "dismantle", it.id);
    for (const [k, v] of Object.entries(C.dismantleYield(d, it.level))) grant(uid, k, v, "dismantle", it.id);
  });

  // ---- crafting table: pattern recipes ----
  function resolveGrid(uid, grid) {
    if (!Array.isArray(grid) || grid.length !== 9) throw new AppError("bad_grid", "Invalid crafting grid.");
    const toks = [], items = [], mats = {}, seen = new Set();
    for (const c of grid) {
      if (!c) { toks.push(null); continue; }
      if (c.t === "mat") { if (!C.MATS[c.k]) throw new AppError("bad_grid", "Unknown material."); toks.push(c.k); mats[c.k] = (mats[c.k] || 0) + 1; }
      else if (c.t === "item") {
        const iid = Number(c.id); if (seen.has(iid)) throw new AppError("bad_grid", "An item can only be used once."); seen.add(iid);
        const it = owned(uid, iid);
        if (get("SELECT 1 FROM equipment WHERE item_id=?", it.id)) throw new AppError("equipped", `Unequip ${C.ITEM[it.def].name} before using it.`);
        toks.push(it.def); items.push(it);
      } else throw new AppError("bad_grid", "Invalid crafting grid.");
    }
    const recipe = C.matchRecipe(toks); if (!recipe) return { recipe: null };
    const cost = {}; for (const [k, n] of Object.entries(mats)) cost[k] = n * recipe.mult;
    if (recipe.fee) cost.coins = recipe.fee;
    return { recipe, cost, items };
  }
  const knownRow = (uid, id) => get("SELECT times FROM recipes_known WHERE user_id=? AND recipe=?", uid, id);
  function preview(uid, grid) {
    const g = resolveGrid(uid, grid); if (!g.recipe) return { match: false };
    return { match: true, out: { type: g.recipe.out[0], id: g.recipe.out[1], qty: g.recipe.qty || 1 }, cost: g.cost,
      can: Object.entries(g.cost).every(([k, v]) => qty(uid, k) >= v), known: !!knownRow(uid, g.recipe.id) };
  }
  const craft = mut((uid, grid) => {
    const g = resolveGrid(uid, grid); if (!g.recipe) throw new AppError("no_recipe", "Those ingredients don’t make anything.");
    spend(uid, g.cost, "craft", g.recipe.id);
    for (const it of g.items) { run("DELETE FROM items WHERE id=?", it.id); ledger(uid, "item:" + it.def, -1, "craft", it.id); }
    const [type, id] = g.recipe.out, q = g.recipe.qty || 1;
    if (type === "item") giveItem(uid, id, "craft"); else grant(uid, id, q, "craft", g.recipe.id);
    const first = !knownRow(uid, g.recipe.id);
    run("INSERT INTO recipes_known(user_id,recipe,times,at) VALUES(?,?,1,?) ON CONFLICT(user_id,recipe) DO UPDATE SET times=times+1", uid, g.recipe.id, now());
    return { crafted: { type, id, qty: q }, discovered: first };
  });
  const use = mut((uid, kind) => {
    const c = C.CONS[kind]; if (!c || !c.games) throw new AppError("not_usable", "That can’t be used directly.", 404);
    spend(uid, { [kind]: 1 }, "use", kind);
    run("INSERT INTO buffs(user_id,kind,games_left) VALUES(?,?,?) ON CONFLICT(user_id,kind) DO UPDATE SET games_left=MIN(games_left+excluded.games_left, ?)", uid, kind, c.games, C.MAX_BUFF_GAMES);
  });

  // ---- achievements ----
  function achStats(uid) {
    const u = user(uid), rows = all("SELECT i.def, e.slot FROM items i LEFT JOIN equipment e ON e.item_id=i.id WHERE i.user_id=?", uid);
    const eq = all("SELECT i.def, i.level FROM equipment e JOIN items i ON i.id=e.item_id WHERE e.user_id=?", uid);
    const n = (sql) => get(sql, uid).n;
    return { linked: u.cc ? 1 : 0, wins: u.wins, best: u.best, games: u.games, level: lvl(u.xp),
      crafts: n("SELECT COALESCE(SUM(times),0) n FROM recipes_known WHERE user_id=?"), known: n("SELECT COUNT(*) n FROM recipes_known WHERE user_id=?"),
      dismantles: n("SELECT COUNT(*) n FROM ledger WHERE user_id=? AND reason='dismantle' AND kind LIKE 'item:%'"),
      upgrades: n("SELECT COUNT(*) n FROM ledger WHERE user_id=? AND reason='upgrade' AND kind='coins'"),
      uses: n("SELECT COUNT(*) n FROM ledger WHERE user_id=? AND reason='use'"),
      gear: rows.filter(r => ["weapon", "armor", "helmet", "boots", "ring", "amulet"].includes(r.slot)).length,
      set: R.bonusOf(eq).active.length, rarity: rows.reduce((m, r) => Math.max(m, C.ITEM[r.def].r), -1),
      shards: qty(uid, "shard"), distinct: new Set(rows.map(r => r.def)).size, special: 0,
      quests: n("SELECT COUNT(*) n FROM quest_claims WHERE user_id=?") };
  }
  function checkAch(uid) {
    const have = new Set(all("SELECT id FROM achievements WHERE user_id=?", uid).map(r => r.id)), s = achStats(uid), got = [];
    for (const a of C.ACH) if (!have.has(a.id) && a.rule !== "special" && s[a.rule] >= a.n) got.push(...unlock(uid, a.id));
    return got;
  }
  function unlock(uid, id) {
    const a = C.ACHIEVEMENT[id];
    if (!run("INSERT OR IGNORE INTO achievements(user_id,id,at) VALUES(?,?,?)", uid, id, now()).changes) return [];
    grant(uid, "coins", a.reward, "achievement", id); return [id];
  }

  // ---- daily and weekly quests: progress comes from rewarded claims, so the anti-farming limits apply ----
  function questBoard(uid, kind) {
    const u = user(uid), p = R.periodOf(kind, now()), picked = R.pickQuests(C.QUESTS[kind], `${uid}:${p.key}`, C.QUESTS_PER_PERIOD);
    const games = all(`SELECT g.* FROM claims c JOIN games g ON g.key=c.game_key WHERE c.user_id=? AND c.xp>0 AND g.end_time>=? AND g.end_time<?`, uid, p.start, p.end)
      .filter(g => g.w_user === u.cc || g.b_user === u.cc).map(g => {
        const white = g.w_user === u.cc, mine = white ? g.w_rating : g.b_rating, theirs = white ? g.b_rating : g.w_rating;
        return { res: R.resultOf(white ? g.w_result : g.b_result), tclass: g.tclass, upset: theirs > mine };
      });
    const done = new Set(all("SELECT quest FROM quest_claims WHERE user_id=? AND period=?", uid, p.key).map(r => r.quest));
    return { key: p.key, ends: p.end, list: picked.map(q => ({ id: q.id, desc: q.desc, n: q.n, cur: R.questProgress(q, games), reward: q.reward, claimed: done.has(q.id) })) };
  }
  const quests = uid => ({ daily: questBoard(uid, "daily"), weekly: questBoard(uid, "weekly") });
  const claimQuest = mut((uid, qid) => {
    const q = C.QUEST[qid], board = q && questBoard(uid, q.kind), mine = board && board.list.find(x => x.id === qid);
    if (!mine) throw new AppError("not_found", "That quest isn’t one of yours right now.", 404);
    if (mine.cur < mine.n) throw new AppError("not_done", "Finish the quest before claiming it.");
    if (!run("INSERT OR IGNORE INTO quest_claims(user_id,period,quest,at) VALUES(?,?,?,?)", uid, board.key, qid, now()).changes) throw new AppError("claimed", "You already claimed that quest.", 409);
    for (const [k, v] of Object.entries(q.reward)) grant(uid, k, v, "quest", `${board.key}:${qid}`);
    return { quest: { id: qid, reward: q.reward } };
  });

  // ---- read models ----
  function view(uid) {
    const u = user(uid), bal = Object.fromEntries(all("SELECT kind, qty FROM balances WHERE user_id=?", uid).map(r => [r.kind, r.qty]));
    const rows = all("SELECT i.id, i.def, i.level, e.slot FROM items i LEFT JOIN equipment e ON e.item_id=i.id WHERE i.user_id=? ORDER BY i.id", uid);
    const b = R.bonusOf(rows.filter(r => r.slot)), L = lvl(u.xp);
    const have = new Set(all("SELECT id FROM achievements WHERE user_id=?", uid).map(r => r.id)), st = achStats(uid);
    return { username: u.username, cc: u.cc, pending: u.cc_pending, code: u.cc_code, xp: u.xp, level: L, lo: need(L), hi: need(L + 1),
      streak: u.streak, best: u.best, games: u.games, wins: u.wins, title: u.title, coins: bal.coins || 0, shield: bal.shield || 0,
      mats: { shard: bal.shard || 0, essence: bal.essence || 0, relic: bal.relic || 0 }, bonus: b.stats, sets: b.active,
      cons: Object.fromEntries(Object.keys(C.CONS).map(k => [k, bal[k] || 0])),
      buffs: Object.fromEntries(all("SELECT kind, games_left FROM buffs WHERE user_id=?", uid).map(r => [r.kind, r.games_left])),
      quests: quests(uid),
      items: rows.map(r => { const d = C.ITEM[r.def]; return { id: r.id, def: r.def, level: r.level, slot: r.slot || null, up: C.upgradeCost(d, r.level), dis: C.dismantleYield(d, r.level) }; }),
      recipes: C.RECIPES.map(r => {
        const k = knownRow(uid, r.id); if (k) return { id: r.id, known: true, times: k.times, out: r.out, rows: r.rows, key: r.key, mult: r.mult, fee: r.fee };
        const open = !r.hintAch || have.has(r.hintAch);
        return { id: r.id, known: false, out: r.out, hint: open ? r.hint : null, lock: open ? null : r.hintAch };
      }),
      ach: Object.fromEntries(C.ACH.map(a => [a.id, have.has(a.id) ? (a.hidden ? { done: 1, name: a.name, desc: a.desc } : { done: 1 }) : a.hidden ? {} : progress(a, st)])) };
  }
  // rarity is a tier, not a count, so "own a Rare item" shows 0 / 1 instead of a misleading "1 / 2"
  function progress(a, st) {
    if (a.rule === "rarity") return { cur: 0, max: 1 };
    return { cur: Math.max(0, Math.min(st[a.rule] || 0, a.n)), max: a.n };
  }
  function leaderboard() {
    const rows = all("SELECT id, username, xp, wins, best, title FROM users WHERE cc IS NOT NULL ORDER BY xp DESC, id ASC LIMIT 20");
    return rows.map(r => {
      const eq = all("SELECT i.def FROM equipment e JOIN items i ON i.id=e.item_id WHERE e.user_id=?", r.id).map(x => C.ITEM[x.def]);
      const top = eq.sort((a, b) => b.r - a.r)[0];
      return { username: r.username, xp: r.xp, level: lvl(r.xp), wins: r.wins, best: r.best, title: r.title, ic: top ? top.id : null };
    });
  }
  return { user, createUser, bumpSession, startLink, finishLink, unlink, sync, buy, equip, upgrade, dismantle, craft, preview, use, quests, claimQuest, view, leaderboard, _grant: grant, _tx: tx };
}
module.exports = { createCore, lvl, need };
