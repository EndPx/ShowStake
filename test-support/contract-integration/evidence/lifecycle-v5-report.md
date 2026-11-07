# ShowStake lifecycle v5 — D036 completion report

- Task: `task_ea9a46a43699`, dispatch `ctx_47d4c5001b1b` (fresh resume of the
  stopped `ctx_74978d0ea9c2` attempt; human resume recorded in
  `msg_943a9392642d`)
- Runtime: provider `new-provider`, model
  `deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated`. Verified from this
  session's model-I/O rollout metadata
  (`C:\Users\abaym\.zcode\cli\rollout\model-io-sess_fd20b5c1-*.jsonl`, which
  records
  `{"modelId":"deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated","providerId":"new-provider"}`).
  The global selector in `provider_config.json` is `zai-api` /
  `GLM-5.3-Flash`; it was **not** the session model. The reasoning level
  "max" is not recorded per request in the rollout (`options` is null), so
  only the provider/model identity is machine-verified here.
- Base commit: `59ac44a` (HEAD); the API source from that commit was not
  touched.
- Classification: **PASS_LOCAL only**; no testnet/live acceptance, no deploy.
- Manifest: `test-support/contract-integration/evidence/lifecycle-v5-manifest.json`

## Starting point and what was actually left

The prior attempt had already reworked `contracts/showstake/src/lib.rs` for
D036 (withdrawal traps, lifetime map, O(1) accounting) and had produced one
complete sandbox result (`20261107T193921Z-1161554-c5766aad`, 984/984) against
candidate `7b2735ef`. That attempt was stopped before the wrapper wrote
`run.json`, `teardown.json` or the `latest.json` pointer, so its run could not
prove teardown or a consistent artifact path.

Three concrete gaps were closed in this dispatch:

1. **Policy identity was not distinct.** D036 requires a distinct published
   policy identity so old rules cannot be silently reinterpreted. `new()`
   accepted any free-form `policy_version`; tests and the runner still published
   the old `showstake-v2/1`. `src/lib.rs` now exports
   `POLICY_IDENTITY = "showstake-v2-d036/1"` and `new()` rejects any other
   value, including the legacy label. The argument is retained for ABI
   stability with the deployed `fc49fb85` surface.
2. **Zero-attendee safeguards were not directly unit-tested.** Added
   `cancel_with_zero_registrations_is_consistent` and
   `timeout_with_zero_registrations_is_consistent` (zero liability, zero
   escrow, terminal state, empty index).
3. **`run.json` recorded the wrong Wasm path.** The wrapper's Python fell back
   to a hard-coded v3 path because `SHOWSTAKE_WASM` was only exported to the
   runner subprocess. The path is now passed as an explicit argv and the
   completed run records `.../wasm/showstake-lifecycle-v5.wasm`.

Nothing from D036 or the prior LC-R1/LC-R2 work was reverted:
`withdraw_registration` still traps before mutation, one lifetime registration
per account/event stands, and cancellation/timeout activation remain O(1).

## Artifacts

