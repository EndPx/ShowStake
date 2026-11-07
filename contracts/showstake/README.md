# contracts/showstake — ShowStake v2 product contract (local vertical slice)

**Local product code. Not deployed and not testnet/mainnet acceptance.**
This crate implements the ShowStake v2 product slice:
publish event → native storage prepay → canonical FT `ft_transfer_call` →
one registration + one account-bound pass in the same receipt, with real FT
resolver refunds on every invalid path. It also implements one lifetime
registration per account/event (voluntary withdrawal/rejoin removed by D036),
organizer cancellation, permissionless timeout refund-only and exactly-once
beneficiary claims through a private FT payout callback. Attendance,
finalization, settlement/redistribution and the factory remain later slices.

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
  `policy_version` must equal the published D036 identity
  `showstake-v2-d036/1` (constant `POLICY_IDENTITY` in `src/lib.rs`); the
  earlier voluntary-withdrawal label `showstake-v2/1` is rejected, so an
  instance built from this source can never be silently relabelled with the old
  rules. The argument is retained for ABI stability with the deployed
  `fc49fb85` surface.
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
- `cancel_event(event_id)` — organizer only, while the event is still Published
  (no settlement in this slice). Every registration becomes entitled to a
  full-principal claim; no reward is paid. The transition is **O(1)** and does
  not rewrite registrations.
- `activate_timeout_refund(event_id)` — permissionless at/after
  `finalize_deadline` while the event is still Published. Sets the terminal
  RefundOnly state and grants full-principal claims; also **O(1)**. Exact
  `now >= deadline` boundary; late finalization is a later slice.
- `claim(registration_id)` — caller must equal the immutable beneficiary and
  attach exactly 1 yoctoNEAR for the canonical FT transfer. Cancellation and
  refund-only do not rewrite every claim record: the full-D entitlement is
  materialized on the first claim for that registration. One pending payout is
  reserved per registration; the contract then calls FT `ft_transfer` with a
  private `on_payout_result(payout_id)` callback. Success moves liability to
  paid; failure restores the full claimable D and allows a new attempt.
  Double claims, stale/duplicate callbacks, spoofed callbacks and wrong
  beneficiaries fail closed.
- Views: `get_config`, `get_event`, `get_registration`, `get_pass`, `get_claim`,
  `get_payout`, `get_event_totals`, `get_escrow_principal`,
  `storage_balance_of`, `get_block_timestamp_ms`, bounded `list_events` /
  `list_event_registrations` (1..=50). `get_event_totals` is O(1): paid and
  pending come from a fixed-size per-event accounting entry, not a history
  walk. Terminal event views derive `Committed` registrations as `Claimable`
  until their first claim materializes the record.
- `nft_transfer`, `nft_transfer_call`, `nft_approve`, `nft_revoke`,
  `nft_revoke_all`, `burn`, `admin_reassign_pass` — all log
  `SHOWSTAKE_REJECT reason=PASS_NOT_TRANSFERABLE` and trap. Passes are custom
  account-bound credentials, not NEP-171/NEP-393 tokens.

## State compatibility and clean instance

The existing `Event`, `Registration`, `Pass` and root `Contract` Borsh layouts
are unchanged. `EventState` and `FinancialStatus` only append variants.
Auxiliary state lives in separate fixed-prefix maps outside the root layout:
`lc` claim records (created with registration), `ea` per-event paid/pending
aggregates (created with publish), `sv` schema marker (created with publish),
and `lr` lifetime registration index (created with registration). Entries are
fixed-size and charged by the measured publish/registration writes.

The deployed `fc49fb85…` artifact lacks claims, accounting, schema and
lifetime entries. The prior `4dde5f4b…` v1 state has claims but no accounting
or schema; the `5b3ae99d…` v3 state has claims/accounting but no schema or
lifetime index. This v4 candidate fails closed on all three with
claim-record/accounting/schema-missing errors. A clean, new contract instance
is required; no silent reinterpretation or migration of any old state is
performed.

## Build and tests

Requires the isolated Rust 1.95.0 toolchain with `wasm32-unknown-unknown`;
do not reuse a host registry and do not download dependencies when the existing
cache is present.

```sh
cargo test --locked
cargo build --locked --release --target wasm32-unknown-unknown
```

The v3 lifecycle candidate is 52/52 `PASS_LOCAL` mocked-VM unit tests. The
local Sandbox runner additionally produced 234/234 real receipt/balance
checks, including a capacity-1 event with 20 withdraw/rejoin cycles and a
nonzero-deposit timeout -> refund -> claim leg; the fresh run is
`20261107T181440Z-874164-46e5b7eb`. Candidate Wasm:
`test-support/contract-integration/wasm/showstake-lifecycle-v3.wasm`
(`5b3ae99db854a013368029ac4716ecd21893a3c93db6f7d8e0b3596b8bc0d34a`).
Testnet evidence remains Codex's authorized deployment gate; no chain
acceptance is claimed here. The ABI/source/build manifest, preserved run list
and open gates are in
`test-support/contract-integration/evidence/lifecycle-v3-manifest.json` and
`lifecycle-v3-report.md`; max-capacity settlement/redistribution gas and
testnet deployment remain `NOT_RUN`. Cancellation and timeout activation
themselves are O(1) and do not walk unbounded history.

Provenance: original Rust written for ShowStake v2 against near-sdk 5.30.1.
CommitPass Solidity was read only as a behavioral reference; no Solidity is
copied.
