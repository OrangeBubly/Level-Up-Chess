// Fake chess.com Published-Data API for local testing (no real chess.com needed). Games are kept in memory only.
// Run:   node tools/fake-chesscom.js            (listens on port 4100, or FAKE_PORT)
// Then:  CHESSCOM_API=http://localhost:4100 node server.js     (never set CHESSCOM_API on the live site)
// GET  /player/:u, /player/:u/games/archives, /player/:u/games/:y/:m, /games/:u   (what the site reads)
// POST /add/:u?res=win|draw|loss&opp=name&tc=600&or=1500   adds a rated game ending now (moves: Morphy's Opera Game)
// POST /loc/:u?v=luc-xxxxxx   sets the profile Location, to pass the sign-up / link check
const http = require("http");
const PORT = +process.env.FAKE_PORT || 4100, base = `http://localhost:${PORT}`;
const players = {}; let n = 0;
const P = u => players[u] || (players[u] = { id: 1000 + Object.keys(players).length, loc: "", games: [] });
http.createServer((req, res) => {
  const url = new URL(req.url, base), parts = url.pathname.split("/").filter(Boolean), q = url.searchParams;
  const send = (o, s = 200) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.method === "POST" && parts[0] === "loc") { P(parts[1]).loc = q.get("v") || ""; return send({ ok: 1 }); }
  if (req.method === "POST" && parts[0] === "add") {
    const u = parts[1], p = P(u), res_ = q.get("res") || "win", opp = q.get("opp") || "opp" + n, t = Math.floor(Date.now() / 1000) + (n++);
    const lose = { win: "resigned", draw: "agreed", loss: "win" }[res_], me = res_ === "loss" ? "resigned" : res_ === "draw" ? "agreed" : "win";
    p.games.push({ url: `https://fake/game/${t}-${n}`, end_time: t, rules: "chess", rated: true, time_control: q.get("tc") || "600",
      pgn: `[Event "Live Chess"]\n[White "${u}"]\n[Black "${opp}"]\n[Result "1-0"]\n[ECO "C41"]\n[ECOUrl "https://www.chess.com/openings/Philidor-Defense-3.d4-Bg4"]\n\n1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0`, white: { username: u, rating: 1500, result: me }, black: { username: opp, rating: +(q.get("or") || 1500), result: lose } });
    return send({ ok: 1, games: p.games.length });
  }
  if (parts[0] === "player" && parts.length === 2) { const p = P(parts[1]); return send({ username: parts[1], player_id: p.id, location: p.loc, status: "basic" }); }
  if (parts[0] === "player" && parts[2] === "games" && parts.length === 5) return send({ games: P(parts[1]).games }); // one month (all, for testing)
  if (parts[0] === "player" && parts[2] === "games") return send({ archives: [`${base}/games/${parts[1]}`] });
  if (parts[0] === "games") return send({ games: P(parts[1]).games });
  send({ error: "not found" }, 404);
}).listen(PORT, () => console.log("fake chess.com on " + base));
