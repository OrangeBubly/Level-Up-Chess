"use strict";
// Level Up Chess: HTTP layer. Game logic lives in lib/core.js; this file does auth, routing and errors.
const express = require("express"), crypto = require("crypto"), fs = require("fs"), path = require("path"), { promisify } = require("util");
const { open, migrate } = require("./lib/db"), { createCore } = require("./lib/core"), { createChesscom } = require("./lib/chesscom");
const C = require("./lib/content"), { AppError } = require("./lib/errors");
const scrypt = promisify(crypto.scrypt);

const PROD = process.env.NODE_ENV === "production", PORT = process.env.PORT || 3000;
const log = (level, o) => console.log(JSON.stringify({ t: new Date().toISOString(), level, ...o }));
if (PROD && process.env.CHESSCOM_API) throw new Error("CHESSCOM_API is a testing hook and must not be set in production.");

// Admins are listed only in the ADMIN_USERS environment variable (comma-separated usernames), never in the database,
// so nothing on the website can make someone an admin. List only accounts that already exist.
const ADMINS = new Set(String(process.env.ADMIN_USERS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
if (ADMINS.size) log("info", { msg: "admin accounts configured", count: ADMINS.size });
const DB_FILE =process.env.DB_FILE || path.join(__dirname, "levelup.db");
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
// small JSON bodies everywhere, except texture uploads (an admin-only route with its own bigger limit)
const smallJson = express.json({ limit: "10kb" }), artJson = express.json({ limit: "400kb" });
app.use((req, res, next) => req.path === "/api/admin/art" ? next() : smallJson(req, res, next));
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

// Sign-up is two steps so an account only exists once a chess.com account (which needs a verified email) is proven.
// Step 1 checks everything and hands back a code plus a signed token; nothing is stored. Step 2 checks the code is in the
// chess.com profile Location, then creates the account already linked. One chess.com account = one site account.
function signupFields(req) {
  const n = String(body(req).username || "").trim().toLowerCase(), p = String(body(req).password || ""), name = String(body(req).cc || "").trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(n)) throw new AppError("bad_username", "Username: 3-20 letters, numbers or underscores.");
  if (p.length < 8 || p.length > 200) throw new AppError("bad_password", "Password must be 8 to 200 characters.");
  if (!/^[a-z0-9_-]{3,25}$/.test(name)) throw new AppError("bad_cc", "That doesn’t look like a chess.com username.");
  if (db.prepare("SELECT 1 FROM users WHERE username=?").get(n)) throw new AppError("username_taken", "That username is taken.", 409);
  if (db.prepare("SELECT 1 FROM users WHERE cc=?").get(name)) throw new AppError("cc_taken", "That chess.com account is already linked to another account.", 409);
  return { n, p, name };
}
const signSignup = s => sign("signup:" + s);
app.post("/api/signup/start", async (req, res) => {
  authLimit(req);
  const { n, name } = signupFields(req), p = await cc.profile(name);
  if (!p) throw new AppError("cc_not_found", "No chess.com player with that username.", 404);
  if (String(p.status || "").startsWith("closed")) throw new AppError("account_closed", "That chess.com account is closed.");
  const code = "luc-" + crypto.randomBytes(3).toString("hex");
  const data = Buffer.from(JSON.stringify({ n, cc: name, code, exp: Date.now() + 30 * 60e3 })).toString("base64url");
  res.json({ code, token: data + "." + signSignup(data) });
});
app.post("/api/signup", async (req, res) => {
  authLimit(req);
  const { n, p, name } = signupFields(req), [data, sig] = String(body(req).token || "").split(".");
  const good = data && sig && signSignup(data), t = good && good.length === sig.length && crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig)) ? JSON.parse(Buffer.from(data, "base64url").toString()) : null;
  if (!t || t.n !== n || t.cc !== name) throw new AppError("bad_signup", "Please start sign-up again.");
  if (Date.now() > t.exp) throw new AppError("signup_expired", "That code expired. Please start sign-up again.");
  const prof = await cc.profile(name);
  if (!prof || !String(prof.location || "").toLowerCase().includes(t.code)) throw new AppError("code_missing", "Code not found in your chess.com Location yet. Save it there and try again.");
  if (String(prof.status || "").startsWith("closed")) throw new AppError("account_closed", "That chess.com account is closed.");
  if (db.prepare("SELECT 1 FROM users WHERE cc_player_id=?").get(prof.player_id)) throw new AppError("cc_taken", "That chess.com account is already linked to another account.", 409);
  const salt = crypto.randomBytes(16).toString("hex"), id = core.createLinkedUser(n, salt, await hashPw(p, salt), name, prof.player_id);
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
app.get("/api/me", auth, (req, res) => res.json(meView(req.u)));

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
  res.json(reply(u, core.finishLink(u.id, p.player_id)));
});
app.post("/api/sync", auth, async (req, res) => {
  const u = req.u; if (!u.cc) throw new AppError("not_linked", "Verify your chess.com username first.");
  if (!limit("sync:" + u.id, 1, 30e3)) throw new AppError("rate_limited", "Easy there, wait 30 seconds between syncs.", 429);
  const p = await cc.profile(u.cc);
  if (!p) throw new AppError("cc_not_found", "That chess.com account could not be found.", 404);
  if (String(p.status || "").startsWith("closed")) throw new AppError("account_closed", "That chess.com account is closed, so it can’t earn rewards.", 403);
  if (p.player_id !== u.cc_player_id) { core.unlink(u.id); throw new AppError("identity_changed", "That username now belongs to a different chess.com account. Please link it again.", 409); }
  res.json(reply(u, core.sync(u.id, await cc.games(u.cc))));
});

