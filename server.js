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

// ---- session secret (env var, or generated once and kept next to the db) ----
const secretFile = path.join(__dirname, ".secret");
let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  SECRET = fs.readFileSync(secretFile, "utf8");
}

const SHOP = [
  { id: "boost", n: "Double Espresso", d: "+25% XP on every game", c: 150, t: "perm" },
  { id: "shield", n: "Streak Shield", d: "Next loss won’t break your streak", c: 80, t: "cons" },
  { id: "neon", n: "Neon theme", d: "Cyan glow for your dashboard", c: 120, t: "theme", v: "#06b6d4" },
  { id: "sunset", n: "Sunset theme", d: "Warm orange accents", c: 120, t: "theme", v: "#f97316" },
  { id: "royal", n: "Royal theme", d: "Purple, fit for a king", c: 120, t: "theme", v: "#8b5cf6" },
  { id: "t1", n: "Title: Tactician", d: "Show it under your name", c: 100, t: "title", v: "Tactician" },
  { id: "t2", n: "Title: Blunder Survivor", d: "Wear it with pride", c: 100, t: "title", v: "Blunder Survivor" },
  { id: "t3", n: "Title: Endgame Wizard", d: "For the patient ones", c: 100, t: "title", v: "Endgame Wizard" },
  { id: "fx", n: "Victory confetti", d: "Emoji burst when you win", c: 200, t: "perm" },
];
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
  let x = res === "win" ? 20 : res === "draw" ? 8 : 3;
  if (res === "win" && diff > 0) x += Math.min(25, Math.round(diff / 10));
  if (res === "win") { u.streak++; u.best = Math.max(u.best, u.streak); x = Math.round(x * (1 + Math.min(u.streak - 1, 5) * 0.1)); }
  else if (res === "loss") { if (u.shield > 0) u.shield--; else u.streak = 0; }
  if (u.owned.includes("boost")) x = Math.round(x * 1.25);
  u.xp += x; u.coins += x; u.games++; if (res === "win") u.wins++;
  return x;
}

// ---- app ----
const app = express();
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

const getUser = id => { const r = db.prepare("SELECT * FROM users WHERE id=?").get(id); if (r) r.owned = JSON.parse(r.owned); return r; };
const saveUser = u => db.prepare(`UPDATE users SET cc=@cc,cc_pending=@cc_pending,cc_code=@cc_code,last_end=@last_end,xp=@xp,coins=@coins,
  streak=@streak,best=@best,games=@games,wins=@wins,shield=@shield,accent=@accent,title=@title,owned=@owned WHERE id=@id`)
  .run({ ...u, owned: JSON.stringify(u.owned) });
const view = u => ({ username: u.username, cc: u.cc, pending: u.cc_pending, code: u.cc_code, xp: u.xp, coins: u.coins,
  streak: u.streak, best: u.best, games: u.games, wins: u.wins, shield: u.shield, accent: u.accent, title: u.title,
  owned: u.owned, level: lvl(u.xp), lo: need(lvl(u.xp)), hi: need(lvl(u.xp) + 1), shop: SHOP });

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
  if (s.t === "theme") u.accent = s.v; if (s.t === "title") u.title = s.v;
  saveUser(u); res.json(view(u));
});

app.post("/api/equip", auth, (req, res) => {
  const u = req.u, s = SHOP.find(x => x.id === req.body.id);
  if (!s || !u.owned.includes(s.id)) return res.status(400).json({ error: "You don’t own that." });
  if (s.t === "theme") u.accent = s.v; else if (s.t === "title") u.title = s.v;
  saveUser(u); res.json(view(u));
});

app.get("/api/leaderboard", (req, res) => {
  const rows = db.prepare("SELECT username,cc,xp,wins,best,title FROM users WHERE cc IS NOT NULL ORDER BY xp DESC LIMIT 20").all();
  res.json(rows.map(r => ({ ...r, level: lvl(r.xp) })));
});

app.listen(PORT, () => console.log("Level Up Chess running on http://localhost:" + PORT));
