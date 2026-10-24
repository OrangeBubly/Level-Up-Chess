"use strict";
// Builds public/vendor/puzzles/puzzles.json, the starter puzzle set for the Learn tab.
// Source: the Lichess puzzle database (CC0, public domain): https://database.lichess.org/#puzzles
// Usage: node tools/build-puzzles.js [megabytes to read, default 25] [puzzles per 100 rating points, default 40]   (needs Node 22.15+ for zstd)
// The full file is about 300 MB, so this reads only its start (one download) and keeps well-liked, well-tested puzzles,
// up to PER_BAND for every 100 rating points. Each puzzle is checked with chess.js: every solution move must be legal.
// In the database the position is BEFORE the opponent's move: the first move is theirs, the rest is the solution.
const fs = require("fs"), path = require("path"), zlib = require("zlib");
const URL_ = "https://database.lichess.org/lichess_db_puzzle.csv.zst", MB = +process.argv[2] || 25, PER_BAND = +process.argv[3] || 40;
const out = path.join(__dirname, "../public/vendor/puzzles/puzzles.json");
(async () => {
  if (!zlib.zstdDecompressSync) throw new Error("This Node.js has no zstd support; use Node 22.15 or newer.");
  const { Chess } = await import(path.join(__dirname, "../public/vendor/chess/chess.js").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:"));
  const r = await fetch(URL_, { headers: { Range: `bytes=0-${MB * 1048576 - 1}`, "User-Agent": "Level Up Chess puzzle builder" } });
  if (r.status !== 206 && r.status !== 200) throw new Error("Lichess said " + r.status);
  // the download stops mid-file, so decompress as a stream and keep everything before the cut
  const text = await new Promise(ok => {
    const parts = [], z = zlib.createZstdDecompress();
    z.on("data", d => parts.push(d)).on("error", () => ok(Buffer.concat(parts).toString("utf8"))).on("end", () => ok(Buffer.concat(parts).toString("utf8")));
    r.arrayBuffer().then(b => z.end(Buffer.from(b)));
  });
  const lines = text.split("\n").slice(1, -1), bands = {}; // the last line may be cut short
  for (const line of lines) {
    const [id, fen, moves, rating, dev, pop, plays, themes] = line.split(",");
    if (+pop < 90 || +plays < 500 || +dev > 90) continue;
    const band = Math.floor(+rating / 100); if ((bands[band] || (bands[band] = [])).length >= PER_BAND) continue;
    const all = moves.split(" "), b = new Chess(fen), u = all[0];
    try {
      b.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      const after = b.fen(); for (const m of all.slice(1)) b.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
      bands[band].push({ id, fen: after, last: u.slice(0, 4), moves: all.slice(1), rating: +rating, themes: themes.split(" ") });
    } catch { console.log("skipped " + id + " (did not check out)"); }
  }
  const list = Object.values(bands).flat().sort((a, b) => a.rating - b.rating);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ source: "Lichess puzzle database (CC0)", puzzles: list }));
  console.log(`read ${lines.length} puzzles, kept ${list.length}, ratings ${list[0].rating} to ${list[list.length - 1].rating}, ${fs.statSync(out).size} bytes -> ${out}`);
})();
