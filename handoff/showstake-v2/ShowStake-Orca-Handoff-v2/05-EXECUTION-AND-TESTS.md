# Execution, ownership and acceptance

Codex coordinates/reviews/accepts; actual DeepSeek implements through Orca. Load installed version-matched orca-cli/orchestration guides. Discover provider/model identifiers; do not assume --agent deepseek exists. Prove one bounded task-result-review cycle. Respect async wake and dispatch mailbox guidance; no terminal steering behind tracked workers, duplicate launches, or polling scripts consuming coordinator mail.

One writer per checkout by default. Isolate conflicting parallel workers through Orca. Migration/API schema/root lockfile each have one owner. Codex freezes ABI/domain before parallel UI and backend. Worker reports implementation, never release acceptance. Secret material absent from dispatches/evidence.

## Tasks

| Task | Depends | Ownership/deliverable | Acceptance |
|---|---|---|---|
| T00 bootstrap | none | Codex repo inventory,executor proof,version pins,capacity with Keyfolio | B01-B03 |
| T01 database/interfaces | T00 | DeepSeek schema migration,grants,OpenAPI,exact amounts | D01-D06 |
| T02 wallet/route/standard probes | T00 | DeepSeek G01-G08 capability report; Codex chooses safe ABI | W01-W08 |
| T03 escrow/pass | T01,T02 ABI | DeepSeek contract publish/deposit/account-bound pass | C01-C07 |
| T04 settlement/payout | T03 | DeepSeek finalize/timeout/refund/claims/gas | F01-F08 |
| T05 auth/projections | T01,T02 | DeepSeek verified identity,worker,event recovery | A01-A07 |
| T06 funding integration | T03,T05 | DeepSeek quote/delivery/second-step commit | P01-P05 |
| T07 check-in/content | T04,T05 | DeepSeek QR,host flow,gated resource | Q01-Q06 |
| T08 UI/design system | T01 schemas;final T06,T07 | DeepSeek token components,screens,error states | U01-U06 |
| T09 end-to-end | T04,T06,T07,T08 | DeepSeek receipts and browser flow;Codex reviews | E01-E04 |
| T10 recovery/security | T09 | Codex audit;DeepSeek fixes | R01-R04 |
| T11 release docs | T10 | README,env/deploy manifest,accepted evidence | R05 |

Fixtures permit independent T01/T03/T05/T08 progress when live providers block; they do not pass live tests. Contract T03/T04 share files: sequence or isolate. No legacy v1 transfer implementation.

## Acceptance matrix

