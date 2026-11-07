# contracts/showstake — ShowStake v2 product contract (local vertical slice)

**Local product code. Not deployed and not testnet/mainnet acceptance.**
This crate implements the first ShowStake v2 product slice:
publish event → native storage prepay → canonical FT `ft_transfer_call` →
one registration + one account-bound pass in the same receipt, with real FT
resolver refunds on every invalid path.

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
  fields rejected. Validates exact D, open phase, capacity, one active
  account/event, lifetime-unique `(payer, commitment_id)`, checked u128 and
  measured prepaid storage **before** granting any right. Success returns 0 and
  writes registration + pass in this receipt; every invalid path returns the
  full unused amount and leaves no balance, count, seat, pass, escrow or
  commitment state.
- Views: `get_config`, `get_event`, `get_registration`, `get_pass`,
  `get_escrow_principal`, `storage_balance_of`, `get_block_timestamp_ms`,
  bounded `list_events` / `list_event_registrations` (1..=50).
- `nft_transfer`, `nft_transfer_call`, `nft_approve`, `nft_revoke`,
  `nft_revoke_all`, `burn`, `admin_reassign_pass` — all log
  `SHOWSTAKE_REJECT reason=PASS_NOT_TRANSFERABLE` and trap. Passes are custom
  account-bound credentials, not NEP-171/NEP-393 tokens.

## Out of scope for this slice

Withdrawal, cancellation, refund-only activation, attendance, finalization,
settlement, claims, payout callbacks and delegate/resale are the next
assignment. The contract only holds accepted FT principal in this slice.

## Build and tests

Requires the isolated Rust 1.95.0 toolchain with `wasm32-unknown-unknown`;
do not reuse a host registry and do not download dependencies when the existing
cache is present.

```sh
cargo test --locked
cargo build --locked --release --target wasm32-unknown-unknown
```

The current candidate is 34/34 `PASS_LOCAL` mocked-VM unit tests. Real
receipt/balance evidence must come from the local Sandbox runner, and testnet
evidence from Codex's authorized deployment; neither is claimed here.

Provenance: original Rust written for ShowStake v2 against near-sdk 5.30.1.
CommitPass Solidity was read only as a behavioral reference; no Solidity is
copied.