// The player view plus an action's result. The view wins any name clash, so a result can never replace part of it
// (newly unlocked achievements go in `unlocked` instead of overwriting the view's `ach` progress).
const meView = u => ({ ...core.view(u.id), admin: ADMINS.has(u.username) });
const reply = (u, r) => { const { ach, ...rest } = r || {}; return { ...rest, ...meView(u), unlocked: ach || [] }; };
const act = fn => (req, res) => res.json(reply(req.u, fn(req.u.id, body(req))));
app.post("/api/buy", auth, act((u, b) => core.buy(u, String(b.id || ""))));
app.post("/api/equip", auth, act((u, b) => core.equip(u, Number(b.iid))));
app.post("/api/upgrade", auth, act((u, b) => core.upgrade(u, Number(b.iid))));
app.post("/api/dismantle", auth, act((u, b) => core.dismantle(u, Number(b.iid))));
app.post("/api/craft", auth, act((u, b) => core.craft(u, b.grid)));
app.post("/api/use", auth, act((u, b) => core.use(u, String(b.kind || ""))));
app.post("/api/quest", auth, act((u, b) => core.claimQuest(u, String(b.id || ""))));
// ---- game reviews: the browser analyses the moves; the server checks the game is theirs, fetches the moves and decides the XP ----
const reviewOpened = new Map(); // user:game -> when its moves were sent, so a "review" finished seconds later pays nothing
setInterval(() => { const old = Date.now() - 6 * 3600e3; for (const [k, t] of reviewOpened) if (t < old) reviewOpened.delete(k); }, 30 * 60e3).unref();
app.get("/api/review/games", auth, (req, res) => res.json({ games: core.reviewList(req.u.id), left: core.reviewsLeft(req.u.id), xp: C.REVIEW_XP }));
app.get("/api/review/game", auth, async (req, res) => {
  if (!limit("review:" + req.u.id, 10, 60e3)) throw new AppError("rate_limited", "Slow down a little.", 429);
  const g = core.reviewTarget(req.u.id, req.query.key), month = await cc.month(g.me.name, g.year, g.month);
  const found = ((month && month.games) || []).find(x => x.url === g.key);
  if (!found || !found.pgn) throw new AppError("not_found", "Chess.com didn’t send the moves for that game. Try again in a minute.", 404);
  reviewOpened.set(req.u.id + ":" + g.key, Date.now());
  res.json({ ...g, pgn: found.pgn });
});
app.post("/api/review/complete", auth, (req, res) => {
  const key = String(body(req).key || ""), opened = reviewOpened.get(req.u.id + ":" + key);
  if (!opened) throw new AppError("reopen", "Open the game again to finish reviewing it.");
  if (Date.now() - opened < C.REVIEW_MIN_SECONDS * 1000) throw new AppError("too_fast", "Take a little longer: look through your mistakes before finishing.");
  reviewOpened.delete(req.u.id + ":" + key);
  res.json(reply(req.u, core.completeReview(req.u.id, key, body(req).accuracy)));
});
app.post("/api/chest/open", auth, act((u, b) => core.openChest(u, String(b.id || ""), Number(b.n) || 1)));
app.post("/api/lock", auth, act((u, b) => core.toggleLock(u, Number(b.iid))));
app.get("/api/dismantle/dupes", auth, (req, res) => res.json(core.dupesPreview(req.u.id)));
app.post("/api/dismantle/dupes", auth, act(u => core.dismantleDupes(u)));
app.post("/api/merchant", auth, act((u, b) => core.buyOffer(u, String(b.id || ""))));
app.post("/api/theme", auth, act((u, b) => core.setTheme(u, String(b.theme || ""))));
app.post("/api/mode", auth, act((u, b) => core.setMode(u, String(b.mode || ""))));
// ---- friends, public profiles and clans ----
const friendLimit = req => { if (!limit("friend:" + req.u.id, 20, 864e5)) throw new AppError("rate_limited", "That’s a lot of friend requests for one day. Try again tomorrow.", 429); };
app.post("/api/friend", auth, (req, res, next) => { friendLimit(req); next(); }, act((u, b) => core.addFriend(u, String(b.name || ""))));
app.post("/api/friend/answer", auth, act((u, b) => core.answerFriend(u, String(b.name || ""), b.accept === true)));
app.post("/api/friend/remove", auth, act((u, b) => core.removeFriend(u, String(b.name || ""))));
app.post("/api/privacy", auth, act((u, b) => core.setPrivacy(u, String(b.privacy || ""))));
app.get("/api/u/:name", auth, (req, res) => { const p = core.publicProfile(req.u.id, req.params.name); res.json({ ...p, admin: ADMINS.has(p.username) }); });