| ID | Required behavior |
|---|---|
| B01 | Correct target repo and license-aware reference reuse; unrelated edits/services preserved |
| B02 | Actual DeepSeek runtime dispatch result reviewed by Codex |
| B03 | Keyfolio/shared worker capacity acknowledged; no duplicate full-capacity schedule assumption |
| D01 | Candidate DDL applies on disposable PostgreSQL; constraints reject invalid data |
| D02 | FK/unique active registration/identity conflict/idempotency checks exercised |
| D03 | API role cannot update financial projections; worker cannot grant app session |
| D04 | Migration backup/restore and projection replay produce same result |
| D05 | Float/overflow/negative atomic values rejected; TS/JSON serialize money strings |
| D06 | Concurrent job lease/cursor/nonce consumption behaves atomically |
| W01 | Google/email creates or recovers same NEAR account through Privy after logout/login |
| W02 | MetaMask login plus embedded NEAR signing bound correctly; EVM signature alone insufficient |
| W03 | Native NEAR wallet authenticates and calls contract; mobile return tested |
| W04 | Account linking requires both controls; identity conflict does not merge silently |
| W05 | Canonical FT/storage/gas IDs and funding recorded; no assumed sponsorship |
| W06 | Actual authorized EVM and non-EVM routes deliver expected FT; dry quote insufficient |
| W07 | Custom nontransferable pass interface documented; no false standards/visibility claim |
| W08 | Network/source account switch invalidates stale attempt or requires explicit new attempt |
| C01 | Exact canonical FT deposit accepted once with registration/pass in same contract receipt |
| C02 | Wrong amount/token/phase/duplicate commitment returned without seat/pass |
| C03 | Capacity1..200 and one active account/event enforced under concurrency |
| C04 | owner=participant=beneficiary immutable; any ordinary transfer/approval/admin reassign rejected |
| C05 | Withdraw before cutoff frees seat once, creates credit; old pass invalid for check-in |
| C06 | Rejoin new commitment keeps old refund separate; no duplicate active registration |
| C07 | Storage failure/unexpected plain transfer cannot fabricate entitlement |
| F01 |20 deposits5m,16 attendees ->each6.25m,total100m |
| F02 |5 deposits10,3 attendees ->17,17,16 ordered by registration,independent of claim order |
| F03 |6 deposits10,1withdrawal,3 attendees ->10 refund+17+17+16=60 |
| F04 | Zero attendees/cancellation/unfinalized timeout return full principal; exact boundary times |
| F05 | Already finalized before deadline can settle later; cancelled/refund-only cannot revert |
| F06 | Async failed payout restores credit once; callback self-only; repeated click/replay safe |
| F07 | Per-event and aggregate conservation under randomized state sequences; no cross-event spending |
| F08 | Max capacity gas measured; chunking if needed resumable/frozen/no early claims |
| A01 | Wrong domain/account/network/expired/replayed challenge rejected |
| A02 | Privy JWT verified server; login without bound NEAR account cannot access pass rights |
| A03 | Backend API cannot forge attendance or mark a payout successful |
| A04 | Indexer duplicates/out-of-order/crash produce correct projections/cursors |
| A05 | Stale chain state fails closed for gated rights; no UI fake confirmation |
| A06 | CSRF/CORS/session logout removes private cached data; no secret exposure |
| A07 | Account unlink cannot alter immutable beneficiary or orphan existing rights invisibly |
| P01 | Source swap SUCCESS alone cannot issue pass/credit event |
| P02 | Swap succeeds but event full/closed -> funds remain user-owned and action clear |
| P03 | Quote validation binds assets/recipient/refund/deadline; modification requires new approval |
| P04 | Timeout/reload same attempt no second payment; actual final outcome recovered |
| P05 | Native claim always available; optional outbound swap failure cannot duplicate escrow payout |
| Q01 | QR only for eligible pass;60s expiry/single-use/event/owner binding tested |
| Q02 | Scan creates pending request; host signature required for confirmed attendance |
| Q03 | Manual host check-in audited; unauthorized caller or closed window rejected |
| Q04 | Finalization uses actual contract attendance; later correction denied |
| Q05 | Content requires attended+settled+matching immutable pass owner; no-show/withdrawn denied |
| Q06 | Private resource not public; signed URL<=60s; current state<=30s; no claim of download clawback |
| U01 | Every required component state in local gallery references tokens |
| U02 | Token contrast test passes and actual keyboard/labels/focus/200% zoom reviewed |
| U03 |390x844 and1440x900 no blocked actions/overflow/privacy flashes |
| U04 | All money/phase/error copy distinguishes funding/registration/check-in/claim |
| U05 | No transfer button; pass bound-account warning shown before deposit |
| U06 | Mobile QR camera denial/recovery and manual path tested; env/timezone labels visible |
| E01 | Same declared environment:publish->fund->commit->pass->check-in->settle->claim->content |
| E02 | At least3 participants cover attended/no-show; receipts and independent balances reconcile |
| E03 | Cancellation and timeout refund scenarios proven; synthetic clock labeled local |
| E04 | Direct NEAR + EVM + non-EVM sources evidenced or full multichain scope explicitly blocked |
| R01 | Restart/backup restore preserves pending payments and exactly-once economic effects |
| R02 | Pause preserves claims/refunds; upgrade/admin authority disclosed |
| R03 | Codex financial/auth diff review and secret scan passes |
| R04 | No required failed tests/unexplained balances; pending external gates listed |
| R05 | README reproducible,artifacts match final commit,scope truth report complete |

## Schedule and reporting

Nov6 bootstrap/wallet gates/schema;Nov7 route proof and ABI;Nov8 escrow/pass;Nov9 settlement/auth;Nov10 funding/check-in;Nov11 UI integration;Nov12 full flow;Nov13 recovery/security;Nov14 stable deliverable/docs. This is a target allocation requiring real capacity reconciliation with Keyfolio. Report slips immediately; do not silently cut wallet routes, refund protection or tests.

Evidence per test: ID,requirement,commit,network,commands/steps,expected,observed,exit status,sanitized artifact/receipt,balance proof,classifier,reviewer,limits. Classifiers in file06. No secret/PII in public evidence.

Dispatch includes exact task/paths/base commit/interfaces/dependencies/authority/tests/stop conditions. DeepSeek result includes diff,commands/results,untested paths,blockers and commit. Codex accepts after inspection,focused independent verification for money/auth and defect fixes. Worker cannot decide new custody,financial rights,scope cuts or publication.

docs/status.md persists task state and dispatch IDs,file ownership,evidence,next work,capacity risk. docs/decisions.md holds choices and sources. Resume by inspecting git and actual Orca state; silence isn't proof of termination. Final report states actual local/testnet/live/blocked outcome even if target date arrived.
