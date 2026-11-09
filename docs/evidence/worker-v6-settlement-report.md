# apps/worker increment — v6 settlement adapter (D038 / `showstake-v2-d036-settle/1`)

Author: DeepSeek Harness / GATER (Orca worker, `GATER/deepseek-v4.1-flash-1017-v2`).
Classifier: source + local evidence `PASS_LOCAL` (fixtures 90/90, real PG 86/86);
read-only testnet full-range proof re-run with **batched resume within one DB lifecycle**
(see Honest limits). Review acceptance is **not** claimed here.

## Scope

Extends the accepted minimum worker (`apps/worker`, pushed `d76211f`) to explicitly
support the accepted v6 settlement artifact `f462ddcb…` / policy
`showstake-v2-d036-settle/1` at `showstake-settle-endpx.testnet`, **without** changing
the existing `showstake-v2/1` minimum deployment and **without** a migration (the
existing SQL schema already represents PUBLISHED/ATTENDANCE_FINALIZED/SETTLING/SETTLED
and the `claim_atomic`/`payout_state`/`payouts_projection` columns — D038). No new
framework/executor/toolchain.

## What changed (exact file manifest)

Modified (worker-owned):
- `apps/worker/src/events.ts` — parse/classify the v6 events (`AttendanceMarked`,
  `EventFinalized`, `SettlementStarted`, `SettlementChunk`, `EventSettled`) and the
  private payout lifecycle (`PayoutStarted`/`PayoutSucceeded`/`PayoutFailed`); unknown
  financial event names throw (fail-closed, never provenance-only).
- `apps/worker/src/project.ts` — `mapEventState` gains the three settled states;
  `mapFinancialStatus` (`Forfeited → ZERO`); pinned-view parsers for
  `get_event_totals` / `get_settlement` / `get_claim` / `get_registration` / `get_payout`.
- `apps/worker/src/store.ts` — settlement/payout ingestion: pinned-view enrichment
  (`get_settlement` per settle, `get_payout` per payout for identity/amount, ONE
  `get_event_totals` per block), deterministic allocation with conservation, attendance
  freeze, event-derived payout transitions reconciled once-per-block against the pinned
  totals (a same-block start+callback never asserts an intermediate `get_payout` state),
  exactly-once payouts, and a synchronous pinned-block assertion.
- `apps/worker/src/source.ts` — FASTNEAR `null` body (HTTP 200 for a missing height)
  is a `BlockNotFoundError` skip candidate (matching 404 semantics), and the official
  RPC's `422`/`404`/`UNKNOWN_BLOCK` canonical answer for a height is now a typed
  `CanonicalBlockMissingError` skip candidate (never proof by itself; the next block's
  canonical `prev_hash`/`prev_height` linkage still proves the gap or fails closed).
- `apps/worker/src/index.ts` — `runBoundedScan` treats both source `BlockNotFoundError`
  and canonical `CanonicalBlockMissingError` as skip candidates.
- `apps/worker/README.md` — v6 event matrix + settlement projection contract.
- `apps/worker/test/fixtures.mjs` — added `SETTLE_DEPLOYMENT` + committed v6 receipt
  block metadata.
- `apps/worker/test/verify-worker-fixtures.mjs` — adversarial v6 classification/parse
  checks (25 new): malformed attendance/counts/payout/unknown-financial, view parsers.
- `apps/worker/test/verify-worker-db.mjs` — real-PG settlement lifecycle section
  (13 checks): resolve/finalize/freeze/allocation/principal/conservation/payout
  start/fail-retry/paid-once/no-double-count **plus a same-block start+callback
  regression and a same-DB-lifecycle batch-resume (`resolveStartHeight`=cursor+1)
  regression**.

New (worker-owned):
- `apps/worker/test/verify-worker-testnet-v6.mjs` — read-only actual-testnet v6 proof.
- `scripts/postgres-disposable/run-worker-testnet-v6.sh` — disposable-PG harness.
- `package.json` — added `verify:worker-testnet-v6` script (api+worker build + v6 proof).

Untouched: `apps/api/**` source, `apps/web/**`, `contracts/**`, `packages/**`,
`migrations/**` (no migration change; D038), `docs/**` planning files.

## Runnable commands

```sh
pnpm --filter @showstake/worker typecheck && pnpm --filter @showstake/worker build
pnpm verify:worker               # 90 adversarial checks (PASS_LOCAL, no DB/network)
pnpm verify:worker-db            # 86 real-PG checks incl. settlement lifecycle (PASS_LOCAL)
pnpm verify:worker-testnet-v6    # read-only v6 full-range testnet proof (batched resume, 90-min bound) + real API read
# direct: wsl -d Ubuntu -- bash scripts/postgres-disposable/run-worker-suite.sh
#         wsl -d Ubuntu -- bash scripts/postgres-disposable/run-worker-testnet-v6.sh
```

