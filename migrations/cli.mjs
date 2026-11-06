// migrations/cli.mjs — thin CLI over runner.mjs.
//
// Usage:
//   node migrations/cli.mjs up         # single-writer locked bootstrap + apply (never runs bootstrap outside the lock)
//   node migrations/cli.mjs status     # READ-ONLY report of applied/pending/drift/stale (never mutates, never locks)
//   node migrations/cli.mjs verify     # up + report; non-zero exit on drift/stale
//
// Options: --dir <path> (default ./schema relative to this file), env DATABASE_URL
// (or SHOWSTAKE_PG_SOCKET/SHOWSTAKE_PG_PORT/SHOWSTAKE_PG_USER/SHOWSTAKE_PG_DB1 for a socket).
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, runMigrations, listMigrations, status } from './runner.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = args.find((a) => ['up', 'status', 'verify'].includes(a)) ?? 'status';
const dirFlag = args.indexOf('--dir');
const dir = dirFlag >= 0 ? resolve(args[dirFlag + 1]) : join(here, 'schema');
const urlFlag = args.indexOf('--url');
const databaseUrl = urlFlag >= 0 ? args[urlFlag + 1] : undefined;

/** Read-only migration report that also works against a never-migrated DB. */
async function readonlyStatus(client, migrations) {
  const reg = await client.query('SELECT to_regclass(\'public.schema_migrations\') AS t');
  if (!reg.rows[0].t) {
    return {
      command: cmd,
      applied: [],
      pending: migrations.map((m) => ({ version: m.version, name: m.name })),
      drift: [],
      stale: [],
    };
  }
  return { command: cmd, ...(await status(client, migrations)) };
}

async function main() {
  const migrations = await listMigrations(dir);
  if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
  const client = await connect(undefined, undefined);
  let exit = 0;
  try {
    let report;
    if (cmd === 'status') {
      report = await readonlyStatus(client, migrations); // no bootstrap, no writes, no locks
    } else {
      const applied = await runMigrations(client, migrations);
      if (applied.length) console.log(`applied: ${applied.map((m) => `${m.version}:${m.name}`).join(', ')}`);
      else console.log('no pending migrations');
      report = { command: cmd, ...(await status(client, migrations)) };
    }
    console.log(JSON.stringify(report, null, 2));
    if (report.drift.length || (report.stale && report.stale.length)) {
      console.error('FAIL: checksum drift or stale migration detected');
      exit = 1;
    }
  } catch (err) {
    console.error(`FAIL: ${err.message}`);
    exit = 1;
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
  return exit;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });