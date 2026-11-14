# ShowStake

## Current release checkpoint — one shared contract

ShowStake is a NEAR event commitment application: participants deposit an exact amount of native USDC on NEAR, receive a non-transferable account-bound pass, and eligible attendees claim the settled pool after organizer-attested attendance and final Rhea redemption. Multiple events share one contract account with separate principal, strategy ownership and claim accounting. Event creation does not deploy another Wasm.

- **Mainnet website:** https://showstake.vercel.app. The CommitPass-derived frontend, NEAR wallet/session integration and VPS backend are deployed.
- **Current mainnet contract:** [`showstake-mainnet-escrow-endpx-2026.near`](https://nearblocks.io/address/showstake-mainnet-escrow-endpx-2026.near), upgraded to **shared-yield V8**, schema2, at block224507548. [Final upgrade receipt](https://nearblocks.io/txns/5nL4htVAQREWW3e7UniPoE5n8bCbD9cJ72REMWjcqiZb).
- **Mainnet artifact:** Wasm276035B, SHA-256 `2fdc615b6427858b8a351b03343385052353ef1b466caad47d16a19c49e24c53`, code hash `4Dq4uEH2PE9FEB7n67d3r3fvHPUy5KAvjhgZ8q5sX4PU`. See the [deployment result](docs/evidence/shared-mainnet-upgrade-v8-20261114/result.json). The existing account and upgrade key were retained; actual upgrade fee0.002184618005035NEAR. No user event, USDC supply or redemption was performed by the agent.
- **Shared testnet contract:** `ss-shared-s1114151743.testnet`, with `mockusdc.testnet` and the explicitly labelled zero-yield MockEarn provider. [Website guide](docs/shared-yield-testnet-guide.md), [42 final lifecycle receipt graphs](docs/evidence/testnet-shared-s1114151743/result.json), [current integration review](docs/evidence/shared-yield-v8-20261114/review.md).
- **Backend:** PostgreSQL schema 11 with 29 primary keys and 47 validated foreign keys. [ERD](docs/backend-erd.md). Old deployment identities and cursors are retained across code revisions.

### Release acceptance flow

The user signs the complete website flow: create event and verify its final receipt; participants deposit exact USDC and read their onchain pass; close registration and supply Rhea; propose QR check-in and separately sign attendance; finalize attendance after check-in closes; redeem Rhea, settle and claim; reconcile USDC and event liability; verify attendee-only materials. A submitted transaction, QR proposal, timer or database row does not prove a completed financial operation. Mainnet user cycle and real Rhea returned-USDC liquidity acceptance remain open.

The required five-participant scenario is five deposits of 2 USDC, two attendees and three no-shows. With zero realized yield, each attendee receives 5 USDC; realized yield is allocated according to the contract's exact rounding rules. The full scenario is proven on testnet with mock assets. Mainnet user acceptance remains open.

NEAR Intents funding is a separate preceding step: supported source asset to the participant's NEAR USDC balance, then an explicit escrow deposit. The currently integrated source routes are ETH on Base and Ethereum. Current catalog and dry quotes passed; funded delivery has not been claimed. Rhea remains `SELECTED_FOR_HACKATHON`, not `TECHNICALLY_ACCEPTED`, until its live technical and returned-USDC withdrawal gates pass.

### Build and review

Use Node 24.18.x and pnpm 10.21.x, then run `pnpm install --frozen-lockfile`, `pnpm typecheck:web`, `pnpm build:web`, `pnpm verify:api` and `pnpm verify:worker`. These local checks do not establish deployment or funded acceptance. Backend setup is documented in [apps/api](apps/api/README.md); the hosted website supplies the reviewed public deployment configuration.

Evidence is classified separately as local, testnet, live hosting/read-only, funded live, blocked or not run. The [current status](docs/status.md) and [decisions](docs/decisions.md) take precedence over dated checkpoints below. Historical raw-block HTTP429 is not relabelled as indexer catch-up; direct `FINAL_CHAIN` reads retain onchain authority.

## Historical checkpoints

The sections below preserve prior deployments and acceptance history. References to a frozen release, current instance or open scope in these dated sections do not replace the current checkpoint above.

Backend data model: [ERD with primary/foreign keys and multi-event boundaries](docs/backend-erd.md). Additive migration `0008` binds wallet ownership, event/deployment/token identity, pass ownership, payout beneficiaries and QR/check-in registrations. One contract deployment holds many events. Multi-event CREATE is live; pooled Earn and the full mainnet financial lifecycle remain unaccepted.

Public frontend: **https://showstake.vercel.app/events/new**. VPS API: **https://srv1330754.hstgr.cloud**. Any connected organizer can create an event directly on the shared mainnet contract after sign-in, an exact storage quote and wallet approval. There is no factory step. USDC registration and Rhea Earn are disabled in this frozen CREATE-only release.

Current handoff: [do-X/see-Y website steps](docs/mainnet-user-test.md), [final mainnet upgrade receipt and actual fee](docs/evidence/multievent-mainnet-upgrade-20261114/result.json), and [local migration/two-organizer proof](docs/evidence/multievent-create-20261114/acceptance.json). Frozen Wasm SHA-256 c81cf3d7...87999e7 was deployed under the approved 0.01-NEAR ceiling; actual fee 0.0018191977271696 NEAR, no top-up or new account.

ShowStake is an event attendance commitment platform built around NEAR escrow. Participants lock a fixed attendance deposit that cannot be voluntarily withdrawn after registration; an account-bound, non-transferable pass represents registration. Organizers finalize attendance onchain before settlement and claims. The product addresses registrations that do not translate into attendance.

Accepted increments include the database foundation, independent settlement oracle, wallet/signing diagnostic harness, and Rust escrow/pass, attendance, settlement and claim contract. The core contract financial lifecycle is exercised on NEAR testnet; full browser/backend integration remains incomplete. Hackathon tracks: `open` and `nfts`; the custom pass does not claim NEP-171 or NEP-393 compliance.

## Inspect the mainnet CREATE deployment

Contract: [showstake-mainnet-escrow-endpx-2026.near](https://nearblocks.io/address/showstake-mainnet-escrow-endpx-2026.near). [Upgrade transaction](https://nearblocks.io/txns/Cpb4sh2B2ASAfLEQouz3sPq9DqN3JYsfJoiXxogqr3BJ) is final. Code hash EUA9Rm9RvU6SwDbkAsqosP9JCSD4qBRhe75p5PnapdyY matches the 225667-byte frozen artifact.

Open the website, connect/sign in, preview event rules, request the storage quote, approve create_event in your wallet, then verify the final receipt and event readback. [Detailed steps and recovery](docs/mainnet-user-test.md). Mainnet wallet-signed CREATE is a user test; no agent-created mainnet event is claimed. Provider capability is false, so this contract returns mainnet registration deposits unused.

[Historical stage1 evidence](docs/evidence/mainnet-deploy-20261112T221125Z/result.json) preserves the old paused single-event deployment and its fees. Its former get_event/get_rhea_control commands are not the latest shared ABI. FullAccess upgrade authority remains in the local OS keychain; this release is frozen by user instruction.

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
