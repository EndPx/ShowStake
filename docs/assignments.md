# Bounded acceptance assignments

2026-11-06 user refinement. One DeepSeek Harness executor through Orca, GATER/deepseek-v4.1-flash-1017-v2; sequential by default. No bootstrap restart or further usage-limit investigation unless it blocks current work. Separation of acceptance does not require parallel workers.

| Assignment | Ownership and outputs | Acceptance boundary |
|---|---|---|
| Database (active ctx_bef153d72467 / task_eee96db2ff7f) | Versioned migration/checksum runner, grants, constraints/concurrency tests, backup/restore/replay, provisional API/domain; explicit single lockfile owner | Real disposable PostgreSQL evidence for D01-D06, reviewed by Codex; no wallet/design pass inferred |
| Wallet/signing then contract (next, by dependency) | Fail-closed auth adapter + runnable narrow probe; login/relogin same account, real signing/account relation; then testnet-first escrow/deposit/pass/refund/claim after reviewed ABI/T01 | W01-W08 gaps explicitly recorded; C01-C07/F01-F08 only actual contract evidence; external blockers do not stop independent local work |
| FigCraft design (separate assignment) | Dedicated editable .figcraft, desktop/mobile renders, baseline tokens and component states, rationale and revisions | Codex visual/state/accessibility review before product frontend. Design sample data labeled; real feature acceptance remains separate |

## Provisional design boundary

Design system and basic discovery/detail/pass/host layouts may start independently under a dedicated assignment. Checkout/account/wallet/claim states remain visibly PROVISIONAL until the relevant PoC establishes same-account relogin/recovery, exact approval count, gas/storage payer and costs, popup/redirect return and funding delivered without registration. No invented one-click checkout or sponsorship. Record known/unknown behavior in the design file and frame checklist.

After wallet evidence, revise these frames before final design acceptance. Product UI must follow the accepted FigCraft design and proven capability states. No resale/transfer/admin reassignment. Swap success is not registration; QR scan is not final attendance. Database and contract work do not wait for visual polish. Scope/rights/acceptance criteria remain unchanged.

Each assignment returns files, commands, exits, expected/observed results, environment, classifiers and blockers. Codex reviews, tests, returns fixes if needed, then commits/pushes accepted files only. Track IDs remain [open,nfts]. Financial actions/deployment/paid services require scoped authorization; submission needs full-payload confirmation.
