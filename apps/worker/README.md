# apps/worker — ShowStake NEAR receipt projection & reconciliation worker

Reads **finalized** NEAR blocks/receipt outcomes, captures **successful** ShowStake
events for an allowlisted event contract, and transactionally maintains
`chain_events` + `events_projection` / `registrations_projection` /
`passes_projection` + durable `worker_cursors`. The worker DB role writes
projections only; it never logs users in and never signs financial actions
(`docs/planning/showstake-v2/02-ARCHITECTURE.md`).

**Status (this increment):** bounded runnable — publication / deposit / pass **plus
the settled v6 lifecycle** (attendance → finalization → bounded settlement → private
payout with retry) on `showstake-v2-d036-settle/1` / `showstake-settle-endpx.testnet`.
Provenance-only events (storage, cancel, refund-only) are captured in `chain_events`
but never project financial rights. Review round 2 moved canonical/finality proof into the
production path, hardened the source normalizer and made the cursor invariants executable.
The v6 adapter extends the same worker with an explicit artifact/policy allowlist — it
does **not** reinterpret the existing `showstake-v2/1` minimum deployment, and settlement
financial totals are read from pinned contract views, never invented by the DB. No
additional executor/framework/toolchain.

## Interface freeze (ingestion → projection)

These boundaries are frozen for this module; multiple writers on them are not
allowed without a reviewed change here.

| Boundary | File | Contract |
|---|---|---|
| Config (explicit allowlist, fail-closed) | `src/config.ts` | `loadConfig(env) → WorkerConfig`; rejects missing/mismatched network/deployment/start-height. |
| Block source | `src/source.ts` | `BlockSource.fetchBlock(height) → NormalizedBlock`; `lastFinalHeight()`. Strict normalizer; `BlockNotFoundError` only for HTTP 404. |
| Canonical source | `src/source.ts` | `CanonicalVerifier.verifyBlock(height, hash)` returns the official RPC's **canonical block at that height** plus its `prev_hash`/`prev_height`; `lastFinalHeight()`. No UNKNOWN_BLOCK-based skip proof. |
| View source (pinned enrichment) | `src/source.ts` | `ViewSource.callView(method, args, blockRef) → {result, blockHeight, blockHash}`; the returned hash must equal the pinned hash. |
| Event parse/classify | `src/events.ts` | `parseShowStakeLogs(logs) → ShowStakeEvent[]`; `classifyEvent(ev)`; throws on malformed/unknown. |
| Enrichment + projection prep | `src/project.ts` | `buildChainEvent`, `enrichPublish`, `parseEventView`, `mapEventState`. |
| Transactional store | `src/store.ts` | `WorkerStore.ingestBlock(deploymentId, block)` — official-RPC canonical/finality proof + one SQL transaction per block; deployment/allowlist bound inside the transaction. |
| Runnable scan | `src/index.ts` | `runBoundedScan(...)` — sequential, bounded by the **official** final height, skip only with canonical proof. |

### Cursor + atomicity invariants (frozen, executable)

1. **One transaction per block**, guarded by a transaction-scoped
   `pg_advisory_xact_lock` on `(deployment_id, consumer)` taken *before* the
   cursor read. First cursor creation is serialized by the same lock.
2. **Exact start.** With no cursor the first write must land exactly on the DB
   `deployments.start_block` (`configured start == DB start`); an existing
   cursor resumes at `cursor+1`. A cursor below `start_block` is refused.
3. **Monotonic + canonically linked.** Forward progress requires the official
   canonical header of the target block to link directly to the cursor:
   `prev_hash == cursor.hash` AND `prev_height == cursor.height`. For contiguous
   blocks that means height+1; across a legitimate height gap it proves every
   intermediate height has no canonical block (the predecessor is the cursor
   block). A source 404 or RPC `UNKNOWN_BLOCK` is **only a skip candidate**, never
   proof (it may be a pruned historical block): if an intermediate block exists,
   the target's predecessor is that block and the linkage mismatch fails closed.
   A missing INITIAL block also fails closed (a fresh first cursor must equal
   `deployments.start_block`). A same-height different hash is a **fork** and
   throws. An older block is an idempotent replay only if every event it carries
   was already ingested with verbatim provenance; it never regresses the cursor
   and never injects new chain events at a passed height.
