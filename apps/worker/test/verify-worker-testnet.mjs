// apps/worker READ-ONLY actual-testnet receipt ingestion/projection proof.
//
// CLEARLY SEPARATE from local fixture tests (verify-worker-fixtures.mjs and
// verify-worker-db.mjs). It runs the REAL production path end-to-end:
//   * deployment resolved/verified against the committed DB row + live code hash,
//     get_config and ACTUAL ft_metadata decimals;
//   * the exact-start gate starts at the contract deployment block;
//   * `runBoundedScan` fetches EVERY intervening block from FASTNEAR NEAR Data,
//     has the production store canonically verify each block hash against the
//     official NEAR JSON-RPC (by canonical height) and prove each block is at or
//     below the official final height, and only skips a 404 height after the RPC
//     proves it is a canonically-skipped block;
//   * malformed real payloads (empty shards / missing receipt outcomes) are
//     rejected by the strict normalizer;
//   * the committed publish + deposit receipts are projected, and the real API
//     server (unprivileged API LOGIN/role) reads the projected event; the API
//     role also reads the projected pass.
//
// Classifier: PASS_TESTNET (read-only public testnet reads; NO transactions, NO
// funds, NO secrets). Runs under WSL/Linux Node over the per-run Unix socket.
//
// Trusted-source boundary: matching a source block hash to the official RPC
// anchors WHICH BLOCK was read, not the receipt/log CONTENTS served for that
// block (FASTNEAR returns no merkle proof for execution outcomes). Receipt/log
// contents are trusted from the selected source inside that block-identity
// boundary; the source's own final-height claim is never trusted.
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkerPool, WorkerStore } from '../dist/store.js';
import { makeLiveChain, makeBlockSource, makeCanonicalVerifier, runBoundedScan } from '../dist/index.js';
import { BlockNotFoundError, NearRpcClient, normalizeFastNearBlock } from '../dist/source.js';
import { KNOWN_EVENTS } from '../dist/events.js';
import { listMigrations, runMigrations, connectConfig } from '../../../migrations/runner.mjs';
import { COMMITTED_DEPLOYMENT, PUBLISH_RECEIPT, DEPOSIT_RECEIPT } from './fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../../..');
const SCHEMA_DIR = join(ROOT, 'migrations', 'schema');
const API_ENTRY = join(ROOT, 'apps', 'api', 'dist', 'index.js');

const DB = () => process.env.SHOWSTAKE_PG_DB1 || 'showstake_disposable';
const SOCKET = () => process.env.SHOWSTAKE_PG_SOCKET || null;
const ARTIFACTS = () => process.env.SHOWSTAKE_PG_ARTIFACTS || null;
const RUN_ID = () => process.env.SHOWSTAKE_PG_RUN_ID || 'local';
const PG_PORT = () => Number(process.env.SHOWSTAKE_PG_PORT || 0);
// D041: the official NEAR-doc-listed FASTNEAR testnet RPC transport is used for
// the high-volume read-only canonical/final/skip proof; the two committed blocks
// are additionally cross-checked against rpc.testnet.near.org below.
const RPC_URL = process.env.WORKER_RPC_URL || 'https://test.rpc.fastnear.com';
const OFFICIAL_RPC_URL = process.env.WORKER_OFFICIAL_RPC_URL || 'https://rpc.testnet.near.org';
const NEARDATA_URL = process.env.WORKER_NEARDATA_URL || 'https://testnet.neardata.xyz';