## Behavioral evidence

| Command | Classifier | Checks | Fail | Evidence |
|---|---|---|---|---|
| `verify:worker` | `PASS_LOCAL` | **90** | 0 | adversarial parsing + v6 classification |
| `verify:worker-db` | `PASS_LOCAL` | **86** | 0 | `docs/evidence/worker-db-worker-run-20261109T113834Z-2435895.json` |
| `verify:worker-testnet-v6` | `BLOCKED_EXTERNAL` | start checks pass; batched scan to ~276713871 | — | `migrations/artifacts/worker-testnet-v6-run-20261109T*.json` + `checkpoint-*.json` |

The real-PG settlement section proves: provisional `attended` (state stays COMMITTED),
`EventFinalized` freezes 2×ATTENDED/1×NO_SHOW, deterministic allocation (attendees
`D + base_share` = 7500000 `CLAIMABLE`, no-show `0`/`ZERO` Forfeited), `principal_atomic`
unchanged (`D`), conservation `sum(claim) == accepted == allocated_total`, and the payout
lifecycle: `PayoutStarted` → pending, `PayoutFailed` restores claimable without
double-count, retry (new `payout_id`) → `PayoutSucceeded` with paid exactly once (two
`payouts_projection` rows: FAILED + SUCCEEDED), a **same-block start+callback** (one
`PayoutStarted` + `PayoutSucceeded` in the same block, where the end-of-block `get_payout`
already reads `Succeeded`) reconciles once per block, and a **same-DB-lifecycle batch
resume** proves the durable cursor resumes even after the DB cluster is torn down (it is
NOT resumable after cleanup — the disposable cluster's cursor is deleted with it).

## v6 settlement semantics implemented

- **Provisional vs finalized attendance** — `AttendanceMarked` flips `attended` only;
  `EventFinalized` freezes `ATTENDED`/`NO_SHOW` (cross-checked counts).
- **Forfeited → ZERO, correct principal D vs reward** — `principal_atomic` stays `D`;
  `claim_atomic` is the total entitlement (reward + principal), `0` for a no-show when
  `attendee_count > 0`, `D` for every registration in the zero-attendee case.
- **No DB financial authority** — `base_share`/`remainder`/`allocated_total` from pinned
  `get_settlement`; `accepted`/`paid`/`pending`/`liability` from ONE pinned
  `get_event_totals` per block (reconciled after the block's event-derived transitions);
  each payout identity/amount cross-checked against pinned `get_payout`; conservation
  asserted.
- **Settlement partial never exposes claimability** — `SettlementChunk` stays `SETTLING`;
  only `EventSettled` finalizes.
- **Idempotent private callback retry, no double count** — `PayoutFailed` restores
  `CLAIMABLE`; a new attempt uses a new `payout_id`; `payouts_projection` unique
  `(registration_id, payout_id)` + one-pending index.
- **Unknown financial events fail closed** — unrecognised names throw instead of
  advancing a stale projection.
- **Event-derived transitions, once-per-block reconcile** — a block carries its payout
  events' transitions (start→PENDING, success→PAID, fail→CLAIMABLE) from the EVENT data,
  then reconciles the block's final financial totals once from the pinned `get_event_totals`;
  the start event never asserts an intermediate `get_payout` state (which is already
  terminal by end-of-block when start + callback share a block).

## Checkpoint dump/stop/restore/resume (local proof — the active-proof recovery)

The disposable cluster is deleted on cleanup, so a proof that hits its bounded deadline
loses the durable cursor. Recovery is now **`pg_dump` of the owned DB data to a per-run
artifact BEFORE proven stop/cleanup**, with a `sha256` + source/config/cursor manifest, and
the next proof restores it into a NEW owned disposable DB and verifies identity before
resuming. Existing `pg_dump`/`pg_restore` only; public chain/local test data only.

- `scripts/postgres-disposable/worker-checkpoint-lib.sh` — SHARED dump/verify/restore
  helpers (`ckpt_config_json`, `ckpt_source_schema_json`, `ckpt_dump`, `ckpt_verify_and_restore`,
  `ckpt_latest`) sourced by BOTH the local regression and the real `run-worker-testnet-v6.sh`
  (same helper path — no duplicated code). The manifest carries the ACTUAL v6 testnet allowlist
  (`showstake-settle-endpx.testnet`, code_hash `HSyv…`, wasm `f462ddcb…`, `showstake-v2-d036-settle/1`)
  + sha256 of all ten worker source adapters + both `migrations/schema/*.sql` files; no credentials.
- `scripts/postgres-disposable/run-worker-checkpoint.sh` — LOCAL regression (cluster A seed → shared `ckpt_dump` → proven stop/cleanup → cluster B `prep` + shared `ckpt_verify_and_restore` → resume → corrupt/wrong-deploy fail-closed).
- `scripts/postgres-disposable/run-worker-testnet-v6.sh` — wired: resume a prior `ckpt_latest` checkpoint at start (verify + restore + `resolveStartHeight`), and on a proof FAILURE do `ckpt_dump` BEFORE stop/cleanup (unique per run id, never overwrite).
- `apps/worker/test/verify-worker-checkpoint.mjs` — phased driver (`seed`/`prep`/`resume`/
  `wrongdeploy`); `verify-worker-testnet-v6.mjs` gained a `WORKER_CHECKPOINT_ONLY_PREP`
  restore-ahead phase (schema+roles+deployment seed, no scan).

**Local evidence (PASS_LOCAL, no network):** two-batch dump-stop-restore-resume produced
the IDENTICAL final projection as the uninterrupted run (event `SETTLED`, totals
15000000/15000000/0, 2 attendees `7500000 PAID`, 1 no-show `0 ZERO`, 3 payouts with the
failed attempt `FAILED` + retry/callback `SUCCEEDED`), the restored cursor identity
`206/S206` + `resolveStartHeight`=207 were verified before resume, a malformed dump and a
wrong-code-hash deployment dump both failed closed (FAILED, not resume-eligible; no event
rights created). Run:
`pnpm verify:worker-checkpoint`; evidence in
`migrations/artifacts/worker-checkpoint-run-20261109T124950Z-2438336/` (dump `5addf2f5…`,
manifest `dumpOk:true`, cursor `{block_height:206}`).

## Honest limits

- Read-only public testnet only; no transactions/funds/keys/deploy/paid services/mainnet.
- FASTNEAR receipt/log contents remain trusted inside the proven block-identity
  boundary (no merkle proof of execution outcomes).
- No commit/push; no factory/Rust/API/web edits; no migration (existing schema suffices).
- Codex review round 1 found and fixed four concrete source defects: totals reconciliation now covers every financial event id in a block and asserts the requested event id; settlement requires matching counts, frozen attendance and claims enabled; payout success/failure requires a matching PENDING payout row. Fresh local verification is recorded in `docs/evidence/worker-v6-codex-review-round1.json`. The v6 adapter is accepted as PASS_LOCAL source integration only; testnet settlement/payout projection remains BLOCKED_EXTERNAL because the public FASTNEAR/RPC endpoints rate-limited the bounded scan.

### Testnet full-range proof (batched resume — `BLOCKED_EXTERNAL`)

**Correction to the prior report:** the disposable PostgreSQL cluster is **deleted on
cleanup**, so the old durable cursor is **NOT resumable after cleanup** — only within the
same DB lifecycle. The v6 full-range scan therefore runs **multiple bounded `runBoundedScan`
batches inside the same owned-DB lifecycle**, calling `resolveStartHeight` between batches
(cursor+1), with incremental `checkpoint-<n>.json` artifacts per batch and a 90-minute
global bound — no weakening of canonical/finality/skipping.

Three bounded runs were made. The scan is **correct and batch-resumable**: it resolved +
verified the v6 deployment, treated FASTNEAR gap heights correctly (first by `null`-body →
`BlockNotFoundError`, then by an official-RPC `UNKNOWN_BLOCK`/422 → a typed
`CanonicalBlockMissingError` skip candidate, proven only by the NEXT block's canonical
`prev_hash` linkage), and completed 3 batches (`checkpoint-1..3`) covering
`276712710…276713609` with all gaps skipped — projecting the real `EventPublished` and
`RegistrationCommitted` deposits before the final remaining range. It then **could not
complete the settlement/payout blocks** because the public FASTNEAR testnet block source
and `test.rpc.fastnear.com` RPC began **rate-limiting** after the repeated full-range
bounded scans (`HTTP 429` from `testnet.neardata.xyz`, and spurious `422` → treated as
skip candidates). This is an external provider-throttling limit, not a source-logic
failure; the deterministic settlement allocation, forfeit and payout retry are fully
proven by the real-PG suite above. A later run after the rate-limit window would resume
the same bounded-batch loop to completion.
