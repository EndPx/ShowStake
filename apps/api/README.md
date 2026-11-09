# ShowStake API

A Fastify/TypeScript server for public event projections and native NEAR proof-of-control sessions. The contract remains the authority for registration, attendance and payouts. Implemented routes include authenticated `GET /v1/me/passes`, `GET /v1/me/claims`, organizer-only `GET /v1/events/:eventId/attendance`, and fail-closed gated `GET /v1/events/:eventId/content` alongside the public and session routes.

## Run and observe

1. Run `pnpm install --frozen-lockfile --ignore-scripts`, then `pnpm verify:api`. See the complete local test summary, including nonce replay, delayed RPC replies, expiry during RPC, Origin authorization and challenge rate limiting. Generated local signatures and injected access-key resolvers do not prove a wallet or testnet login.
2. Run `pnpm verify:api-db` on Windows with WSL distribution `Ubuntu`. See a real disposable PostgreSQL cluster apply the migrations, serve loopback HTTP, exercise sessions with a restricted service LOGIN, and stop before cleanup. The runner uses Linux `/tmp` (tmpfs on the reviewed machine), not Windows `%TEMP%`. Downloads are pinned to Linux Node24.18.0 and official PostgreSQL18 packages. Every DB run has its own artifact directory.
3. To run a persistent local API, provision PostgreSQL using `migrations/`, set the environment below privately, run `pnpm build:api`, then `node apps/api/dist/index.js`. Open `http://127.0.0.1:3001/health`; see `db: up` when the configured database is reachable. The disposable test server stops after its suite and is not a persistent application instance.

## Configuration and database identity

Required: `DATABASE_URL`, `DB_ROLE=showstake_api`, `AUTH_DOMAIN` (fixed NEP-413 recipient), and `AUTH_NETWORK=testnet` (or an explicitly selected supported environment). Keep credentials outside Git; never use a migration operator/superuser connection for the API.

An administrator provisions a dedicated service LOGIN with `NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS` and grants it membership in `showstake_api` only. Set its authentication credential privately through the deployment credential mechanism. The runtime sets the API role before handing out pool connections, rejects privileged session identities, and checks projection write denial. `RESET ROLE` returns to the unprivileged service identity, not an operator. Tests provision a disposable `showstake_api_service` login over a local Unix socket; this is not production credential provisioning.

Defaults: `HOST=127.0.0.1`, `PORT=3001`, challenge TTL capped at5minutes, session idle15minutes/absolute24hours, Secure/HttpOnly/SameSite=Lax cookie, `TRUST_PROXY=false`. Set `AUTH_ALLOWED_ORIGINS` to exact application origins. Use `COOKIE_SECURE=false` only for explicitly local HTTP testing. `RPC_TESTNET_URL` and `RPC_MAINNET_URL` default to official NEAR RPC endpoints; local RPC requires explicit configuration. RPC requests time out after10seconds and fail closed.

## Security and interfaces

- Challenges bind account, network, domain, purpose, nonce and timestamps. Only nonce/token hashes are stored. The signer echoes the32-byte nonce in hex with the NEP-413 public key/signature.
- Crypto and current FullAccess key membership must verify. A fresh RPC reply is checked against a post-RPC clock; expiry is checked again afterward. No implicit-account fixture fallback is enabled in the service.
- A challenge row is locked before the database checks current expiry and consumes it. Session creation shares that transaction. Expiry while blocked on an unchanged row cannot create a session.
- Session writes require an allowed Origin/Referer, in addition to cookie policy. The challenge endpoint is limited to10/minute/direct socket IP per process; forwarded headers cannot rotate the bucket. A multi-instance deployment needs shared limiting or a verified ingress policy before production acceptance.
- Public event reads require no session/pass and report staleness from observed timestamps. Worker cursors/indexing are not implemented, so this is row-age freshness only. No chain data is fabricated by the API.
- Passes and claims are read only from projections keyed by the verified session wallet binding; the client cannot select an account. Attendance compares that binding to the event organizer account and never treats a participant pass as host authority. Content requires the same account to own an attended pass and the event to be `SETTLED`, then fails closed when projection freshness or a verified private-object signer is unavailable.
- D036 removes voluntary participant withdrawal/rejoin after commit. This API exposes no withdrawal route.

## Acceptance boundary

The initial executor was DeepSeek Harness/GATER, with later MiniMax work. Codex identified defects, stopped the incompatible worker attempt with process confirmation, and implemented/tested the final integration fixes. The review/implementation provenance is recorded in `docs/evidence/api-codex-integration-review.json`; this is not an independent external security audit.

QR/check-in/funding routes, contract ingestion and indexing, browser wallet integration, social/email/EVM login, and a persistent hosted deployment remain future scope. A fresh empty database has no catalog events until a verified worker projects contract activity. No testnet API authentication or full T05/E2E acceptance is claimed; local route behavior does not prove live storage signing or chain finality.
