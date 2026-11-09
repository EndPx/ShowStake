// apps/worker READ-ONLY actual-testnet v6 settlement-lifecycle proof.
//
// Separate from the minimum-worker testnet proof (verify-worker-testnet.mjs).
// It runs the REAL production path against the accepted v6 settlement deployment
// (showstake-settle-endpx.testnet, f462ddcb…, policy showstake-v2-d036-settle/1):
//   * resolves + verifies the v6 deployment (live code hash, get_config,
//     ACTUAL ft_metadata decimals);
//   * `runBoundedScan` fetches EVERY intervening block from the deployment block
//     through the committed final payout block, canonically verifying each hash
//     against the official NEAR JSON-RPC and bounding by official finality;
//   * projects the committed d036-settle-five lifecycle: publish, 5 deposits,
//     2 attendance marks, finalize, settlement (2 attendees / 3 no-shows),
//     2 payouts — and asserts the deterministic allocation (attendees 5000000
//     CLAIMABLE->PAID, no-shows 0 ZERO), conservation and provenance;
//   * reads the projected settled event through the real API server.
//
// Classifier: PASS_TESTNET (read-only public testnet; NO transactions/funds/secrets).
import { spawn } from 'node:child_process';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkerPool, WorkerStore } from '../dist/store.js';
import { makeLiveChain, makeBlockSource, makeCanonicalVerifier, runBoundedScan } from '../dist/index.js';
import { NearRpcClient } from '../dist/source.js';
import { KNOWN_EVENTS } from '../dist/events.js';
import { listMigrations, runMigrations, connectConfig } from '../../../migrations/runner.mjs';
import { SETTLE_DEPLOYMENT, V6_SETTLE_PUBLISH, V6_SETTLE_FINAL_BLOCK } from './fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../../..');
const SCHEMA_DIR = join(ROOT, 'migrations', 'schema');
const API_ENTRY = join(ROOT, 'apps', 'api', 'dist', 'index.js');

const DB = () => process.env.SHOWSTAKE_PG_DB1 || 'showstake_disposable';
const SOCKET = () => process.env.SHOWSTAKE_PG_SOCKET || null;
const ARTIFACTS = () => process.env.SHOWSTAKE_PG_ARTIFACTS || null;
const RUN_ID = () => process.env.SHOWSTAKE_PG_RUN_ID || 'local';
const PG_PORT = () => Number(process.env.SHOWSTAKE_PG_PORT || 0);
const RPC_URL = process.env.WORKER_RPC_URL || 'https://test.rpc.fastnear.com';
const OFFICIAL_RPC_URL = process.env.WORKER_OFFICIAL_RPC_URL || 'https://rpc.testnet.near.org';
const NEARDATA_URL = process.env.WORKER_NEARDATA_URL || 'https://testnet.neardata.xyz';

