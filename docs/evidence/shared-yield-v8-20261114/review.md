# Shared-yield V8 integration review

This candidate follows D052: one ShowStake contract, independent event records and vault ownership, no per-event code deployment. Mainnet C81 is unchanged. The candidate is accepted for the bounded testnet frontend review; full browser and mainnet acceptance are separate.

## Verified

- **PASS_LOCAL:** 20 Rust unit tests; optimized shared-yield Wasm builds with Rust 1.99.1 and Binaryen 120, 276035 bytes, SHA-256 `2fdc615b6427858b8a351b03343385052353ef1b466caad47d16a19c49e24c53`. The exact source hashes are in `source-manifest.json`.
- **PASS_LOCAL:** real Sandbox two-event lifecycle using MockEarn, then a separate run using the actual public Rhea Wasm. Both prove simultaneous supplied event ownership, redemption of A preserving B, five deposits of 2 to two claims of 5, cancellation refunds of 2, failed FT payout restoration and retry, and zero final escrow liability. All native/token balances in those runs are local fixtures.
- **PASS_LOCAL:** actual C81 Wasm empty-state migration to V8 succeeds with explicitly synthetic extra 0.6 NEAR; nonempty migration is rejected. Post-migration storage is 276695 bytes. This is not a mainnet upgrade.
- **PASS_TESTNET:** `../testnet-shared-s1114151743/result.json`, one root `ss-shared-s1114151743.testnet`, two organizers, ten real Mock-USDC deposits across two events, two concurrent MockEarn positions, two attendee payouts of 5, five cancelled-event refunds of 2, provider transfer failure/retry, beneficiary payout failure/retry, and 42 final receipt graphs. Root code identity is pinned in `deployment-proof.json`.
- **PASS_LOCAL:** API and worker builds/typechecks, 90 worker fixtures, shared refund/pending/legacy regressions, OpenAPI, direct authorization and private access, and real disposable PostgreSQL role/FK/concurrency tests. API role cannot write financial projections. Four direct-access application tables use real PK/FK constraints; deployed isolated testnet schema has 29 PK and 47 validated FK constraints.
- **PASS_TESTNET:** the earlier V7 API witness records real NEP-413 sessions, final-chain QR issuance, organizer `PENDING_SIGNATURE`, and replay denial. It does not prove the V8 browser widgets or historical indexer coverage.
- **PASS_LOCAL:** final testnet frontend build and 13 focused test groups, including exact refund yield rounding, final callback proofs, failed claim recovery, direct redemption, shortfall rejection, cross-tab journal locking, storage approval, wallet focus identity, and bounded direct-chain dashboard discovery. Mainnet C81 release remains separate.

## Review disposition

Codex read the contract migration, receiver, vault callbacks, accounting and claims, and the API trust/role boundary. Implementer second-pass reviews are not independent audits. A separate API worker reviewed frontend transaction recovery and found four journal liveness issues; the web writer fixed them and the reviewer reran the corresponding tests. No final financial source changes followed the V8 build.

## Open acceptance gates

- V8 browser flow through the GitHub-built preview is pending at this commit; no screenshot or CLI result is substituted for that flow.
- Raw historical block ingestion remains externally limited by HTTP 429. `FINAL_CHAIN` fallback does not advance the worker cursor or claim complete projection coverage.
- Real 24-hour timeout and maximum-capacity tests have distinct evidence; shortened local schedules do not prove a real day elapsed.
- Rhea mainnet supply/partial/full redemption and returned-USDC liquidity are not proven. Rhea is `SELECTED_FOR_HACKATHON`, not `TECHNICALLY_ACCEPTED`.
- Mainnet shared-yield deployment, native top-up and real USDC operations are not performed. The user signs their own reviewed Rhea micro-test; a new exact upgrade scope is required for the new artifact.
- Ambiguous provider outcomes, losses/shortfalls and unwithdrawable positions fail closed. There is no public partial-withdrawal method. These limits are material to a mainnet release.

Sanitized evidence is split by network and environment. No mainnet asset action is included in this review.
