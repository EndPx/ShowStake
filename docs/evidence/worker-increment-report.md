# apps/worker increment — indexing first slice report (review round 2 → final)

Classifier (executor evidence, **reviewer acceptance still pending**):
`PASS_LOCAL` (deterministic fixtures + real disposable PostgreSQL, no network) and
`PASS_TESTNET` (read-only public testnet). No production/financial claim. No commit/push.

## Provenance & runtime

| Step | Runtime | Provider / model | Dispatch / note |
|---|---|---|---|
| Round 1 | DeepSeek Harness via Orca | GATER / `deepseek-v4.1-flash-1017-v2` | `worker-codex-review-round1.json` (FAILED, 29 checks) |
| Round 2 (source + evidence) | ZCode via Orca (Cloud Near) | `deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated` (D040 reassignment) | produced the current source and the 72/73/32 evidence below |
| Review round 2 | Codex | — | independent 62 fixtures/build pass; remaining gap was the skip proof (`worker-codex-review-round2.json`) |
| Independent PG re-run | Codex | — | `worker-run-20261109T063730Z-2429929` exit 0 / PASS, stop/cleanup proven |
| This report | DeepSeek Harness via Orca | GATER / `deepseek-v4.1-flash-1017-v2` (D043) | assembles preserved evidence; quota block, no re-run |

The executor that produced the current `apps/worker` source/evidence was ZCode
(Cloud Near) under D040; earlier GATER runs are preserved in
`docs/evidence/worker-db-worker-run-*.json` / `worker-testnet-*.json`. D042/D043
reassigned the file set to DeepSeek Harness/GATER, which was immediately blocked
(`503/upstream 402 quota_exceeded`) before any new execution; this report therefore
**finishes the preserved evidence into a review manifest — it is not a new run**.

## What was built

`apps/worker/**` — a bounded runnable NEAR receipt-projection worker (TypeScript,
`pg` + `@showstake/domain`). It reads finalized FASTNEAR NEAR Data blocks, consumes
**successful** receipts whose `executor_id` is the allowlisted event contract, and
transactionally writes `chain_events` + `events_projection` / `registrations_projection`
/ `passes_projection` + durable `worker_cursors`. Scope is publication/deposit/pass;
settlement is out of scope. Provenance-only events (storage/cancel/refund/payout) are
captured in `chain_events` and never projected. The worker DB role writes projections
only; it never logs users in and never signs financial actions.

The frozen ingestion→projection interface and the eight executable cursor/atomicity
invariants are specified in `apps/worker/README.md` (interface freeze, capability
matrix, configuration allowlist). No additional executor/framework/toolchain was added.

## Runnable commands (exact)

```sh
pnpm --filter @showstake/worker typecheck     # tsc --noEmit
pnpm --filter @showstake/worker build         # tsc -> apps/worker/dist/
pnpm verify:worker          # typecheck + build + adversarial fixtures (no DB) — 72 checks
pnpm verify:worker-db       # build + disposable-PostgreSQL acceptance (WSL tmpfs) — 73 checks
pnpm verify:worker-testnet  # build api+worker + read-only full-range testnet proof — 32 checks
# worker runnable scan (bounded, testnet): pnpm --filter @showstake/worker start
# direct:
wsl -d Ubuntu -- bash scripts/postgres-disposable/run-worker-suite.sh
wsl -d Ubuntu -- bash scripts/postgres-disposable/run-worker-testnet.sh
```

Runtime constraints observed: Node `>=24.18 <25`, pnpm workspace, disposable
postgresql-18 cluster over a per-run Unix socket (`TMPDIR=/tmp` tmpfs) with proven
stop/cleanup.

## Behavioral evidence (preserved, all pass)

| Command | Classifier | Checks | Fail | Evidence |
|---|---|---|---|---|
| `verify:worker` (fixtures, no DB) | `PASS_LOCAL` | **72** | 0 | adversarial labelled receipt fixtures (strict source/status/log parsing) |
| `verify:worker-db` (real disposable PG) | `PASS_LOCAL` | **73** | 0 | `docs/evidence/worker-db-worker-run-20261109T063730Z-2429929.json` |
| `verify:worker-testnet` (read-only) | `PASS_TESTNET` | **32** | 0 | `docs/evidence/worker-testnet-worker-testnet-run-20261108T161130Z-2415426.json` |

The real-PG run (`worker-run-20261109T063730Z-2429929`, 73/73) covers the R1 cursor
invariants (transaction advisory lock incl. first-cursor creation, exact-start incl.
fail-closed missing-initial-block, monotonic advancement only through official
canonical `prev_hash`/`prev_height` linkage, fork denial, pruned-height denial,
idempotent old replay, verbatim replay provenance/payload comparison, conditional
expected-previous upsert, malformed-cursor fail-closed, crash rollback, two-connection
different-height opposite-order and same-height exactly-once), source-vs-official
header consistency, R5 in-transaction deployment/allowlist bind + actual FT metadata
decimals + NOINHERIT/RESET ROLE guard, and API-role read of the projected event/pass.

The testnet proof (`worker-testnet-run-20261108T161130Z-2415426`, 32/32) ran the
**production** `runBoundedScan` from the committed deployment block `276624074`
through the committed deposit block `276624391` (**318 canonical blocks ingested, 0
skipped, 0 unproven missing**), bounded by the official RPC final height
(`276798539`), each block hash proven against the official RPC, and read the projected
event through a real API server (`GET /v1/events`, `GET /v1/events/:id`) and the
projected pass through the API role.