| Item | Value |
|---|---|
| Current candidate v5 | `test-support/contract-integration/wasm/showstake-lifecycle-v5.wasm` — 390,557 bytes, `d79ef24c72d2eea762d4c3e78a1990a21bf13458b0bf07c908a68fc6ca1d5bee` |
| Prior candidate v4 (preserved) | `showstake-lifecycle-v4.wasm` — 390,430 bytes, `7b2735ef5d30986df828a3af024e3b3dc37e1ddd6d519088233a8bfc8405d707` |
| Prior candidate v3 (preserved, historical) | `showstake-lifecycle-v3.wasm` — 389,769 bytes, `5b3ae99db854a013368029ac4716ecd21893a3c93db6f7d8e0b3596b8bc0d34a` |
| Prior candidate v2 (preserved) | `showstake-lifecycle-v2.wasm` — 389,769 bytes, `9211fe4c790e9eec5d9f8d070c83a40868abc0ab249929cd8aebbadc8e4d8f43` |
| Prior candidate v1 (preserved) | `showstake-lifecycle.wasm` — 388,381 bytes, `4dde5f4bd2fbe0a6c7d3918d188cf2f06aafa03fd7a9f9b01dfbf6af0224187d` |
| Frozen deployed (unchanged) | `showstake.wasm` — 339,957 bytes, `fc49fb85cc6e718086ddf81e9a936362a8c36ef9384a8444eadafa6ec0cdcd8e` |
| Source | `contracts/showstake/src/lib.rs` — `0c9f9a56d00acdbfcf7c759e2e6d5f3c8b896fe8d5614ae0a1fb4aaacb505f71` |
| Tests | `contracts/showstake/tests/test_basics.rs` — `f86981480cf6fcab6a5f1ad2e2a30155e8203de629aeff12796c41e7242b7dfe` |
| Runner source | `test-support/contract-integration/runner/src/main.rs` — `d30336da455ecf0938ea98b9fe9ffd4c1e1af83df971313c6a8fc9c7732e5a89` |
| Wrapper | `run-product-integration.sh` — `4c40d72dc11a5da4008227bc606e8dbd71adc89377113fbf1c78a2726dd961fe` |
| Toolchain | isolated `1.95.0-x86_64-unknown-linux-gnu`, rustc `1.95.0 (59807616e 2026-04-14)`, offline cargo |

Reproducibility (PASS_LOCAL): rebuilding with the existing isolated toolchain
and existing target cache reproduced the v5 SHA-256 exactly:

```sh
export RUSTUP_HOME="$PWD/.local/zcode-settlement-oracle/sandbox-probe/.toolchain/rustup"
export CARGO_HOME="$PWD/.local/zcode-settlement-oracle/sandbox-probe/.toolchain/cargo"
export CARGO_TARGET_DIR=/var/tmp/showstake-target-c3989af8ce837da4
export CARGO_NET_OFFLINE=true

cd contracts/showstake
"$CARGO_HOME/bin/rustup" run 1.95.0-x86_64-unknown-linux-gnu cargo test --locked
"$CARGO_HOME/bin/rustup" run 1.95.0-x86_64-unknown-linux-gnu \
  cargo build --locked --release --target wasm32-unknown-unknown

cd test-support/contract-integration
bash run-product-integration.sh
```

No bootstrap, cache download or cache cleanup was performed; the runner reuses
the already-locked `borsh 1.8.1` / `base64 0.22.1` graph for the bounded
Sandbox state patch.

## D036 acceptance mapping

| D036 requirement | Evidence | Result |
|---|---|---|
| Valid deposit/pass is final; no voluntary withdrawal | `withdraw_registration` traps before any read/write; unit `withdrawal_is_disabled_before_mutation`; sandbox `voluntary_withdrawal_disabled_fails` (top-level failure, Wasm trap) and `voluntary_withdrawal_disabled_no_state` (claims/escrow/event unchanged) | PASS_LOCAL |
| No rejoin | Lifetime map `(event, account)` never removed; unit `one_lifetime_registration_per_account`; second deposit refunded | PASS_LOCAL |
| One accepted registration per account/event | `one_lifetime_registration_per_account`; sandbox `duplicate_deposit_reject_reason` (`ACTIVE_REGISTRATION`) | PASS_LOCAL |
| Organizer cancellation still returns principal | Unit `cancel_grants_full_principal_claims_and_pays_once`, `cancel_is_o1_at_capacity_200`; sandbox cancel + claim at capacity 200 | PASS_LOCAL |
| Timeout without finalization still returns principal | Unit `timeout_refund_only_is_permissionless_and_deadline_inclusive`, `timeout_refund_is_o1_at_capacity_200`; sandbox nonzero timeout + claim | PASS_LOCAL |
| Zero attendees remain safe | New unit tests `cancel_with_zero_registrations_is_consistent`, `timeout_with_zero_registrations_is_consistent`; sandbox `timeout_refund_only_state` on a zero-registration instance | PASS_LOCAL |
| Distinct published policy identity | `POLICY_IDENTITY = "showstake-v2-d036/1"` is enforced at `new()`; legacy `showstake-v2/1` rejected by unit `legacy_policy_identity_is_rejected`; sandbox events/passes report the new identity | PASS_LOCAL |
| Old state not silently reinterpreted | Schema marker `sv` required; legacy instances without it fail closed (clean instance required) | PASS_LOCAL |

