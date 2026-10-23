"use strict";
// Level Up Chess: HTTP layer. Game logic lives in lib/core.js; this file does auth, routing and errors.
const express = require("express"), crypto = require("crypto"), fs = require("fs"), path = require("path"), { promisify } = require("util");
const { open, migrate } = require("./lib/db"), { createCore } = require("./lib/core"), { createChesscom } = require("./lib/chesscom");
const C = require("./lib/content"), { AppError } = require("./lib/errors");
const scrypt = promisify(crypto.scrypt);

const PROD = process.env.NODE_ENV === "production", PORT = process.env.PORT || 3000;
const log = (level, o) => console.log(JSON.stringify({ t: new Date().toISOString(), level, ...o }));
if (PROD && process.env.CHESSCOM_API) throw new Error("CHESSCOM_API is a testing hook and must not be set in production.");

const DB_FILE = process.env.DB_FILE || path.join(__dirname, "levelup.db");
const db = open(DB_FILE);
migrate(db, { file: DB_FILE, backupDir: process.env.BACKUP_DIR || path.join(path.dirname(DB_FILE), "backups") });
const core = createCore(db, { log });
const cc = createChesscom({ base: process.env.CHESSCOM_API, contact: process.env.CONTACT_EMAIL });

let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  log("warn", { msg: "SESSION_SECRET is not set; using a generated .secret file. Set SESSION_SECRET so sessions survive redeploys." });
  const f = path.join(__dirname, ".secret");
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  SECRET = fs.readFileSync(f, "utf8");
}

// ---- sessions (signed cookie; the version number lets logout revoke every session) ----
const sign = s => crypto.createHmac("sha256", SECRET).update(s).digest("hex");
const mkToken = u => { const p = `${u.id}.${u.sv}.${Date.now() + 30 * 864e5}`; return p + "." + sign(p); };
function readToken(t) {
  const [id, sv, exp, sig] = (t || "").split("."); if (!sig) return null;
  const good = sign(`${id}.${sv}.${exp}`);
  if (good.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig)) || Date.now() > +exp) return null;
  return { id: +id, sv: +sv };
}
const cookie = (req, n) => { const m = (req.headers.cookie || "").split(/;\s*/).find(c => c.startsWith(n + "=")); return m ? decodeURIComponent(m.slice(n.length + 1)) : null; };
const setSession = (res, u) => res.setHeader("Set-Cookie", `sid=${encodeURIComponent(mkToken(u))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${PROD ? "; Secure" : ""}`);

// ---- rate limiter (in memory, single instance) ----
const hits = new Map();
function limit(key, max, ms) {
  const now = Date.now(), h = (hits.get(key) || []).filter(t => now - t < ms);
  if (h.length >= max) return false; h.push(now); hits.set(key, h); return true;
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (!h.some(t => now - t < 15 * 60e3)) hits.delete(k); }, 5 * 60e3).unref();

const hashPw = async (pw, salt) => (await scrypt(pw, salt, 64)).toString("hex");
const DUMMY_SALT = crypto.randomBytes(16).toString("hex"), body = req => (req.body && typeof req.body === "object" ? req.body : {});

const app = express();
const hops = process.env.TRUST_PROXY ?? (PROD ? "1" : ""); // number of proxies in front of the app (Render: 1)
if (hops !== "") app.set("trust proxy", /^\d+$/.test(hops) ? +hops : hops);
app.use(express.json({ limit: "10kb" }));
app.use((req, res, next) => { const t0 = Date.now(); res.on("finish", () => { if (req.path.startsWith("/api")) log("info", { m: req.method, p: req.path, s: res.statusCode, ms: Date.now() - t0 }); }); next(); });
app.use(express.static(path.join(__dirname, "public")));

function auth(req, res, next) {
  const t = readToken(cookie(req, "sid")), u = t && core.user(t.id);
  if (!u || u.sv !== t.sv) throw new AppError("auth", "Please log in.", 401);
  req.u = u; next();
}
const authLimit = req => { if (!limit("auth:" + req.ip, 20, 15 * 60e3)) throw new AppError("rate_limited", "Too many attempts. Try again later.", 429); };

app.get("/healthz", (req, res) => { db.prepare("SELECT 1").get(); res.json({ ok: true }); });
app.get("/api/catalog", (req, res) => res.json(C.catalog()));

