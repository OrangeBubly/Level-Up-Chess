Third-party files used by the chess boards (game review and the Learn tab). They are served as-is and kept separate from the site's own code.

stockfish/  Stockfish 19 (lite, single-threaded WebAssembly build), from the "stockfish" npm package v19.0.1 by Nathan Rugg.
            Licence: GNU GPL v3, see stockfish/Copying.txt.
            Source code: https://github.com/nmrugg/stockfish.js (this build) and https://github.com/official-stockfish/Stockfish (the engine).

chess/      chess.js v1.4.0 (move rules and PGN reading), from the "chess.js" npm package.
            Licence: BSD 2-Clause, see chess/LICENSE. Source code: https://github.com/jhlywa/chess.js

openings/   openings.json, built by tools/build-openings.js from the Lichess opening list (a.tsv to e.tsv).
            Licence: public domain (CC0 1.0). Source: https://github.com/lichess-org/chess-openings

puzzles/    puzzles.json, a starter set for the Learn tab, built by tools/build-puzzles.js from the Lichess puzzle database.
            Licence: public domain (CC0 1.0). Source: https://database.lichess.org/#puzzles

pieces/     cburnett/, the chess piece set by Colin M.L. Burnett (the classic set also used by Lichess and Wikipedia),
            copied unchanged from https://github.com/lichess-org/lila/tree/master/public/piece/cburnett
            Licence: GPLv2 or later (also offered under BSD and GFDL on Wikimedia Commons). Author: https://en.wikipedia.org/wiki/User:Cburnett
