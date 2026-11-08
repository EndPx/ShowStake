# ShowStake lifecycle v6 — attendance, finalization and bounded settlement

- Task: `task_8c183efb95cc`, dispatch `ctx_2eb83ce3f311`
- Runtime: provider `new-provider`, model
  `deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated`, verified from this
  session's model-I/O rollout metadata (`modelId`/`providerId` per request).
  The global selector in `provider_config.json` is `zai-api` /
  `GLM-5.3-Flash` and was not the session model. The reasoning level "max" is
  not recorded per request (`options` is null), so only the provider/model
  identity is machine-verified.
- Base commit: `a632d3c` (accepted v5 bounded refund/claim; the deployed
  `fc49fb85` and accepted `d79ef24c` artifacts are untouched).
- Classification: **PASS_LOCAL only**; no testnet/live acceptance, no deploy.
- Manifest: `test-support/contract-integration/evidence/lifecycle-v6-manifest.json`

## What was delivered

1. **Attendance marking/correction** (`mark_attendance`) — organizer only,
   only while the event is `Published` and `checkin_open <= now < checkin_close`.
   Repeats with the same value are idempotent (no write, `changed=false`);
   `attended=false` corrects inside the same window. Registration and pass
   attendance are updated together.
2. **Attendance finalization** (`finalize_event`) — organizer only, only
   `checkin_close <= now < finalize_deadline`. Walks the bounded registration
   index once, freezes the attendee count and moves to `AttendanceFinalized`.
   Marking and a second finalize are denied afterwards.
3. **Permissionless bounded settlement** (`settle`) with the exact D036
   allocation: first call freezes `pool/q/r` and enters `Settling`; each call
   allocates at most 25 registrations in immutable registration-sequence order
   from the frozen cursor; completion verifies registration count, allocated
   sum and attendee cursor before `Settled`. Replay after completion is an
   idempotent no-op. Claims are disabled until `Settled`; cancellation is
   locked once `Settling`.
4. **Claims** — the unchanged beneficiary/private-callback path now uses the
   cursor allocation after settlement (`Claimable`, or `Forfeited` for a zero
   no-show allocation). `Cancelled`/`RefundOnly` keep full-D materialization.
5. **Oracle comparison** — every on-chain allocation is compared against the
   accepted independent settlement oracle, not a re-implementation.

The ABI/event/state proposal was frozen in `contracts/showstake/README.md`
(section "Frozen proposal — attendance, finalization and settlement (candidate
v6)") **before** implementation, as required.

## Artifacts

| Item | Value |
|---|---|
| Current candidate v6 | `test-support/contract-integration/wasm/showstake-lifecycle-v6.wasm` — 420,795 bytes, `f462ddcbb8b47ff03f4bea71c054cefe0d0a576b1346a0f9a55688c43307fd59` |
| Accepted v5 (preserved) | `showstake-lifecycle-v5.wasm` — 390,557 bytes, `d79ef24c72d2eea762d4c3e78a1990a21bf13458b0bf07c908a68fc6ca1d5bee` |
| Prior v4/v3/v2/v1 (preserved) | `7b2735ef…`, `5b3ae99d…`, `9211fe4c…`, `4dde5f4b…` |
| Frozen deployed (unchanged) | `showstake.wasm` — 339,957 bytes, `fc49fb85cc6e718086ddf81e9a936362a8c36ef9384a8444eadafa6ec0cdcd8e` |
| Contract source | `contracts/showstake/src/lib.rs` — `3b72b03bb2f8e436f138028cbe08436312dbd5f64f8a39dfc375bf96f7f06539` |
| Contract tests | `contracts/showstake/tests/test_basics.rs` — `15613700652aeec3ea289b50965b253138d94f2bc67e36ba62dac57ae7f447f8` |
| Contract README (ABI freeze) | `36acca6c…` |
| Runner source | `test-support/contract-integration/runner/src/main.rs` — `a7fd58440d2f0a75f722d39c078ba971f949af18ce3a63d4652f0a96457604c2` |
| Wrapper | `run-product-integration.sh` — `7f0359516c1bced6444120de1e95849f8aade0401f0e9fddf674dbf9a52cea7f` |
| Oracle generator | `test-support/contract-integration/oracle/generate-settlement-expected.mjs` — `f3cfe164…` |
| Oracle scenarios | `test-support/contract-integration/oracle/scenarios.json` — `ddae4fff…` |
| Oracle expected output | `evidence/oracle-settlement-expected.json` — `d4b8a1cd98bdc328cbec54e14c2fe7e17b1433ef4794834f55f86a8e6aef048f` |
| Oracle allocation module | `test-support/settlement-oracle/src/settlement.mjs` — `61b926917a4b1c38295d689e5dc48094ee12081ea7cecdc26ed2c5018fffc6e8` |
| Toolchain | isolated `1.95.0-x86_64-unknown-linux-gnu`, rustc `1.95.0 (59807616e 2026-04-14)`, offline cargo |

