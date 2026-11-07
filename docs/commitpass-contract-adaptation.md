# CommitPass contract flow and ShowStake adaptation

Read-only inspection by Codex. Source: CommitPass Monad commit `542273df306a7e5887f1dfcabf1383e78930f579`; exact source hashes in evidence/commitpass-contract-inspection.json. Factory working tree has a pre-existing formatting diff, preserved. Core Solidity files carry SPDX MIT; any copied/adapted code must retain applicable notices and provenance. No tests executed and no legacy file/service changed.

## Existing CommitPass lifecycle

1. Factory `createEvent` validates schedule/deposit/capacity<=500 and deploys a vault with immutable organizer, asset/yield/treasury and report authorization.
2. Participant `deposit` checks open phase/capacity/one deposit, uses ERC20 transferFrom, mints ERC20 share and records participant in insertion order. Registration is coupled to token transfer, not a backend row.
3. Organizer `requestStart` closes registration; START report through trusted forwarder triggers allocation of vault funds to ERC4626 yield source. `requestSettlement` fixes cutoff and requests automation.
4. `_processReport` binds chain/target/action/expiry/snapshot. SETTLE report contains a sorted unique deposited-attendee list; `_settleEvent` marks attendance and redeems yield.
5. Settlement enforces principal coverage, charges floor(50% of no-show principal) to treasury, and distributes remaining assets to attendees. Zero attendees refund all registrants, including recovered yield. `_allocate` assigns quotient and remainder in original participant order before anyone claims.
6. `claimReward` marks claimed and updates totalClaimed before SafeERC20 transfer to msg.sender. Same-transaction revert protects state if transfer reverts. Repeat claims denied. Cancellation before start allocates exact principal refunds. Organizer ownership changes are rejected.

## Required ShowStake mapping

| CommitPass mechanism | Reuse as concept | ShowStake v2 implementation |
|---|---|---|
| Factory/event configuration | Immutable event rules and organizer identity | Native NEAR event registry/escrow design; do not assume one contract per event or per pass |
| ERC20 approve + deposit | Valid token payment creates registration atomically | Participant-controlled NEAR account signs canonical FT transfer_call; receiver validates FT predecessor, sender, exact D, commitment, capacity and prepaid storage |
| ERC20 vault share | Registration receipt/display | Custom account-bound Event Pass, owner=participant=beneficiary; no transfer/approval/admin reassignment; no standards claim |
| CRE START + yield deposit | Explicit lifecycle phases | Remove yield/start custody movement. Funds remain in event escrow; no CRE forwarder/signer inherited |
| CRE snapshot attendee report | Attendance must be authorized before allocation | Organizer signs mark_attendance on NEAR, correction only in window; finalization freezes actual contract state, not an arbitrary backend list |
| Treasury fee50%/capacity500 | None | Fee0, no yield, capacity1..200, all no-show principal to attendees |
| Deterministic `_allocate` | Allocation before claim; registration-order remainder; no claim-order advantage | v2 F01-F03 exact principal/no-show formula; withdraw credit excluded from pool and preserved separately |
| Single boolean hasDeposited | Duplicate prevention | Lifetime commitment uniqueness + one active account/event; withdrawal frees seat once, rejoin has new registration/pass, old claim remains |
| EVM claim synchronous rollback | Reserve before external transfer; receiver fixed | NEAR asynchronous pending payout + private callback success/failure; unknown callback outcome never authorizes blind retry |
| Cancel before start | Refund mode | v2 cancellation, no-attendee and24h-finalization-timeout modes; no override of partial settlement |
| Direct chain balance | Conservation | Per-event accepted=paid+pending+outstanding incl withdrawn; canonical FT aggregate coverage, unsolicited tokens separate |

## Cross-chain funding boundary

Source wallet on a supported/tested chain -> NEAR Intents route -> participant-controlled NEAR account -> separate participant-signed canonical FT deposit into escrow -> registration/pass. The contract does not take arbitrary source-chain assets or trust swap status as proof of registration. Base/Solana are route targets subject to current token/quote availability and funded testing; do not claim every chain. Failed/full/closed escrow commit leaves delivered funds with participant or returns unused FT through resolver. Never use plain FT transfer as RSVP or provider experimental direct escrow routing by assumption.

## Tests to adapt, not copy as passing evidence

CommitPass SettlementPolicy tests cover conservation, no-attendee, cancellation, deterministic remainder, organizer authority, report replay. Preserve those test intentions; replace expected fee/yield/CRE behavior with v2 policy and NEAR receipts. Add withdrawal/rejoin, strict time boundaries, nontransferability, fake/wrong FT, storage failure, asynchronous callback failures/overlap, multi-event isolation and max200 gas. Old test names or Solidity passing results never establish NEAR correctness.

## Next implementation boundary

Use this flow map with docs/contract-interface-candidate.md and immutable v2 tests for the actual Rust escrow slice. The current Sandbox fixtures only prepare FT/receiver testing and are not the ShowStake contract. Contract/storage/event ABI must be reviewed before parallel production projections. Interactive wallet testing may follow frontend (D027); local contract development must not wait for full UI. No deployed addresses or paid/public actions selected here.