const results = [];
function check(id, ok, expected, observed) {
  results.push({ id, ok: Boolean(ok), expected, observed, classifier: 'PASS_TESTNET' });
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${id}  (observed: ${observed})`);
}
async function expectReject(id, fn, contains) {
  try {
    await fn();
    check(id, false, `rejects (${contains})`, 'did not reject');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(id, msg.includes(contains), `rejects (${contains})`, msg);
  }
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

async function run() {
  if (!SOCKET()) throw new Error('SHOWSTAKE_PG_SOCKET is required');
  const client = await rawClient(DB());
  let pool = null;
  try {
    const migrations = await listMigrations(SCHEMA_DIR);
    await runMigrations(client, migrations);
    await client.query(`
      INSERT INTO deployments (id, environment, network, contract_id, ft_contract_id, ft_decimals, start_block, code_hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (network, contract_id, code_hash) DO UPDATE SET start_block = EXCLUDED.start_block`,
      [DEPLOYMENT_ID, COMMITTED_DEPLOYMENT.environment, COMMITTED_DEPLOYMENT.network, COMMITTED_DEPLOYMENT.contractId,
        COMMITTED_DEPLOYMENT.ftContractId, COMMITTED_DEPLOYMENT.ftDecimals, COMMITTED_DEPLOYMENT.startHeight, COMMITTED_DEPLOYMENT.codeHash]);
    await client.query('CREATE ROLE showstake_worker_service LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    await client.query('GRANT showstake_worker TO showstake_worker_service WITH INHERIT FALSE, SET TRUE');
    await client.query('CREATE ROLE showstake_api_service LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    await client.query('GRANT showstake_api TO showstake_api_service WITH INHERIT FALSE, SET TRUE');

    pool = createWorkerPool({ ...connectConfig(DB(), SOCKET()), user: 'showstake_worker_service', application_name: 'showstake-worker-testnet' });
    const verifier = makeCanonicalVerifier(RPC_URL);
    const store = new WorkerStore(pool, COMMITTED_DEPLOYMENT, 'showstake-worker-testnet', makeLiveChain(RPC_URL), verifier);
    const { id: deploymentId, startBlock } = await store.resolveDeployment();
    check('TESTNET_DEPLOY_RESOLVED', deploymentId === DEPLOYMENT_ID && startBlock === COMMITTED_DEPLOYMENT.startHeight,
      `committed deployment resolved at deployment block ${COMMITTED_DEPLOYMENT.startHeight}`, `${deploymentId}/${startBlock}`);

    await store.verifyLiveIdentity();
    check('TESTNET_LIVE_IDENTITY', true, 'live code_hash + get_config + ACTUAL ft_metadata decimals match allowlist', `${COMMITTED_DEPLOYMENT.codeHash}/6`);

    const nextHeight = await store.resolveStartHeight(deploymentId, startBlock);
    check('TESTNET_EXACT_START', nextHeight === COMMITTED_DEPLOYMENT.startHeight,
      'exact-start gate starts at the contract deployment block (never the later publish block)', nextHeight);

    const blockSource = makeBlockSource(NEARDATA_URL);
    const scan = await runBoundedScan({
      store,
      blockSource,
      verifier,
      deploymentId,
      nextHeight,
      maxBlocks: 1000,
      untilHeight: DEPOSIT_RECEIPT.blockHeight,
      log: (m) => console.log(`    [scan] ${m}`),
    });
    const expectedHeights = DEPOSIT_RECEIPT.blockHeight - nextHeight + 1;
    check('TESTNET_SCAN_END', scan.endHeight === DEPOSIT_RECEIPT.blockHeight,
      `scan ends at the committed deposit block ${DEPOSIT_RECEIPT.blockHeight}`, scan.endHeight);
    check('TESTNET_SCAN_FULL_RANGE', scan.blocksIngested + scan.heightsSkipped.length === expectedHeights && scan.heightsUnprovenMissing.length === 0,
      `every height ${nextHeight}..${DEPOSIT_RECEIPT.blockHeight} ingested or proven skipped by canonical prev-hash linkage`, JSON.stringify({ ingested: scan.blocksIngested, skipped: scan.heightsSkipped, unproven: scan.heightsUnprovenMissing, expected: expectedHeights }));
    check('TESTNET_SCAN_OFFICIAL_FINAL_BOUND', scan.officialFinalHeight >= DEPOSIT_RECEIPT.blockHeight,
      'scan bounded by the OFFICIAL RPC final height', scan.officialFinalHeight);

    // The two committed blocks are independently cross-checked against the
    // official near.org RPC host (the full scan uses the D041 transport).
    const official = new NearRpcClient(OFFICIAL_RPC_URL);
    await official.verifyBlock(PUBLISH_RECEIPT.blockHeight, PUBLISH_RECEIPT.blockHash);
    await official.verifyBlock(DEPOSIT_RECEIPT.blockHeight, DEPOSIT_RECEIPT.blockHash);
    check('TESTNET_OFFICIAL_RPC_CROSSCHECK', true,
      'publish/deposit canonical hashes independently agree with rpc.testnet.near.org', `${PUBLISH_RECEIPT.blockHash}/${DEPOSIT_RECEIPT.blockHash}`);

    // Real malformed-source payloads (the fetched deposit block, mutated).
    const rawRes = await fetch(`${NEARDATA_URL.replace(/\/$/, '')}/v0/block/${DEPOSIT_RECEIPT.blockHeight}`, { signal: AbortSignal.timeout(30_000) });
    if (!rawRes.ok) throw new Error(`raw block fetch HTTP ${rawRes.status}`);
    const rawPayload = await rawRes.json();
    const noShardOutcomes = structuredClone(rawPayload);
    delete noShardOutcomes.shards[0].receipt_execution_outcomes;
    await expectReject('TESTNET_REAL_MISSING_SHARD_OUTCOMES_REJECTED', async () => normalizeFastNearBlock(noShardOutcomes), 'no receipt_execution_outcomes member');
    const emptyShards = structuredClone(rawPayload);
    emptyShards.shards = [];
    await expectReject('TESTNET_REAL_EMPTY_SHARDS_REJECTED', async () => normalizeFastNearBlock(emptyShards), 'shards array is empty');
    const missingLogs = structuredClone(rawPayload);
    const anyOutcome = missingLogs.shards.flatMap((s) => s.receipt_execution_outcomes)[0];
    if (!anyOutcome) throw new Error('deposit block has no outcome to mutate');
    delete anyOutcome.execution_outcome.outcome.logs;
    await expectReject('TESTNET_REAL_MISSING_LOGS_REJECTED', async () => normalizeFastNearBlock(missingLogs), 'no outcome.logs member');

    const depositShards = structuredClone(rawPayload);
    depositShards.shards.pop();
    await expectReject('TESTNET_REAL_PARTIAL_SHARD_SET_REJECTED', async () => normalizeFastNearBlock(depositShards), 'shard set incomplete');
    const duplicateShard = structuredClone(rawPayload);
    duplicateShard.shards[1].shard_id = duplicateShard.shards[0].shard_id;
    await expectReject('TESTNET_REAL_DUPLICATE_SHARD_ID_REJECTED', async () => normalizeFastNearBlock(duplicateShard), 'duplicate shard_id');

    await expectReject('TESTNET_CANONICAL_MISMATCH_REJECTED', () => verifier.verifyBlock(DEPOSIT_RECEIPT.blockHeight, '11111111111111111111111111111111'), 'canonical check');
    const depositHeader = await verifier.verifyBlock(DEPOSIT_RECEIPT.blockHeight, DEPOSIT_RECEIPT.blockHash);
    const publishHeader = await verifier.verifyBlock(PUBLISH_RECEIPT.blockHeight, PUBLISH_RECEIPT.blockHash);
    check('TESTNET_OFFICIAL_HEADER_LINKAGE', depositHeader.prevHeight === DEPOSIT_RECEIPT.blockHeight - 1 && publishHeader.prevHeight === PUBLISH_RECEIPT.blockHeight - 1,
      'official headers provide prev_height/prev_hash linkage for the committed blocks', JSON.stringify({ depositPrev: depositHeader.prevHeight, publishPrev: publishHeader.prevHeight }));
    let notFound = null;
    try { await blockSource.fetchBlock(scan.officialFinalHeight + 1_000_000); } catch (e) { notFound = e; }
    check('TESTNET_MISSING_HEIGHT_IS_TYPED', notFound instanceof BlockNotFoundError, 'FASTNEAR 404 for a height is a typed not-found (skip candidate)', notFound instanceof Error ? notFound.name : String(notFound));

    const ev = (await client.query(`SELECT * FROM events_projection WHERE deployment_id=$1`, [deploymentId])).rows[0];
    check('TESTNET_EVENT_ID', ev && ev.chain_event_id === 'testnet-first-event', 'event_id projected', ev?.chain_event_id);
    check('TESTNET_EVENT_ORGANIZER', ev && ev.organizer_account === COMMITTED_DEPLOYMENT.organizer, 'organizer projected', ev?.organizer_account);
    check('TESTNET_EVENT_MONEY', ev && ev.deposit_atomic === '1000000' && ev.capacity === 10, 'deposit/capacity projected', `${ev?.deposit_atomic}/${ev?.capacity}`);
    check('TESTNET_EVENT_RULES_TIMES', ev && ev.reg_open.toISOString() === new Date(1794050511780).toISOString() && ev.finalize_deadline.toISOString() === new Date(1794162171780).toISOString(), 'rules times projected (enriched)', ev?.reg_open?.toISOString());

    const reg = (await client.query(`SELECT * FROM registrations_projection WHERE chain_registration_id='reg-0'`)).rows[0];
    const pass = (await client.query(`SELECT * FROM passes_projection WHERE pass_id='pass-0'`)).rows[0];
    check('TESTNET_REGISTRATION', reg && reg.participant_account === COMMITTED_DEPLOYMENT.organizer && reg.principal_atomic === '1000000' && reg.state === 'COMMITTED', 'reg-0 committed', reg?.chain_registration_id);
    check('TESTNET_PASS', pass && pass.owner_account === COMMITTED_DEPLOYMENT.organizer, 'pass-0 owner = participant', pass?.pass_id);
    check('TESTNET_TOTALS', ev && ev.accepted_atomic === '1000000' && ev.liability_atomic === '1000000', 'event totals reflect the committed deposit', `${ev?.accepted_atomic}/${ev?.liability_atomic}`);

    const chain = await client.query(`SELECT receipt_id, log_index, block_height, block_hash, event_name FROM chain_events WHERE deployment_id=$1 ORDER BY block_height, receipt_id, log_index`, [deploymentId]);
    const pubRow = chain.rows.find((r) => r.receipt_id === PUBLISH_RECEIPT.receiptId);
    const depRow = chain.rows.find((r) => r.receipt_id === DEPOSIT_RECEIPT.receiptId);
    check('TESTNET_PUBLISH_PROVENANCE', pubRow && pubRow.event_name === 'EventPublished' && Number(pubRow.block_height) === PUBLISH_RECEIPT.blockHeight && pubRow.block_hash === PUBLISH_RECEIPT.blockHash,
      'publish provenance (receipt/height/hash) stored', JSON.stringify(pubRow));
    check('TESTNET_DEPOSIT_PROVENANCE', depRow && depRow.event_name === 'RegistrationCommitted' && Number(depRow.block_height) === DEPOSIT_RECEIPT.blockHeight && depRow.block_hash === DEPOSIT_RECEIPT.blockHash,
      'deposit provenance (receipt/height/hash) stored', JSON.stringify(depRow));
    const unknownNames = chain.rows.filter((r) => !KNOWN_EVENTS.has(r.event_name));
    check('TESTNET_ALL_EVENTS_KNOWN', unknownNames.length === 0 && chain.rows.length >= 2,
      'every captured chain event name is in the deployed-ABI event set', JSON.stringify(chain.rows.map((r) => r.event_name)));
    const provenanceRows = chain.rows.filter((r) => r.event_name !== 'EventPublished' && r.event_name !== 'RegistrationCommitted');
    check('TESTNET_STORAGE_EVENTS_ACCOUNTED', provenanceRows.every((r) => r.event_name === 'StorageDeposited' || r.event_name === 'EventCancelled' || r.event_name === 'RefundModeActivated' || r.event_name === 'PayoutStarted' || r.event_name === 'PayoutSucceeded' || r.event_name === 'PayoutFailed'),
      `provenance-only events captured and never projected (${provenanceRows.length})`, JSON.stringify(provenanceRows.map((r) => r.event_name)));
    const committedChain = chain.rows.filter((r) => r.event_name === 'RegistrationCommitted').length;
    const regCount = (await client.query(`SELECT count(*)::int n FROM registrations_projection`)).rows[0].n;
    const passCount = (await client.query(`SELECT count(*)::int n FROM passes_projection`)).rows[0].n;
    check('TESTNET_PROJECTION_CONSISTENCY', committedChain === regCount && regCount === passCount && regCount >= 1,
      'every committed chain event has exactly one registration and pass projection', JSON.stringify({ committedChain, regCount, passCount }));

    const cursor = await store.readCursor(deploymentId);
    check('TESTNET_CURSOR', cursor?.block_height === DEPOSIT_RECEIPT.blockHeight && cursor?.block_hash === DEPOSIT_RECEIPT.blockHash,
      'cursor advanced to the deposit block via the locked, monotonic path', JSON.stringify(cursor));

    // Real API server: unprivileged API LOGIN/SET ROLE serve the projected event.
    const apiPort = await freePort();
    if (!PG_PORT()) throw new Error('SHOWSTAKE_PG_PORT is required to start the API over TCP');
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
        try {
          const r = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(2_000) });
          ready = r.status === 200;
        } catch { /* not up yet */ }
        if (!ready) await sleep(250);
      }
      check('TESTNET_API_READY', ready, 'real API server ready on loopback with unprivileged role', ready ? apiUrl : `exit=${child.exitCode} log=${apiLog.slice(-400)}`);
      if (ready) {
        const listRes = await fetch(`${apiUrl}/v1/events`, { signal: AbortSignal.timeout(10_000) });
        const listJson = await listRes.json();
        const listHit = Array.isArray(listJson?.data?.items) && listJson.data.items.some((it) => it.id === ev.id);
        check('TESTNET_API_LIST_EVENT', listRes.status === 200 && listHit, 'GET /v1/events returns the newly projected event', `status=${listRes.status} hit=${listHit}`);

        const oneRes = await fetch(`${apiUrl}/v1/events/${ev.id}`, { signal: AbortSignal.timeout(10_000) });
        const oneJson = await oneRes.json();
        const data = oneJson?.data ?? {};
        check('TESTNET_API_READ_EVENT', oneRes.status === 200 && data.id === ev.id && data.depositAtomic === '1000000' && data.capacity === 10
          && data.contractId === COMMITTED_DEPLOYMENT.contractId && data.network === 'testnet' && data.state === 'PUBLISHED'
          && data.totals?.acceptedAtomic === '1000000' && data.totals?.liabilityAtomic === '1000000',
          'real API GET /v1/events/:id serves the projected event + totals', `status=${oneRes.status} ${JSON.stringify(data).slice(0, 200)}`);
      }
    } finally {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolveExit) => child.once('exit', resolveExit)),
        sleep(5_000).then(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }),
      ]);
    }

    await client.query('SET ROLE showstake_api');
    const apiPass = await client.query(`SELECT pass_id, owner_account FROM passes_projection WHERE deployment_id=$1`, [deploymentId]);
    await client.query('RESET ROLE');
    check('TESTNET_API_READ_PASS', apiPass.rows[0]?.pass_id === 'pass-0' && apiPass.rows[0]?.owner_account === COMMITTED_DEPLOYMENT.organizer,
      'API role reads the projected pass', apiPass.rows[0]?.pass_id);

    const failed = results.filter((r) => !r.ok);
    const summary = {
      id: 'worker-testnet-proof',
      task: 'apps/worker read-only actual-testnet full-range ingestion/projection proof (review round 2)',
      classifier: failed.length === 0 ? 'PASS_TESTNET' : 'FAILED',
      ok: failed.length === 0,
      reviewer_pending: true,
      run_id: RUN_ID(),
      environment: { network: 'testnet', neardata: NEARDATA_URL, rpc: RPC_URL, official_crosscheck_rpc: OFFICIAL_RPC_URL, postgresql: 'disposable postgresql-18 cluster' },
      provider: { runtime: 'ZCode via Orca (Cloud Near); D040 executor reassignment', model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated', prior_round: 'GATER/deepseek-v4.1-flash-1017-v2' },
      source_manifest: {
        block: 'FASTNEAR NEAR Data (https://github.com/fastnear/neardata-server) /v0/block/<height>',
        view: 'NEAR JSON-RPC query (call_function) pinned to receipt block hash',
        canonical: 'NEAR JSON-RPC block-by-height canonical proof + official prev_hash/prev_height chain linkage + final-height bound; D041 transport test.rpc.fastnear.com',
        official_crosscheck: 'https://rpc.testnet.near.org block-by-height for the two committed receipt blocks',
        receipts: ['docs/evidence/testnet-product-smoke.json (publish/deposit receipt block metadata)'],
        deployment: ['docs/evidence/testnet-showstake-deployment-result.json'],
      },
      trusted_source_boundary: 'Block identity (height/hash/canonicality/finality) is proven against the official JSON-RPC. Receipt execution-outcome/log CONTENTS come from FASTNEAR and are not merkle-proved here; they are trusted inside the proven block-identity boundary.',
      scan: { start: nextHeight, until: DEPOSIT_RECEIPT.blockHeight, blocksIngested: scan.blocksIngested, heightsSkipped: scan.heightsSkipped, heightsUnprovenMissing: scan.heightsUnprovenMissing, officialFinalHeight: scan.officialFinalHeight },
      receipts: { publish: PUBLISH_RECEIPT, deposit: DEPOSIT_RECEIPT },
      totals: { checks: results.length, failed: failed.length },
      checks: results,
      commands: ['wsl -d Ubuntu -- bash scripts/postgres-disposable/run-worker-testnet.sh'],
      note: 'READ-ONLY public testnet reads; NO transactions/funds/secrets. The production runBoundedScan ingested EVERY canonical block from the contract deployment block to the committed deposit block (no publish->deposit jump), with each block hash proven against the official RPC by canonical height + official prev_hash/prev_height chain linkage and bounded by official finality; source 404/UNKNOWN_BLOCK alone is never skip evidence. Malformed real payloads (missing outcomes/logs, empty/partial/duplicate shard sets) are rejected; the projected event is read through the real API server and the projected pass through the API role.',
    };
    if (ARTIFACTS()) {
      await mkdir(ARTIFACTS(), { recursive: true });
      await writeFile(join(ARTIFACTS(), 'worker-testnet.json'), JSON.stringify(summary, null, 2));
    }
    await writeFile(join(ROOT, 'docs', 'evidence', `worker-testnet-${RUN_ID()}.json`), JSON.stringify(summary, null, 2) + '\n');
    console.log(`\nverify-worker-testnet: ${results.length - failed.length}/${results.length} checks`);
    return summary;
  } finally {
    if (pool) await pool.end().catch(() => {});
    await client.end().catch(() => {});
  }
}

const deadline = setTimeout(() => { console.error('verify-worker-testnet FAILED: deadline'); process.exit(1); }, 900000);
try {
  const summary = await run();
  clearTimeout(deadline);
  process.exit(summary.ok ? 0 : 1);
} catch (e) {
  clearTimeout(deadline);
  console.error('verify-worker-testnet FATAL:', e instanceof Error ? e.message : String(e));
  process.exit(1);
}