Reproducibility (PASS_LOCAL): rebuilding with the existing isolated toolchain
and target cache reproduced the v6 SHA-256 exactly.

## Tests

- Contract unit tests: **63 passed, 0 failed** (mocked VM). New coverage:
  attendance window/organizer-only, idempotent duplicate/correction,
  finalize window/immutability/counted attendees, settle-before-finalize
  denial, all-attended principal return, no-show pool split with deterministic
  remainder (17/17/16), the packet 5×D2 example (5/5/0/0/0), zero-attendee
  refunds, capacity-200 eight-chunk cursor with fixed storage and gated
  claims, chunk-boundary remainder ordering, cancellation after finalization,
  timeout denial after finalization, and rejection of both older policy
  identities. Log: `lifecycle-v6-unit-tests.log` (`4ea0bde6…`).
- Real Sandbox: **2,328/2,328 checks**, 1,436 transactions (1,410 top-level
  successes, 26 expected negative paths), 17 snapshots. Run:
  `20261108T005435Z-1890976-5a5eacd9`.

## Exact allocation

With `N` registrations, `A` attendees, `M = N - A` and common deposit `D`:

- `A > 0`: `pool = M*D`, `q = floor(pool/A)`, `r = pool mod A`. Attendees in
  immutable registration-sequence order receive `D + q + 1` for the first `r`
  and `D + q` for the rest. No-shows receive `0`.
- `A = 0`: every registration is refunded its own `D`.
- Platform/organizer fee is zero; `sum(allocation) == accepted_principal ==
  N*D`. Withdrawals are not part of D036; the oracle's legacy withdrawal
  support is not treated as a requirement.

Packet examples confirmed on-chain and against the oracle:

| Scenario | Payouts by registration sequence | Total |
|---|---|---|
| 5 × D2, 2 attendees | `5,5,0,0,0` (unit) | 10 |
| 5 × D10, 3 attendees | `17,0,17,16,0` (sandbox + oracle) | 50 |

## Sandbox scenarios (real receipts/balances)

| Scenario | Evidence | Result |
|---|---|---|
| Normal (3 registrations, all attended) | settle `CdZ1QRf7…`, oracle payouts 10/10/10 (30) | PASS_LOCAL |
| Remainder (5 × D10, attendees at seq 0,2,3) | settle `EegGARg…`, oracle 17/0/17/16/0 (50), carol claims 17 with balance delta, bob no-show claim fails | PASS_LOCAL |
| Zero attendees (3 registrations) | settle `CNwiTd8…`, oracle 10/10/10 refunds | PASS_LOCAL |
| Late finalize denied (unfinalized at deadline) | `timeout_late_finalize_denied` `61nx6oHR…` fails; event stays Published; timeout then refunds | PASS_LOCAL |
| Finalized in time settles after deadline | late settle `5YfY71s…` after a labelled stored-deadline patch (`checkin_close + 20s`) and a real fast-forward; timeout on the finalized event `9AYS8KP7…` fails | PASS_LOCAL |
| Unauthorized mark/finalize | bob mark and bob finalize fail; wrong beneficiary claim fails | PASS_LOCAL |
| Duplicate / idempotent | duplicate mark `8tvHqH…` changes no state; second finalize fails; settle replay after completion is a no-op | PASS_LOCAL |
| Chunk recovery at capacity 200 | first settle enters Settling at cursor 25; claims during Settling fail; cancellation locked `E9EdoNx3…`; 7 more chunks advance 50…200; completion verifies count/sum/attendees; replay no-op | PASS_LOCAL |
| Claims / conservation | alice 10, carol 17, zero-case alice 10, late alice 20, cap bob 50; FT supply 1,000,000 conserved across holders and instances | PASS_LOCAL |

