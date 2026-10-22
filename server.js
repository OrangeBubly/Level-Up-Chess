// Level Up Chess backend: accounts, verified chess.com linking, server-side XP, shop, leaderboard.
const express = require("express"), crypto = require("crypto"), fs = require("fs"), path = require("path");
const Database = require("better-sqlite3");

const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === "production";
const db = new Database(process.env.DB_FILE || path.join(__dirname, "chess.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL,
  cc TEXT UNIQUE, cc_pending TEXT, cc_code TEXT, last_end INTEGER DEFAULT 0,
  xp INTEGER DEFAULT 0, coins INTEGER DEFAULT 0, streak INTEGER DEFAULT 0, best INTEGER DEFAULT 0,
  games INTEGER DEFAULT 0, wins INTEGER DEFAULT 0, shield INTEGER DEFAULT 0,
  accent TEXT DEFAULT '', title TEXT DEFAULT '', owned TEXT DEFAULT '[]');
CREATE TABLE IF NOT EXISTS seen(url TEXT PRIMARY KEY);`);
try { db.exec("ALTER TABLE users ADD COLUMN equipped TEXT DEFAULT '{}'"); } catch {} // safe upgrade for existing databases

// ---- session secret (env var, or generated once and kept next to the db) ----
const secretFile = path.join(__dirname, ".secret");
let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  SECRET = fs.readFileSync(secretFile, "utf8");
}

// [id, name, slot, rarity 0-3, cost, stat bonuses, glyph, flavor]
const SHOP = [
 ["k1","Iron King","throne",0,120,{xp:3},"♚","Heavy is the head. Heavier is the helmet."],
 ["q1","Crimson Queen","throne",2,450,{xp:6,upset:10},"♛","She never loses a tempo, only a few pawns."],
 ["k2","Obsidian Monarch","throne",3,900,{xp:10,coin:10},"♚","Forged in the heat of a thousand resignations."],
 ["n1","Shadow Knight","flank",1,220,{upset:12},"♞","Strikes from the dark, always from an L."],
 ["b1","Venom Bishop","flank",1,220,{coin:12},"♝","Every diagonal pays a toll."],
 ["n2","Ghost Stallion","flank",2,500,{upset:20,streak:3},"♞","Haunts the strongest opponents in your pool."],
 ["r1","Iron Rook","bastion",0,100,{streak:3},"♜","Holds the line when everything else falls."],
 ["r2","Magma Fortress","bastion",2,480,{xp:5,streak:5},"♜","Castled in lava. Nobody dares to check it."],
 ["p1","Lucky Pawn","vanguard",0,80,{coin:6},"♟\uFE0E","Found it on the floor. Still counts."],
 ["p2","Bloodline Pawn","vanguard",1,260,{xp:5,coin:5},"♟\uFE0E","Descended from a long line of promotions."],
 ["p3","Promoted Pawn","vanguard",3,800,{xp:8,upset:15,streak:5},"♟\uFE0E","Walked the whole board. Became a legend."],
 ["a1","Ember Aura","aura",1,300,{xp:2},"🔥","Victories burst into flames."],
 ["a2","Blood Moon Aura","aura",3,700,{xp:4,coin:6},"🌑","Rises when you win. Sets when you blunder."],
 ["t1","Tactician","title",0,100,{},"✦","A title for your profile and the leaderboard."],
 ["t2","Blunder Survivor","title",0,100,{},"✦","Lost the queen. Won the game."],
 ["t3","Endgame Wizard","title",1,200,{},"✦","Turns a pawn up into a trophy."],
].map(([id,n,slot,r,c,s,g,f])=>({id,n,slot,r,c,s,g,f,t:"item"}));
SHOP.push({id:"shield",n:"Streak Shield",slot:"consumable",r:0,c:80,s:{},g:"🛡",f:"Your next loss won’t break your streak.",t:"cons"});
const bonus = u => { const b = { xp: 0, coin: 0, upset: 0, streak: 0 };
  for (const id of Object.values(u.equipped || {})) { const it = SHOP.find(x => x.id === id); if (it) for (const k in it.s) b[k] += it.s[k]; }
  return b; };
const lvl = xp => Math.floor(Math.sqrt(xp / 50)) + 1;
const need = l => 50 * (l - 1) * (l - 1);

// ---- passwords + sessions ----
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString("hex");
const sign = s => crypto.createHmac("sha256", SECRET).update(s).digest("hex");
const mkToken = id => { const p = id + "." + (Date.now() + 30 * 864e5); return p + "." + sign(p); };
function readToken(t) {
  const [id, exp, sig] = (t || "").split(".");
  if (!sig || sign(id + "." + exp) !== sig || Date.now() > +exp) return null;
  return +id;
}
function cookie(req, name) {
  const m = (req.headers.cookie || "").split(/;\s*/).find(c => c.startsWith(name + "="));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
const setSession = (res, id) => res.setHeader("Set-Cookie",
  `sid=${encodeURIComponent(mkToken(id))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${PROD ? "; Secure" : ""}`);

// ---- tiny in-memory rate limiter ----
const hits = new Map();
function limit(key, max, ms) {
  const now = Date.now(), h = (hits.get(key) || []).filter(t => now - t < ms);
  if (h.length >= max) return false;
  h.push(now); hits.set(key, h); return true;
}

// ---- chess.com ----
const CC_API = process.env.CHESSCOM_API || "https://api.chess.com/pub"; // override only for testing
const UA = "LevelUpChess/1.0 (contact: " + (process.env.CONTACT_EMAIL || "set CONTACT_EMAIL") + ")";
async function cj(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("chess.com returned " + r.status);
  return r.json();
}
const DRAWS = ["agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"];

function award(u, res, diff) {
  const b = bonus(u);
  let x = res === "win" ? 20 : res === "draw" ? 8 : 3;
  if (res === "win" && diff > 0) x += Math.round(Math.min(25, diff / 10) * (1 + b.upset / 100));
  if (res === "win") { u.streak++; u.best = Math.max(u.best, u.streak); x = Math.round(x * (1 + Math.min(u.streak - 1, 5) * (0.1 + b.streak / 100))); }
  else if (res === "loss") { if (u.shield > 0) u.shield--; else u.streak = 0; }
  x = Math.round(x * (1 + b.xp / 100));
  u.xp += x; u.coins += Math.round(x * (1 + b.coin / 100)); u.games++; if (res === "win") u.wins++;
  return x;
}

// ---- app ----
const app = express();
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

const getUser = id => { const r = db.prepare("SELECT * FROM users WHERE id=?").get(id); if (r) { r.owned = JSON.parse(r.owned); r.equipped = JSON.parse(r.equipped || "{}"); } return r; };
const saveUser = u => db.prepare(`UPDATE users SET cc=@cc,cc_pending=@cc_pending,cc_code=@cc_code,last_end=@last_end,xp=@xp,coins=@coins,
  streak=@streak,best=@best,games=@games,wins=@wins,shield=@shield,accent=@accent,title=@title,owned=@owned,equipped=@equipped WHERE id=@id`)
  .run({ ...u, owned: JSON.stringify(u.owned), equipped: JSON.stringify(u.equipped) });
const view = u => ({ username: u.username, cc: u.cc, pending: u.cc_pending, code: u.cc_code, xp: u.xp, coins: u.coins,
  streak: u.streak, best: u.best, games: u.games, wins: u.wins, shield: u.shield, title: u.title,
  owned: u.owned, equipped: u.equipped, bonus: bonus(u), level: lvl(u.xp), lo: need(lvl(u.xp)), hi: need(lvl(u.xp) + 1), shop: SHOP });

function auth(req, res, next) {
  const id = readToken(cookie(req, "sid")), u = id && getUser(id);
  if (!u) return res.status(401).json({ error: "Please log in." });
  req.u = u; next();
}
const wrap = f => (req, res) => Promise.resolve(f(req, res)).catch(e => res.status(502).json({ error: e.message || "Something went wrong." }));

app.post("/api/signup", (req, res) => {
  if (!limit("auth:" + req.ip, 20, 15 * 60e3)) return res.status(429).json({ error: "Too many attempts. Try again later." });
  const n = String(req.body.username || "").trim().toLowerCase(), p = String(req.body.password || "");
  if (!/^[a-z0-9_]{3,20}$/.test(n)) return res.status(400).json({ error: "Username: 3-20 letters, numbers or underscores." });
  if (p.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  const salt = crypto.randomBytes(16).toString("hex");
  try {
    const r = db.prepare("INSERT INTO users(username,salt,hash) VALUES(?,?,?)").run(n, salt, hashPw(p, salt));
    setSession(res, r.lastInsertRowid); res.json({ ok: true });
  } catch { res.status(409).json({ error: "That username is taken." }); }
});

app.post("/api/login", (req, res) => {
  if (!limit("auth:" + req.ip, 20, 15 * 60e3)) return res.status(429).json({ error: "Too many attempts. Try again later." });
  const n = String(req.body.username || "").trim().toLowerCase(), p = String(req.body.password || "");
  const u = db.prepare("SELECT * FROM users WHERE username=?").get(n);
  const ok = u && crypto.timingSafeEqual(Buffer.from(hashPw(p, u.salt)), Buffer.from(u.hash));
  if (!ok) return res.status(401).json({ error: "Wrong username or password." });
  setSession(res, u.id); res.json({ ok: true });
});

app.post("/api/logout", (req, res) => { res.setHeader("Set-Cookie", "sid=; Max-Age=0; Path=/"); res.json({ ok: true }); });
app.get("/api/me", auth, (req, res) => res.json(view(req.u)));

// Step 1: claim a chess.com username; we hand back a code to prove ownership.
app.post("/api/cc", auth, wrap(async (req, res) => {
  const cc = String(req.body.cc || "").trim().toLowerCase();
  if (!/^[a-z0-9_-]{3,25}$/.test(cc)) return res.status(400).json({ error: "That doesn’t look like a chess.com username." });
  if (!(await cj(CC_API + "/player/" + cc))) return res.status(404).json({ error: "No chess.com player with that username." });
  const taken = db.prepare("SELECT id FROM users WHERE cc=? AND id<>?").get(cc, req.u.id);
  if (taken) return res.status(409).json({ error: "Another account already verified that chess.com username." });
  req.u.cc_pending = cc; req.u.cc_code = "luc-" + crypto.randomBytes(3).toString("hex");
  saveUser(req.u); res.json(view(req.u));
}));

// Step 2: user puts the code in their chess.com profile "Location"; we check it.
app.post("/api/cc/verify", auth, wrap(async (req, res) => {
  const u = req.u;
  if (!u.cc_pending) return res.status(400).json({ error: "Start by entering your chess.com username." });
  const p = await cj(CC_API + "/player/" + u.cc_pending);
  if (!p || !String(p.location || "").toLowerCase().includes(u.cc_code)) return res.status(400).json({ error: "Code not found in your chess.com Location yet. Save it there and try again." });
  if (u.cc !== u.cc_pending) u.last_end = 0;
  try { u.cc = u.cc_pending; u.cc_pending = null; u.cc_code = null; saveUser(u); }
  catch { return res.status(409).json({ error: "Another account already verified that username." }); }
  res.json(view(u));
}));

// Sync: the server reads games itself, so XP can’t be faked from the browser.
app.post("/api/sync", auth, wrap(async (req, res) => {
  const u = req.u;
  if (!u.cc) return res.status(400).json({ error: "Verify your chess.com username first." });
  if (!limit("sync:" + u.id, 1, 30e3)) return res.status(429).json({ error: "Easy there, wait 30 seconds between syncs." });
  const ar = await cj(CC_API + "/player/" + u.cc + "/games/archives");
  const urls = ((ar && ar.archives) || []).slice(-2); let games = [];
  for (const url of urls) { const m = await cj(url); games = games.concat((m && m.games) || []); }
  games.sort((a, b) => a.end_time - b.end_time);
  if (!u.last_end) {
    u.last_end = games.length ? games[games.length - 1].end_time : Math.floor(Date.now() / 1000);
    saveUser(u); return res.json({ ...view(u), msg: "Baseline set. Play some rated games, then sync again to earn XP!" });
  }
  const isSeen = db.prepare("SELECT 1 FROM seen WHERE url=?"), mark = db.prepare("INSERT OR IGNORE INTO seen(url) VALUES(?)");
  const fresh = games.filter(g => g.end_time > u.last_end && g.rated && g.rules === "chess" && !isSeen.get(g.url)).slice(0, 50);
  let total = 0, won = 0, lvBefore = lvl(u.xp);
  db.transaction(() => {
    for (const g of fresh) {
      const w = g.white.username.toLowerCase() === u.cc, me = w ? g.white : g.black, op = w ? g.black : g.white;
      const r = me.result === "win" ? "win" : DRAWS.includes(me.result) ? "draw" : "loss";
      total += award(u, r, op.rating - me.rating); if (r === "win") won++; mark.run(g.url);
    }
    if (games.length) u.last_end = Math.max(u.last_end, games[games.length - 1].end_time);
    saveUser(u);
  })();
  res.json({ ...view(u), count: fresh.length, gained: total, leveled: lvl(u.xp) > lvBefore, won });
}));

app.post("/api/buy", auth, (req, res) => {
  const u = req.u, s = SHOP.find(x => x.id === req.body.id);
  if (!s) return res.status(404).json({ error: "No such item." });
  if (s.t !== "cons" && u.owned.includes(s.id)) return res.status(400).json({ error: "You already own that." });
  if (u.coins < s.c) return res.status(400).json({ error: "Not enough coins." });
  u.coins -= s.c;
  if (s.t === "cons") u.shield++; else u.owned.push(s.id);
  saveUser(u); res.json(view(u));
});

// Equip toggles: equipping an owned item fills its slot; equipping it again empties the slot.
app.post("/api/equip", auth, (req, res) => {
  const u = req.u, s = SHOP.find(x => x.id === req.body.id);
  if (!s || s.t === "cons" || !u.owned.includes(s.id)) return res.status(400).json({ error: "You don’t own that." });
  if (u.equipped[s.slot] === s.id) { delete u.equipped[s.slot]; if (s.slot === "title") u.title = ""; }
  else { u.equipped[s.slot] = s.id; if (s.slot === "title") u.title = s.n; }
  saveUser(u); res.json(view(u));
});

app.get("/api/leaderboard", (req, res) => {
  const rows = db.prepare("SELECT username,cc,xp,wins,best,title,equipped FROM users WHERE cc IS NOT NULL ORDER BY xp DESC LIMIT 20").all();
  res.json(rows.map(r => { const e = JSON.parse(r.equipped || "{}"), t = SHOP.find(x => x.id === e.throne); delete r.equipped; return { ...r, level: lvl(r.xp), g: t ? t.g : "♟\uFE0E" }; }));
});

app.listen(PORT, () => console.log("Level Up Chess running on http://localhost:" + PORT));
