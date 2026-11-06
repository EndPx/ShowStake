# Settlement oracle traceability — acceptance IDs

Status date: 2026-11-07. Scope: `.local/zcode-settlement-oracle` only.
Label: **LOCAL TEST ORACLE / PASS_LOCAL for modelled behaviour**. **NEAR contract tests = NOT_RUN.** Fixtures never prove onchain acceptance.

Machine-readable run: `docs/evidence/settlement-oracle-runs/<runId>/result.json`, with a current-run pointer at `docs/evidence/settlement-oracle-latest.json` (each run keeps a unique identity; prior runs are never overwritten). Raw log: `docs/evidence/settlement-oracle-runs/<runId>/result.tap.txt`.
Command: `node oracle/scripts/run-oracle.mjs`.

## Coverage levels

| Level | Meaning |
|---|---|
| `PASS_LOCAL` | Behaviour is modelled and independently asserted locally; oracle tests passed. |
| `PARTIAL_LOCAL` | Part of the requirement is modelled; the remaining chain/DB/concurrency/gas part is `NOT_RUN`. |
| `NOT_RUN` | No local oracle evidence; real NEAR contract/T03/T04 or environment execution required. |

These levels are **not** contract acceptance and do not freeze an ABI.

## Codex round-1 adversarial regressions (fixed)

- `CROSS_EVENT_PAYOUT_ID_COLLISION`: payout storage is namespaced by `(eventId, payoutId)`; the same payout id may exist in two events, each callback resolves its own record, and `payoutView(payoutId, eventId)` is unambiguous. A one-argument view of a reused id fails as ambiguous rather than returning the wrong event.
- `REJECTED_SETTLEMENT_MUTATES_STATE`: `settle({chunkSize:0})` and all other invalid chunk sizes are validated before `event.settlement` is created or `SETTLING` is entered, so cancellation remains possible after a rejected call.
- Additional rejected-input snapshots cover commit/mark/finalize/withdraw/cancel/refund-only/claim/settleChunk; `amendContent` now validates title and description together before mutation.
- Regression file: `oracle/test/adversarial-regressions.test.mjs` (not part of the original delivery, added after Codex round-1 review).


## Acceptance matrix

