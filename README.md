# ShowStake

Current mainnet review handoff (2026-11-13): [browser steps and scoped treasury plan](docs/mainnet-user-test.md), [review evidence and remaining gates](docs/evidence/mainnet-integration-review-20261113.json). The production mainnet frontend build passes locally, but funded event/Rhea acceptance is still blocked: actual withdrawal, contract recovery/provenance, real browser wallet and final PostgreSQL migration tests remain open. The deployed escrow stays empty and paused. Do not interpret the mainnet build as permission to deposit.

ShowStake is an event attendance commitment platform built around NEAR escrow. Participants lock a fixed attendance deposit that cannot be voluntarily withdrawn after registration; an account-bound, non-transferable pass represents registration. Organizers finalize attendance onchain before settlement and claims. The product addresses registrations that do not translate into attendance.

Accepted increments include the database foundation, independent settlement oracle, wallet/signing diagnostic harness, and Rust escrow/pass, attendance, settlement and claim contract. The core contract financial lifecycle is exercised on NEAR testnet; full browser/backend integration remains incomplete. Hackathon tracks: `open` and `nfts`; the custom pass does not claim NEP-171 or NEP-393 compliance.

## Inspect the paused mainnet deployment

Contract: [`showstake-mainnet-escrow-endpx-2026.near`](https://nearblocks.io/address/showstake-mainnet-escrow-endpx-2026.near). This is **PASS_LIVE for empty, paused deployment only**. There is no mainnet event or participant deposit; Rhea funded withdrawal and mainnet browser lifecycle are not accepted.

1. Inspect [account creation](https://nearblocks.io/txns/J8fBgZFDPnvoViz9UQPUeKaYs1qQoaRt81QWqMWL9tZQ) and [atomic deploy + initialization](https://nearblocks.io/txns/HoBrYk5ye1n4SXThHULFTg3avu8dyo8ERy5XL3SDEjwc).
2. Run `near contract call-function as-read-only showstake-mainnet-escrow-endpx-2026.near get_rhea_control json-args '{}' network-config mainnet now`. See paused=true and principal_cap=0. Run `get_event` the same way and see null.
3. Inspect [receipt/code/balance evidence](docs/evidence/mainnet-deploy-20261112T221125Z/result.json). Onchain code matches SHA-256 `03076c4a9496e8ae1e6af68c791752d4a7220597942effd0c3a1839a252be9d2`; deployed code matching is not a claim of independent audit or reproducible source verification.

Fees totaled0.0092553459773227NEAR. The2.30NEAR contract funding is mostly retained as balance/storage reserve. FullAccess upgrade authority is retained in the local OS keychain. No public deposit pilot is enabled.

## Inspect the five-person settlement on testnet

Current settlement instance: `showstake-settle-endpx.testnet`, source `b744c00`, Wasm `f462ddcbb8b47ff03f4bea71c054cefe0d0a576b1346a0f9a55688c43307fd59`, policy `showstake-v2-d036-settle/1`.

1. Inspect [finalization](https://testnet.nearblocks.io/txns/Cwe8nVcUc1uTphYTChPSgifCBuRgtCKNBhE228LCv9mf) and [settlement](https://testnet.nearblocks.io/txns/D9f1DRGL4qHqD4jW7d4PPKBgPZcvXTZtHYj4cBmsit91). See five registrations, two organizer-attested attendees, and an allocated total of10 SS_TEST.
2. Inspect [attendee1 claim](https://testnet.nearblocks.io/txns/EkQ4teBg161EDxwnggk1PiTxrmFmLYocVdH68DN5r4F7) and [attendee2 claim](https://testnet.nearblocks.io/txns/8fg8fSnaCF7m5uAExN4xBAbH4njWFGuCamcMnjxRDWRe). Each participant deposited2 SS_TEST and received5; the three no-shows received0.
3. Read `get_settlement` / `get_event_totals` for event `d036-settle-five`: see `Settled`, complete allocation, accepted/paid `10000000` atomic units, pending/liability `0`. Inspect [all31 receipts, five passes and balance snapshots](docs/evidence/testnet-settlement-five.json).

This uses normal FT deposits and actual testnet time windows, with no state patch. Organizer-only attendance/finalization, premature claims, no-show claims and duplicate claims were tested as expected failures. SS_TEST is synthetic testnet FT (6decimals), not NEAR or USD. These CLI/keychain proofs do not imply browser/wallet integration, a public deposit pilot, mainnet readiness or completed indexing.

## Inspect D036 cancellation and claim on testnet

The newer clean instance is `showstake-d036-endpx.testnet`, deployed from source snapshot `a632d3c` with Wasm SHA-256 `d79ef24c72d2eea762d4c3e78a1990a21bf13458b0bf07c908a68fc6ca1d5bee` and policy `showstake-v2-d036/1`. A valid commit is final for participants: voluntary withdrawal/rejoin is denied. Organizer cancellation and deadline timeout preserve principal refunds.

1. Read `get_config` on this account through NEAR testnet RPC. See the D036 policy, immutable organizer and canonical synthetic FT.
2. Inspect [the cancellation](https://testnet.nearblocks.io/txns/9dkwCjpHrhcW5tDFhcqfcAwEEwyVZ1UEcYZusqj7oWjY) and [the claim](https://testnet.nearblocks.io/txns/3KyMCsRvbkgLW6U5xjqp6EYmnWR5YXrXYDUxGupY2ZdG). See a real testnet FT payout after organizer cancellation.
3. Read `get_claim` with registration ID `reg-0` and `get_event_totals` with event ID `d036-refund-test`. See `Paid`, accepted/paid `1000000`, pending/liability `0`. [Full receipts and balance snapshots](docs/evidence/testnet-d036-smoke.json) distinguish local, testnet and not-run cases.

These are CLI/keychain proofs using synthetic SS_TEST; no browser/wallet/full lifecycle acceptance is implied. Testnet timeout24h, attendance, finalization, redistribution and factory remain open. The earlier minimum instance below remains unchanged; it was not upgraded over incompatible state.

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
