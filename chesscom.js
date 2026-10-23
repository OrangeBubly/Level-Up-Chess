"use strict";
// Chess.com Published-Data API client: one request at a time (they ask for serial access),
// conditional requests via ETag, and backoff when they answer 429.
const { AppError } = require("./errors");
function createChesscom({ base = "https://api.chess.com/pub", contact = "set CONTACT_EMAIL", fetchFn = fetch } = {}) {
  const UA = `LevelUpChess/2.0 (contact: ${contact})`, cache = new Map(), sleep = ms => new Promise(r => setTimeout(r, ms));
  let chain = Promise.resolve();
  async function once(url, n = 0) {
    const c = cache.get(url);
    const r = await fetchFn(url, { headers: { "User-Agent": UA, ...(c ? { "If-None-Match": c.etag } : {}) } });
    if (r.status === 304 && c) return c.body;
    if (r.status === 404 || r.status === 410) return null;
    if (r.status === 429 && n < 2) { await sleep(1500 * 2 ** n); return once(url, n + 1); }
    if (!r.ok) throw new AppError("chesscom_unavailable", "Chess.com isn’t responding right now. Please try again in a minute.", 502);
    const body = await r.json(), etag = r.headers.get("etag");
    if (etag) { cache.set(url, { etag, body }); if (cache.size > 500) cache.delete(cache.keys().next().value); }
    return body;
  }
  const get = url => { const job = chain.then(() => once(url)); chain = job.catch(() => {}); return job; };
  return {
    profile: u => get(`${base}/player/${u}`),
    async games(u, months = 2) {
      const ar = await get(`${base}/player/${u}/games/archives`);
      let out = []; for (const x of ((ar && ar.archives) || []).slice(-months)) out = out.concat(((await get(x)) || {}).games || []);
      return out;
    },
  };
}
module.exports = { createChesscom };
