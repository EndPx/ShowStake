// migrations/runner.mjs — versioned, checksum-aware, atomic migration runner.
//
// The runner is the ONLY writer of schema on a disposable cluster:
//   1. runMigrations() — takes the single-writer advisory lock FIRST, then
//      bootstraps roles/schema-level grants (bootstrap is now UNDER the lock,
//      never before it), then applies each pending migration.
//   2. applyMigrations() — runs each pending migration as `showstake_migration`
//      inside its own transaction; records its file sha256. A failed migration
//      rolls back only itself (atomic) and aborts the run.
//   3. drift check — an already-applied migration whose on-disk sha256 changed
//      is a hard failure (never silently re-applied).
//   4. stale check — an applied migration whose file is no longer on disk is a
//      hard failure (a removed migration must be reconciled, never ignored).
//
// Re-running `up` is idempotent: applied migrations with a matching checksum are
// skipped. DDL objects are owned by `showstake_migration`, not API/worker roles.

import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const MIGRATION_ROLE = 'showstake_migration';
const LOCK_KEY = [871493, 684213]; // fixed namespace by convention

const FILE_RE = /^(\d{4})_[A-Za-z0-9_-]+\.sql$/;

/** sha256 hex of a Buffer/string. */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** Create a pg dependency lazily (keeps this module importable without pg). */
function pgModule() {
  // @ts-ignore — resolved from node_modules when the suite runs.
  // eslint-disable-next-line import/no-unresolved
  return import('pg').then((m) => m.default ?? m);
}

/** List migrations in `dir` sorted by numeric version. */
export async function listMigrations(dir) {
  const names = (await readdir(dir)).filter((f) => FILE_RE.test(f)).sort();
  return Promise.all(
    names.map(async (name) => {
      const path = join(dir, name);
      const buf = await readFile(path);
      return {
        version: Number(FILE_RE.exec(name)[1]),
        name,
        path,
        sql: buf.toString('utf8'),
        checksum: sha256(buf),
      };
    }),
  );
}

/**
 * Build a node-pg connection config. When `SHOWSTAKE_PG_SOCKET` is set the
 * client connects over the per-run Unix socket (stable, isolated, no TCP) — the
 * same socket the disposable cluster advertises under `-k`. Otherwise it falls
 * back to DATABASE_URL (used by direct CLI runs).
 *
 * @param {string} [database]
 * @param {string} [socket]
 */
export function connectConfig(database, socket) {
  const sock = socket ?? process.env.SHOWSTAKE_PG_SOCKET ?? null;
  if (sock) {
    return {
      user: process.env.SHOWSTAKE_PG_USER || 'showstake',
      host: sock, // a directory path => node-pg connects over the Unix socket
      port: Number(process.env.SHOWSTAKE_PG_PORT || 55439),
      database: database || process.env.SHOWSTAKE_PG_DB1 || 'postgres',
    };
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL (or SHOWSTAKE_PG_SOCKET) is required');
  }
  return { connectionString: process.env.DATABASE_URL };
}

/** Open a pg.Client (socket-first, DATABASE_URL fallback). */
export async function connect(database, socket) {
  const pg = await pgModule();
  const client = new pg.Client(connectConfig(database, socket));
  await client.connect();
  return client;
}

/** @param {import('pg').Client} client */
export async function acquireMigrationLock(client) {
  const res = await client.query(
    'SELECT pg_try_advisory_lock($1, $2) AS got',
    [LOCK_KEY[0], LOCK_KEY[1]],
  );
  if (!res.rows[0].got) {
    throw new Error(`another migration is already running (advisory lock ${LOCK_KEY[0]},${LOCK_KEY[1]} held)`);
  }
}

/** Best-effort session advisory-lock release (never throws). */
export async function releaseMigrationLock(client) {
  try {
    await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_KEY[0], LOCK_KEY[1]]);
  } catch { /* connection may be aborted; the session lock dies with it */ }
}

/**
 * Cluster/role provisioning (idempotent, superuser). MUST be called while holding
 * the single-writer advisory lock (see runMigrations). Roles are created here
 * (by the migration operator) rather than in a versioned migration because the
 * `public` schema is owned by pg_database_owner and only its owner may
 * grant/revoke USAGE/CREATE on it.
 *
 * @param {import('pg').Client} client
 */