## Oracle comparison

`generate-settlement-expected.mjs` imports the accepted
`test-support/settlement-oracle/src/settlement.mjs` (hash `61b92691…`) and
writes the expected per-registration payouts for the five scenarios. The
wrapper copies that JSON into the run directory and hashes it; the runner
refuses to run without it and compares every on-chain claim amount, the event
`allocated_total`, `pool/base_share/remainder`, and attendee/no-show counts.
All 213 per-registration payouts plus every scenario's total and terms matched
the oracle.

## Gas at capacity 200 (receipt gas, real Sandbox)

| Path | Gas |
|---|---|
| `finalize_event` at 200 registrations (200 Tgas attached) | 34,235,531,615,805 (~34.24 Tgas) |
| `settle` chunk of 25 entries (200 Tgas attached) | min 20,310,779,431,535 / max 20,467,845,028,436 |
| All 8 chunks | 162,798,559,606,497 (~162.8 Tgas) |
| `claim` after settlement (100 Tgas attached) | 3,454,113,745,143 (normal) / 3,462,000,443,960 (cap-200) |
| `cancel_event` at 200 / at 2 registrations | 2,299,863,203,460 / 2,294,634,680,315 |
| `activate_timeout_refund` at 200 | 2,318,509,391,228 |

A single 200-entry settlement receipt would be roughly eight times a chunk
(~163 Tgas plus overhead), too close to the 200 Tgas attached for a
permissionless call, so the design uses eight bounded chunks of 25 with a
frozen cursor, an independent allocated-sum check and claims disabled until
completion. Capacity remains 200; no cap was reduced.

## ABI and state compatibility

- Export comparison (Node `WebAssembly.Module.exports`): frozen 21 → v5 29 →
  v6 33. `mark_attendance`, `finalize_event`, `settle` and `get_settlement`
  are additive; nothing was removed.
- `new(...)` keeps its signature; the only new condition is the exact policy
  identity `showstake-v2-d036-settle/1` (the v2-withdrawal and v5-D036 labels
  are rejected).
- Stored structs (`Config`, `Event`, `Registration`, `Pass`, `ClaimRecord`,
  `EventAccounting`) and the 12-field root `Contract` layout are field-for-
  field identical to v5. Enums only append variants.
- `SettlementState` (prefix `st`) is created in the measured publish write and
  only updated with fixed-size values; unit tests show zero storage growth
  across all eight chunks.
- `SCHEMA_VERSION` is 3. Older states (`fc49fb85`, v1–v4 and the accepted v5
  schema 2) fail closed with clean-instance errors; no in-place migration is
  attempted. Existing view JSON shapes are unchanged; `get_settlement` is
  additive.

## Evidence integrity and preserves

- `run.json` status PASS_LOCAL, `failure_reasons: []`, wasm path/hash match,
  frozen hash match, oracle hash match, runner build/run exits 0.
- Teardown: `ownership_verified: true`, `proven_stopped: true` (PGID 1891096,
  `remaining: []`).
- Hashes: run.json `ba70df30…`, result.json `d57fcd40…`, teardown.json
  `3b653d6e…`.
- Frozen `fc49fb85`, candidates v1–v5, all prior run folders, and the
  interrupted earlier v6 attempt (`20261108T004925Z-1866288-af4de579`) are
  preserved; no old evidence file was rewritten.

## Open gates

1. **Codex review/acceptance of v6** — this is worker evidence, not
   acceptance.
2. **Testnet deployment — NOT_RUN.** Codex owns the clean testnet deployment;
   `fc49fb85` remains deployed.
3. **Real 24-hour deadline — PARTIAL.** Unit-tested derivation and exact
   boundaries; Sandbox uses a labelled shortened stored deadline with a real
   clock crossing.
4. **API/worker projection schema — unchanged.** Attendance/settlement are
   contract-only; any projection addition needs a Codex decision.
5. **Settlement claim failure/retry** uses the unchanged private callback path;
   the existing failed-payout retry checks remain in the same run, but a
   settlement-amount failure was not separately forced in this Sandbox.
6. **Factory** remains out of slice.
7. **Reasoning level "max"** not independently machine-verified.

No commit, push, deployment, key, real asset or paid service was used. Only
`contracts/showstake/**` and `test-support/contract-integration/**` were
modified; no API/web/worker/root-lockfile file was touched.