## LC-R1 — bounded refund processing and capacity-200 gas

Cancellation, timeout activation and `get_event_totals` no longer walk
registrations:

- terminal activation writes only the event state and reads one fixed-size
  per-event accounting entry;
- entitlement is materialized lazily on first `claim`;
- `paid`/`pending` are fixed-size aggregate writes;
- the new maps (`lc`, `ea`, `sv`, `lr`) live outside the root Borsh layout.

Measured on the real Sandbox (capacity 200 vs the ordinary 2-registration
event):

| Path | Gas burnt on the contract receipt |
|---|---|
| `cancel_event` at 200 registrations | 2,265,237,437,803 |
| `cancel_event` at 2 registrations | 2,260,070,621,358 |
| `activate_timeout_refund` at 200 registrations (real clock past deadline) | 2,283,943,686,759 |

The 200-registration cancel costs ~5.2 Ggas more than the 2-registration
cancel — flat, not proportional to history. Unit tests additionally assert
`env::storage_usage()` is unchanged across both terminal activations at
capacity 200.

## LC-R2 — real nonzero deposit -> timeout -> refund -> claim

A dedicated Sandbox instance (`deadline-showstake.sandbox`) is deployed with
the v5 candidate and a fresh FT (`deadline-ft.sandbox`). Alice is funded with
exactly `D = 100` and registers through the real FT resolver; 199 synthetic
canonical-FT-funded registrations fill capacity 200 so the gas claim above is
measured on a full event. Capacity 200 is reached with
`accepted_principal = 20000`.

Time fixture is explicit and labelled, not a fake 24h claim:

- `deadline_original_definition` — `finalize_deadline = checkin_close + 24h`
  (1794180243621 from checkin_close 1794093843621);
- `deadline_patched_for_bounded_sandbox` — the stored deadline alone is
  shortened to `checkin_close + 20s` (1794093863621) via
  `sandbox_patch_state`, preserving ordering; the label states the patch;
- `deadline_early_activation_fails` — before the real clock crosses the stored
  deadline, permissionless activation fails;
- `sandbox_fast_forward` advances the real clock across it (no wall-clock
  sleep, no in-memory state mutation of claims);
- `deadline_permissionless_timeout_succeeds` — any account activates
  refund-only;
- `deadline_timeout_refund_only` — `RefundOnly`, claim 100 `Claimable`,
  `accepted 20000 = paid 0 + pending 0 + liability 20000`;
- `deadline_claim_paid_once` — alice claims at 100 Tgas; FT transfer and
  private callback receipts succeed; claim `Paid`, paid_amount 100, totals
  `paid 100`, liability 19900.

Unit tests cover the real `checkin_close + 24h` derivation and the exact
`deadline - 1` / at-deadline boundary.

## ABI compatibility with the deployed artifact

Wasm export sections compared directly with Node's `WebAssembly.Module`:

- deployed `fc49fb85`: 21 exported functions;
- candidate `d79ef24c`: 29 exported functions;
- **removed: none**; added: `withdraw_registration` (traps), `cancel_event`,
  `activate_timeout_refund`, `claim`, `on_payout_result`, `get_claim`,
  `get_payout`, `get_event_totals`.

`new(organizer, canonical_ft, network, policy_version)` keeps its signature;
the only new init condition is the exact policy identity. `claim` keeps the
exactly-1-yoctoNEAR + immutable-beneficiary + >=100 Tgas rules. Pass methods
(`nft_transfer`, `nft_transfer_call`, `nft_approve`, `nft_revoke`,
`nft_revoke_all`, `burn`, `admin_reassign_pass`) remain callable and trap with
`PASS_NOT_TRANSFERABLE`.

## State/schema compatibility

- Root `Contract` layout is field-for-field identical to the deployed source
  (12 fields; compared against `git show 70d6319:contracts/showstake/src/lib.rs`).
- `Config`, `Event`, `Registration`, `Pass` stored structs have no added or
  removed fields.
- Stored enums are append-only: `EventState` gains `Cancelled`/`RefundOnly`;
  `FinancialStatus` gains `Claimable`/`Pending`/`Paid`. `EventPhase` and
  `PayoutState` are JSON-only, not stored.
