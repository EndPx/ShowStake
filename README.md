# ShowStake

ShowStake is an event attendance commitment platform built around NEAR escrow. Participants commit a refundable deposit to an event; an account-bound, non-transferable pass represents registration. Organizers finalize attendance onchain before settlement and claims. The product addresses registrations that do not translate into attendance.

Accepted local increments include the database foundation, the independent settlement oracle, and the wallet/signing diagnostic harness. There is no deployed application or proven live escrow lifecycle yet. Hackathon tracks: `open` and `nfts`; the custom pass does not currently claim NEP-171 or NEP-393 compliance.

## Try the accepted foundation

Prerequisites: Node 24.18.x, pnpm 10.21.0, Git. The PostgreSQL command below additionally requires Windows with WSL distribution `Ubuntu`, Bash, and access to download official PostgreSQL packages and the pinned Linux Node runtime. It creates an isolated temporary server and stops it after the run.

1. Run `pnpm install --frozen-lockfile --ignore-scripts`. See the pinned database dependencies install without wallet or frontend dependencies.
2. Run `pnpm verify`. See toolchain checks and all 11 preserved planning-packet hashes pass. This checks foundation integrity; it does not exercise a wallet or migration.
3. Run `pnpm verify:t01-static`. See exact-money boundaries, SQL provenance, fail-closed evidence aggregation, and the 19-route OpenAPI contract validate. The OpenAPI file describes an interface; no HTTP server is implemented in this increment.
4. Run `pnpm verify:t01`. See migrations execute against a real disposable PostgreSQL server, followed by constraints, role denials, backup/restore, labeled chain-event replay, numeric boundaries and concurrency checks. Successful full runs record 52 database checks plus orchestration outcomes, proven server stop and cleanup.
5. Inspect the unique directory under `migrations/artifacts/` and [Codex review evidence](docs/evidence/t01-codex-52-review.json). See local test provenance and the limits of the evidence. Replay data is labeled fixture data, not observed onchain state.

NEAR remains the authority for registration, final attendance and payouts. A successful cross-chain swap is not registration; scanning a QR code is not final attendance. Login/signing, escrow deposit/pass/refund, settlement, gated content and funded cross-chain integration remain subsequent acceptance milestones.

Start with the [authoritative v2 planning packet](docs/planning/showstake-v2/00-START-HERE.md), [current status](docs/status.md), and [decisions](docs/decisions.md). Keep credentials in an ignored `.env`; `.env.example` contains placeholders only.

## Settlement/refund test support

Run `node test-support/settlement-oracle/scripts/run-oracle.mjs --packet-root . --evidence-dir .local/oracle-runs`. See 105 local oracle tests covering packet allocation examples, withdrawals, refund modes, claim callbacks and event isolation, with a unique evidence directory for every run. This executes a synthetic Node model; it does not execute a NEAR contract, measure gas, or pass T03/T04. Read the [oracle limits and OPEN_GATEs](test-support/settlement-oracle/README.md) before using it as an independent test reference.

## Wallet/signing diagnostic harness

Run `pnpm dev:t02-harness`, open the local URL Vite prints (default `http://127.0.0.1:5174/`), and see the NEAR Connect candidate plus a documented, uninvoked NEAR Auth candidate. `pnpm build:t02-harness` and the `verify:t02-*` scripts check the local implementation; they do not prove a real wallet session. Connect/sign/relogin requires a consenting human wallet, and production auth requires server-side challenge/session handling. No pass, deposit or payout success is simulated. See the [probe README](apps/web/onboarding-probe/README.md) and [Codex acceptance limits](docs/evidence/t02-codex-local-acceptance.json).