4. **Conditional upsert.** Creation inserts only (`ON CONFLICT DO NOTHING` must
   not hit); update carries the exact expected previous `height+hash` in the
   `WHERE` and requires `rowCount = 1`. Any mismatch rolls the block back.
   Chain-event replay is not a silent drop either: an existing
   `(receipt_id, log_index)` row must have the same block height/hash/time, event
   name, schema version and JSON payload, or the replay throws.
5. **Fail-closed state.** A malformed `worker_cursors.cursor_value` (including
   JSON `null`, missing hash, non-integer height) throws; it is never treated as
   "no cursor / start over".
6. **Canonical + final + linkage proof in the ingest path.** `ingestBlock` asks
   the official RPC for the canonical block at the height (by height, not only by
   hash), requires the hash to match, requires the source's own
   `prev_hash`/`prev_height` to equal the official header, and requires the height
   to be at or below the official final height. The scan's upper bound is the
   official final height, never the block source's claim. A pinned `get_event`
   view must report exactly the ingested block's height and hash.
7. **Deployment binding inside the transaction.** The `deploymentId` is re-read
   from `deployments` inside the transaction and compared field-by-field with the
   explicit allowlist (environment/network/contract/FT/decimals/code hash) before
   any event or cursor write.
8. **Strict source.** `normalizeFastNearBlock` rejects absent/empty `shards`, a
   shard without an explicit `receipt_execution_outcomes` array, outcomes missing
   `id`/`outcome`/`executor_id`/`logs`, a `block_hash` differing from the parent
   block, duplicate receipt ids, malformed status variants, missing/malformed
   `prev_hash`/`prev_height`, and non-bounded timestamps. The header `chunks`
   shard set must be non-empty, unique and EXACTLY equal to the `shards` set, so
   a partial or duplicate shard set is never claimed complete merely because it
   is non-empty. Explicit empty outcome arrays and empty `logs` arrays are
   accepted. Any throw means the cursor cannot advance.

Ingestion also persists `chain_events` dedup (`ON CONFLICT (deployment_id,
receipt_id, log_index) DO NOTHING`) + projections + the conditional cursor write
in that same transaction. Any canonical/validation/parse/enrichment/DB error rolls
the whole block back, so the cursor can never advance past required unprocessed
data. Replay/restart is idempotent.

### Event support matrix

| ShowStake event (`standard=showstake`, `version=1.0.0`) | Projection |
|---|---|
| `EventPublished` | `events_projection` (rules enriched from pinned `get_event` view) |
| `RegistrationCommitted` | `registrations_projection` + `passes_projection` + event totals |
| `AttendanceMarked` | provisional `attended` flag only (state stays `COMMITTED` until finalize) |
| `EventFinalized` | freeze attendance: `ATTENDED` / `NO_SHOW`; event → `ATTENDANCE_FINALIZED` |
| `SettlementStarted` | event → `SETTLING` (claims stay disabled) |
| `SettlementChunk` | partial allocation only (state stays `SETTLING`; never claimable) |
| `EventSettled` | deterministic allocation + event → `SETTLED`; totals from pinned `get_event_totals` |
| `PayoutStarted`/`Succeeded`/`Failed` | `payouts_projection` + registration `payout_state`; totals from pinned `get_event_totals` |
| `StorageDeposited`, `EventCancelled`, `RefundModeActivated` | provenance only (`chain_events`) |
| unknown event / wrong version / wrong standard / malformed amount | **fail closed** (throw, cursor not advanced) |

Only successful receipts (`outcome.status` is `SuccessValue`/`SuccessReceiptId`,
never `Failure`) whose `executor_id` is the allowlisted contract are consumed.
Failed-receipt logs never grant rights.

### v6 settlement projection (D038 / `showstake-v2-d036-settle/1`)