| ID | Requirement (packet) | Oracle level | Oracle tests | Packet citations / limits |
|---|---|---|---|---|
| C01 | Exact canonical FT deposit accepted once with registration/pass in the same contract receipt. | PARTIAL_LOCAL | `identity-boundaries` C01 atomic deposit; all acceptance vectors | `CIT-IDENTITY-BIND`, `CIT-PASS-OWNER`. No real NEP-141 receipt. |
| C02 | Wrong amount/token/phase/duplicate commitment returned without seat/pass. | PASS_LOCAL | `identity-boundaries` wrong token/amount/phase/duplicate/malformed; `commitDeposit` disposal metadata | `CIT-CAPACITY`, `CIT-ONE-ACTIVE`. Single-threaded call atomicity only. |
| C03 | Capacity 1..200 and one active account/event under concurrency. | PARTIAL_LOCAL | `publish` capacity bounds; `identity-boundaries` capacity 1/200, duplicate active; `refunds` seat freed once | `CIT-CAPACITY`, `CIT-ONE-ACTIVE`. Concurrency/races `NOT_RUN`. |
| C04 | owner=participant=beneficiary immutable; transfer/approval/admin reassign rejected. | PASS_LOCAL | `identity-boundaries` pass immutability + beneficiary mismatch; `claims` immutable beneficiary/relink | `CIT-PASS-OWNER`, `CIT-PASS-NO-TRANSFER`, `CIT-IDENTITY-BIND`. Custom pass, not NEP-171/393 conformance. |
| C05 | Withdraw before cutoff frees seat once, creates D credit; old pass invalid. | PASS_LOCAL | `refunds` C05 withdrawal/seat/pass; failed payout leaves WITHDRAWN | `CIT-WITHDRAW`, `CIT-WITHDRAW-ENTITLEMENT`, `CIT-TIME-WINDOWS`. |
| C06 | Rejoin new commitment keeps old refund separate; no duplicate active. | PASS_LOCAL | `refunds` C06 rejoin; `claims` claim order | `CIT-REJOIN`, `CIT-ONE-ACTIVE`. OG-08 covers multiple beneficiary claims. |
| C07 | Storage failure/unexpected plain transfer cannot fabricate entitlement. | PARTIAL_LOCAL | `identity-boundaries` C07 storage prepaid flag + plain transfer | Real FT storage/resolver refund `NOT_RUN`. |
| D02 | FK/unique active registration/identity conflict/idempotency. | PARTIAL_LOCAL | `identity-boundaries` duplicate commitment/active/identity mismatch | PostgreSQL constraints/FKs `NOT_RUN`; oracle state only. |
| D05 | Float/overflow/negative atomic rejected; JSON money strings. | PARTIAL_LOCAL | `atomic` canonical u128 + overflow; `publish` JSON strings; `identity-boundaries` aggregate overflow; `differential` | `CIT-U128-DB`, `CIT-U128-CHECK`, `CIT-D05`, `CIT-JSON-MONEY`. DB/API serialization `NOT_RUN`. |
| F01 | 20 deposits 5m, 16 attendees -> each 6.25m, total 100m. | PASS_LOCAL | `allocation`, `acceptance` F01 | `CIT-F01`, `CIT-SETTLE-FORMULA`. |
| F02 | 5 deposits 10, 3 attendees -> 17,17,16 by registration, independent of claim order. | PASS_LOCAL | `allocation`, `acceptance` F02, `claims` claim order | `CIT-F02`, `CIT-EXAMPLE-5`. |
| F03 | 6 deposits 10, 1 withdrawal, 3 attendees -> 10+17+17+16=60. | PASS_LOCAL | `allocation`, `acceptance` F03 | `CIT-F03`, `CIT-EXAMPLE-6`. |
| F04 | Zero attendees/cancellation/unfinalized timeout full principal; exact boundary times. | PASS_LOCAL | `refunds` zero/cancel/timeout; `lifecycle` phase vectors; `acceptance` F04 | `CIT-CANCEL`, `CIT-REFUND-ONLY`, `CIT-TIME-WINDOWS`. OG-01 deadline boundary. |
| F05 | Finalized before deadline can settle later; cancelled/refund-only cannot revert. | PASS_LOCAL | `lifecycle` F05 + terminal checks; `acceptance` F05 | `CIT-SETTLE-AFTER-DEADLINE`, `CIT-TERMINAL`. |
| F06 | Failed payout restores once; callback self-only; repeated click/replay safe. | PASS_LOCAL | `claims` failure/exactly-once/private callback; `conservation` randomized | `CIT-CLAIM-EXACTLY-ONCE`. OG-05 stale success. |
| F07 | Per-event and aggregate conservation under randomized sequences; no cross-event spending. | PASS_LOCAL | `conservation` seeded scenarios + isolation | `CIT-CONSERVATION`, `CIT-ISOLATION`. Single-threaded model. |
| F08 | Max capacity gas measured; chunking resumable/frozen/no early claims. | PARTIAL_LOCAL | `claims`/`acceptance` chunk semantics; `identity-boundaries` 200-seat ceiling | `CIT-CHUNK-IDEMPOTENT`, `CIT-CANCEL-CHUNK-LOCK`. Gas not measured; G09/OG-06 open. |
| E02 | At least 3 participants cover attended/no-show; receipts and balances reconcile. | PARTIAL_LOCAL | `acceptance` every vector; `conservation` randomized reconciliation | `CIT-CONSERVATION`, `CIT-ISOLATION`. No real receipts/chain balances. |
| E03 | Cancellation and timeout refund scenarios proven; synthetic clock labeled local. | PARTIAL_LOCAL | `refunds` cancel/timeout; `lifecycle` phase vectors | `CIT-CANCEL`, `CIT-REFUND-ONLY`, `CIT-TIME-WINDOWS`. Synthetic block-time only. |

