# ShowStake

ShowStake is an event attendance commitment platform built around NEAR escrow. Participants commit a refundable deposit to an event; an account-bound, non-transferable pass represents registration. Organizers finalize attendance onchain before settlement and claims. The product addresses registrations that do not translate into attendance.

Accepted increments include the database foundation, independent settlement oracle, wallet/signing diagnostic harness, and minimum Rust escrow/pass contract. The minimum contract is deployed on NEAR testnet; the full browser/backend/financial lifecycle remains incomplete. Hackathon tracks: `open` and `nfts`; the custom pass does not claim NEP-171 or NEP-393 compliance.

## Inspect the minimum testnet contract

This deployment uses synthetic testnet assets only. Contract: `showstake-endpx.testnet`; organizer: `showstake-participant-endpx.testnet`; FT: `showstake-ft-endpx.testnet` (`SS_TEST`, 6 decimals). Source snapshot: `70d6319`; Wasm SHA-256: `fc49fb85cc6e718086ddf81e9a936362a8c36ef9384a8444eadafa6ec0cdcd8e`. One contract instance hosts one event and issues account-bound passes. Factory, withdrawal, cancellation, attendance, settlement and claim are not available in this artifact. Do not use real assets or treat this as a public deposit invitation.

1. Run `npx --yes near-cli-rs@0.31.1 contract call-function as-read-only showstake-endpx.testnet get_config json-args '{}' network-config testnet now`. See the immutable organizer, canonical FT, testnet network and policy version.
2. Run the same read command with method `list_events` and JSON arguments `'{"from":0,"limit":10}'`. See the published test event and its contract-derived counts, or an empty list before publication.
3. Inspect the [deployment receipt](https://testnet.nearblocks.io/txns/B5DJuxtFuHi7gs2ePg3YKxG5orJqpA1myXo4qdyEm4mv), [deployment evidence](docs/evidence/testnet-showstake-deployment-result.json), and [Codex local review](docs/evidence/contract-slice-codex-review.json). See actual environment labels and the limits of this minimum slice.

## Try the local API

1. Run `pnpm verify:api`. See40 local checks for public event reads, nonce/signature/session behavior, delayed RPC/expiry, Origin checks and rate limits. These use generated local keys and an injected resolver, not a real-wallet proof.
2. Run `pnpm verify:api-db` with WSL `Ubuntu`. See25 checks against a real disposable PostgreSQL server, including a loopback HTTP server, restricted service login, concurrent nonce use and expiry after a database lock. The server stops after the suite.
3. Follow [API configuration](apps/api/README.md) to run a persistent local server against your configured database. Worker/indexing and full browser/testnet auth integration remain incomplete.

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