export async function bootstrap(client) {
  const roles = [
    ['showstake_migration', 'CREATE ROLE showstake_migration NOLOGIN'],
    ['showstake_api', 'CREATE ROLE showstake_api NOLOGIN'],
    ['showstake_worker', 'CREATE ROLE showstake_worker NOLOGIN'],
  ];
  for (const [name, ddl] of roles) {
    const res = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
    if (res.rowCount === 0) {
      await client.query(ddl); // literal, non-user-supplied identifier
    }
  }

  await client.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
  await client.query('GRANT USAGE ON SCHEMA public TO showstake_migration, showstake_api, showstake_worker');
  await client.query('GRANT CREATE ON SCHEMA public TO showstake_migration');

  // Least-privilege: NOLOGIN roles have no temporary-table ability unless granted.
  // PUBLIC's default TEMP grant is removed on this database (the schema/roles
  // comments may claim "no TEMP", so the claim must be made true). The migration
  // operator's own session retains superuser, so no migration needs TEMP.
  const dbname = (await client.query('SELECT current_database() AS d')).rows[0].d;
  await client.query(`REVOKE TEMPORARY ON DATABASE ${JSON.stringify(dbname)} FROM PUBLIC`);
  await client.query(`REVOKE TEMPORARY ON DATABASE ${JSON.stringify(dbname)} FROM showstake_api, showstake_worker`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    integer PRIMARY KEY,
      name       text NOT NULL,
      checksum   text NOT NULL,           -- sha256 hex of the migration file bytes
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
  await client.query('ALTER TABLE schema_migrations OWNER TO showstake_migration');
  // Runtime roles may inspect the applied migration set (read-only).
  await client.query('GRANT SELECT ON TABLE schema_migrations TO showstake_api, showstake_worker');
}

/** @param {import('pg').Client} client @returns {Promise<Map<number,{name:string,checksum:string}>>} */
export async function loadApplied(client) {
  const res = await client.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
  const map = new Map();
  for (const row of res.rows) map.set(Number(row.version), { name: row.name, checksum: row.checksum });
  return map;
}

/**
 * Apply pending migrations. Throws on drift, on a stale (removed) migration, or
 * on any migration failure (after that single migration is rolled back).
 *
 * The single-writer advisory lock is acquired here by default and is ALWAYS
 * released in `finally` — including when `loadApplied` (or any earlier step)
 * throws, so a failed run cannot leave the lock held.
 *
 * @param {import('pg').Client} client
 * @param {Array<{version:number,name:string,sql:string,checksum:string}>} migrations
 * @param {{lock?: boolean}} [opts]
 * @returns {Promise<Array<{version:number,name:string}>>} the migrations actually applied now
 */
export async function applyMigrations(client, migrations, opts = {}) {
  const takeLock = opts.lock !== false;
  if (takeLock) await acquireMigrationLock(client);
  try {
    const existing = await loadApplied(client); // inside the guarded region (lock released on throw)
    const applied = [];

    // Stale migration refusal: anything applied whose file no longer exists on
    // disk is a hard failure (a removed migration must be reconciled).
    const staleVersions = [...existing.keys()].filter((v) => !migrations.some((m) => m.version === v)).sort();
    if (staleVersions.length) {
      throw new Error(`stale migration(s) present in DB but missing from disk: ${staleVersions.map((v) => existing.get(v).name).join(', ')}`);
    }

    for (const m of migrations) {
      const prev = existing.get(m.version);
      if (prev) {
        if (prev.checksum !== m.checksum) {
          throw new Error(
            `checksum drift at migration ${m.version} (${m.name}): recorded ${prev.checksum} != on-disk ${m.checksum}`,
          );
        }
        continue; // safe idempotent skip
      }

      await client.query(`SET ROLE ${MIGRATION_ROLE}`);
      let inTx = false;
      try {
        await client.query('BEGIN');
        inTx = true;
        await client.query(m.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [m.version, m.name, m.checksum],
        );
        await client.query('COMMIT');
        inTx = false;
      } catch (err) {
        if (inTx) {
          try { await client.query('ROLLBACK'); } catch { /* connection may be aborted */ }
        }
        throw err;
      } finally {
        try { await client.query('RESET ROLE'); } catch { /* ignore */ }
      }
      applied.push({ version: m.version, name: m.name });
    }
    return applied;
  } finally {
    if (takeLock) await releaseMigrationLock(client);
  }
}

/**
 * One-shot `up`: lock -> bootstrap -> apply, all under the same advisory lock so
 * concurrent invocations (including concurrent bootstraps) are serialized and the
 * loser fails fast without touching roles/schema.
 *
 * @param {import('pg').Client} client
 * @param {Array<{version:number,name:string,sql:string,checksum:string}>} migrations
 */
export async function runMigrations(client, migrations) {
  await acquireMigrationLock(client);
  try {
    await bootstrap(client);
    return await applyMigrations(client, migrations, { lock: false });
  } finally {
    await releaseMigrationLock(client);
  }
}

/** Full status report: applied / pending / drift / stale. */
export async function status(client, migrations) {
  const existing = await loadApplied(client);
  const report = { applied: [], pending: [], drift: [] };
  for (const m of migrations) {
    const prev = existing.get(m.version);
    if (prev) {
      if (prev.checksum !== m.checksum) report.drift.push({ version: m.version, name: m.name });
      else report.applied.push({ version: m.version, name: m.name });
    } else {
      report.pending.push({ version: m.version, name: m.name });
    }
  }
  const stale = [...existing.keys()].filter((v) => !migrations.some((m) => m.version === v));
  return { ...report, stale: stale.map((v) => ({ version: v, name: existing.get(v).name })) };
}