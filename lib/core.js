"use strict";
// The single authoritative place where balances, items and rewards change.
// Every mutation runs inside one BEGIN IMMEDIATE transaction and re-reads what it needs inside it.
const crypto = require("crypto"), C = require("./content"), R = require("./rules"), { AppError } = require("./errors");
const lvl = xp => Math.floor(Math.sqrt(xp / 50)) + 1, need = l => 50 * (l - 1) * (l - 1);

function createCore(db, opts = {}) {
  const BATCH = opts.batch || 200, now = opts.now || (() => Math.floor(Date.now() / 1000)), rand = opts.rand || (() => crypto.randomInt(0, 1e9) / 1e9), log = opts.log || (() => {});
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
  // sign-up after proving a chess.com account: the account is created already linked, or not at all
  function createLinkedUser(username, salt, hash, cc, playerId) {
    try {
      return tx(() => {
        const id = Number(run("INSERT INTO users(username,salt,hash,cc,cc_player_id) VALUES(?,?,?,?,?)", username, salt, hash, cc, playerId).lastInsertRowid);
        grant(id, "coins", C.WELCOME_COINS, "welcome", null); checkAch(id); return id;
      });
    } catch (e) {
      if (/users\.username/.test(e.message)) throw new AppError("username_taken", "That username is taken.", 409);
      if (/users\.cc/.test(e.message)) throw new AppError("cc_taken", "That chess.com account is already linked to another account.", 409);
      throw e;
    }
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
            if (res === "win") { const ch = R.rollChest(C.CHESTS, rand()); if (ch) dr["chest:" + ch.id] = 1; } // a resource chest, sometimes
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
    if (it.locked) throw new AppError("locked", "That item is locked. Unlock it first.");
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
        if (it.locked) throw new AppError("locked", `${C.ITEM[it.def].name} is locked. Unlock it to craft with it.`);
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

  // ---- resource chests: earned from wins, opened for materials ----
  const openChest = mut((uid, id, n = 1) => {
    const ch = C.CHESTS.find(c => c.id === id); if (!ch) throw new AppError("not_found", "Unknown chest.", 404);
    n = Number.isInteger(n) && n >= 1 ? Math.min(n, C.MAX_OPEN) : 1;
    spend(uid, { ["chest:" + id]: n }, "open", id);
    const loot = {};
    for (let i = 0; i < n; i++) for (const [k, v] of Object.entries(R.rollLoot(ch, rand))) loot[k] = (loot[k] || 0) + v;
    for (const [k, v] of Object.entries(loot)) grant(uid, k, v, "chest", id);
    return { opened: { id, n, loot } };
  });

  // ---- inventory helpers: locks and clearing out duplicates ----
  const toggleLock = mut((uid, iid) => { const it = owned(uid, iid); run("UPDATE items SET locked=? WHERE id=?", it.locked ? 0 : 1, it.id); });
  // spare copies: for each item, keep the highest-level copy and every locked or equipped copy; the rest are duplicates. The preview only reports them; dismantleDupes dismantles them like normal.
  function duplicates(uid) {
    const rows = all("SELECT i.*, e.slot eq FROM items i LEFT JOIN equipment e ON e.item_id=i.id WHERE i.user_id=? ORDER BY i.def, i.level DESC, (e.slot IS NOT NULL) DESC, i.locked DESC, i.id", uid);
    const seen = new Set(); return rows.filter(r => { const first = !seen.has(r.def); seen.add(r.def); return !first && !r.eq && !r.locked; });
  }
  function dupesPreview(uid) {
    const d = duplicates(uid), y = {};
    for (const it of d) for (const [k, v] of Object.entries(C.dismantleYield(C.ITEM[it.def], it.level))) y[k] = (y[k] || 0) + v;
    return { count: d.length, yield: y, items: d.map(it => ({ id: it.id, def: it.def, level: it.level })) };
  }
  const dismantleDupes = mut(uid => {
    const p = dupesPreview(uid);
    for (const it of p.items) { run("DELETE FROM items WHERE id=?", it.id); ledger(uid, "item:" + it.def, -1, "dismantle", it.id); }
    for (const [k, v] of Object.entries(p.yield)) grant(uid, k, v, "dismantle", "duplicates");
    return { dupes: { count: p.count, yield: p.yield } };
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
      chests: n("SELECT COALESCE(-SUM(delta),0) n FROM ledger WHERE user_id=? AND reason='open' AND kind LIKE 'chest:%'"),
      shards: qty(uid, "shard"), distinct: new Set(rows.map(r => r.def)).size, special: 0,
      quests: n("SELECT COUNT(*) n FROM quest_claims WHERE user_id=?"), merchant: n("SELECT COALESCE(SUM(qty),0) n FROM merchant_buys WHERE user_id=?"),
      wanderer: eq.filter(r => C.ITEM[r.def].set === "wanderer").length,
      friends: n("SELECT COUNT(*) n FROM friends WHERE user_id=?"), clan: n("SELECT COUNT(*) n FROM clan_members WHERE user_id=?") };
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

  // ---- the Wandering Merchant: daily offers, each with a per-player daily limit ----
  function merchant(uid) {
    const p = R.periodOf("daily", now());
    const bought = Object.fromEntries(all("SELECT offer, qty FROM merchant_buys WHERE user_id=? AND period=?", uid, p.key).map(r => [r.offer, r.qty]));
    return { key: p.key, ends: p.end, offers: R.merchantOffers(p.key).map(o => ({ ...o, left: Math.max(0, o.limit - (bought[o.id] || 0)) })) };
  }
  const buyOffer = mut((uid, oid) => {
    const m = merchant(uid), o = m.offers.find(x => x.id === oid);
    if (!o) throw new AppError("not_found", "The merchant isn’t selling that today.", 404);
    if (!o.left) throw new AppError("sold_out", "You’ve bought all of that offer for today.");
    spend(uid, o.cost, "merchant", `${m.key}:${oid}`);
    if (o.give.t === "item") giveItem(uid, o.give.id, "merchant"); else grant(uid, o.give.id, o.give.qty, "merchant", `${m.key}:${oid}`);
    run("INSERT INTO merchant_buys(user_id,period,offer,qty) VALUES(?,?,?,1) ON CONFLICT(user_id,period,offer) DO UPDATE SET qty=qty+1", uid, m.key, oid);
    return { bought: o.give };
  });

  // ---- account settings ----
  function setTheme(uid, id) {
    const t = C.THEME[id]; if (!t) throw new AppError("not_found", "Unknown theme.", 404);
    if (user(uid).wins < t.wins) throw new AppError("locked", `Win ${t.wins} rated games to unlock ${t.name}.`);
    run("UPDATE users SET theme=? WHERE id=?", id, uid);
  }
  // also bumps the session version, which logs out every other device
  const setPassword = (uid, salt, hash) => run("UPDATE users SET salt=?, hash=?, sv=sv+1 WHERE id=?", salt, hash, uid);

  // ---- friends ----
  const byName = name => get("SELECT * FROM users WHERE username=?", String(name || "").trim().toLowerCase());
  function other(uid, name) {
    const o = byName(name); if (!o) throw new AppError("not_found", "No player with that username.", 404);
    if (o.id === uid) throw new AppError("self", "That’s you!");
    return o;
  }
  const areFriends = (a, b) => !!get("SELECT 1 FROM friends WHERE user_id=? AND friend_id=?", a, b);
  const friendCount = uid => get("SELECT COUNT(*) n FROM friends WHERE user_id=?", uid).n;
  function relation(me, them) {
    if (me === them) return "self";
    if (areFriends(me, them)) return "friends";
    if (get("SELECT 1 FROM friend_requests WHERE from_id=? AND to_id=?", me, them)) return "sent";
    if (get("SELECT 1 FROM friend_requests WHERE from_id=? AND to_id=?", them, me)) return "received";
    return "none";
  }
  function befriend(a, b) {
    if (friendCount(a) >= C.MAX_FRIENDS || friendCount(b) >= C.MAX_FRIENDS) throw new AppError("friend_limit", `Players can have up to ${C.MAX_FRIENDS} friends.`);
    run("DELETE FROM friend_requests WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)", a, b, b, a);
    run("INSERT OR IGNORE INTO friends(user_id,friend_id,at) VALUES(?,?,?),(?,?,?)", a, b, now(), b, a, now());
  }
  // sending a request to someone who already asked you makes you friends straight away
  const addFriend = mut((uid, name) => {
    const o = other(uid, name), rel = relation(uid, o.id);
    if (rel === "friends") throw new AppError("already", "You’re already friends.");
    if (rel === "received") { befriend(uid, o.id); return { friend: "accepted" }; }
    if (friendCount(uid) >= C.MAX_FRIENDS) throw new AppError("friend_limit", `Players can have up to ${C.MAX_FRIENDS} friends.`);
    run("INSERT OR IGNORE INTO friend_requests(from_id,to_id,at) VALUES(?,?,?)", uid, o.id, now());
    return { friend: "sent" };
  });
  const answerFriend = mut((uid, name, accept) => {
    const o = other(uid, name);
    if (relation(uid, o.id) !== "received") throw new AppError("not_found", "That friend request isn’t there any more.", 404);
    if (accept) befriend(uid, o.id); else run("DELETE FROM friend_requests WHERE from_id=? AND to_id=?", o.id, uid);
    return { friend: accept ? "accepted" : "declined" };
  });
  // removes a friend, or cancels a request in either direction
  const removeFriend = mut((uid, name) => {
    const o = other(uid, name);
    run("DELETE FROM friends WHERE (user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)", uid, o.id, o.id, uid);
    run("DELETE FROM friend_requests WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)", uid, o.id, o.id, uid);
  });
  function setPrivacy(uid, v) {
    if (v !== "public" && v !== "friends") throw new AppError("bad_privacy", "Choose public or friends only.");
    run("UPDATE users SET privacy=? WHERE id=?", v, uid);
  }
  const card = u => { const c = clanOf(u.id); return { username: u.username, level: lvl(u.xp), xp: u.xp, wins: u.wins, title: u.title, tag: c ? c.tag : null }; };
  function social(uid) {
    const names = sql => all(sql, uid).map(card);
    return {
      friends: names("SELECT u.* FROM friends f JOIN users u ON u.id=f.friend_id WHERE f.user_id=? ORDER BY u.xp DESC"),
      received: names("SELECT u.* FROM friend_requests r JOIN users u ON u.id=r.from_id WHERE r.to_id=? ORDER BY r.at"),
      sent: names("SELECT u.* FROM friend_requests r JOIN users u ON u.id=r.to_id WHERE r.from_id=? ORDER BY r.at"),
    };
  }

  // ---- public profiles ----
  function publicProfile(viewer, name) {
    const u = byName(name); if (!u) throw new AppError("not_found", "No player with that username.", 404);
    const rel = relation(viewer, u.id), c = clanOf(u.id);
    const base = { username: u.username, rel, clan: c ? { id: c.id, name: c.name, tag: c.tag } : null, title: u.title, level: lvl(u.xp) };
    if (u.privacy === "friends" && rel !== "friends" && rel !== "self") return { ...base, private: true };
    const eq = all("SELECT i.def, i.level, e.slot FROM equipment e JOIN items i ON i.id=e.item_id WHERE e.user_id=?", u.id);
    const ach = all("SELECT id FROM achievements WHERE user_id=? ORDER BY at", u.id).map(r => r.id).filter(id => C.ACHIEVEMENT[id])
      .map(id => { const a = C.ACHIEVEMENT[id]; return a.hidden ? { id, name: a.name, desc: a.desc } : { id }; });
    return { ...base, private: false, xp: u.xp, wins: u.wins, games: u.games, best: u.best, streak: u.streak, cc: u.cc, since: u.created_at,
      gear: eq.map(r => ({ def: r.def, level: r.level, slot: r.slot })), bonus: R.bonusOf(eq).stats, sets: R.bonusOf(eq).active, ach };
  }

  // ---- clans ----
  const clanOf = uid => get("SELECT c.* FROM clan_members m JOIN clans c ON c.id=m.clan_id WHERE m.user_id=?", uid);
  const clanSize = id => get("SELECT COUNT(*) n FROM clan_members WHERE clan_id=?", id).n;
  const weekStart = () => R.periodOf("weekly", now()).start;
  function clanXp(id) {
    return { xp: get("SELECT COALESCE(SUM(u.xp),0) s FROM clan_members m JOIN users u ON u.id=m.user_id WHERE m.clan_id=?", id).s,
      week: get("SELECT COALESCE(SUM(c.xp),0) s FROM claims c JOIN clan_members m ON m.user_id=c.user_id WHERE m.clan_id=? AND c.at>=?", id, weekStart()).s };
  }
  function addMember(uid, c) {
    if (clanSize(c.id) >= C.CLAN_MAX) throw new AppError("clan_full", `That clan is full (${C.CLAN_MAX} members).`);
    run("INSERT INTO clan_members(user_id,clan_id,joined_at) VALUES(?,?,?)", uid, c.id, now());
    run("DELETE FROM clan_requests WHERE user_id=?", uid);
  }
  function myClan(uid, leaderOnly) {
    const c = clanOf(uid); if (!c) throw new AppError("no_clan", "You’re not in a clan.");
    if (leaderOnly && c.leader !== uid) throw new AppError("not_leader", "Only the clan leader can do that.", 403);
    return c;
  }
  const createClan = mut((uid, name, tag) => {
    name = String(name || "").trim().replace(/\s+/g, " "); tag = String(tag || "").trim().toUpperCase();
    if (!/^[A-Za-z0-9][A-Za-z0-9 ]{1,22}[A-Za-z0-9]$/.test(name)) throw new AppError("bad_name", "Clan name: 3-24 letters, numbers or spaces.");
    if (!/^[A-Z0-9]{2,5}$/.test(tag)) throw new AppError("bad_tag", "Clan tag: 2-5 letters or numbers.");
    if (clanOf(uid)) throw new AppError("in_clan", "Leave your current clan first.");
    if (get("SELECT 1 FROM clans WHERE name=?", name)) throw new AppError("name_taken", "That clan name is taken.", 409);
    if (get("SELECT 1 FROM clans WHERE tag=?", tag)) throw new AppError("tag_taken", "That clan tag is taken.", 409);
    spend(uid, { coins: C.CLAN_COST }, "clan", tag);
    const id = Number(run("INSERT INTO clans(name,tag,leader,open,at) VALUES(?,?,?,1,?)", name, tag, uid, now()).lastInsertRowid);
    addMember(uid, { id }); return { clanAction: "created" };
  });
  const joinClan = mut((uid, id) => {
    const c = Number.isInteger(id) ? get("SELECT * FROM clans WHERE id=?", id) : null;
    if (!c) throw new AppError("not_found", "That clan doesn’t exist.", 404);
    if (clanOf(uid)) throw new AppError("in_clan", "Leave your current clan first.");
    if (c.open) { addMember(uid, c); return { clanAction: "joined" }; }
    run("INSERT OR IGNORE INTO clan_requests(clan_id,user_id,at) VALUES(?,?,?)", c.id, uid, now()); return { clanAction: "requested" };
  });
  const cancelClanRequest = mut((uid, id) => { run("DELETE FROM clan_requests WHERE clan_id=? AND user_id=?", Number(id), uid); });
  const answerClan = mut((uid, name, accept) => {
    const c = myClan(uid, true), o = other(uid, name);
    if (!run("DELETE FROM clan_requests WHERE clan_id=? AND user_id=?", c.id, o.id).changes) throw new AppError("not_found", "That request isn’t there any more.", 404);
    if (!accept) return { clanAction: "declined" };
    if (clanOf(o.id)) throw new AppError("in_clan", "They already joined another clan.");
    addMember(o.id, c); return { clanAction: "accepted" };
  });
  // the longest-standing member takes over from a leader who leaves; an empty clan closes
  function leave(uid, c) {
    run("DELETE FROM clan_members WHERE user_id=?", uid);
    if (c.leader !== uid) return;
    const next = get("SELECT user_id FROM clan_members WHERE clan_id=? ORDER BY joined_at, user_id LIMIT 1", c.id);
    if (next) run("UPDATE clans SET leader=? WHERE id=?", next.user_id, c.id);
    else { run("DELETE FROM clan_requests WHERE clan_id=?", c.id); run("DELETE FROM clans WHERE id=?", c.id); }
  }
  const leaveClan = mut(uid => leave(uid, myClan(uid)));
  const kick = mut((uid, name) => {
    const c = myClan(uid, true), o = other(uid, name);
    if (!run("DELETE FROM clan_members WHERE user_id=? AND clan_id=?", o.id, c.id).changes) throw new AppError("not_found", "They’re not in your clan.", 404);
  });
  function setClanOpen(uid, open) { const c = myClan(uid, true); run("UPDATE clans SET open=? WHERE id=?", open ? 1 : 0, c.id); }
  function clanView(uid) {
    const c = clanOf(uid);
    if (!c) return { mine: null, requested: all("SELECT clan_id FROM clan_requests WHERE user_id=?", uid).map(r => r.clan_id) };
    const ws = weekStart(), lead = c.leader === uid;
    const members = all(`SELECT u.*, m.joined_at, (SELECT COALESCE(SUM(x.xp),0) FROM claims x WHERE x.user_id=u.id AND x.at>=?) week
      FROM clan_members m JOIN users u ON u.id=m.user_id WHERE m.clan_id=? ORDER BY week DESC, u.xp DESC`, ws, c.id)
      .map(u => ({ ...card(u), week: u.week, leader: u.id === c.leader }));
    return { requested: [], mine: { id: c.id, name: c.name, tag: c.tag, open: !!c.open, leader: lead, ...clanXp(c.id), members,
      requests: lead ? all("SELECT u.* FROM clan_requests r JOIN users u ON u.id=r.user_id WHERE r.clan_id=? ORDER BY r.at", c.id).map(card) : [] } };
  }
  function clanBoard() {
    return all("SELECT c.*, (SELECT COUNT(*) FROM clan_members m WHERE m.clan_id=c.id) members FROM clans c").map(c =>
      ({ id: c.id, name: c.name, tag: c.tag, open: !!c.open, members: c.members, ...clanXp(c.id) }))
      .sort((a, b) => b.week - a.week || b.xp - a.xp || a.id - b.id).slice(0, 50);
  }

  // ---- content editor (admins): items, recipes and textures stored in the database ----
  function reloadContent() {
    C.applyCustom({
      items: all("SELECT data FROM custom_items ORDER BY at, id").map(r => JSON.parse(r.data)),
      recipes: all("SELECT data FROM custom_recipes ORDER BY at, id").map(r => JSON.parse(r.data)),
      art: Object.fromEntries(all("SELECT id, at FROM art").map(r => [r.id, r.at])),
      ...Object.fromEntries([["sets", "set"], ["ach", "ach"], ["quests", "quest"], ["offers", "offer"], ["mats", "mat"], ["chests", "chest"]].map(([k, kind]) =>
        [k, all("SELECT data FROM custom_content WHERE kind=? ORDER BY at, id", kind).map(r => JSON.parse(r.data))])),
    });
  }
  // names and text show up in pages, so keep them to plain characters
  const text = (v, min, max, what) => {
    v = String(v == null ? "" : v).trim().replace(/\s+/g, " ");
    if (v.length < min || v.length > max || /[<>"`&\\]/.test(v)) throw new AppError("bad_" + what, `${what[0].toUpperCase() + what.slice(1)}: ${min}-${max} characters, no < > " \` & or \\.`);
    return v;
  };
  const int = (v, lo, hi, what) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new AppError("bad_" + what, `${what}: a whole number from ${lo} to ${hi}.`); return n; };
  const cost = (o, what) => {
    if (o == null) return null;
    const out = {}; for (const k of ["coins", ...Object.keys(C.MATS)]) if (o[k]) out[k] = int(o[k], 0, 100000, what);
    if (!Object.keys(out).length) throw new AppError("bad_" + what, `Give the ${what} at least one coin or material amount.`);
    return out;
  };
  const newId = (prefix, taken) => { let n = 1; while (taken(prefix + n)) n++; return prefix + n; };
  const isBase = id => C.BASE_ITEMS.some(i => i.id === id);
  function saveItem(d) {
    const id = d.id ? String(d.id) : newId("c", x => !!C.ITEM[x] || !!get("SELECT 1 FROM custom_items WHERE id=?", x)), old = C.ITEM[id];
    if (d.id && !old) throw new AppError("not_found", "Unknown item.", 404);
    const slot = String(d.slot || ""); if (!C.SLOTS.some(s => s[0] === slot)) throw new AppError("bad_slot", "Choose a slot.");
    if (old && old.slot !== slot) throw new AppError("bad_slot", "An item’s slot can’t change once it exists (players may have it equipped).");
    const stats = {};
    for (const k of Object.keys(d.stats || {})) {
      if (!(k in C.CAPS)) throw new AppError("bad_stats", "Unknown stat.");
      const v = Number(d.stats[k]); if (!(v >= 0 && v <= 50)) throw new AppError("bad_stats", "Each stat: 0 to 50 (%).");
      if (v) stats[k] = Math.round(v * 10) / 10;
    }
    if (slot === "title" && Object.keys(stats).length) throw new AppError("bad_stats", "Banners are cosmetic: no stats.");
    const set = d.set ? String(d.set) : null; if (set && !C.SETS[set]) throw new AppError("bad_set", "Unknown set.");
    const g = String(d.g || ""); if (!C.GLYPHS.includes(g) && !(old && g === old.g)) throw new AppError("bad_glyph", "Choose a symbol.");
    const item = { id, name: text(d.name, 2, 40, "name"), slot, r: int(d.r, 0, 5, "rarity"), price: int(d.price, 0, 100000, "price"), stats, g,
      f: text(d.f, 0, 120, "description"), set, merchantCost: cost(d.merchantCost, "merchant price"), retired: !!d.retired };
    run("INSERT INTO custom_items(id,data,at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, at=excluded.at", id, JSON.stringify(item), now());
    reloadContent(); return C.ITEM[id];
  }
  // a new item nobody has can be deleted; anything else is retired instead, so no inventory breaks.
  // For a built-in item this undoes any edits and brings back the original.
  function deleteItem(id) {
    if (isBase(id)) { run("DELETE FROM custom_items WHERE id=?", id); reloadContent(); return { restored: true }; }
    if (!get("SELECT 1 FROM custom_items WHERE id=?", id)) throw new AppError("not_found", "Unknown item.", 404);
    if (get("SELECT 1 FROM items WHERE def=?", id)) throw new AppError("in_use", "Players own this item, so it can only be retired.");
    if (C.RECIPES.some(r => r.out[1] === id || Object.values(r.key).includes(id))) throw new AppError("in_use", "A recipe uses this item. Delete or change that recipe first, or retire the item.");
    run("DELETE FROM custom_items WHERE id=?", id); reloadContent(); return { deleted: true };
  }
  function saveRecipe(d) {
    const out = Array.isArray(d.out) ? [String(d.out[0]), String(d.out[1])] : [];
    if (!(out[0] === "item" && C.ITEM[out[1]] && !C.ITEM[out[1]].retired) && !(out[0] === "cons" && C.CONS[out[1]])) throw new AppError("bad_out", "Choose what the recipe makes.");
    if (!Array.isArray(d.grid) || d.grid.length !== 9) throw new AppError("bad_grid", "The pattern must be a 3x3 grid.");
    const grid = d.grid.map(t => { if (!t) return null; t = String(t); if (!C.MATS[t] && !(C.ITEM[t] && !C.ITEM[t].retired)) throw new AppError("bad_grid", "Unknown ingredient."); return t; });
    if (!grid.some(Boolean)) throw new AppError("bad_grid", "Put at least one ingredient in the pattern.");
    const hintAch = d.hintAch ? String(d.hintAch) : null; if (hintAch && !C.ACHIEVEMENT[hintAch]) throw new AppError("bad_hint", "Unknown achievement.");
    const known = id => C.RECIPES.some(r => r.id === id) || C.BASE_RECIPES.some(r => r.id === id) || !!get("SELECT 1 FROM custom_recipes WHERE id=?", id);
    const id = d.id ? String(d.id) : newId("cr", known); if (d.id && !known(id)) throw new AppError("not_found", "Unknown recipe.", 404);
    const r = { id, out, grid, qty: out[0] === "cons" ? int(d.qty || 1, 1, 10, "amount") : 1, mult: int(d.mult, 1, 50, "material cost"),
      fee: int(d.fee, 0, 100000, "coin fee"), hint: text(d.hint, 0, 150, "hint"), hintAch };
    const taken = C.matchRecipe(grid); if (taken && taken.id !== id) throw new AppError("pattern_taken", "Another recipe already uses that pattern.", 409);
    run("INSERT INTO custom_recipes(id,data,at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, at=excluded.at", id, JSON.stringify(r), now());
    reloadContent(); return C.RECIPES.find(x => x.id === id);
  }
  // removes an added recipe; turns off a built-in one (restoreRecipe brings it back)
  function deleteRecipe(id) {
    if (C.BASE_RECIPES.some(r => r.id === id)) run("INSERT INTO custom_recipes(id,data,at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, at=excluded.at", id, JSON.stringify({ id, retired: true }), now());
    else if (!run("DELETE FROM custom_recipes WHERE id=?", id).changes) throw new AppError("not_found", "Unknown recipe.", 404);
    reloadContent();
  }
  function restoreRecipe(id) { run("DELETE FROM custom_recipes WHERE id=?", id); reloadContent(); }
  // the full list for the editor, including turned-off built-in recipes, with patterns as 3x3 grids
  function contentAdmin() {
    const gridOf = r => [0, 1, 2].flatMap(y => [...(r.rows[y] || "").padEnd(3, ".")].map(ch => ch === "." ? null : r.key[ch]));
    const off = new Set(all("SELECT id, data FROM custom_recipes").filter(r => JSON.parse(r.data).retired).map(r => r.id));
    return { recipes: [...C.RECIPES.map(r => ({ id: r.id, out: r.out, qty: r.qty || 1, grid: gridOf(r), mult: r.mult, fee: r.fee, hint: r.hint, hintAch: r.hintAch, custom: !!r.custom, base: C.BASE_RECIPES.some(b => b.id === r.id) })),
      ...C.BASE_RECIPES.filter(r => off.has(r.id)).map(r => ({ id: r.id, out: r.out, qty: r.qty || 1, grid: gridOf(r), mult: r.mult, fee: r.fee, hint: r.hint, hintAch: r.hintAch, base: true, off: true }))],
      owned: Object.fromEntries(all("SELECT def, COUNT(*) n FROM items GROUP BY def").map(r => [r.def, r.n])), ...contentLists() };
  }
  // ---- sets, achievements, quests and merchant offers (one table, custom_content, keyed by kind) ----
  const statBlock = (o, what) => {
    const out = {};
    for (const k of Object.keys(o || {})) {
      if (!(k in C.CAPS)) throw new AppError("bad_" + what, "Unknown stat.");
      const v = Number(o[k]); if (!(v >= 0 && v <= 50)) throw new AppError("bad_" + what, "Each stat: 0 to 50 (%).");
      if (v) out[k] = Math.round(v * 10) / 10;
    }
    return out;
  };
  const BASES = {
    set: () => Object.keys(C.BASE_SETS), ach: () => C.BASE_ACH.map(a => a.id),
    quest: () => [...C.BASE_QUESTS.daily, ...C.BASE_QUESTS.weekly].map(q => q.id), offer: () => C.BASE_MERCHANT_POOL.map(o => o.id),
    mat: () => C.BASE_MATS.map(m => m.id), chest: () => C.BASE_CHESTS.map(c => c.id),
  };
  const LIVE = { set: () => Object.keys(C.SETS), ach: () => C.ACH.map(a => a.id), quest: () => Object.keys(C.QUEST), offer: () => C.MERCHANT_POOL.map(o => o.id),
    mat: () => Object.keys(C.MATS), chest: () => C.CHESTS.map(c => c.id) };
  const PREFIX = { set: "cs", ach: "ca", quest: "cq", offer: "co", mat: "cm", chest: "cc" };
  // kinds whose built-ins can be edited and restored but never turned off: the game's own rules use them
  const KEEP = { set: "sets", mat: "materials", chest: "chests (set the drop chance to 0 to stop one dropping)" };
  const color = v => { v = String(v || ""); if (!/^#[0-9a-fA-F]{6}$/.test(v)) throw new AppError("bad_color", "Pick a colour."); return v.toLowerCase(); };
  const pct = (v, what) => { const n = Number(v); if (!(n >= 0 && n <= 100)) throw new AppError("bad_" + what, `${what}: 0 to 100 (%).`); return Math.round(n * 10) / 10; };
  // each kind's editor fields, checked and cleaned; old is the current version when editing
  const CHECK = {
    set: (d) => {
      const bonus = {};
      for (const [n, st] of Object.entries(d.bonus || {})) { const p = int(n, 2, 6, "pieces"), b = statBlock(st, "bonus"); if (Object.keys(b).length) bonus[p] = b; }
      if (!Object.keys(bonus).length) throw new AppError("bad_bonus", "Give the set at least one bonus.");
      return { name: text(d.name, 2, 30, "name"), bonus };
    },
    ach: (d, old) => {
      const rule = old && !C.ACH_RULES[old.rule] ? old.rule : String(d.rule || ""); // hand-coded rules (Giant Slayer, Well Travelled) stay as they are
      if (!(old && rule === old.rule) && !C.ACH_RULES[rule]) throw new AppError("bad_rule", "Choose what the achievement counts.");
      return { name: text(d.name, 2, 40, "name"), desc: text(d.desc, 3, 100, "description"), reward: int(d.reward, 0, 10000, "reward"),
        rule, n: rule === "rarity" ? int(d.n, 0, 5, "target") : int(d.n, 1, 100000, "target"), hidden: !!d.hidden };
    },
    quest: (d, old) => {
      const kind = old ? old.kind : String(d.kind || ""); if (kind !== "daily" && kind !== "weekly") throw new AppError("bad_kind", "Choose daily or weekly.");
      const type = String(d.type || ""); if (!["play", "win", "wd", "upset"].includes(type)) throw new AppError("bad_type", "Choose a goal.");
      const tc = d.tc ? String(d.tc) : null; if (tc && !["bullet", "blitz", "rapid"].includes(tc)) throw new AppError("bad_tc", "Unknown time control.");
      return { kind, desc: text(d.desc, 3, 60, "description"), type, n: int(d.n, 1, 1000, "target"), tc, reward: cost(d.reward, "reward") || (() => { throw new AppError("bad_reward", "Give a reward."); })() };
    },
    offer: (d) => {
      const g = d.give || {}, t = String(g.t || ""), id = String(g.id || "");
      if (!(t === "mat" && C.MATS[id]) && !(t === "cons" && C.CONS[id])) throw new AppError("bad_give", "Choose a material or potion.");
      const price = cost(d.cost, "price"); if (!price) throw new AppError("bad_price", "Give it a price.");
      return { give: { t, id, qty: int(g.qty, 1, 100, "amount") }, cost: price, limit: int(d.limit, 1, 10, "daily limit") };
    },
    mat: (d) => ({ name: text(d.name, 2, 30, "name"), r: int(d.r, 0, 5, "rarity"), color: color(d.color) }),
    chest: (d) => {
      const loot = (Array.isArray(d.loot) ? d.loot : []).filter(l => l && l.id).map(l => {
        const id = String(l.id); if (!C.MATS[id]) throw new AppError("bad_loot", "Unknown material in the loot.");
        const min = int(l.min, 1, 1000, "minimum"), max = int(l.max, min, 1000, "maximum (at least the minimum)");
        const chance = pct(l.chance, "loot chance"); if (!chance) throw new AppError("bad_loot", "Each loot line needs a chance above 0%.");
        return { id, min, max, chance };
      });
      if (!loot.length || loot.length > 8) throw new AppError("bad_loot", "Give the chest 1 to 8 loot lines.");
      return { name: text(d.name, 2, 30, "name"), color: color(d.color), chance: pct(d.chance, "drop chance"), loot };
    },
  };
  // every material another piece of content names must exist
  function materialRefs() {
    const refs = [];
    for (const r of all("SELECT data FROM custom_recipes")) { const d = JSON.parse(r.data); if (!d.retired) for (const t of d.grid || []) if (t) refs.push([t, "a recipe"]); }
    for (const [id, c] of Object.entries(C.MERCHANT_ITEMS)) for (const k in c) refs.push([k, (C.ITEM[id] || {}).name + "’s merchant price"]);
    for (const q of Object.values(C.QUEST)) for (const k in q.reward) refs.push([k, "the quest “" + q.desc + "”"]);
    for (const o of C.MERCHANT_POOL) { refs.push([o.give.t === "mat" ? o.give.id : "coins", "a merchant offer"]); for (const k in o.cost) refs.push([k, "a merchant offer"]); }
    for (const c of C.CHESTS) for (const l of c.loot) refs.push([l.id, "the " + c.name]);
    return refs.filter(([k]) => k !== "coins" && !C.MATS[k] && !C.ITEM[k]);
  }
  // after any change, the game must still hang together; otherwise the change is undone
  function checkContent() {
    for (const i of C.ITEMS) if (i.set && !C.SETS[i.set]) throw new AppError("in_use", `${i.name} is in that set. Move it to another set first.`);
    for (const r of C.RECIPES) if (r.hintAch && !C.ACHIEVEMENT[r.hintAch]) throw new AppError("in_use", "That achievement unlocks a recipe hint. Change the recipe first.");
    for (const k of ["daily", "weekly"]) {
      const q = C.QUESTS[k];
      if (q.length < C.QUESTS_PER_PERIOD || q.filter(x => !x.tc).length < C.QUESTS_PER_PERIOD - 1)
        throw new AppError("too_few", `Keep at least ${C.QUESTS_PER_PERIOD} ${k} quests, with at least ${C.QUESTS_PER_PERIOD - 1} not tied to a time control.`);
    }
    if (C.MERCHANT_POOL.length < C.MERCHANT_POOL_PICKS) throw new AppError("too_few", `Keep at least ${C.MERCHANT_POOL_PICKS} merchant offers.`);
    const odds = C.CHESTS.reduce((s, c) => s + c.chance, 0);
    if (odds > 100) throw new AppError("too_many", `All chest drop chances together come to ${Math.round(odds * 10) / 10}%. Keep them at 100% or less.`);
    const missing = materialRefs()[0]; if (missing) throw new AppError("in_use", `That material is still used by ${missing[1]}. Change that first.`);
  }
  // runs a content change in a transaction; if checkContent fails, the database rolls back and the old content is restored
  function contentTx(f) {
    try { return tx(() => { const r = f(); reloadContent(); checkContent(); return r; }); }
    catch (e) { reloadContent(); throw e; }
  }
  const kindOf = k => { if (!CHECK[k]) throw new AppError("bad_kind", "Unknown content type."); return k; };
  const rowOf = (kind, id) => get("SELECT data FROM custom_content WHERE kind=? AND id=?", kind, id);
  const writeRow = (kind, id, data) => run("INSERT INTO custom_content(kind,id,data,at) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data, at=excluded.at", kind, id, JSON.stringify(data), now());
  function currentOf(kind, id) {
    return kind === "set" ? (C.SETS[id] && { id, ...C.SETS[id] }) : kind === "ach" ? C.ACHIEVEMENT[id] : kind === "quest" ? C.QUEST[id]
      : kind === "mat" ? C.MAT_INFO[id] : kind === "chest" ? C.CHESTS.find(c => c.id === id) : C.MERCHANT_POOL.find(o => o.id === id);
  }
  function saveContent(kind, d) {
    kindOf(kind);
    const known = id => BASES[kind]().includes(id) || !!rowOf(kind, id) || LIVE[kind]().includes(id);
    const id = d && d.id ? String(d.id) : newId(PREFIX[kind], known);
    if (d && d.id && !known(id)) throw new AppError("not_found", "Not found.", 404);
    const data = { id, ...CHECK[kind](d || {}, currentOf(kind, id)) };
    return contentTx(() => { writeRow(kind, id, data); return { id }; });
  }
  // an added entry is deleted; a built-in one is turned off (restoreContent brings it back), except the KEEP kinds.
  // Materials and chests that players are holding can't be deleted.
  function deleteContent(kind, id) {
    kindOf(kind); const base = BASES[kind]().includes(id);
    if (base && KEEP[kind]) throw new AppError("in_use", `Built-in ${KEEP[kind]} can be edited and restored, but not removed.`);
    const held = kind === "mat" ? id : kind === "chest" ? "chest:" + id : null;
    if (held && get("SELECT 1 FROM balances WHERE kind=? AND qty>0", held)) throw new AppError("in_use", "Players are holding some, so it can’t be deleted.");
    return contentTx(() => {
      if (base) writeRow(kind, id, { id, retired: true });
      else if (!run("DELETE FROM custom_content WHERE kind=? AND id=?", kind, id).changes) throw new AppError("not_found", "Not found.", 404);
    });
  }
  function restoreContent(kind, id) { kindOf(kind); return contentTx(() => { run("DELETE FROM custom_content WHERE kind=? AND id=?", kind, id); }); }
  // everything for the editor, including turned-off built-ins
  function contentLists() {
    const rows = kind => Object.fromEntries(all("SELECT id, data FROM custom_content WHERE kind=?", kind).map(r => [r.id, JSON.parse(r.data)]));
    const tag = (kind, list) => { const rs = rows(kind), base = new Set(BASES[kind]());
      return list.map(x => ({ ...x, base: base.has(x.id), edited: base.has(x.id) && !!rs[x.id], custom: !base.has(x.id) })); };
    const off = (kind, list) => { const rs = rows(kind); return list.filter(x => rs[x.id] && rs[x.id].retired).map(x => ({ ...x, base: true, off: true })); };
    const baseQ = [...C.BASE_QUESTS.daily, ...C.BASE_QUESTS.weekly];
    return {
      sets: tag("set", Object.entries(C.SETS).map(([id, s]) => ({ id, ...s, used: C.ITEMS.filter(i => i.set === id).length }))),
      ach: [...tag("ach", C.ACH).map(a => ({ ...a, owners: get("SELECT COUNT(*) n FROM achievements WHERE id=?", a.id).n })), ...off("ach", C.BASE_ACH)],
      quests: [...tag("quest", [...C.QUESTS.daily, ...C.QUESTS.weekly]), ...off("quest", baseQ)],
      offers: [...tag("offer", C.MERCHANT_POOL), ...off("offer", C.BASE_MERCHANT_POOL)],
      mats: tag("mat", Object.values(C.MAT_INFO)).map(m => ({ ...m, held: get("SELECT COALESCE(SUM(qty),0) n FROM balances WHERE kind=?", m.id).n })),
      chests: tag("chest", C.CHESTS).map(c => ({ ...c, held: get("SELECT COALESCE(SUM(qty),0) n FROM balances WHERE kind=?", "chest:" + c.id).n })),
    };
  }
  // chest textures are stored as chest_<id> so they can't clash with a material or item id
  const artIds = () => [...Object.keys(C.ITEM), ...Object.keys(C.MATS), ...Object.keys(C.CONS), ...C.CHESTS.map(c => "chest_" + c.id)];
  function setArt(id, png) {
    if (!artIds().includes(id)) throw new AppError("not_found", "Unknown item.", 404);
    run("INSERT INTO art(id,png,at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET png=excluded.png, at=excluded.at", id, png, Date.now());
    reloadContent();
  }
  function clearArt(id) { run("DELETE FROM art WHERE id=?", id); reloadContent(); }
  const getArt = id => get("SELECT png FROM art WHERE id=?", id);

  // ---- player-requested reset and deletion: the only places a player's own data is removed ----
  const PROGRESS = ["equipment", "items", "balances", "ledger", "achievements", "buffs", "recipes_known", "quest_claims", "merchant_buys"];
  // a fresh start: progress goes, the login, chess.com link, friends, clan and settings stay.
  // claims stay too, so games already rewarded can never pay out again.
  function resetProgress(uid) {
    return tx(() => {
      for (const t of PROGRESS) run(`DELETE FROM ${t} WHERE user_id=?`, uid);
      run("UPDATE users SET xp=0, streak=0, best=0, games=0, wins=0, title='' WHERE id=?", uid);
      const th = C.THEME[user(uid).theme]; if (!th || th.wins > 0) run("UPDATE users SET theme='dark' WHERE id=?", uid);
      grant(uid, "coins", C.WELCOME_COINS, "welcome", null); checkAch(uid);
    });
  }
  // removes the account and everything tied to it; the username and chess.com account become free again
  function deleteAccount(uid) {
    tx(() => {
      const c = clanOf(uid); if (c) leave(uid, c);
      for (const t of [...PROGRESS, "claims", "clan_requests"]) run(`DELETE FROM ${t} WHERE user_id=?`, uid);
      run("DELETE FROM friends WHERE user_id=? OR friend_id=?", uid, uid);
      run("DELETE FROM friend_requests WHERE from_id=? OR to_id=?", uid, uid);
      run("DELETE FROM users WHERE id=?", uid);
    });
  }

  // ---- admin testing tools ----
  // server.js only calls these for usernames listed in ADMIN_USERS, and only on the admin's own account.
  // Everything still goes through grant/giveItem, so the ledger stays balanced and shows reason "admin".
  const ADMIN_MAX = 100000, adminKinds = () => ["coins", ...Object.keys(C.MATS), ...Object.keys(C.CONS), ...C.CHESTS.map(c => "chest:" + c.id)];
  const adminGive = mut((uid, kind, n) => {
    if (!adminKinds().includes(kind)) throw new AppError("bad_kind", "Unknown resource.");
    if (!Number.isInteger(n) || n < 1 || n > ADMIN_MAX) throw new AppError("bad_amount", `Amount must be 1 to ${ADMIN_MAX}.`);
    grant(uid, kind, n, "admin", null); return { gave: { kind, n } };
  });
  const adminItem = mut((uid, def) => {
    if (!C.ITEM[def]) throw new AppError("bad_item", "Unknown item.");
    giveItem(uid, def, "admin"); return { gave: { item: def } };
  });
  const adminWins = mut((uid, n) => {
    if (!Number.isInteger(n) || n < 0 || n > ADMIN_MAX) throw new AppError("bad_amount", `Wins must be 0 to ${ADMIN_MAX}.`);
    run("UPDATE users SET wins=?, games=MAX(games, ?) WHERE id=?", n, n, uid);
  });
  // lets the admin buy today's merchant offers and claim this period's quests again
  const adminResetDay = mut(uid => {
    const d = R.periodOf("daily", now()).key, w = R.periodOf("weekly", now()).key;
    run("DELETE FROM merchant_buys WHERE user_id=? AND period=?", uid, d);
    run("DELETE FROM quest_claims WHERE user_id=? AND period IN (?, ?)", uid, d, w);
  });

  // ---- read models ----
  function view(uid) {
    const u = user(uid), bal = Object.fromEntries(all("SELECT kind, qty FROM balances WHERE user_id=?", uid).map(r => [r.kind, r.qty]));
    const rows = all("SELECT i.id, i.def, i.level, i.locked, e.slot FROM items i LEFT JOIN equipment e ON e.item_id=i.id WHERE i.user_id=? ORDER BY i.id", uid);
    const b = R.bonusOf(rows.filter(r => r.slot)), L = lvl(u.xp);
    const have = new Set(all("SELECT id FROM achievements WHERE user_id=?", uid).map(r => r.id)), st = achStats(uid);
    return { username: u.username, cc: u.cc, pending: u.cc_pending, code: u.cc_code, xp: u.xp, level: L, lo: need(L), hi: need(L + 1),
      streak: u.streak, best: u.best, games: u.games, wins: u.wins, title: u.title, coins: bal.coins || 0, shield: bal.shield || 0,
      mats: Object.fromEntries(Object.keys(C.MATS).map(k => [k, bal[k] || 0])), chests: Object.fromEntries(C.CHESTS.map(c => [c.id, bal["chest:" + c.id] || 0])), bonus: b.stats, sets: b.active,
      cons: Object.fromEntries(Object.keys(C.CONS).map(k => [k, bal[k] || 0])),
      buffs: Object.fromEntries(all("SELECT kind, games_left FROM buffs WHERE user_id=?", uid).map(r => [r.kind, r.games_left])),
      cv: C.VERSION, quests: quests(uid), merchant: merchant(uid), theme: u.theme, since: u.created_at, privacy: u.privacy, social: social(uid), clan: clanView(uid),
      items: rows.map(r => { const d = C.ITEM[r.def]; return { id: r.id, def: r.def, level: r.level, locked: !!r.locked, slot: r.slot || null, up: C.upgradeCost(d, r.level), dis: C.dismantleYield(d, r.level) }; }),
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
  // hide: usernames left off the board (admin accounts, whose test rewards would be unfair)
  function leaderboard(hide = []) {
    const rows = all(`SELECT id, username, xp, wins, best, title FROM users WHERE cc IS NOT NULL AND username NOT IN (SELECT value FROM json_each(?))
      ORDER BY xp DESC, id ASC LIMIT 20`, JSON.stringify([...hide]));
    return rows.map(r => {
      const eq = all("SELECT i.def FROM equipment e JOIN items i ON i.id=e.item_id WHERE e.user_id=?", r.id).map(x => C.ITEM[x.def]);
      const top = eq.sort((a, b) => b.r - a.r)[0];
      const c = clanOf(r.id);
      return { username: r.username, xp: r.xp, level: lvl(r.xp), wins: r.wins, best: r.best, title: r.title, ic: top ? top.id : null, tag: c ? c.tag : null };
    });
  }
  reloadContent(); // apply the admin-made content stored in this database
  return { openChest, toggleLock, dupesPreview, dismantleDupes, saveContent, deleteContent, restoreContent, saveItem, deleteItem, saveRecipe, deleteRecipe, restoreRecipe, contentAdmin, setArt, clearArt, getArt, user, createUser, createLinkedUser, bumpSession, startLink, finishLink, unlink, sync, buy, equip, upgrade, dismantle, craft, preview, use, quests, claimQuest, merchant, buyOffer, setTheme, setPassword, addFriend, answerFriend, removeFriend, setPrivacy, publicProfile,
    createClan, joinClan, cancelClanRequest, answerClan, leaveClan, kick, setClanOpen, clanBoard, adminGive, adminItem, adminWins, adminResetDay, resetProgress, deleteAccount, view, leaderboard, _grant: grant, _tx: tx };
}
module.exports = { createCore, lvl, need };