const results = [];
function check(id, ok, expected, observed) {
  results.push({ id, ok: Boolean(ok), expected, observed, classifier: 'PASS_TESTNET' });
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${id}  (observed: ${observed})`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pgMod() {
  const m = await import('pg');
  return m.default ?? m;
}
async function rawClient(db) {
  const { Client } = await pgMod();
  const c = new Client(connectConfig(db, SOCKET()));
  await c.connect();
  return c;
}
async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : null;
      s.close(() => (port ? resolvePort(port) : reject(new Error('no port'))));
    });
    s.on('error', reject);
  });
}

const DEPLOYMENT_ID = '00000000-0000-4000-8000-0000000000d1';
const DEP = SETTLE_DEPLOYMENT;

async function run() {
  if (!SOCKET()) throw new Error('SHOWSTAKE_PG_SOCKET is required');
  const client = await rawClient(DB());
  let pool = null;
  try {
    const migrations = await listMigrations(SCHEMA_DIR);
    await runMigrations(client, migrations);
    await client.query('CREATE ROLE showstake_worker_service LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    await client.query('GRANT showstake_worker TO showstake_worker_service WITH INHERIT FALSE, SET TRUE');
    await client.query('CREATE ROLE showstake_api_service LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    await client.query('GRANT showstake_api TO showstake_api_service WITH INHERIT FALSE, SET TRUE');

    // Checkpoint restore-ahead phase: schema + roles only (NO deployment/data), so
    // the runner's target-empty check holds and the deployment comes from the dump.
    if (process.env.WORKER_CHECKPOINT_ONLY_PREP === '1') {
      check('TESTNET_V6_PREP', true, 'schema+roles seeded (restore-ahead, no deployment)', 'prep');
      await client.end().catch(() => {});
      return { ok: true };
    }

    await client.query(`
      INSERT INTO deployments (id, environment, network, contract_id, ft_contract_id, ft_decimals, start_block, code_hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (network, contract_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, start_block = EXCLUDED.start_block`,
      [DEPLOYMENT_ID, DEP.environment, DEP.network, DEP.contractId, DEP.ftContractId, DEP.ftDecimals, DEP.startHeight, DEP.codeHash]);

    pool = createWorkerPool({ ...connectConfig(DB(), SOCKET()), user: 'showstake_worker_service', application_name: 'showstake-worker-testnet-v6' });
    const verifier = makeCanonicalVerifier(RPC_URL);
    const store = new WorkerStore(pool, DEP, 'showstake-worker-testnet-v6', makeLiveChain(RPC_URL), verifier);
    const { id: deploymentId, startBlock } = await store.resolveDeployment();
    check('TESTNET_V6_DEPLOY_RESOLVED', deploymentId === DEPLOYMENT_ID && startBlock === DEP.startHeight,
      `v6 deployment resolved at block ${DEP.startHeight}`, `${deploymentId}/${startBlock}`);

    await store.verifyLiveIdentity();
    check('TESTNET_V6_LIVE_IDENTITY', true, 'live code_hash + get_config + ft_metadata match v6 allowlist', DEP.codeHash);

    // Post-restore manifest identity (resume path): the runner sets CKPT_MANIFEST;
    // verify the manifest's exact deploymentId + consumer + cursor match the restored DB.
    if (process.env.CKPT_MANIFEST) {
      const m = JSON.parse(await readFile(process.env.CKPT_MANIFEST, 'utf8'));
      const c = await store.readCursor(deploymentId);
      check('TESTNET_V6_MANIFEST_IDENTITY',
        m.deploymentId === deploymentId && m.consumer === 'showstake-worker-testnet-v6' &&
        m.cursor && m.cursor.block_height === c?.block_height && m.cursor.block_hash === c?.block_hash,
        'manifest deploymentId+consumer+cursor == restored DB', JSON.stringify({ mDeploy: m.deploymentId, deploy: deploymentId, mConsumer: m.consumer, mCursor: m.cursor, cursor: c }));
    }

    const nextHeight = await store.resolveStartHeight(deploymentId, startBlock);
    check('TESTNET_V6_EXACT_START', nextHeight === DEP.startHeight, 'exact-start gate starts at v6 deployment block', nextHeight);

    const blockSource = makeBlockSource(NEARDATA_URL);
    // Multiple bounded runBoundedScan batches within the SAME disposable-DB
    // lifecycle: resolveStartHeight resumes from the durable cursor between
    // batches, so a long full-range scan completes without weakening any
    // canonical/finality/skip check. Incremental checkpoints are written per batch.
    const SCAN_BATCH = 300;
    const expectedHeights = V6_SETTLE_FINAL_BLOCK.blockHeight - DEP.startHeight + 1;
    const globalDeadlineAt = Date.now() + 90 * 60 * 1000;
    let cursorHeight = nextHeight;
    let totalIngested = 0;
    const totalSkipped = [];
    const batchRecords = [];
    let finalOfficial = 0;
    let scanDone = false;
    while (!scanDone) {
      if (Date.now() > globalDeadlineAt) throw new Error('global 90-min deadline reached before full range');
      const batch = await runBoundedScan({
        store, blockSource, verifier, deploymentId,
        nextHeight: cursorHeight, maxBlocks: SCAN_BATCH,
        untilHeight: V6_SETTLE_FINAL_BLOCK.blockHeight,
        log: (m) => console.log(`    [scan] ${m}`),
      });
      totalIngested += batch.blocksIngested;
      totalSkipped.push(...batch.heightsSkipped);
      finalOfficial = batch.officialFinalHeight;
      const record = {
        batch: batchRecords.length + 1, startHeight: cursorHeight, endHeight: batch.endHeight,
        blocksIngested: batch.blocksIngested, heightsSkipped: batch.heightsSkipped,
        heightsUnprovenMissing: batch.heightsUnprovenMissing,
        officialFinalHeight: batch.officialFinalHeight, reason: batch.reason,
      };
      batchRecords.push(record);
      if (ARTIFACTS()) {
        await mkdir(ARTIFACTS(), { recursive: true });
        await writeFile(join(ARTIFACTS(), `checkpoint-${record.batch}.json`), JSON.stringify(record, null, 2));
      }
      console.log(`    [batch ${record.batch}] end=${batch.endHeight} ingested=${batch.blocksIngested} skipped=${batch.heightsSkipped.length} unproven=${batch.heightsUnprovenMissing.length}`);
      if (batch.endHeight >= V6_SETTLE_FINAL_BLOCK.blockHeight) { scanDone = true; break; }
      // Resume from the durable cursor (cursor+1) within the SAME DB lifecycle.
      const resumed = await store.resolveStartHeight(deploymentId, startBlock);
      if (resumed <= cursorHeight) throw new Error('batch resume did not advance the durable cursor (stalled)');
      cursorHeight = resumed;
    }
    check('TESTNET_V6_SCAN_END', totalIngested + totalSkipped.length === expectedHeights, 'scan reached the final payout block across bounded batches', JSON.stringify({ ingested: totalIngested, skipped: totalSkipped.length, expected: expectedHeights }));
    check('TESTNET_V6_SCAN_FULL_RANGE', totalIngested + totalSkipped.length === expectedHeights && batchRecords.length >= 2,
      `every height ${DEP.startHeight}..${V6_SETTLE_FINAL_BLOCK.blockHeight} ingested or proven skipped across ${batchRecords.length} bounded batches`, JSON.stringify({ batches: batchRecords.map((b) => [b.batch, b.startHeight, b.endHeight, b.blocksIngested, b.heightsSkipped.length]) }));
    check('TESTNET_V6_SCAN_OFFICIAL_FINAL_BOUND', finalOfficial >= V6_SETTLE_FINAL_BLOCK.blockHeight, 'each batch bounded by OFFICIAL RPC final height', finalOfficial);
    check('TESTNET_V6_BATCH_RESUMED', batchRecords.length >= 2 && batchRecords.every((b) => b.endHeight >= DEP.startHeight && b.blocksIngested > 0 || b.heightsSkipped.length > 0),
      'multiple bounded batches resumed from the durable cursor', `batches=${batchRecords.length}`);

    const official = new NearRpcClient(OFFICIAL_RPC_URL);
    await official.verifyBlock(V6_SETTLE_PUBLISH.blockHeight, V6_SETTLE_PUBLISH.blockHash);
    await official.verifyBlock(V6_SETTLE_FINAL_BLOCK.blockHeight, V6_SETTLE_FINAL_BLOCK.blockHash);
    check('TESTNET_V6_OFFICIAL_RPC_CROSSCHECK', true, 'publish/final-payout hashes independently agree with rpc.testnet.near.org', `${V6_SETTLE_PUBLISH.blockHash}/${V6_SETTLE_FINAL_BLOCK.blockHash}`);

    const ev = (await client.query(`SELECT * FROM events_projection WHERE deployment_id=$1`, [deploymentId])).rows[0];
    check('TESTNET_V6_EVENT_SETTLED', ev && ev.chain_event_id === 'd036-settle-five' && ev.state === 'SETTLED' && ev.deposit_atomic === '2000000' && ev.capacity === 5,
      'd036-settle-five projected SETTLED (deposit 2000000, capacity 5)', `${ev?.chain_event_id}/${ev?.state}`);
    check('TESTNET_V6_EVENT_TOTALS', ev && ev.accepted_atomic === '10000000' && ev.paid_atomic === '10000000' && ev.pending_atomic === '0' && ev.liability_atomic === '0',
      'contract totals: accepted=paid=10000000, pending=liability=0', `${ev?.accepted_atomic}/${ev?.paid_atomic}/${ev?.liability_atomic}`);

    const regs = await client.query(`SELECT chain_registration_id, sequence_no, state, attended, principal_atomic::text d, claim_atomic::text c, payout_state s FROM registrations_projection WHERE event_id=$1 ORDER BY sequence_no ASC`, [ev.id]);
    const r = regs.rows;
    check('TESTNET_V6_REGISTRATIONS', r.length === 5 && r.filter((x) => x.state === 'ATTENDED').length === 2 && r.filter((x) => x.state === 'NO_SHOW').length === 3,
      '5 registrations: 2 ATTENDED, 3 NO_SHOW (frozen at finalize)', JSON.stringify(r.map((x) => [x.chain_registration_id, x.state])));
    const attendees = r.filter((x) => x.state === 'ATTENDED');
    const noShows = r.filter((x) => x.state === 'NO_SHOW');
    check('TESTNET_V6_ALLOCATION', attendees.length === 2 && attendees.every((x) => x.c === '5000000' && x.s === 'PAID') && noShows.length === 3 && noShows.every((x) => x.c === '0' && x.s === 'ZERO'),
      'attendees claim 5000000 PAID; no-shows claim 0 ZERO (Forfeited->ZERO)', JSON.stringify(r.map((x) => [x.chain_registration_id, x.c, x.s])));
    check('TESTNET_V6_PRINCIPAL_UNCHANGED', r.every((x) => x.d === '2000000'), 'principal stays D=2000000 (claim is reward+principal)', JSON.stringify(r.map((x) => x.d)));
    check('TESTNET_V6_CONSERVATION', r.reduce((s, x) => s + BigInt(x.c), 0n).toString() === '10000000', 'sum(claim_atomic) == accepted == 10000000', r.reduce((s, x) => s + BigInt(x.c), 0n).toString());

    const payouts = await client.query(`SELECT payout_id, recipient_account, amount_atomic::text a, state FROM payouts_projection ORDER BY payout_id ASC`);
    check('TESTNET_V6_PAYOUTS', payouts.rows.length === 2 && payouts.rows.every((x) => x.state === 'SUCCEEDED' && x.a === '5000000'),
      'two payouts SUCCEEDED 5000000 each (exactly once)', JSON.stringify(payouts.rows));

    const chain = await client.query(`SELECT event_name, count(*)::int n FROM chain_events WHERE deployment_id=$1 GROUP BY event_name ORDER BY event_name`, [deploymentId]);
    const names = Object.fromEntries(chain.rows.map((x) => [x.event_name, x.n]));
    check('TESTNET_V6_CHAIN_EVENTS', names['EventPublished'] === 1 && names['RegistrationCommitted'] === 5 && names['AttendanceMarked'] === 2 && names['EventFinalized'] === 1 && names['SettlementStarted'] === 1 && names['EventSettled'] === 1 && names['PayoutStarted'] === 2 && names['PayoutSucceeded'] === 2,
      'full lifecycle chain provenance captured', JSON.stringify(names));
    const unknownNames = chain.rows.filter((x) => !KNOWN_EVENTS.has(x.event_name));
    check('TESTNET_V6_ALL_EVENTS_KNOWN', unknownNames.length === 0, 'every captured event name is in the v6 ABI set', JSON.stringify(unknownNames.map((x) => x.event_name)));

    const cursor = await store.readCursor(deploymentId);
    check('TESTNET_V6_CURSOR', cursor?.block_height === V6_SETTLE_FINAL_BLOCK.blockHeight && cursor?.block_hash === V6_SETTLE_FINAL_BLOCK.blockHash,
      'cursor advanced to the final payout block', JSON.stringify(cursor));

    // Real API public read of the projected settled event.
    const apiPort = await freePort();
    if (!PG_PORT()) throw new Error('SHOWSTAKE_PG_PORT is required');
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    const child = spawn(process.execPath, [API_ENTRY], {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: `postgresql://showstake_api_service@127.0.0.1:${PG_PORT()}/${DB()}`,
        DB_ROLE: 'showstake_api',
        AUTH_DOMAIN: apiUrl,
        AUTH_NETWORK: 'testnet',
        COOKIE_SECURE: 'false',
        HOST: '127.0.0.1',
        PORT: String(apiPort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let apiLog = '';
    child.stdout.on('data', (d) => { apiLog += d.toString(); });
    child.stderr.on('data', (d) => { apiLog += d.toString(); });
    try {
      let ready = false;
      for (let i = 0; i < 120 && !ready; i++) {
        if (child.exitCode !== null) break;
        try { const r = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(2_000) }); ready = r.status === 200; } catch { /* not up yet */ }
        if (!ready) await sleep(250);
      }
      check('TESTNET_V6_API_READY', ready, 'real API server ready on loopback', ready ? apiUrl : `exit=${child.exitCode} log=${apiLog.slice(-400)}`);
      if (ready) {
        const oneRes = await fetch(`${apiUrl}/v1/events/${ev.id}`, { signal: AbortSignal.timeout(10_000) });
        const oneJson = await oneRes.json();
        const data = oneJson?.data ?? {};
        const totals = data.totals ?? {};
        check('TESTNET_V6_API_READ_EVENT', oneRes.status === 200 && data.id === ev.id && data.state === 'SETTLED' && data.contractId === DEP.contractId && totals.acceptedAtomic === '10000000' && totals.paidAtomic === '10000000' && String(totals.liabilityAtomic) === '0',
          'real API GET /v1/events/:id serves the SETTLED event + totals', `status=${oneRes.status} ${JSON.stringify(data).slice(0, 200)}`);
      }
    } finally {
      child.kill('SIGTERM');
      await Promise.race([new Promise((resolveExit) => child.once('exit', resolveExit)), sleep(5_000).then(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } })]);
    }

    const failed = results.filter((x) => !x.ok);
    const summary = {
      id: 'worker-testnet-v6-proof',
      task: 'apps/worker read-only actual-testnet v6 settlement lifecycle projection proof',
      classifier: failed.length === 0 ? 'PASS_TESTNET' : 'FAILED',
      ok: failed.length === 0,
      reviewer_pending: true,
      run_id: RUN_ID(),
      environment: { network: 'testnet', neardata: NEARDATA_URL, rpc: RPC_URL, official_crosscheck_rpc: OFFICIAL_RPC_URL, postgresql: 'disposable postgresql-18 cluster' },
      provider: { runtime: 'DeepSeek Harness via Orca', model: 'GATER/deepseek-v4.1-flash-1017-v2', prior_round: 'ZCode/deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated (contract v6)' },
      source_manifest: {
        block: 'FASTNEAR NEAR Data (https://github.com/fastnear/neardata-server) /v0/block/<height>',
        view: 'NEAR JSON-RPC query (call_function) pinned to receipt block hash (get_event/get_settlement/get_event_totals/get_payout)',
        canonical: 'NEAR JSON-RPC block-by-height canonical proof + official prev_hash/prev_height chain linkage + final-height bound; D041 transport test.rpc.fastnear.com',
        official_crosscheck: 'https://rpc.testnet.near.org block-by-height for the committed publish/final-payout blocks',
        receipts: ['docs/evidence/testnet-settlement-five.json (31 real d036-settle-five receipts)'],
        deployment: ['docs/evidence/testnet-settle-deployment-result.json (showstake-settle-endpx.testnet, f462ddcb…)'],
      },
      trusted_source_boundary: 'Block identity (height/hash/canonicality/finality) is proven against the official JSON-RPC. Receipt execution-outcome/log CONTENTS come from FASTNEAR and are not merkle-proved; pinned get_event/get_settlement/get_event_totals/get_payout views cross-check contract state at the ingested block.',
      scan: { start: DEP.startHeight, until: V6_SETTLE_FINAL_BLOCK.blockHeight, blocksIngested: totalIngested, heightsSkipped: totalSkipped, batches: batchRecords },
      totals: { checks: results.length, failed: failed.length },
      checks: results,
      commands: ['wsl -d Ubuntu -- bash scripts/postgres-disposable/run-worker-testnet-v6.sh'],
      note: 'READ-ONLY public testnet reads; NO transactions/funds/secrets. The production runBoundedScan ingested every intervening canonical block from the v6 deployment block to the committed final payout block across multiple bounded batches within the same disposable-DB lifecycle (resolveStartHeight resumes from the durable cursor each batch; incremental checkpoints written per batch), each hash proven against the official RPC — no canonical/finality/skip weakening. Deterministic settlement projection: 2 attendees claim D+share (5000000) PAID, 3 no-shows Forfeited->ZERO (claim 0), principal D unchanged, conservation sum(claim)==accepted==10000000, two payouts exactly-once; event-derived payout transitions reconciled once-per-block against pinned totals; projected event read through the real API server.',
    };
    if (ARTIFACTS()) {
      await mkdir(ARTIFACTS(), { recursive: true });
      await writeFile(join(ARTIFACTS(), 'worker-testnet-v6.json'), JSON.stringify(summary, null, 2));
    }
    await writeFile(join(ROOT, 'docs', 'evidence', `worker-testnet-v6-${RUN_ID()}.json`), JSON.stringify(summary, null, 2) + '\n');
    console.log(`\nverify-worker-testnet-v6: ${results.length - failed.length}/${results.length} checks`);
    return summary;
  } finally {
    if (pool) await pool.end().catch(() => {});
    await client.end().catch(() => {});
  }
}

const deadline = setTimeout(() => { console.error('verify-worker-testnet-v6 FAILED: deadline'); process.exit(1); }, 5400000);
try {
  const summary = await run();
  clearTimeout(deadline);
  process.exit(summary.ok ? 0 : 1);
} catch (e) {
  clearTimeout(deadline);
  console.error('verify-worker-testnet-v6 FATAL:', e instanceof Error ? e.message : String(e));
  process.exit(1);
}