- New state lives in separate prefixes (`lc` claims, `ea` accounting, `sv`
  schema marker, `lr` lifetime index), so old root Borsh state still decodes.
- Old deployed state has no `sv`/`ea`/`lc` entries and **fails closed** with
  "clean lifecycle instance or explicit migration required"; no in-place
  upgrade is attempted.
- `SCHEMA_VERSION` remains 2 because the stored layout is unchanged from v4.

## Sandbox evidence

| Item | Value |
|---|---|
| Run id | `20261107T230211Z-1427450-f5f311e3` (2026-11-07T23:02:11Z → 23:14:26Z) |
| Status | PASS_LOCAL, `failure_reasons: []` |
| Checks | 984/984 passed |
| Transactions | 898 total, 882 top-level success, 16 expected negative paths |
| Snapshots | 17 FT/credit/event snapshots |
| Inputs | candidate `d79ef24c...` (match), FT fixture `d1c7d009...` (match), frozen deployed `fc49fb85...` (match), near-sandbox `797b9d7a...` (match) |
| Wrapper artifacts | `run.json`, `result.json`, `teardown.json`, `harness.log`, `runner.log`; `latest.json` points at this run |
| Run json SHA-256 | `6d8469e956075df94b2306cbb7133215b3df46a387f8e498baa71fa634244dd5` |
| Result json SHA-256 | `f99533fc61e0ef9f65bae68247c3bb036218db84a125d5b6b6c7faa7b3994685` |
| Teardown json SHA-256 | `3e4b0baec6d98d33283bd190d148d6d56d7fb090b64bd78c60e569422aecd91d` |

Selected receipts:

- voluntary withdrawal denial: `MhvxALDpeqiwNvV7Pbnt75bo8vP5WqsV6Vs4B889y7X`
  (top-level failure, `WebAssembly trap: unreachable`)
- capacity-200 cancellation: `BwWC9n252Upi6XV6V2ieYbyrfQDp52SV7Z9EU1NckkwV`
- capacity-200 timeout activation: `GrKcuAhS7WT1sK7B9hC77wAnCJWdBwnhyUJ6cAovYvmW`
- capacity-200 real-FT claim: `44BFZVXj5g3cKaaLPBQ5thsdqYxBrJG2CFLFi149CJKf`

Unit tests: `lifecycle-v5-unit-tests.log` (50 passed, 0 failed),
`lifecycle-v5-unit-tests.json`; log SHA-256
`8089d87cae74c20797ad935c2998e3ba37f3b7d7057fee46df4cfda4abaebb1a`.

Teardown: `ownership_verified: true`, `proven_stopped: true`, owned process
group 1427567, `remaining: []`, `unverified_remaining: []`. The strategy is
limited to this run's own PGID + the pinned near-sandbox binary + the
run-owned `--home` prefix.

## Open gates (unchanged or new)

1. **Codex review of v5** — this report is worker evidence, not acceptance.
   The v5 Wasm/source differ from v4 only by the policy-identity check, the
   new zero-attendee tests and the wrapper path fix; Codex must review before
   integration or deployment.
2. **Testnet lifecycle deployment — NOT_RUN.** Requires a Codex-signed
   action; `fc49fb85` remains the deployed artifact, untouched.
3. **Clean instance — required and disclosed.** Old instances lack `sv`/`lc`/
   `ea`; v5 fails closed.
4. **Real 24h deadline — PARTIAL.** Sandbox uses the labelled shortened
   deadline + real fast-forward; the +24h derivation and exact boundary are
   unit-tested, not waited out on chain.
5. **Attendance/finalization/settlement/factory — out of slice.**
6. **Callback non-execution — residual risk.** A successful FT transfer whose
   private callback never executes leaves the claim Pending with no manual
   resolver.
7. **Reasoning level "max" — NOT independently machine-verified** (rollout
   metadata records provider/model only; `options` is null).
8. **API/app integration — not in this slice.** No API, Node or lockfile file
   outside `test-support/contract-integration/**` was modified.

No commit, push, deployment, public RPC, wallet key, real asset or paid
resource was used.
