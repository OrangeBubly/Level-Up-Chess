# Level Up Chess: backend + frontend

Accounts, verified chess.com linking, server-side XP, upgrade shop and a public leaderboard.

## Run it
    npm install
    CONTACT_EMAIL=you@example.com npm start      # http://localhost:3000

Optional env vars: `PORT`, `DB_FILE` (SQLite path), `SESSION_SECRET` (otherwise generated into `.secret`),
`NODE_ENV=production` (marks the session cookie Secure; serve over HTTPS), `CONTACT_EMAIL` (sent in the
User-Agent to chess.com, which asks API users to identify themselves).

## How it stays fair
- The **server** reads games from chess.com's public API, so XP can't be faked from the browser.
- Players **prove ownership** of a chess.com username by putting a code in their profile's Location field.
  One chess.com account can be verified by one user only.
- Only **rated standard chess** games count; each game URL is recorded once so it can't be counted twice.
- First sync sets a baseline, so old games never give XP. Syncs are limited to one per 30 s per user.
- Passwords use scrypt; sessions are signed HttpOnly cookies; login/signup are rate limited.

## API
POST /api/signup, /api/login, /api/logout · GET /api/me · POST /api/cc, /api/cc/verify, /api/sync ·
POST /api/buy, /api/equip · GET /api/leaderboard

## Deploying
Needs a Node host with a persistent disk for the SQLite file (Render, Railway, Fly.io, a VPS). Serverless
hosts with ephemeral storage will lose data unless you swap SQLite for Postgres.
The rate limiter is in-memory, so run a single instance (or move it to Redis if you scale out).