- **Provisional vs finalized attendance.** `AttendanceMarked` only flips
  `registrations_projection.attended`; the `state` column stays `COMMITTED`.
  `EventFinalized` freezes it: `attended=true` → `ATTENDED`, else `NO_SHOW`
  (cross-checked against the event's attendee/no-show counts).
- **Deterministic allocation (Forfeited → ZERO).** On `EventSettled` each
  registration, in `sequence_no` order, receives `claim_atomic` = `deposit +
  base_share + (attendee_index < remainder ? 1 : 0)` for attendees, `0` for a
  no-show when `attendee_count > 0`, or `deposit` for every registration in the
  zero-attendee case; `payout_state` = `CLAIMABLE` or `ZERO`. `principal_atomic`
  stays `D` (the deposit) — `claim_atomic` is the total allocated entitlement.
- **Contract totals, no DB-created rights.** `base_share`/`remainder`/`allocated_total`
  come from the pinned `get_settlement` view; `accepted`/`paid`/`pending`/`liability`
  come from the pinned `get_event_totals` view; payouts are cross-checked against the
  pinned `get_payout` view. Conservation is asserted: `sum(claim_atomic) == accepted`
  `== allocated_total`. A `PayoutFailed` restores `CLAIMABLE` without double-counting
  liability, and a retry is a new `payout_id` (exactly-once via the unique constraint).
- **Unknown financial events fail closed.** An unrecognised showstake event name
  throws rather than advancing a stale projection.

## Source selection + capability matrix

Selected source: **FASTNEAR NEAR Data** — https://github.com/fastnear/neardata-server .
Public testnet base URL `https://testnet.neardata.xyz`; documented endpoints used
here are `/v0/last_block/final` and `/v0/block/<height>` (the README also lists
`first_block`, per-shard/header/optimistic endpoints and `mainnet.neardata.xyz`).
The documented limit is **180 requests/minute per IP** with 1 Gbps bandwidth; the
worker paces block reads at ≤150/minute and backs off on HTTP 429.

Primary-source facts, and what is **unknown/untested**:

| Capability | FASTNEAR NEAR Data | NEAR Lake framework/indexer | Notes / sources |
|---|---|---|---|
| Function | Finalized block + per-shard receipt execution outcomes (JSON) | S3-indexed Lake data via the Lake framework SDK | FASTNEAR README endpoint list. Lake is a framework + bucket layout, not one HTTP call. |
| History | Height-addressed finalized blocks | S3 archive (testnet/mainnet buckets) | Lake buckets: `near-lake-data-testnet`, `near-lake-data-mainnet` (eu-central-1) per the indexer README. |
| Network | testnet + mainnet public hosts | testnet + mainnet buckets | Both cover the configured testnet; only FASTNEAR was exercised here. |
| Access | Unauthenticated HTTPS | **AWS credentials required**; buckets are **requester-pays**; readers are charged by AWS | Lake indexer README: "Connections to the bucket have to be done with AWS credentials provided" and "All NEAR Lake AWS S3 buckets have Request Payer enabled". |
| Security | Read-only HTTP; block identity re-checked against NEAR JSON-RPC | Read-only S3; data pinned to block heights | See the trusted-source boundary below. |
| Cost | No key/payment used here; documented rate limit, no price statement in the README | **Requester pays** => AWS request/data-transfer charges | Do not claim Lake is free. Neither service's price/SLA is contracted here. |
| Reliability | No SLA/availability statement in the README; 429 throttling observed and handled | No SLA statement in the repository | **Unknown** for both; no production-availability claim. |
| Time | Minutes (plain `fetch` over documented endpoints) | Higher (SDK + S3 credentials/requester-pays setup) | FASTNEAR selected for this bounded slice. |

Primary sources: https://github.com/fastnear/neardata-server (endpoints, 180
req/min, 1 Gbps) and https://github.com/near/near-lake-indexer (bucket names, AWS
credentials, requester-pays, "charged for it by AWS"). NEAR Lake was **not**
integrated (no additional framework/toolchain this slice).

### Trusted-source boundary (honest limit)

