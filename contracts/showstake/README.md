# contracts/showstake — ShowStake v2 product contract (local vertical slice)

**Local product code. Not deployed and not testnet/mainnet acceptance.**
This crate implements the ShowStake v2 product slice:
publish event → native storage prepay → canonical FT `ft_transfer_call` →
one registration + one account-bound pass in the same receipt, with real FT
resolver refunds on every invalid path. It also implements one lifetime
registration per account/event (voluntary withdrawal/rejoin removed by D036),
organizer cancellation, permissionless timeout refund-only, organizer
attendance finalization, permissionless bounded settlement with exact
redistribution and exactly-once beneficiary claims through a private FT payout
callback. The factory remains a later slice.

## Frozen proposal — attendance, finalization and settlement (candidate v6)

This section is the ABI/event/state freeze Codex reviews before integration.
The accepted v5 artifact (`d79ef24c…`) and its state are preserved unchanged;
this is a distinct candidate with a new policy identity and a clean instance.

### State machine

`Published → AttendanceFinalized → Settling → Settled`, with
`Published | AttendanceFinalized → Cancelled` and
`Published → RefundOnly` (permissionless timeout). Once `Settling` starts it is
terminal for cancellation; `Settled`, `Cancelled` and `RefundOnly` are
terminal. A finalized event settles even after `finalize_deadline`; timeout is
only available while the event is still unfinalized (`Published`).

### New and changed methods

- `mark_attendance(registration_id: String, attended: bool) -> RegistrationView`
  — organizer only, only while `Published` and `checkin_open <= now <
  checkin_close`. Repeated calls with the same value are idempotent (no state
  write, `changed=false`); `attended=false` is a correction inside the same
  window. Updates the registration and its pass together.
- `finalize_event(event_id: String) -> EventView` — organizer only, only while
  `Published` and `checkin_close <= now < finalize_deadline`. Walks the
  append-only registration index once (bounded by capacity 200), counts stored
  `Attended` flags, freezes `attendee_count`/`finalized_at` in the settlement
  entry and moves the event to `AttendanceFinalized`. A second finalize is
  denied; attendance cannot change afterwards.
- `settle(event_id: String) -> SettlementView` — permissionless. Requires
  `AttendanceFinalized` or `Settling`. The first call freezes `pool`, `q`, `r`
  and enters `Settling`; every call allocates at most `SETTLE_CHUNK = 25`
  registrations in immutable registration-sequence order from the stored
  cursor. Completion requires `allocated_count == total_registrations`,
  `allocated_total == accepted_principal` and
  `attendee_cursor == attendee_count`, then moves to `Settled`. A call while
  `Settled` is an idempotent no-op. Claims are disabled until `Settled`.
- `get_settlement(event_id: String) -> SettlementView` — O(1) read-only view
  of the frozen counts, cursor and completion.
- `cancel_event(event_id)` — extended to `Published | AttendanceFinalized`;
  denied once `Settling`. It never overwrites a partial allocation.
- `activate_timeout_refund(event_id)` — unchanged: `Published` only, at/after
  `finalize_deadline`. Denied after finalization.
- `claim(registration_id)` — `Cancelled`/`RefundOnly` still materialize the
  full `D` on first claim. After `Settled` the cursor-written allocation is
  used instead (`Claimable` amount, or `Forfeited` for a zero no-show
  allocation). `Finalized`/`Settling` claims are rejected.

### Exact allocation (D036: no withdrawals)

With `N` registrations, `A` attendees, `M = N - A` no-shows and common deposit
`D`: if `A > 0`, `pool = M*D`, `q = floor(pool/A)`, `r = pool mod A`; attendees
in registration-sequence order receive `D + q + 1` for the first `r` and
`D + q` for the rest; no-shows receive `0`. If `A = 0`, every registration is
refunded its own `D`. Platform and organizer fees are zero, and
`sum(allocation) == accepted_principal == N*D`. These are the packet examples:
5 registrations of 2 with 2 attendees → 5,5 and 0 for three no-shows;
5 registrations of 10 with 3 attendees → 17,17,16,0,0.

### Events (EVENT_JSON, standard `showstake`)

`AttendanceMarked` (`registration_id`, `attended`, `changed`, `event_id`),
`EventFinalized` (`event_id`, `attendee_count`, `no_show_count`,
`total_registrations`, `finalized_at`), `SettlementStarted` (`event_id`,
`pool`, `base_share`, `remainder`, `attendee_count`, `actor`),
`SettlementChunk` (`event_id`, `cursor`, `total_registrations`,
`allocated_total`, `complete`), `EventSettled` (`event_id`, `paid`-free
allocation totals: `allocated_total`, `attendee_count`, `no_show_count`,
`total_registrations`). Existing event names are unchanged.

### State compatibility