## Round-2 gap → closed (canonical prev-hash linkage skip proof)

Reviewer round 2 (`worker-codex-review-round2.json`, `accepted: false`) held a single
`remaining` item: *"UNKNOWN_BLOCK is not proof that a height was skipped; require the
next canonical `prev_hash` linkage to the current cursor, or fail closed on missing
history."* That gap is now implemented and evidenced:

- **Source** (`apps/worker/src/source.ts` `RpcCanonicalVerifier`): `verifyBlock(height,
  hash)` returns the official canonical block's `prev_hash`/`prev_height`; its docstring
  states *"No `proveSkipped` exists: an RPC `UNKNOWN_BLOCK`/source 404 can mean a pruned
  historical block, so it is NEVER accepted as skip evidence by itself."*
- **Store** (`apps/worker/src/store.ts` `ingestBlock`): forward progress requires the
  official canonical header of the target block to link directly to the cursor —
  `prev_hash == cursor.hash` AND `prev_height == cursor.height`; a 404/`UNKNOWN_BLOCK`
  is only a skip candidate, never proof; an existing intermediate block breaks the
  linkage and fails closed.
- **Scan** (`apps/worker/src/index.ts` `runBoundedScan`): a source 404 pushes the height
  onto `pendingMissing` (skip candidate) and only a later ingested block whose official
  predecessor is the cursor proves those heights skipped (`heightsSkipped`); a trailing
  unproven missing run is reported (`heightsUnprovenMissing`), never silently dropped.

Evidence of the closure: `DB_PRUNED_HEIGHT_NOT_SKIPPED`, `DB_LINKAGE_PREVHASH_MISMATCH`,
`DB_LINKAGE_PREVHEIGHT_MISMATCH`, `DB_SKIP_LINKAGE_ACCEPTED`, `DB_RESUME_AFTER_SKIP`,
`DB_CONCURRENT_HIGHER_FIRST_GAP_DENIED` (real PG), and `TESTNET_OFFICIAL_HEADER_LINKAGE`,
`TESTNET_MISSING_HEIGHT_IS_TYPED` (testnet).

## Exact file manifest

`apps/worker/**` (worker-owned):
- `apps/worker/package.json` · `apps/worker/tsconfig.json` · `apps/worker/README.md`
- `apps/worker/src/{index,cli,config,events,identity,project,source,store,types}.ts` · `apps/worker/src/external.d.ts`
- `apps/worker/test/{fixtures.mjs, verify-worker-fixtures.mjs, verify-worker-db.mjs, verify-worker-testnet.mjs}`

Worker PG-suite entrypoints (worker-owned):
- `scripts/postgres-disposable/run-worker-suite.sh` · `scripts/postgres-disposable/run-worker-testnet.sh`

Root manifests (worker-owned, additive only):
- `package.json` — added `verify:worker`, `verify:worker-db`, `verify:worker-testnet` scripts
  (`verify:worker-testnet` also builds `@showstake/api` for the real API read; no `apps/api` source edit)
- `pnpm-lock.yaml` — added `pg`/`@types/pg`/`tsx`/`typescript`/`@types/node` + workspace links for `@showstake/worker`

Generated `apps/worker/dist/` is git-ignored. Untouched: `apps/web/**`, `apps/api/**` source,
`contracts/**`, `packages/**`, `migrations/**` (immutable migrations), `test-support/contract-integration/**`,
`wallet-adapter/**`.

## Evidence artifacts

- `docs/evidence/worker-codex-review-round1.json` (FAILED, 29 independent checks and R1 gaps)
- `docs/evidence/worker-codex-review-round2.json` (accepted:false; sole remaining item = skip proof)
- `docs/evidence/worker-review-round2-response-20261108T034141Z.json` (R1–R5 resolution map)
- `docs/evidence/worker-db-worker-run-20261109T063730Z-2429929.json` (73/73 PASS_LOCAL)
- `docs/evidence/worker-testnet-worker-testnet-run-20261108T161130Z-2415426.json` (32/32 PASS_TESTNET)
- prior DB/testnet runs preserved (`worker-db-worker-run-20261108T*`, `worker-testnet-worker-testnet-run-20261108T*`, `-20261107T*`)
- `docs/evidence/indexer-source-testnet-probe.json` (PASS_LIVE source probe, not worker acceptance)
- `docs/evidence/gater-quota-indexing-blocker.json` (this report's preserved-evidence source: 72 fixture / 73 real PG / 32 testnet / 318 blocks)

## Trusted-source boundary & honest limits

- Block **identity** (height/hash/canonicality/finality + `prev_hash`/`prev_height`
  linkage) is proven against the official NEAR JSON-RPC.
- FASTNEAR receipt execution-outcome/**log CONTENTS** are **not merkle-proved** in this
  worker; they are trusted inside the proven block-identity boundary. Strict
  schema/status/log checks and the pinned `get_event` cross-check constrain that trust,
  but are not a cryptographic receipt proof.
- Source (`FASTNEAR NEAR Data`) and NEAR Lake are compared by primary sources only
  (Lake requires AWS credentials and is requester-pays); NEAR Lake is **not** integrated.
  No SLA/pricing is contracted for either.
- `PASS_TESTNET` is a read-only public-testnet proof (no transactions/funds/keys/deploy).
- Settlement/factory/attendance projections are out of scope for this increment.

## Reviewer acceptance status (what remains)

Everything the reviewer asked for in round 2 is implemented and evidenced above, but
**no worker source has been accepted or pushed** — final source/evidence integration
review and scoped commit remain with Codex. This report makes no completed-feature or
production claim.