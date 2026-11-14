# Isolated TESTNET preview ? current operator checkpoint

The review preview is https://showstake-testnet.vercel.app and the API origin/path is https://srv1330754.hstgr.cloud/testnet. The preview was published with the Vercel CLI from the same Git-connected project; the reviewed commit/push remains pending. It is testnet-only: Mock USDC and zero-yield MockEarn, with no mainnet financial acceptance implied.

The active HTTP path is **Nginx `/testnet` to the isolated API on port 3913**. The isolated PostgreSQL 18 instance listens on localhost:55442. The existing mainnet API remains on port 3912. An unused Caddy change was restored; do not install or reload a Caddy site for this preview. Preserve production services, existing state and credentials.

The factory worker has adopted three children but is **CATCHING_UP/BLOCKED_EXTERNAL**: HTTP 429 from raw-block source `https://testnet.neardata.xyz` and historical scanning still prevent fresh-index acceptance. Bounded dRPC and FASTNEAR final-block reads returned HTTP 200 in approximately 0.3 seconds; this is not sustained-throughput proof. Inspect the worker journal, provider responses and durable cursors; do not reset or jump a cursor to make a check pass. API health and a running process do not establish fresh event/pass projections or wallet lifecycle completion. Latest reported verification: API 37, funding PostgreSQL 16, worker PostgreSQL 96, web TypeScript 37 and web build; see `../../docs/evidence/atomic-factory-20261114/report.md` for contract and Sandbox evidence.

For a user-facing review, follow `../../docs/testnet-factory-user-test.md`. The current Vercel preview is still under review and the mixed browser/CLI lifecycle has not yet proven QR check-in and browser claim end to end. Never print environment files, credentials or wallet material while diagnosing.

## Local build

From the repository root with Node 24.18.x and pnpm 10.21.x:

```sh
pnpm install --frozen-lockfile
pnpm typecheck:web
pnpm build:web
pnpm build:api
pnpm --filter @showstake/worker build
```

These are local build commands. Production release, proxy changes, database operations and chain transactions require their own reviewed scope. A mainnet factory upgrade is a new financial action; the previous maximum 0.01 NEAR authorization has already been consumed.

Historical pre-deployment instructions remain available in Git history.