- `EventState` gains append-only `AttendanceFinalized`, `Settling`, `Settled`;
  `AttendanceStatus` gains `Attended`; stored no-shows are derived as
  `NoShow` once attendance is frozen; `FinancialStatus` gains `Forfeited`;
  `EventPhase` (JSON only) gains the three new phases.
- A new fixed-size `SettlementState` entry (map prefix `st`) is created in the
  measured `publish_event` write and updated only with fixed-size writes, so
  no lifecycle call creates uncharged storage. `Registration`/`Pass`/`Event`
  root structs and the 12-field root `Contract` layout are unchanged.
- `SCHEMA_VERSION` becomes 3 and the policy identity becomes
  `showstake-v2-d036-settle/1`. Instances written by v5 (schema 2) and the
  deployed `fc49fb85` fail closed and require a clean instance; no in-place
  migration is attempted.
- Existing view JSON shapes are unchanged; `get_settlement` is additive.

## One event per contract

Each deployment hosts exactly one event and may issue many account-bound
passes (max 200 active, one active per account). The organizer is fixed
immutably at initialization, so no first-publish front-run is possible. Any
publish by another account, and any second publish of any event id, is denied
before any state or native-credit mutation. Factory/permissionless child
deployment is a later slice, not part of this contract.

The external pass identity is the tuple (network, contract account, pass_id).
`pass_id` is unique per contract; `owner = participant = beneficiary`; no
transfer, approval, burn or admin reassignment exists.

## Implemented surface

- `new(organizer, canonical_ft, network, policy_version)` — one-time immutable
  config. `organizer` is the only account allowed to publish.
  `policy_version` must equal the published identity
  `showstake-v2-d036-settle/1` (constant `POLICY_IDENTITY` in `src/lib.rs`);
  the earlier `showstake-v2/1` and `showstake-v2-d036/1` labels are rejected,
  so an instance built from this source can never be silently relabelled with
  an older rule set. The argument is retained for ABI stability with the
  deployed `fc49fb85` surface.
- `publish_event(event_id, rules)` — only the configured organizer may call;
  exactly one event may exist for the lifetime of the contract. Times are
  validated
  `reg_open < reg_close <= cancel_cutoff <= checkin_open < checkin_close`,
  `finalize_deadline = checkin_close + 24h`, deposit > 0, capacity 1..=200.
- `storage_deposit(account_id?)` / `storage_balance_of(account_id)` — prepaid
  native NEAR credit. A new `credits` entry's measured storage growth is paid
  from the attached deposit before any credit is granted; only the remainder is
  credited, and a too-small prepay traps atomically. Existing entries have a
  fixed-size `u128`, so top-ups charge only actual growth (normally zero).
  Event/registration storage is charged from measured `env::storage_usage()`
  growth. No FT credit, seat or pass is created here.
- `ft_on_transfer(sender_id, amount, msg)` — only the immutable canonical FT;
  bounded versioned message `{version:1,event_id,commitment_id}` with unknown
  fields rejected. Validates exact D, open phase, capacity, one lifetime
  registration per account/event, lifetime-unique `(payer, commitment_id)`,
  checked u128 and measured prepaid storage **before** granting any right.
  Success returns 0 and writes registration + pass in this receipt; every
  invalid path returns the full unused amount and leaves no balance, count,
  seat, pass, escrow or commitment state.
- `withdraw_registration(registration_id)` — **disabled by D036**. The route
  remains callable for ABI stability but traps before any state read or
  mutation. There is no voluntary refund/rejoin after a valid deposit/pass;
  one lifetime registration per account/event means capacity 200 bounds total
  registrations on a clean instance.
- `mark_attendance(registration_id, attended)` — organizer only, `Published`
  and `checkin_open <= now < checkin_close`; idempotent repeats and in-window
  corrections update registration and pass together.
- `finalize_event(event_id)` — organizer only, `checkin_close <= now <
  finalize_deadline`; walks the bounded index once, freezes the attendee count
  and moves to `AttendanceFinalized`; immutable afterwards.
- `settle(event_id)` — permissionless, `AttendanceFinalized` or `Settling`;
  first call freezes allocation terms, each call allocates at most 25 entries
  from the frozen cursor, completion verifies count/sum/attendee cursor and
  moves to `Settled`. Idempotent no-op after completion; claims disabled until
  then.
- `cancel_event(event_id)` — organizer only, `Published` or
  `AttendanceFinalized` (before `Settling`). Every registration becomes
  entitled to a full-principal claim; no reward is paid. The transition is
  **O(1)** and never overwrites a partial allocation.
- `activate_timeout_refund(event_id)` — permissionless at/after
  `finalize_deadline` while the event is still `Published` (unfinalized). Sets
  the terminal RefundOnly state and grants full-principal claims; also **O(1)**.
  A finalized event settles instead of switching to refund-only.
