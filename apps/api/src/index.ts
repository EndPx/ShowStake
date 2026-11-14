import { loadConfig } from './config.js';
import { PgStore } from './store/pg-store.js';
import { PgFundingStore } from './store/funding-store.js';
import { buildApp } from './app.js';
import { buildAccessKeyVerifier } from './auth/rpc.js';
import { assertRestrictedDbRole, assertRuntimeLeastPrivilege, createScopedPool } from './db.js';

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is required to run the API server');
  }
  // The API must run least-privilege: every pooled connection assumes the
  // restricted NOLOGIN runtime role (never the superuser operator connection).
  const dbRole = assertRestrictedDbRole(config.dbRole);
  const pool = createScopedPool({ connectionString: config.databaseUrl }, dbRole);
  // Startup gate: prove the ACTUAL runtime connection is the restricted role and
  // cannot mutate projections/deployments, before a single request is served.
  await assertRuntimeLeastPrivilege(pool, dbRole);

  const store = new PgStore(pool);
  const app = buildApp({
    store,
    config,
    accessKeyVerifier: buildAccessKeyVerifier(config),
    fundingStore: new PgFundingStore(pool),
  });

  const close = async (): Promise<void> => {
    await app.close();
    await pool.end();
  };
  process.on('SIGINT', () => {
    void close().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void close().finally(() => process.exit(0));
  });

  await app.listen({ host: config.host, port: config.port });
  console.log(`[showstake-api] listening on ${config.host}:${config.port}`);
}

main().catch((e) => {
  console.error('[showstake-api] fatal start error:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
