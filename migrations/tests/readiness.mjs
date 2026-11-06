// migrations/tests/readiness.mjs — prove the ACTUAL node-pg client connects to
// the disposable cluster BEFORE any test phase starts, with a bounded deadline
// and a precise final error. Never a fixed sleep; it loops on real connect
// attempts so a slow postmaster cannot produce an ECONNREFUSED phase later.
//
// Usage: node migrations/tests/readiness.mjs [--deadline-ms N] [--interval-ms N]
// Env: SHOWSTAKE_PG_SOCKET / SHOWSTAKE_PG_PORT / SHOWSTAKE_PG_USER / SHOWSTAKE_PG_DB1
import { connect } from './lib.mjs';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};
const deadlineMs = flag('--deadline-ms', 30000);
const intervalMs = flag('--interval-ms', 500);

const deadline = Date.now() + deadlineMs;
let lastErr = null;
let attempts = 0;

while (Date.now() < deadline) {
  attempts++;
  const client = await connect(process.env.SHOWSTAKE_PG_DB1).catch((e) => { lastErr = e; return null; });
  if (client) {
    try {
      const r = await client.query('SELECT 1 AS ok');
      if (r.rows[0].ok === 1) {
        console.log(`READY: node-pg connected via Unix socket after ${attempts} attempt(s) (SELECT 1 ok)`);
        await client.end().catch(() => {});
        process.exit(0);
      }
    } catch (e) {
      lastErr = e;
    }
    await client.end().catch(() => {});
  }
  await new Promise((res) => setTimeout(res, intervalMs));
}

console.error(`NOT READY after ${deadlineMs}ms / ${attempts} attempts`);
console.error(`final error: ${lastErr ? `${lastErr.code || ''} ${lastErr.message}`.trim() : 'no connection established (unknown cause)'}`);
process.exit(1);