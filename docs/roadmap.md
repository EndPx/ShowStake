# ShowStake delivery roadmap

Snapshot: 2026-11-07. Tracks: open, nfts. Internal target: November 14, 23:59 WIB. Test evidence is local unless explicitly classified otherwise.

| Task | Dependency | Deliverable and acceptance | Current status |
|---|---|---|---|
| T00 bootstrap | none | Real executor dispatch/result/Codex review, preserved v2 packet, repo/toolchain | Accepted, committed/pushed |
| T01 database/interfaces | T00 | Versioned PostgreSQL migrations, constraints, least-privilege grants, replay/restore/concurrency, exact amounts, OpenAPI | Accepted PASS_LOCAL: 52 checks, default-clone proof; committed/pushed |
| T02 wallet/route probes | T00 | Native NEAR and social/email/EVM paths, verified account binding, login/relogin same account, signing, supported funding/FT route and reviewed ABI | Partial: local adapter/harness increment accepted after99 checks, build and browser startup; real signing/relogin/social/EVM gates open |
| T03 escrow/pass | T01 + reviewed T02 interface gates | Event publish, valid FT deposit, atomic seat/pass issuance, immutable participant/beneficiary, non-transferable custom pass | Minimum accepted in 70d6319: 34 unit + 91 real Sandbox checks; same Wasm PASS_TESTNET via CLI/keychain publish/deposit/reg-0/pass-0, duplicate/wrong-amount refunds and transfer denial. Factory and full browser integration remain open |
| T04 settlement/payout | T03 | Organizer finalization, timeout/cancel/withdraw refunds, exact redistribution, claim callback failure/retry and conservation | Not accepted; independent test-support oracle accepted PASS_LOCAL (105 tests), no contract execution |
| T05 auth/projections | T01,T02 | Backend challenges/sessions, identity linking, chain-event ingestion, durable cursor/recovery, projection freshness | API source in progress under ctx_0589ce453a2d, unaccepted; indexing worker not implemented; T01 replay is test support |
| T06 funding | T03,T05 | Supported quote/delivery to participant NEAR account, separate signed escrow deposit, expiry/unknown/retry recovery | Not accepted; no funded cross-chain proof; Intents has no testnet |
| T07 check-in/content | T04,T05 | Expiring QR, pending request, organizer-signed attendance, backend-gated attendee materials | Not accepted |
| T08 frontend | T01; final integration T06,T07 | Adapt CommitPass baseline, preserve suitable layouts/interactions, ShowStake tokens and exact state presentation, responsive/accessibility checks | Reuse inspection/map complete; adaptation pending; new FigCraft design deferred |
| T09 end-to-end | T04,T06,T07,T08 | Browser create/fund/deposit/pass/check-in/finalize/settle/claim/content, actual receipts and negative paths | Not run |
| T10 recovery/security | T09 | Auth/role/replay abuse, double claim, callback failures, event isolation, recovery and browser regressions | Not run; isolated negative test preparation allowed earlier |
| T11 release/docs | T10 | Judge README and numbered reproducibility, honest provenance, config/deploy manifest, demo/submission artifacts and accepted evidence | Initial README exists; final acceptance not run |

## Execution policy

Codex coordinates, freezes interfaces, reviews and accepts. DeepSeek Harness/GATER owns API/Node work; authorized ZCode/Cloud Near owns Rust contracts/integration tests directly in the main repository. Verify actual model/provider on executor recovery. Writers have disjoint file ownership; one owner for Node manifest/lockfile. Preserve unfinished source and FigCraft archives. Review -> relevant tests -> fixes -> commit -> push for every accepted increment.

Immediate order: review T02 harness and fix any defects; real-wallet handoff and contract interface decision; T03 then T04. CommitPass adaptation, T05 and independent test preparation proceed where dependencies permit. No need to finish the entire UI before proving escrow. FigCraft work is deferred by the latest human direction.

## Gates and scope

Public EndPx/ShowStake pushes are authorized only for reviewed/tested increments. Dedicated testnet accounts/faucet/keychain, reviewed testnet deployments and synthetic test-token transactions are explicitly authorized. Mainnet deployment, paid resources, real assets, public deposits and submission retain separate authorization gates. A fixture or local oracle never passes a wallet, testnet or live contract gate. No pass transfer/resale/reassignment; swap success is not registration; QR scan is not final attendance; SQL projections do not authorize balances or payouts.

Capacity and schedule risk: approximately one week to internal target, with core wallet/escrow gates still open, repeated GATER IP-binding errors, a standalone ZCode Start Plan compatibility gap, and capacity shared with Keyfolio. No Keyfolio resources/services modified. Scope and acceptance are unchanged; no defensible completion percentage yet.

Latest sequencing (D027): interactive wallet acceptance is performed through the adapted ShowStake frontend when ready. Local wallet regression tests and independent backend/contract/Sandbox work continue now; the diagnostic harness remains available as test support. Do not treat this scheduling change as a passed or removed T02 gate.


## Testnet to mainnet release progression

Canonical operational gates and evidence requirements: [release-checklist.md](release-checklist.md). Execution order is full testnet lifecycle acceptance -> mainnet release candidate preparation -> exact human authorization -> mainnet deployment without public deposits -> same-network small-fund E2E -> separately approved limited pilot. Preparation does not authorize mainnet signing, spending, paid services or public deposits. Mainnet gates do not block current local/testnet implementation.

| Release status | Required evidence | Current state |
|---|---|---|
| IMPLEMENTED_LOCAL | Reviewed product source, pinned build/Wasm, relevant implementation tests and reproducible commands | Only individually accepted foundation/probe increments; full product not at this status |
| TESTNET_ACCEPTED | Frontend/backend/wallet full lifecycle and negative cases, verified dedicated accounts/FT and receipts/balance reconciliation | Not reached |
| MAINNET_PREPARED | Exact release commit/artifact/config, review evidence, custody/upgrade/pause decisions, recovery and bounded transaction proposals | Not reached; planning only |
| MAINNET_DEPLOYED | Scoped human authorization, installed code/config/key/asset verification and deployment receipt | Not authorized or reached |
| MAINNET_E2E_ACCEPTED | Direct NEAR + supported EVM/non-EVM funding, participant NEAR delivery, separate escrow commit, attendance/settlement/claim and separate cancellation/refund with same-network receipts/reconciliation | Not reached |
| PILOT_APPROVED | E2E accepted, explicit participant/deposit limits, monitoring/support and separate human launch decision | Not authorized or reached |

These are product/release statuses, distinct from PASS_LOCAL/PASS_TESTNET/PASS_LIVE/FAILED/BLOCKED_EXTERNAL/NOT_RUN test classifications. Deployment alone never advances to E2E acceptance.
