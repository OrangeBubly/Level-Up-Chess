"use strict";
// Builds public/vendor/openings/openings.json, the opening book the review screen uses for "book" moves and opening names.
// Source: the Lichess opening list (CC0, public domain): https://github.com/lichess-org/chess-openings
// Usage: download a.tsv ... e.tsv from that repository into a folder, then run
//   node tools/build-openings.js <that folder>
// Every position on every named line counts as book. Positions are keyed by a short hash of the first four FEN fields
// (pieces, side to move, castling, en passant); public/index.html hashes positions the same way (bookKey).
const fs = require("fs"), path = require("path");
const dir = process.argv[2]; if (!dir) { console.error("usage: node tools/build-openings.js <folder with a.tsv..e.tsv>"); process.exit(1); }
const fnv = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0; return h.toString(16).padStart(8, "0"); };
const key = fen => fnv(fen.split(" ").slice(0, 4).join(" "));
(async () => {
  const { Chess } = await import(path.join(__dirname, "../public/vendor/chess/chess.js").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:"));
  const names = [], pos = {};
  for (const x of ["a", "b", "c", "d", "e"]) {
    for (const line of fs.readFileSync(path.join(dir, x + ".tsv"), "utf8").split(/\r?\n/).slice(1)) {
      const [eco, name, pgn] = line.split("\t"); if (!pgn) continue;
      const b = new Chess(); b.loadPgn(pgn);
      const moves = b.history(), r = new Chess();
      for (const m of moves) { r.move(m); const k = key(r.fen()); if (!(k in pos)) pos[k] = -1; }
      const k = key(r.fen()); if (pos[k] === -1) { pos[k] = names.length; names.push([eco, name]); } // first name for a position wins
    }
  }
  const out = path.join(__dirname, "../public/vendor/openings/openings.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ source: "Lichess chess-openings (CC0)", names, pos }));
  console.log(`${names.length} named openings, ${Object.keys(pos).length} book positions, ${fs.statSync(out).size} bytes -> ${out}`);
})();