Matching a source block's height/hash against the official NEAR JSON-RPC proves
**which block** was read (canonical identity + finality). FASTNEAR returns the
receipt execution outcomes/logs for that block **without a merkle proof verified
here**, so receipt/log **contents** are trusted inside the proven block-identity
boundary; a compromised/malicious source could serve wrong contents under a real
block hash. The worker's strict schema/status/log checks and the pinned
`get_event` cross-check constrain that trust, but they are not a cryptographic
receipt proof.

## Configuration (explicit allowlist + verified identity)

All env vars are required unless a default is shown. Fail-closed on any mismatch.

```
WORKER_NETWORK=testnet
WORKER_ENVIRONMENT=testnet
WORKER_CONTRACT_ID=showstake-endpx.testnet
WORKER_FT_CONTRACT_ID=showstake-ft-endpx.testnet
WORKER_FT_DECIMALS=6
WORKER_CODE_HASH=HyqAt2yJGvV3CHKNYLA9oqzt1aWrmagwSbtogdXhA8wo
WORKER_WASM_SHA256=fc49fb85cc6e718086ddf81e9a936362a8c36ef9384a8444eadafa6ec0cdcd8e
WORKER_ORGANIZER=showstake-participant-endpx.testnet
WORKER_POLICY_VERSION=showstake-v2/1
WORKER_START_HEIGHT=276624074   # contract deployment block; must EXACTLY equal deployments.start_block on a fresh cursor
WORKER_CONSUMER=showstake-worker
WORKER_RPC_URL=https://rpc.testnet.near.org   # default; D041 testnet transport is https://test.rpc.fastnear.com
WORKER_NEARDATA_URL=https://testnet.neardata.xyz
WORKER_MAX_BLOCKS_PER_RUN=1000                # bounded, default
DATABASE_URL=...                              # or SHOWSTAKE_PG_* socket (tests)
```

The DB `deployments` row is operator-seeded (worker role is read-only on it).
`resolveDeployment` + `resolveStartHeight` + `ingestBlock` enforce: DB row matches
the allowlist (network/contract/ft/decimals/code_hash/start block), the base58
`code_hash` decodes to `wasm_sha256`, the live RPC `code_hash` + `get_config` view
match, the FT's own `ft_metadata.decimals`/`symbol` (not just config/DB echoes)
match, the fresh start equals the deployment `start_block`, and the ingestion id
is re-bound to the allowlist inside every ingestion transaction. Any mismatch
refuses to start/ingest.

The worker runtime pool requires a dedicated **NOINHERIT, non-superuser** LOGIN
with no `CREATEDB`/`CREATEROLE`/`REPLICATION`/`BYPASSRLS`, no API/migration
membership, no inherited/privileged membership and no direct write grants on
projections/cursors. Membership in `showstake_worker` must be granted
`WITH INHERIT FALSE, SET TRUE`, so `RESET ROLE` cannot restore write authority;
startup proves this empirically (projection UPDATE / cursor DELETE return 42501
after `RESET ROLE`).

## Commands

```sh
pnpm --filter @showstake/worker typecheck
pnpm --filter @showstake/worker build
pnpm verify:worker               # typecheck+build+adversarial fixtures (no DB)
pnpm verify:worker-db            # build + WSL disposable-PostgreSQL suite
pnpm verify:worker-testnet       # build API+worker + read-only full-range testnet proof (minimum v1)
pnpm verify:worker-testnet-v6    # build API+worker + read-only full-range v6 settlement testnet proof
pnpm verify:worker-checkpoint    # local dump/restore/resume proof for the v6 cursor
pnpm --filter @showstake/worker start   # bounded runnable scan (testnet)
```

Tests are deterministic labelled fixtures (`apps/worker/test/fixtures.mjs`);
DB acceptance uses a real disposable PostgreSQL (TMPDIR=/tmp tmpfs) with proven
stop/cleanup. The read-only testnet proofs are clearly separate from local
fixtures: they run the production `runBoundedScan` from the contract deployment
block through the committed final receipt block (every intervening height, no
jumps), reject mutated real payloads, and read the projected event through the real
API server. `verify:worker-testnet-v6` covers the settled `d036-settle-five`
lifecycle on `showstake-settle-endpx.testnet` (deterministic allocation, no-show
forfeit, two payouts, conservation).

