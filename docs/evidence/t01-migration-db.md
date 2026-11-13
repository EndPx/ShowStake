# T01 migration/database evidence (D01–D06)

Classifier: **PASS_LOCAL** — worker-authored, Codex review pending.

Base commit: `784ccc92122da4d675541253d1a0e0c0c5f476c5` · run id: `run-20261113T015308Z-12991` · mode: `full`

## Environment

- OS: Windows + WSL2 (Linux Node over per-run Unix socket)
- WSL distro: Ubuntu 26.04.1 LTS (WSL2)
- Node: v24.18.0
- PostgreSQL: disposable (official postgresql-18 apt extracted to owned temp dir)
- listener: per-run Unix socket (loopback TCP disabled for the client)
- port: `42563`

## Totals

- 57 checks, 0 failed

## Commands run

- `wsl -d Ubuntu -- bash scripts/postgres-disposable/run-suite.sh`
- `node migrations/tests/run-t01.mjs d01|d02|d03|d04-fixtures|d04-verify|d05|d06|finalize (Linux Node, Unix socket)`
- `node migrations/cli.mjs status  (READ-ONLY, advisory-lock migration runner)`
- `node packages/domain/verify.mjs  (D05-static money strings/states/envelopes)`
- `node migrations/verify-baseline.mjs (baseline provenance, no edit)`
- `node scripts/verify-t01-aggregate.mjs (fail-closed aggregate regressions)`
- `node scripts/verify-openapi.mjs (pinned OpenAPI validation)`
- `pg_dump -Fc showstake_disposable | pg_restore --no-owner --no-privileges showstake_restore`

## Phase results

### d01 — D01 apply + checksum + idempotency + drift + atomic rollback + stale + TEMP

10/10 passed (PASS)

- OK **D01_APPLY_AND_REAPPLY** — expected 7 migrations applied, then 0 on re-run; observed `applied=1,2,3,4,5,6,7 re-run=0`
- OK **D01_NO_DRIFT_OR_PENDING** — expected no drift, no pending, no stale; observed `drift=0 pending=0 stale=0`
- OK **D01_TABLES** — expected 23 tables present; observed `all present`
- OK **D01_REAL_POSTGRESQL** — expected real PostgreSQL server reports version; observed `PostgreSQL 18.6 (Ubuntu 18.6-1.pgdg24.04+2) on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0, 64-bit`
- OK **D01_LOOPBACK_OR_SOCKET_ONLY** — expected listener is loopback or Unix-socket only (never all-interfaces); observed `listen_addresses="127.0.0.1"`
- OK **D01_API_NO_TEMP** — expected API role denied TEMP table creation; observed `denied=42501`
- OK **D01_ATOMIC_ROLLBACK** — expected failed migration rolled back fully (no table, no tracking row); observed `threw=true table-absent=true no-row=true`
- OK **D01_DRIFT** — expected checksum drift fails closed; observed `drift-threw=true`
- OK **D01_STALE_REFUSAL** — expected stale (removed) migration refused; observed `stale-threw=true`
- OK **D01_LOCK_RELEASED_ON_ERROR** — expected migration lock released after a failed apply; observed `released=true`

### d02 — D02 FK/unique/identity/idempotency/rules

15/15 passed (PASS)

- OK **D02_FK_EVENT** — expected foreign key violation 23503; observed `code=23503`
- OK **D02_ONE_ACTIVE_REGISTRATION** — expected partial unique active-registration index 23505; observed `code=23505`
- OK **D02_WITHDRAWN_EXCLUDED** — expected WITHDRAWN excluded from active-registration uniqueness (insert ok); observed `inserted`
- OK **D02_IDENTITY_CONFLICT** — expected duplicate provider+subject 23505; observed `code=23505`
- OK **D02_WALLET_BINDING_CONFLICT** — expected duplicate namespace+network+account 23505; observed `code=23505`
- OK **D02_IDEMPOTENCY_KEY** — expected duplicate (scope,key) 23505; observed `code=23505`
- OK **D02_PARTICIPANT_EQ_BENEFICIARY** — expected participant!=beneficiary CHECK 23514; observed `code=23514`
- OK **D02_REALIZED_YIELD_CONSERVATION** — expected 10 principal + 2 realized yield supports 12 paid; observed `2`
- OK **D02_UNALLOCATED_YIELD_NOT_A_CLAIM** — expected realized funds may remain outside participant allocations; observed `2`
- OK **D02_REALIZED_YIELD_MISMATCH** — expected yield conservation mismatch rejected; observed `code=23514`
- OK **D02_ALLOCATED_YIELD_BOUNDED** — expected allocated yield cannot exceed realized yield; observed `code=23514`
- OK **D02_PRINCIPAL_PLUS_YIELD_U128** — expected combined principal and yield must fit u128; observed `code=23514`
- OK **D02_CAPACITY_RANGE** — expected capacity 0 CHECK 23514; observed `code=23514`
- OK **D02_ENVIRONMENT_ENUM** — expected environment 'prod' CHECK 23514; observed `code=23514`
- OK **D02_SESSION_EXPIRY_RULE** — expected idle > absolute CHECK 23514; observed `code=23514`

### d03 — D03 SET ROLE least-privilege

9/9 passed (PASS)