- `claim(registration_id)` — caller must equal the immutable beneficiary and
  attach exactly 1 yoctoNEAR for the canonical FT transfer. Cancellation and
  refund-only materialize the full-D entitlement on the first claim; after
  settlement the cursor-written allocation is used and a zero no-show
  allocation is `Forfeited`. One pending payout is reserved per registration;
  the contract then calls FT `ft_transfer` with a private
  `on_payout_result(payout_id)` callback. Success moves liability to paid;
  failure restores the claimable amount and allows a new attempt. Double
  claims, stale/duplicate callbacks, spoofed callbacks and wrong beneficiaries
  fail closed.
- Views: `get_config`, `get_event`, `get_registration`, `get_pass`, `get_claim`,
  `get_payout`, `get_event_totals`, `get_settlement`, `get_escrow_principal`,
  `storage_balance_of`, `get_block_timestamp_ms`, bounded `list_events` /
  `list_event_registrations` (1..=50). `get_event_totals` is O(1): paid and
  pending come from a fixed-size per-event accounting entry, not a history
  walk. `get_settlement` is O(1) and additive. Terminal event views derive
  `Committed` registrations as `Claimable` until their first claim
  materializes the record; frozen attendance derives unmarked registrations as
  `NoShow`.
- `nft_transfer`, `nft_transfer_call`, `nft_approve`, `nft_revoke`,
  `nft_revoke_all`, `burn`, `admin_reassign_pass` — all log
  `SHOWSTAKE_REJECT reason=PASS_NOT_TRANSFERABLE` and trap. Passes are custom
  account-bound credentials, not NEP-171/NEP-393 tokens.

## State compatibility and clean instance

The existing `Event`, `Registration`, `Pass` and root `Contract` Borsh layouts
are unchanged. `EventState`, `AttendanceStatus` and `FinancialStatus` only
append variants (`AttendanceFinalized`/`Settling`/`Settled`,
`Attended`/`NoShow`, `Forfeited`). Auxiliary state lives in separate
fixed-prefix maps outside the root layout: `lc` claim records (created with
registration), `ea` per-event paid/pending aggregates (created with publish),
`st` attendance/settlement cursor (created with publish), `sv` schema marker
(created with publish), and `lr` lifetime registration index (created with
registration). Entries are fixed-size and charged by the measured
publish/registration writes; settlement chunks only rewrite fixed-size values.

The deployed `fc49fb85…` artifact lacks claims, accounting, schema, lifetime
and settlement entries. The `4dde5f4b…` v1 state lacks accounting/schema; the
`5b3ae99d…` v3 state lacks schema/lifetime; the accepted `d79ef24c…` v5 state
is schema 2 and lacks the attendance/settlement map. This v6 candidate
(`f462ddcb…`, schema 3) fails closed on every older state with
claim-record/accounting/schema/settlement-missing errors. A clean, new
contract instance is required; no silent reinterpretation or in-place
migration of any old state is performed.

## Build and tests

Requires the isolated Rust 1.95.0 toolchain with `wasm32-unknown-unknown`;
do not reuse a host registry and do not download dependencies when the existing
cache is present.

```sh
cargo test --locked
cargo build --locked --release --target wasm32-unknown-unknown
```

The v6 settlement candidate is 63/63 `PASS_LOCAL` mocked-VM unit tests. The
local Sandbox runner produced 2,328/2,328 real receipt/balance checks over
1,436 transactions, including attendance marking, finalization, permissionless
chunked settlement at capacity 200, zero-attendee refunds, a deterministic
17/17/16 remainder, late-finalize denial, finalize-then-settle-after-deadline,
unauthorized/duplicate paths, claim gating while `SETTLING`, cancellation lock,
and registration-by-registration comparison against the accepted settlement
oracle. Fresh run: `20261108T005435Z-1890976-5a5eacd9`. Candidate Wasm:
`test-support/contract-integration/wasm/showstake-lifecycle-v6.wasm`
(`f462ddcbb8b47ff03f4bea71c054cefe0d0a576b1346a0f9a55688c43307fd59`).
Measured receipt gas at capacity 200: finalize ~34.2 Tgas (200 Tgas attached),
each 25-entry settle chunk ~20.3–20.5 Tgas (200 Tgas attached), claims ~3.5
Tgas (100 Tgas attached). Testnet evidence remains Codex's authorized
deployment gate; no chain acceptance is claimed here. The ABI/source/build
manifest, preserved run list and open gates are in
`test-support/contract-integration/evidence/lifecycle-v6-manifest.json` and
`lifecycle-v6-report.md`; a real 24-hour wait and testnet deployment remain
`NOT_RUN`/`PARTIAL`.

Provenance: original Rust written for ShowStake v2 against near-sdk 5.30.1.
CommitPass Solidity was read only as a behavioral reference; no Solidity is
copied.