app.post("/api/signup", async (req, res) => {
  authLimit(req);
  const n = String(body(req).username || "").trim().toLowerCase(), p = String(body(req).password || "");
  if (!/^[a-z0-9_]{3,20}$/.test(n)) throw new AppError("bad_username", "Username: 3-20 letters, numbers or underscores.");
  if (p.length < 8 || p.length > 200) throw new AppError("bad_password", "Password must be 8 to 200 characters.");
  const salt = crypto.randomBytes(16).toString("hex"), h = await hashPw(p, salt);
  let id; try { id = core.createUser(n, salt, h); } catch (e) { if (/UNIQUE/.test(e.message)) throw new AppError("username_taken", "That username is taken.", 409); throw e; }
  setSession(res, core.user(id)); res.json({ ok: true });
});
app.post("/api/login", async (req, res) => {
  authLimit(req);
  const n = String(body(req).username || "").trim().toLowerCase(), p = String(body(req).password || "");
  const u = db.prepare("SELECT * FROM users WHERE username=?").get(n);
  const h = await hashPw(p.slice(0, 200), u ? u.salt : DUMMY_SALT); // always hash, so timing doesn't reveal usernames
  if (!u || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(u.hash))) throw new AppError("bad_login", "Wrong username or password.", 401);
  setSession(res, u); res.json({ ok: true });
});
app.post("/api/logout", (req, res) => {
  const t = readToken(cookie(req, "sid")); if (t) core.bumpSession(t.id); // revokes this and any other session
  res.setHeader("Set-Cookie", "sid=; Max-Age=0; Path=/"); res.json({ ok: true });
});
app.get("/api/me", auth, (req, res) => res.json(core.view(req.u.id)));

// Chess.com linking: claim a username, then prove it by putting a code in the profile Location.
app.post("/api/cc", auth, async (req, res) => {
  const name = String(body(req).cc || "").trim().toLowerCase();
  if (!/^[a-z0-9_-]{3,25}$/.test(name)) throw new AppError("bad_cc", "That doesn’t look like a chess.com username.");
  if (!(await cc.profile(name))) throw new AppError("cc_not_found", "No chess.com player with that username.", 404);
  core.startLink(req.u.id, name, "luc-" + crypto.randomBytes(3).toString("hex")); res.json(core.view(req.u.id));
});
app.post("/api/cc/verify", auth, async (req, res) => {
  const u = req.u; if (!u.cc_pending) throw new AppError("no_pending", "Start by entering your chess.com username.");
  const p = await cc.profile(u.cc_pending);
  if (!p || !String(p.location || "").toLowerCase().includes(u.cc_code)) throw new AppError("code_missing", "Code not found in your chess.com Location yet. Save it there and try again.");
  if (String(p.status || "").startsWith("closed")) throw new AppError("account_closed", "That chess.com account is closed.");
  res.json(reply(u.id, core.finishLink(u.id, p.player_id)));
});
app.post("/api/sync", auth, async (req, res) => {
  const u = req.u; if (!u.cc) throw new AppError("not_linked", "Verify your chess.com username first.");
  if (!limit("sync:" + u.id, 1, 30e3)) throw new AppError("rate_limited", "Easy there, wait 30 seconds between syncs.", 429);
  const p = await cc.profile(u.cc);
  if (!p) throw new AppError("cc_not_found", "That chess.com account could not be found.", 404);
  if (String(p.status || "").startsWith("closed")) throw new AppError("account_closed", "That chess.com account is closed, so it can’t earn rewards.", 403);
  if (p.player_id !== u.cc_player_id) { core.unlink(u.id); throw new AppError("identity_changed", "That username now belongs to a different chess.com account. Please link it again.", 409); }
  res.json(reply(u.id, core.sync(u.id, await cc.games(u.cc))));
});

// The player view plus an action's result. Newly unlocked achievements go in `unlocked`, so they don't overwrite the view's `ach` progress.
const reply = (uid, r) => { const { ach, ...rest } = r || {}; return { ...core.view(uid), ...rest, unlocked: ach || [] }; };
const act = fn => (req, res) => res.json(reply(req.u.id, fn(req.u.id, body(req))));
app.post("/api/buy", auth, act((u, b) => core.buy(u, String(b.id || ""))));
app.post("/api/equip", auth, act((u, b) => core.equip(u, Number(b.iid))));
app.post("/api/upgrade", auth, act((u, b) => core.upgrade(u, Number(b.iid))));
app.post("/api/dismantle", auth, act((u, b) => core.dismantle(u, Number(b.iid))));
app.post("/api/craft", auth, act((u, b) => core.craft(u, b.grid)));
app.post("/api/use", auth, act((u, b) => core.use(u, String(b.kind || ""))));
app.post("/api/quest", auth, act((u, b) => core.claimQuest(u, String(b.id || ""))));
app.post("/api/craft/preview", auth, (req, res) => {
  if (!limit("prev:" + req.u.id, 120, 60e3)) throw new AppError("rate_limited", "Slow down a little.", 429);
  res.json(core.preview(req.u.id, body(req).grid));
});

let lbCache = { at: 0, rows: [] };
app.get("/api/leaderboard", (req, res) => { if (Date.now() - lbCache.at > 15e3) lbCache = { at: Date.now(), rows: core.leaderboard() }; res.json(lbCache.rows); });

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof AppError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err.type === "entity.parse.failed" || err.status === 400) return res.status(400).json({ error: "Invalid request.", code: "bad_request" });
  log("error", { p: req.path, msg: err.message, stack: err.stack });
  res.status(500).json({ error: "Something went wrong on our side. Please try again.", code: "internal" });
});
app.listen(PORT, () => log("info", { msg: "Level Up Chess running", port: PORT, db: DB_FILE }));
