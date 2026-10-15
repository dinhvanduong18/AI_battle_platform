# OTTv2 backend (Phase 4)

This service adds account authentication, Redis Elo matchmaking, WebSocket signaling relay, PostgreSQL match ledger, signed result verification, Elo updates, and replay storage. The clients still send game traffic directly over a WebRTC DataChannel after signaling completes.

## Start with Docker Compose

From this directory:

1. Copy `.env.example` to `.env`.
2. Replace `JWT_SECRET` with a random secret of at least 32 characters and change the database password.
3. Run `docker compose --env-file .env up --build`.
4. Serve the project root over HTTP on port 8000, then open the page in two browsers. In the lobby, register two accounts and use **Tìm trận**.

The migration runs automatically at backend startup. For browser development, set `PUBLIC_ORIGIN` to the exact origin serving `index.html` and set the lobby backend URL to `http://localhost:8787`.

## Routes

- `POST /api/auth/register` and `POST /api/auth/login`
- `GET /api/me`
- `GET /api/matches` and `GET /api/matches/:id/replay`
- `POST /api/match/submit-result`
- WebSocket `/ws`: authenticate first, then use `find-match`, `cancel-match`, `session-key`, and `signal` messages.

The queue uses an Elo range beginning at ±100 and expands in timed intervals up to the configured maximum. PostgreSQL owns the authoritative account rating and result ledger. Result submission locks the match and both rating rows in one transaction, verifies both account-bound P-256 signatures, replays every committed move through `shared/OTTGameEngine.js`, compares the final state, then applies the configured FIDE-style K-factor calculation. Repeated submissions for a completed match are idempotent.

Replay JSON is stored in PostgreSQL by default. When S3-compatible credentials are configured, it is uploaded to the configured bucket and the API returns a short-lived signed download URL to an authorized player.

## Important deployment settings

- Use HTTPS/WSS for public deployment and configure `PUBLIC_ORIGIN` to the exact frontend origin.
- Put PostgreSQL, Redis, and the backend behind private network rules; expose only the HTTPS/WebSocket reverse proxy.
- Provide a TURN service for restrictive NATs. The current browser client uses a public STUN server as a development default.
- `FIDE_K_FACTOR` defaults to 20. The account model currently does not collect age or FIDE game-count data, so FIDE's special K-factor eligibility rules are not inferred.
- Disconnect claims from Phase 3 still need a dedicated adjudication policy and endpoint; an untrusted client cannot award itself Elo solely by claiming a peer disconnected.
