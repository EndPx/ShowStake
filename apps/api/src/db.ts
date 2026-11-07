// Least-privilege PostgreSQL runtime pool for the API.
//
// The HTTP API must NEVER run as the migration operator / superuser. It connects
// as a dedicated unprivileged LOGIN and immediately `SET ROLE` to the NOLOGIN API
// role on every pooled connection (node-pg's `onConnect` hook is awaited BEFORE
// a client is handed out, so there is no race where a query runs pre-SET-ROLE).
//
// `assertRuntimeLeastPrivilege` is a startup gate that uses the ACTUAL runtime
// connection to prove (a) the session's `current_user` is the restricted role and
// (b) a projection write is denied with 42501 — not an isolated `SET ROLE`
// snippet, but the same pool the app serves traffic from.
import { Pool, type PoolConfig } from 'pg';

/** The only runtime role the API may assume (created NOLOGIN by the migration bootstrap). */
export const API_DB_ROLE = 'showstake_api';

/** Tables the API may READ but must NEVER mutate (projections + deployments). */
const READ_ONLY_TABLES = [
  'events_projection',
  'registrations_projection',
  'passes_projection',
  'payouts_projection',
  'deployments',
] as const;

/**
 * Validate the configured DB role. Accept only the known restricted NOLOGIN role
 * (fail-closed: a typo, `null`, or an attempt to run as superuser aborts startup).
 */
export function assertRestrictedDbRole(role: string | null): string {
  if (role !== API_DB_ROLE) {
    throw new Error(
      `DB_ROLE must be '${API_DB_ROLE}' (the least-privilege NOLOGIN API runtime role); got ${JSON.stringify(role ?? null)}. Refusing to start on a superuser connection.`,
    );
  }
  return role;
}

/**
 * Build a pool whose every connection runs `SET ROLE <role>` before it is
 * released to the caller. `onConnect` is awaited by pg-pool before acquisition.
 */
export function createScopedPool(config: PoolConfig, role: string): Pool {
  assertRestrictedDbRole(role);
  return new Pool({
    ...config,
    onConnect: async (client) => {
      // Resolve tables using the API role's schema USAGE, while checking the
      // original session_user separately. NOINHERIT service logins have no USAGE.
      await client.query(`SET ROLE ${JSON.stringify(role)}`);
      const identity = await client.query<{ unsafe: boolean }>(`
        SELECT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
          OR pg_has_role(session_user, 'showstake_worker', 'MEMBER')
          OR has_table_privilege(session_user, 'events_projection', 'INSERT,UPDATE,DELETE')
          OR has_table_privilege(session_user, 'deployments', 'INSERT,UPDATE,DELETE')) AS unsafe
        FROM pg_roles r WHERE r.rolname = session_user`);
      if (!identity.rows[0] || identity.rows[0].unsafe) {
        throw new Error('API requires a dedicated unprivileged LOGIN; operator/superuser credentials are forbidden');
      }
    },
  });
}

/**
 * Startup gate: prove the runtime pool actually operates as the restricted role.
 * Throws (aborting startup) when it cannot, or when the runtime role can mutate a
 * projection/deployments table. Uses `DELETE ... WHERE false` (column-agnostic) so
 * no row is ever removed; PostgreSQL still requires the DELETE privilege at parse
 * time, so a granted write returns rowCount 0 and a missing grant raises 42501.
 */
export async function assertRuntimeLeastPrivilege(pool: Pool, role: string): Promise<void> {
  const client = await pool.connect();
  try {
    const cur = await client.query<{ current_user: string }>('SELECT current_user');
    const actual = cur.rows[0]?.current_user;
    if (actual !== role) {
      throw new Error(`least-privilege check failed: current_user is '${actual}', expected '${role}'`);
    }

    for (const table of READ_ONLY_TABLES) {
      let denied = false;
      try {
        await client.query(`DELETE FROM ${table} WHERE false`);
      } catch (e) {
        if ((e as { code?: string }).code === '42501') denied = true;
        else throw e;
      }
      if (!denied) {
        throw new Error(`least-privilege check failed: runtime role '${role}' can mutate '${table}'`);
      }
    }
  } finally {
    client.release();
  }
}