// ---- admin testing tools: only for ADMIN_USERS, only on their own account, every use logged ----
// Anyone else gets the same "not found" as a missing page, so the tools don't advertise themselves.
function admin(req, res, next) {
  if (!ADMINS.has(req.u.username)) throw new AppError("not_found", "Not found.", 404);
  const b = body(req), shown = b.png ? { ...b, png: `(${String(b.png).length} characters of image)` } : b;
  log("warn", { msg: "admin action", user: req.u.username, p: req.path, body: shown }); next();
}
app.post("/api/admin/give", auth, admin, act((u, b) => core.adminGive(u, String(b.kind || ""), Number(b.n))));
app.post("/api/admin/item", auth, admin, act((u, b) => core.adminItem(u, String(b.def || ""))));
app.post("/api/admin/wins", auth, admin, act((u, b) => core.adminWins(u, Number(b.wins))));
app.post("/api/admin/reset", auth, admin, act(u => core.adminResetDay(u)));

// ---- content editor: items, recipes and textures (admins only; changes apply to everyone at once) ----
app.get("/api/admin/content", auth, admin, (req, res) => res.json(core.contentAdmin()));
const edited = fn => (req, res) => { const r = fn(body(req)); lbCache.at = 0; res.json({ ok: true, result: r || null, catalog: C.catalog(), ...core.contentAdmin() }); };
app.post("/api/admin/item/save", auth, admin, edited(b => core.saveItem(b.item || {})));
app.post("/api/admin/item/delete", auth, admin, edited(b => core.deleteItem(String(b.id || ""))));
app.post("/api/admin/recipe/save", auth, admin, edited(b => core.saveRecipe(b.recipe || {})));
app.post("/api/admin/recipe/delete", auth, admin, edited(b => core.deleteRecipe(String(b.id || ""))));
app.post("/api/admin/recipe/restore", auth, admin, edited(b => core.restoreRecipe(String(b.id || ""))));
// sets, achievements, quests and merchant offers: kind is set, ach, quest or offer
app.post("/api/admin/content/save", auth, admin, edited(b => core.saveContent(String(b.kind || ""), b.data || {})));
app.post("/api/admin/content/delete", auth, admin, edited(b => core.deleteContent(String(b.kind || ""), String(b.id || ""))));
app.post("/api/admin/content/restore", auth, admin, edited(b => core.restoreContent(String(b.kind || ""), String(b.id || ""))));
// textures: a PNG (sent as base64), at most 200 KB and 512x512 pixels
app.post("/api/admin/art", auth, artJson, admin, edited(b => {
  const buf = Buffer.from(String(b.png || ""), "base64");
  const isPng = buf.length > 24 && buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && buf.subarray(12, 16).toString() === "IHDR";
  if (!isPng) throw new AppError("bad_image", "That isn’t a PNG image.");
  if (buf.length > 200 * 1024) throw new AppError("bad_image", "Images must be 200 KB or smaller.");
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  if (!w || !h || w > 512 || h > 512) throw new AppError("bad_image", "Images must be at most 512 x 512 pixels.");
  core.setArt(String(b.id || ""), buf);
}));
app.post("/api/admin/art/clear", auth, admin, edited(b => core.clearArt(String(b.id || ""))));
// public: serves a texture; ?v= in the page's link changes whenever the texture does, so it can be cached
app.get("/art/:file", (req, res) => {
  const m = /^([a-z0-9_]{1,40})\.png$/.exec(req.params.file), a = m && core.getArt(m[1]);
  if (!a) return res.status(404).end();
  res.set({ "Content-Type": "image/png", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'", "Cache-Control": "public, max-age=604800" }).send(a.png);
});
app.post("/api/clan/create", auth, act((u, b) => core.createClan(u, b.name, b.tag)));
app.post("/api/clan/join", auth, act((u, b) => core.joinClan(u, Number(b.id))));
app.post("/api/clan/cancel", auth, act((u, b) => core.cancelClanRequest(u, Number(b.id))));
app.post("/api/clan/answer", auth, act((u, b) => core.answerClan(u, String(b.name || ""), b.accept === true)));
app.post("/api/clan/leave", auth, act(u => core.leaveClan(u)));
app.post("/api/clan/kick", auth, act((u, b) => core.kick(u, String(b.name || ""))));
app.post("/api/clan/open", auth, act((u, b) => core.setClanOpen(u, b.open === true)));
let clanCache = { at: 0, rows: [] };
app.get("/api/clans", auth, (req, res) => { if (Date.now() - clanCache.at > 15e3) clanCache = { at: Date.now(), rows: core.clanBoard() }; res.json(clanCache.rows); });

const checkPassword = async (u, pw) => {
  if (!crypto.timingSafeEqual(Buffer.from(await hashPw(String(pw || "").slice(0, 200), u.salt)), Buffer.from(u.hash))) throw new AppError("bad_login", "Your current password is wrong.", 401);
};
app.post("/api/password", auth, async (req, res) => {
  authLimit(req);
  const p = String(body(req).password || "");
  await checkPassword(req.u, body(req).old);
  if (p.length < 8 || p.length > 200) throw new AppError("bad_password", "Password must be 8 to 200 characters.");
  const salt = crypto.randomBytes(16).toString("hex");
  core.setPassword(req.u.id, salt, await hashPw(p, salt));
  setSession(res, core.user(req.u.id)); res.json({ ok: true }); // this device stays logged in, every other one is logged out
});
// Clearing save data and deleting the account both need the password plus a typed confirmation word.
const confirmWord = (req, w) => { if (String(body(req).confirm || "").trim().toUpperCase() !== w) throw new AppError("confirm", `Type ${w} to confirm.`); };
app.post("/api/account/reset", auth, async (req, res) => {
  authLimit(req); confirmWord(req, "RESET"); await checkPassword(req.u, body(req).password);
  core.resetProgress(req.u.id); log("info", { msg: "progress reset", user: req.u.username });
  res.json(reply(req.u, {}));
});
app.post("/api/account/delete", auth, async (req, res) => {
  authLimit(req); confirmWord(req, "DELETE"); await checkPassword(req.u, body(req).password);
  core.deleteAccount(req.u.id); log("info", { msg: "account deleted", id: req.u.id });
  res.setHeader("Set-Cookie", "sid=; Max-Age=0; Path=/"); res.json({ ok: true });
});
app.post("/api/craft/preview", auth, (req, res) => {
  if (!limit("prev:" + req.u.id, 120, 60e3)) throw new AppError("rate_limited", "Slow down a little.", 429);
  res.json(core.preview(req.u.id, body(req).grid));
});

let lbCache = { at: 0, rows: [] };
app.get("/api/leaderboard", (req, res) => { if (Date.now() - lbCache.at > 15e3) lbCache = { at: Date.now(), rows: core.leaderboard(ADMINS) }; res.json(lbCache.rows); });

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof AppError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err.type === "entity.parse.failed" || err.status === 400) return res.status(400).json({ error: "Invalid request.", code: "bad_request" });
  log("error", { p: req.path, msg: err.message, stack: err.stack });
  res.status(500).json({ error: "Something went wrong on our side. Please try again.", code: "internal" });
});
app.listen(PORT, () => log("info", { msg: "Level Up Chess running", port: PORT, db: DB_FILE }));
