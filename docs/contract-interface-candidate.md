# Escrow/pass interface candidate for local implementation

Codex architecture preparation, 2026-11-07. Status: candidate, NOT a frozen ABI, implemented contract, deployment authorization or live acceptance. T00/T01 remain accepted. The packet and later identity/provider decisions are authoritative. No production FT/address, SDK version, storage charge or gas budget is selected here.

## Authority and JSON boundaries

One immutable canonical FT account per deployment. Configuration records network, asset account, decimals, policy version and rules hash. Amount arguments/results are canonical unsigned decimal strings bounded by u128; timestamps are UTC integer milliseconds with checked conversions from contract block time. IDs/counters exposed to JavaScript must remain exact strings. Native storage deposits are separate from FT principal. Event financial rules, schedule, organizer and capacity cannot be edited after publication.

## Proposed methods

| Method | Caller and required behavior |
|---|---|
| `new(config)` | One-time initialization; explicitly injected local test FT for sandbox, never described as a supported mainnet asset |
| `storage_deposit(account_id?)`, `storage_balance_of(account_id)` | Prepay/account for bounded contract storage using native NEAR; no FT credit, pass or seat. Exact storage accounting and safe surplus handling require implementation tests |
| `publish_event(event_id, rules)` | Organizer derives from authenticated predecessor; validate immutable times, D>0, capacity1..200, canonical asset, prepaid storage and checked deadline. No API-provided organizer override |
| `ft_on_transfer(sender_id, amount, msg)` | Only canonical FT predecessor; bounded/versioned message contains event and commitment ID, not a selectable owner/beneficiary. Participant and beneficiary derive from FT sender. Validate exact D, phase, capacity, active-account uniqueness, lifetime commitment uniqueness and storage before any mutation. Return all unused amount on invalid input; return zero only on atomic accepted registration/pass issuance |
| `withdraw(registration_id)` | Only participant, before cutoff, once; invalidate active registration/check-in entitlement, release seat, retain old owner and create full D refund credit |
| `mark_attendance(registration_id, attended)` | Only event organizer, within check-in window; idempotent same value, corrections only in window, no database authority |
| `finalize_attendance(event_id)` | Only organizer, close<=now<deadline; freeze actual onchain active registration set/count. No accepted offchain attendance array |
| `activate_refund_only(event_id)` | Permissionless at deadline when not finalized; full outstanding principal refunds, irreversible mode |
| `cancel_event(event_id)` | Only organizer under packet cancellation rules, before settlement allocation; no overwrite of SETTLING/SETTLED state |
| `settle(event_id)` | Permissionless after valid finalization; deterministic allocations in registration-sequence order, no token transfer. Finalized before deadline can settle afterward. Zero-attendee path refunds principal |
| `continue_settlement(event_id, expected_cursor)` | Include only if measured max-capacity gas requires chunking; freeze inputs and cursor, reject inconsistent continuation, disable settlement-dependent claims until allocation complete |
| `claim(registration_id)` | Participant requests payout to immutable stored beneficiary; no receiver argument. Reserve credit into one pending attempt before async canonical FT transfer; no duplicate spend |
| `on_claim_result(registration_id, payout_id)` | Self-only callback; validate pending attempt identity and inspect promise result. Success moves pending to paid; failed FT promise restores credit exactly once. Duplicate/stale callback cannot mutate a newer attempt |
| Views: config/event/registration/pass/claim/accounting + bounded lists | Report actual state/version; pass fields match v2 and contain no PII/QR secrets. No gallery or NEP-171/393 guarantee |

Transfer, approval, delegated transfer, owner reassignment and burn are not supported. If compatibility entrypoints are exposed, each must explicitly reject and have negative tests. Rejoining uses a new registration/pass/commitment and separate storage credit; previous refund remains claimable. Ever-increasing historical registrations require prepaid storage and checked principal/counter overflow despite active capacity<=200.

## Allocation and callbacks

Preserve packet examples F01-F03. Withdrawn principal is excluded from the active no-show pool and remains an outstanding refund. Among active attendees distribute each principal plus quotient of no-show pool; the first remainder-count attendees in immutable registration order receive one additional atomic unit. Claim order does not affect allocation. Zero attendees/cancel/timeout use full-principal refunds. Fees and yield are zero.

Per-event `accepted = paid + pending + outstanding` includes withdrawn principal; aggregate liabilities must remain covered by canonical FT holdings, with unsolicited tokens accounted separately. All arithmetic and state transitions are checked. Invalid deposit must not consume storage/commitment or create any partial pass, accounting or seat state.

A failed transfer promise and a callback that itself fails are different cases. Never unlock/retry merely because a callback timed out: the FT transfer may already have succeeded. Retain pending state on unknown outcome; callback gas and bounded/no-panic cleanup need real sandbox evidence. No administrator assertion may fabricate payout success or redirect beneficiary. Recovery of an unresolved pending attempt remains an explicit test/design gate, not an automatic retry assumption.

## Events and acceptance

Versioned event payloads must identify deployment/contract, event, registration, pass, commitment, participant and immutable beneficiary where relevant. Proposed names: EventPublished, RegistrationCommitted, RegistrationWithdrawn, AttendanceMarked, AttendanceFinalized, RefundOnlyActivated, EventCancelled, SettlementStarted/Progress/Completed, PayoutPending/Succeeded/Failed. Freeze exact names/schema against worker/API requirements before parallel production ingestion. API T01 schema is not silently rewritten to match this candidate.

Actual contract tests must exercise C01-C07 and F01-F08 on compiled NEAR Wasm with a local NEAR Sandbox and real test FT receipts. Unit tests and the independent oracle supplement these tests. Required observations include token resolver refund receipts, no entitlement on failed deposit, owner/beneficiary immutability, boundary times, active-account concurrency, withdrawal/rejoin, deterministic rounding, wrong/duplicate callbacks, transfer failure, randomized conservation and max200 gas. No deployment to public testnet/mainnet is authorized by this document.

## Remaining gates

Wallet signing/account recovery, canonical network/FT/token storage, sponsorship, exact storage prepayment policy, measured gas/chunk choice, callback-failure recovery, event schema and SDK/tool versions remain open. Local sandbox test fixtures can unblock implementation without claiming these production capabilities. Implementation must use the official scaffold/toolchain workflow after verifying installed versions; do not guess crate versions.

## Official sources consulted through llms.txt

- https://docs.near.org/llms.txt
- https://docs.near.org/smart-contracts/security/cross-contract-calls/ft-transfer-call — FT predecessor/sender distinction and unused-token resolver semantics.
- https://docs.near.org/smart-contracts/security/cross-contract-calls/callback-failures — callback receipt failure does not undo earlier receipts or automatically retry.
- https://docs.near.org/smart-contracts/testing/integration-test — compiled contracts and test accounts on a local Sandbox, including callback/time scenarios.
- `docs/planning/showstake-v2/01-PRODUCT.md`, `05-EXECUTION-AND-TESTS.md` — product policy, C01-C07/F01-F08 and exact examples.
