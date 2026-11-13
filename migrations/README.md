# migrations — ShowStake T01 database home

Versioned, checksum-aware, atomic PostgreSQL migrations plus the real disposable
PostgreSQL acceptance suite (D01–D06). This is the single home for database
schema/role/interface work (the packet allows `db/` **or** `migrations/`; we
choose `migrations/`).

Current physical model: [backend ERD](../docs/backend-erd.md). Migration `0008`
adds composite foreign keys for wallet ownership, canonical event assets,
funding/registration scope, pass event/deployment/owner, payout beneficiary and
QR/check-in registration identity. It backfills `passes_projection.event_id`;
inconsistent existing rows abort the transaction rather than being deleted.
The worker version that writes the new column must accompany the migration.
Historical migrations `0001`–`0007` remain unchanged.

## Layout

- `schema/0001_initial.sql` — initial schema, DDL body **verbatim** from
  `docs/planning/showstake-v2/schema.sql` (baseline is never edited; see
  `verify-baseline.mjs`). Run as `showstake_migration`; the runner adds the
  transaction (the baseline's own `BEGIN;`/`COMMIT;` are not duplicated).
- `schema/0002_roles_grants.sql` — least-privilege table grants for
  `showstake_api` / `showstake_worker`.
- `runner.mjs` — migration engine: **bootstrap runs UNDER the advisory lock**,
  checksum-drift and **stale-migration** refusal, atomic rollback, idempotent
  re-run, TEMP revoked so the "no TEMP" claim is true, and `loadApplied` errors
  still release the lock (try/finally covers every step).
- `cli.mjs` — `up` (locked bootstrap + apply via `runMigrations`) / `status`
  (read-only) / `verify`.
- `verify-baseline.mjs` — proves 0001's DDL body is byte-identical to baseline.
- `tests/run-t01.mjs` — D01–D06 phases + `finalize`. D04 now **rebuilds
  projections from the immutable labeled `chain_events` ledger** (see
  `tests/replay.mjs`). D06 now runs overlapping two-connection cursor+projection
  transactions with rollback recovery and a real advisory-lock concurrency test.
- `tests/aggregate.mjs` — fail-closed phase aggregation; a missing/stale/
  failed/invalid phase (or a dump failure, or an orchestrator error) always yields
  a non-zero classifier, even if old green files exist in another directory.
- `tests/readiness.mjs` — the actual node-pg client proves connectivity (bounded
  retry) before any phase starts.

## Roles (cluster-level, provisioned by `bootstrap`, under the lock)

| Role | Login | Purpose |
|---|---|---|
| `showstake_migration` | NOLOGIN | owns all schema objects; only DDL/grants (runner applies as this role) |
| `showstake_api` | NOLOGIN | DML on app tables; **read-only** on projections; **no TEMP** |
| `showstake_worker` | NOLOGIN | writes chain/projection/cursor tables; **cannot** insert sessions/identities; **no TEMP** |

The disposable cluster superuser is `showstake`.

## Commands (exact; observed on this checkout)

Requires Node v24.18.0 + pnpm 10.21.0 + WSL2 Ubuntu (disposable official
postgresql-18 and a pinned Linux Node both extracted into an owned temp dir; no
existing database is touched). Prerequisite: `pnpm install --frozen-lockfile`.

```sh
# static (no DB): money-string/states/envelope self-check
pnpm verify:domain
# static (no DB): prove migration 0001 == preserved baseline
pnpm verify:baseline
# static (no DB): fail-closed phase-aggregation regressions
pnpm verify:t01-aggregate
# static (no DB): pinned OpenAPI validation + route inventory
pnpm verify:openapi
# all static checks
pnpm verify:t01-static

# real disposable-DB PK/FK, multi-event and 0007 -> 0008 upgrade checks
pnpm verify:relations

# full real-DB suite (D01-D06 + pg_dump/pg_restore + evidence, exit 0)
pnpm verify:t01
# or directly:
wsl -d Ubuntu -- bash scripts/postgres-disposable/run-suite.sh

# single migration runner (socket first via SHOWSTAKE_PG_SOCKET, or --url):
node migrations/cli.mjs up --url postgres://showstake@127.0.0.1:55439/showstake_disposable
node migrations/cli.mjs status --url postgres://showstake@127.0.0.1:55439/showstake_disposable
```

Evidence is written to `docs/evidence/t01-migration-db.{json,md}`; each run's raw
phase logs/artifacts live under a **unique** `migrations/artifacts/<runId>/`
directory and failed runs are preserved (never overwritten by a later run).

## Safety

- Disposable cluster binds `listen_addresses='127.0.0.1'` on a **dynamically
  chosen** loopback port plus a per-run Unix socket; the test client connects
  only over the Unix socket (no Windows->WSL TCP loopback). pg_hba allows only the
  local socket + loopback.
- Cleanup deletes the exact per-run temp dir **only** after `pg_ctl` proves the
  server stopped and the path passes the ownership guard (reused from
  `scripts/postgres-disposable/setup.sh`, whose `selftest` still passes).
- `migrations/cli.mjs status` is read-only: it does not bootstrap, mutate, or take
  the advisory lock.
- Money is authored as canonical u128 strings (domain `atomic_amount`); JSON
  boundary accepts strings only (see `packages/domain`).