- OK **D03_API_NO_PROJECTION_UPDATE** — expected API update projection denied 42501; observed `code=42501`
- OK **D03_API_NO_PROJECTION_INSERT** — expected API insert projection denied 42501; observed `code=42501`
- OK **D03_API_CAN_READ_PROJECTION** — expected API SELECT projection ok; observed `rows=1`
- OK **D03_API_CAN_INSERT_SESSION** — expected API INSERT session allowed; observed `inserted`
- OK **D03_WORKER_NO_SESSION** — expected worker INSERT session denied 42501; observed `code=42501`
- OK **D03_WORKER_NO_IDENTITY** — expected worker INSERT identity denied 42501; observed `code=42501`
- OK **D03_WORKER_NO_TEMP** — expected worker denied TEMP table; observed `denied=42501`
- OK **D03_WORKER_CAN_WRITE_PROJECTION** — expected worker INSERT projection allowed; observed `inserted evt-worker-1`
- OK **D03_WORKER_CAN_OBSERVE_FUNDING** — expected worker UPDATE funding observation allowed; observed `state->SOURCE_PENDING`

### d04-fixtures — D04 immutable labeled replay ledger loaded

1/1 passed (PASS)

- OK **D04_FIXTURES_LOADED** — expected replay chain_events ledger stored (EventCreated + 4 registrations + 1 withdrawal); observed `loaded`

### d04-verify — D04 dump/restore roundtrip + independent chain_events replay

12/12 passed (PASS)

- OK **D04_DUMP_RESTORE_EXITS** — expected pg_dump and pg_restore both exit 0; observed `{"pg_dump":0,"pg_restore":0}`
- OK **D04_ROUNDTRIP_EQUAL** — expected all 23 tables byte-equal after pg_dump/pg_restore; observed `identical`
- OK **D04_REPLAY_RECONSTRUCT_DB1** — expected replay rebuilds projection from chain_events == independent fixture (accepted incl. withdrawn; pending=0; liability=accepted) in DB1; observed `accepted=20000000 active=15000000 wdCredit=5000000 paid=0 pending=0 liability=20000000`
- OK **D04_REPLAY_RECONSTRUCT_DB2** — expected replay rebuilds projection from chain_events == independent fixture in DB2; observed `accepted=20000000 active=15000000 wdCredit=5000000 liability=20000000`
- OK **D04_REPLAY_EQUIVALENT** — expected DB1 and DB2 replay agree and both match the fixture; observed `agreed`
- OK **D04_CHAINEVENTS_TOTAL** — expected accepted total is derived from chain_events (not summed from the projection) and equals the rebuilt projection; observed `chain_events=20000000 projection=20000000`
- OK **D04_CONSERVATION** — expected conservation holds: accepted = active + withdrawnCredit AND accepted = paid + pending + liability; observed `active+wdCredit=20000000 paid+pending+liability=20000000`
- OK **D04_WITHDRAWN_REFUND_CLAIM** — expected withdrawn row retains a claimable refund credit (claim_atomic=D, payout_state=CLAIMABLE); observed `state=WITHDRAWN claim=5000000 payout=CLAIMABLE`
- OK **D04_WITHDRAWN_HISTORIC_OWNER** — expected withdrawn row retains historic owner (participant/beneficiary unchanged); observed `participant=replay.dan beneficiary=replay.dan`
- OK **D04_REPLAY_IDEMPOTENT** — expected re-replay is idempotent (dedup by receipt/registration; canonical totals unchanged); observed `again accepted=20000000 active=15000000 wdCredit=5000000 liability=20000000`
- OK **D04_DUPLICATE_RECEIPT_REJECTED** — expected immutable ledger rejects a duplicate receipt (23505); observed `code=23505`
- OK **D04_DURABLE_CURSOR** — expected worker_cursors advanced for the replay consumer in the same transaction; observed `cursor={"event_id":"00000000-0000-4000-8000-000000000012","block_height":"105","receipts_applied":6}`

### d05 — D05 atomic_amount numeric boundary + canonical string round-trip

5/5 passed (PASS)

- OK **D05_NEGATIVE** — expected atomic_amount(-1) -> 23514; observed `code=23514`
- OK **D05_FRACTION** — expected atomic_amount(1.5) -> 23514; observed `code=23514`
- OK **D05_OVERFLOW** — expected atomic_amount(340282366920938463463374607431768211456) -> 23514; observed `code=23514`
- OK **D05_U128_MAX_OK** — expected 2^128-1 accepted exactly; observed `340282366920938463463374607431768211455`
- OK **D05_DB_STRING_ROUNDTRIP** — expected DB atomic_amount domain round-trips as exact string via ::text; observed `d=5000000 type=atomic_amount`

### d06 — D06 two-connection cursor/projection tx, rollback recovery, migration lock

5/5 passed (PASS)

- OK **D06_JOB_LEASE_ONE_WINNER** — expected exactly one connection claims the job lease; observed `winner=1 loser=0`
- OK **D06_NONCE_ONE_CONSUMER** — expected one nonce consumer wins, the other gets 0 rows; observed `rows=[1,0]`
- OK **D06_CURSOR_PROJECTION_OVERLAP** — expected one connection locks the cursor (FOR UPDATE NOWAIT); the other is refused 55P03; observed `lockA=1 lockB=55P03`
- OK **D06_ROLLBACK_RECOVERY** — expected rolled-back projection+cursor transaction leaves no partial state; observed `proj=0 cursor_h=0`
- OK **D06_MIGRATION_LOCK_CONCURRENT** — expected concurrent migration runs serialize: loser fails fast, bootstrap is under the lock; observed `rejected=true noBootstrap=true winnerApplied=true`

## Limits / notes

LABELED design-sample fixtures only; no chain/live data, no secrets. D04 replay rebuilds projections from immutable labeled chain_events with the Product01 invariant accepted=paid+pending+liability (withdrawn credit included). DB1==DB2 roundtrip and replay are local sandbox equivalence, never chained evidence. Full acceptance aggregates static/readiness/cli/dump/stop/cleanup plus every phase from the same run; a no-dump "all" run is NOT_RUN (partial), never PASS_LOCAL. Worker-authored; Codex review pending.