Evidence labels are honest: `PASS_LOCAL` (fixtures/PG/checkpoint, no network),
`PASS_TESTNET` (read-only public testnet), `BLOCKED_EXTERNAL` when the public
testnet source is rate-limited, never a live/production claim. The v6 adapter's
local source integration is reviewed PASS_LOCAL; the full settlement/payout
testnet projection remains BLOCKED_EXTERNAL until the public endpoint recovers.

## Runtime/provider + provenance

Runtime: DeepSeek Harness via Orca, model GATER/`deepseek-v4.1-flash-1017-v2`
(the v6 settlement adapter + report); the earlier minimum-worker source/evidence
was authored by ZCode via Orca (Cloud Near), model
`deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated` (D040 reassignment; earlier
GATER/`deepseek-v4.1-flash-1017-v2` runs remain preserved). Source manifest and
per-run evidence are written to `docs/evidence/worker-db-<run>.json`,
`docs/evidence/worker-testnet-<run>.json` and
`docs/evidence/worker-testnet-v6-<run>.json`; prior runs are preserved, new runs
have unique ids.

Money is canonical u128 base-10 strings; time is checked integer milliseconds;
projections carry `receipt_id`/`log_index`/block hash+height provenance.

## Candidate MockEarn adapter

Policy showstake-native-usdc-event/1 is handled only for the exact reviewed candidate Wasm hash in src/candidate.ts. Set WORKER_CANDIDATE_PROVIDER_ACCOUNT explicitly. A successful finalized receipt from that executor, including empty-log receipts, triggers a pinned bounded event/registration/pass snapshot. The adapter verifies pinned MockEarn identity and FT escrow/provider position. Zero-yield settlement and claim states map to existing projection rows; it creates no fictional payout records. Cancel/refund phases and nonzero yield remain fail-closed pending their own implementation/tests.

The mainnet review candidate has a separate fixed deployment, code hash, token and provider allowlist in `src/candidate.ts` and `src/config.ts`. Configure `WORKER_NETWORK=mainnet`, `WORKER_ENVIRONMENT=mainnet`, the exact pinned values, organizer and deployment start height. Its successful finalized receipts drive block-pinned snapshots; a null event creates no event row. Actual realized yield and allocated yield are kept separate; only allocated yield enters claim liability. Refund states are mapped from contract views. Pending and supplied funds are observational: the worker does not verify Rhea solvency or accept the provider. Migrations through 0007 are required for yield accounting. A fixture or a worker projection does not authorize a transaction or prove a funded provider cycle.

The manual deployment CLI runs one bounded cycle by default (`node apps/worker/dist/cli.js --once` from the repository); `--watch` repeats from the durable cursor, with `WORKER_WATCH_INTERVAL_MS` from 5000 to 300000. A one-block HTTP lookahead overlaps source fetch and verification, while database commits remain sequential. The source's latest height bounds availability only: the official final height and canonical verification still govern every ingested block. A missing tail is not treated as a proven skip.

For an operator-approved factory, `node apps/worker/dist/adopt-cli.js --watch` polls one bounded page per cycle. Set `WORKER_FACTORY_ID`, `WORKER_FACTORY_CODE_HASH`, `WORKER_FACTORY_ORGANIZER`, and a restricted database connection; the enabled operator-owned factory trust row must match. Optional `WORKER_WATCH_INTERVAL_MS` is 5000–300000 (default 15000), `WORKER_MAX_BLOCKS_PER_RUN` is 1–1000, and `WORKER_FACTORY_FROM_INDEX` selects a starting page. Page traversal wraps back to that index after the final page. Each child is revalidated against fresh final chain state and resumed from its durable cursor. RPC/source failures stop that cycle and are retried without moving the failed cursor. No factory is accepted merely by setting these environment variables.