## Open gates (explicitly unresolved, vectors supplied)

| Gate | Packet says | Oracle default | Vectors |
|---|---|---|---|
| OG-01 | Refund-only "after deadline"; finalization `< deadline`. | `now >= deadline` (`AT_OR_AFTER`), with `AFTER` variant. | `lifecycle-boundaries.json` refund-only deadline cases |
| OG-02 | D05 rejects overflow; aggregate u128 behavior unspecified. | Reject a deposit that would overflow `accepted_principal`; return full. | `identity-boundaries` max-u128 + second deposit |
| OG-03 | Terminal phases immutable; cancel after REFUND_ONLY unspecified. | REFUND_ONLY terminal; cancel denied. Same full-principal economics. | `lifecycle` cancel-after-refund-only |
| OG-04 | Withdrawal "grants D claim"; claim window unspecified. | Withdrawn claim CLAIMABLE immediately. | `claims`/`refunds` pre-settlement withdrawn claims |
| OG-05 | Exactly-once callback; stale success after failure+reclaim unspecified. | Only PENDING payout resolves; later callbacks `CALLBACK_STALE`. | `claims` failed -> reclaim -> late success |
| OG-06 | Chunk if one call exceeds safe gas bound (G09). | No gas claim; both one-shot and chunked paths modelled. | `claims`/`acceptance` chunk tests |
| OG-07 | A=0 full refunds; terminal state label not named. | ATTENDANCE_FINALIZED + A=0 -> SETTLED, full D claims. | `refunds` zero-attendee |
| OG-08 | Rejoin keeps old claim payable; pagination unspecified. | Distinct registrations have independent claims. | `refunds` C06 both claims paid |


Relocation proof: `docs/evidence/settlement-oracle-relocation/README.md` (package copied outside `.local`, explicit parent packet root, 105/105 PASS_LOCAL; deliberate failed run preserved the earlier PASS evidence).

## NOT_RUN (must not be inferred from this oracle)

- NEAR contract T03 escrow/pass and T04 settlement/payout tests (Rust/WASM sandbox).
- Real NEP-141 `ft_transfer_call`, `ft_on_transfer`, private payout callback receipts.
- Max-200 settlement gas measurement (G09).
- Concurrent transactions, chain ordering, real receipt atomicity and replay.
- PostgreSQL migrations, roles/grants, FK/check constraints, projection replay (T01).
- Testnet and mainnet/live transactions, wallets, storage deposits, provider routes.
- Browser/UI/API integration and any claim of NEP-171/NEP-393 conformance.

## Reproduction and relocation

```sh
cd <folder containing oracle/>
node oracle/scripts/run-oracle.mjs
# explicit roots when the package is copied elsewhere:
node oracle/scripts/run-oracle.mjs --packet-root /path/to/ShowStake --evidence-dir /tmp/oracle-evidence
```

The package root is the folder containing `oracle/`, or the package folder itself when the contents are flattened; the packet root is discovered by walking
ancestors for `docs/planning/showstake-v2/01-PRODUCT.md` unless `--packet-root` /
`SHOWSTAKE_PACKET_ROOT` is set. Tests use the same resolution. `oracle/TRACEABILITY.md` is the
canonical matrix; the `docs/evidence` copy is legacy delivery and is not assumed after relocation.
Each run gets a unique id and writes `docs/evidence/settlement-oracle-runs/<runId>/result.json`
plus a TAP log; `settlement-oracle-latest.json` is only a pointer and prior runs are preserved.
The runner verifies pinned packet hashes and marks `PASS_LOCAL` only for the current clean run.
Evidence separates the Node execution environment from externally sourced worker attribution; the
workspace `.zcode` selector is labelled leftover setup and is not execution evidence.
