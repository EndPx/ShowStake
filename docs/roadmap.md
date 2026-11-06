# ShowStake delivery roadmap

Snapshot: 2026-11-07. Tracks: open, nfts. Internal target: November 14, 23:59 WIB. Test evidence is local unless explicitly classified otherwise.

| Task | Dependency | Deliverable and acceptance | Current status |
|---|---|---|---|
| T00 bootstrap | none | Real executor dispatch/result/Codex review, preserved v2 packet, repo/toolchain | Accepted, committed/pushed |
| T01 database/interfaces | T00 | Versioned PostgreSQL migrations, constraints, least-privilege grants, replay/restore/concurrency, exact amounts, OpenAPI | Accepted PASS_LOCAL: 52 checks, default-clone proof; committed/pushed |
| T02 wallet/route probes | T00 | Native NEAR and social/email/EVM paths, verified account binding, login/relogin same account, signing, supported funding/FT route and reviewed ABI | Partial: runnable harness local checks/build passed; source review and real wallet gates open |
| T03 escrow/pass | T01 + reviewed T02 interface gates | Event publish, valid FT deposit, atomic seat/pass issuance, immutable participant/beneficiary, non-transferable custom pass | Not accepted; no tested escrow lifecycle |
| T04 settlement/payout | T03 | Organizer finalization, timeout/cancel/withdraw refunds, exact redistribution, claim callback failure/retry and conservation | Not accepted; local test oracle can proceed independently |
| T05 auth/projections | T01,T02 | Backend challenges/sessions, identity linking, chain-event ingestion, durable cursor/recovery, projection freshness | Not accepted; T01 test replay is not a production worker |
| T06 funding | T03,T05 | Supported quote/delivery to participant NEAR account, separate signed escrow deposit, expiry/unknown/retry recovery | Not accepted; no funded cross-chain proof; Intents has no testnet |
| T07 check-in/content | T04,T05 | Expiring QR, pending request, organizer-signed attendance, backend-gated attendee materials | Not accepted |
| T08 frontend | T01; final integration T06,T07 | Adapt CommitPass baseline, preserve suitable layouts/interactions, ShowStake tokens and exact state presentation, responsive/accessibility checks | Reuse inspection/map complete; adaptation pending; new FigCraft design deferred |
| T09 end-to-end | T04,T06,T07,T08 | Browser create/fund/deposit/pass/check-in/finalize/settle/claim/content, actual receipts and negative paths | Not run |
| T10 recovery/security | T09 | Auth/role/replay abuse, double claim, callback failures, event isolation, recovery and browser regressions | Not run; isolated negative test preparation allowed earlier |
| T11 release/docs | T10 | Judge README and numbered reproducibility, honest provenance, config/deploy manifest, demo/submission artifacts and accepted evidence | Initial README exists; final acceptance not run |

## Execution policy

Codex coordinates, freezes interfaces, reviews and accepts. DeepSeek Harness/GATER is the main implementation writer. ZCode can work on independent non-design tests in an isolated folder; its exact model/provider must be verified before task execution. No concurrent writes to the main source/lockfile. Preserve unfinished source and FigCraft archives. Review -> relevant tests -> fixes -> commit -> push for every accepted increment.

Immediate order: review T02 harness and fix any defects; real-wallet handoff and contract interface decision; T03 then T04. CommitPass adaptation, T05 and independent test preparation proceed where dependencies permit. No need to finish the entire UI before proving escrow. FigCraft work is deferred by the latest human direction.

## Gates and scope

Public EndPx/ShowStake pushes are authorized only for reviewed/tested increments. Deployment, paid upgrades/resources, real-asset transactions and hackathon submission remain separate authorization gates. A fixture or local oracle never passes a wallet, testnet or live contract gate. No pass transfer/resale/reassignment; swap success is not registration; QR scan is not final attendance; SQL projections do not authorize balances or payouts.

Capacity and schedule risk: approximately one week to internal target, with core wallet/escrow gates still open, repeated GATER IP-binding errors, a standalone ZCode Start Plan compatibility gap, and capacity shared with Keyfolio. No Keyfolio resources/services modified. Scope and acceptance are unchanged; no defensible completion percentage yet.