The unreleased schema-2 global-ready factory profile is selected explicitly with `WORKER_FACTORY_DISCOVERY_MODE=global`; omit `WORKER_FACTORY_ORGANIZER` in that mode. It pages `list_all_children` in Ready-completion order and verifies each organizer, request, keyless child and leaf at one final block before operator-trusted adoption. No schema-2 factory address or hash is pre-approved, and the current leaf pin remains the previously reviewed artifact until a replacement is independently accepted. Legacy organizer-scoped mode remains the default.

The optional `WORKER_FACTORY_LEAF_PROFILE=linked-v2` selects only the frozen `49a591ba…` candidate and its exact linked-withdraw policy/hash, and requires global schema-2 discovery plus an enabled operator trust row. It does not change the deployed manual `03076c4a…` profile. Partial-redemption coverage combines pinned FT balance and provider internal position with integer scaling, preserving fractional dust; it is observational and does not establish provider safety, receipt finality or mainnet liquidity. No factory is enabled by this profile selection.

Candidate-specific real PostgreSQL tests cover two 5-USDC allocations from five 2-USDC deposits, pending/paid, stable UUID replay, and insufficient escrow rollback. Existing cursor/canonical/source-completeness rules remain mandatory. This is local component acceptance; a full live scan must separately catch up before the API projection is current.

## Schema-3 factory worker

Set `WORKER_MODE=factory`, `WORKER_NETWORK` and `WORKER_ENVIRONMENT` both set to `mainnet` or both to `testnet`. Set `WORKER_FACTORY_PROFILE` to an operator-reviewed JSON object with exactly: `network`, `factoryId`, `factoryCodeHash`, `schemaVersion`, `factoryPolicy`, `leafHash`, `leafSha`, `leafPolicy`, `canonicalFt`, `providerAccount`, and `providerKind`. Schema is `3`, factory policy is `showstake-factory-atomic-event/3`, mainnet uses leaf policy `showstake-native-usdc-factory-rhea/3` and provider kind `RHEA_MAINNET`; testnet uses `showstake-native-usdc-event/1` and `MOCK_TESTNET`. Supply exact reviewed account, code and SHA values; no default hashes or wildcard trust are provided. The leaf hash must decode to the SHA. Mainnet canonical native USDC and Rhea are fixed; testnet FT, provider and factory must be explicitly pinned `.testnet` accounts and the FT must have six decimals.

A matching enabled `factory_deployment_allowlist` row must be configured independently by the migration operator. Each cycle verifies a bounded public-ready page at one fresh final block, checks keylessness and the factory request/derived child identity, adopts via the restricted database function, and scans each child from its creation height or durable cursor. A watch cycle advances through pages and wraps to page zero; a restart begins discovery at page zero and resumes each child's durable cursor. One `--once` invocation handles at most one page of 20 children and at most `WORKER_FACTORY_CHILD_BLOCKS` heights per child (default 8, maximum 64, also bounded by `WORKER_MAX_BLOCKS_PER_RUN`); pass the returned `nextIndex` as `WORKER_FACTORY_FROM_INDEX` for the next one-shot page, or use `--watch`. Source/RPC gaps still use the existing canonical linkage checks.

For explicitly pinned testnet candidate experiments, the existing single-deployment runner accepts `WORKER_ADAPTER=testnet-static-v3`, testnet network/environment, mock FT/provider `.testnet` accounts, policy `showstake-native-usdc-event/1`, and matching code-hash/SHA pins. The deployment DB row, live identity and durable cursor checks remain required. This does not automatically discover testnet children. All new worker tests are local fixtures; final artifact hashes, database permissions and actual provider/RPC behavior require separate verification.

Factory cycles report per-child scan bounds and elapsed time. A failed child does not prevent other children on the same page from being visited; one-shot mode reports failure and watch mode retries on a later page cycle. Within a cycle, up to 64 normalized source blocks and already-final canonical headers are reused across children. Every cached canonical header came from the configured RPC at or below its previously observed finalized height and is still checked against the requested hash; predecessor linkage and transactional per-child cursors are unchanged. The configured RPC remains the canonical trust source.
