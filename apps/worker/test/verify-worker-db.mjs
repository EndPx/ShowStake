// apps/worker disposable-PostgreSQL acceptance. Runs under WSL/Linux Node over
// the per-run Unix socket (same convention as migrations/tests and apps/api).
// Requires env exported by scripts/postgres-disposable/run-worker-suite.sh:
//   SHOWSTAKE_PG_SOCKET / _PORT / _USER / _DB1 / _ARTIFACTS / _RUN_ID
//
// Classifier: PASS_LOCAL (deterministic labelled fixtures + real disposable
// PostgreSQL; NO network, NO real assets). Projections are written by the
// restricted worker role; the API role's read-only grants are re-asserted.
//
// R1 behaviour proven here on real PG: per-(deployment,consumer) transaction
// lock including first-cursor creation, exact-start gate, monotonic contiguous
// advancement, fork rejection, unproven-gap rejection, canonically-proven skip,
// idempotent old replay without regression, conditional expected-previous cursor
// upsert, malformed-cursor fail-closed, crash rollback, and two-connection
// different-height/opposite-order attempts (higher height first => gap, then
// lower height, then retry) plus same-height overlap exactly-once.
import { candidateDbTest } from './candidate-db.mjs';
import { factoryDbTest } from './factory-db.mjs';
import { linkedDbTest } from './linked-db.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkerPool, WorkerStore, assertWorkerLeastPrivilege } from '../dist/store.js';
import { listMigrations, runMigrations, connectConfig } from '../../../migrations/runner.mjs';
import { COMMITTED_DEPLOYMENT, SETTLE_DEPLOYMENT, localFixtureBlocks, commitBlock, block, receipt, log } from './fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../../..');
const SCHEMA_DIR = join(ROOT, 'migrations', 'schema');

const DB = () => process.env.SHOWSTAKE_PG_DB1 || 'showstake_disposable';
const SOCKET = () => process.env.SHOWSTAKE_PG_SOCKET || null;
const ARTIFACTS = () => process.env.SHOWSTAKE_PG_ARTIFACTS || null;
const RUN_ID = () => process.env.SHOWSTAKE_PG_RUN_ID || 'local';

const results = [];
function check(id, ok, expected, observed) {
  results.push({ id, ok: Boolean(ok), expected, observed, classifier: 'PASS_LOCAL' });
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

const DEPLOYMENT_ID = '00000000-0000-4000-8000-0000000000c1';
const OTHER_DEPLOYMENT_ID = '00000000-0000-4000-8000-0000000000c2';
const DEP = COMMITTED_DEPLOYMENT;
const CONSUMER = 'showstake-worker-suite';
const FIXTURE_START = 100;
const SERVICE_USER = 'showstake_worker_service';

function makeFakeLiveChain(view, { codeHash = DEP.codeHash, config = null, decimals = DEP.ftDecimals, pin = null } = {}) {
  const cfg = config ?? { organizer: DEP.organizer, canonical_ft: DEP.ftContractId, network: DEP.network, policy_version: DEP.policyVersion };
  return {
    viewSource: {
      async callView(method, args, blockRef) {
        if (method === 'get_config') return { result: cfg, blockHeight: 1, blockHash: 'H' };
        if (method === 'ft_metadata') return { result: { spec: 'ft-1.0.0', name: 'ShowStake Test FT', symbol: 'SS_TEST', decimals }, blockHeight: 1, blockHash: 'H' };
        if (method === 'get_event') {
          if (pin) return { result: view, blockHeight: pin.height, blockHash: pin.hash };
          return { result: view, blockHeight: Number(String(blockRef).replace(/^H/, '')), blockHash: blockRef };
        }
        throw new Error(`unexpected view ${method}`);
      },
    },
    async accountCodeHash() { return codeHash; },
  };
}

/**
 * Fake official-RPC verifier. `headers` is the registered canonical header for
 * each block hash: verifyBlock returns its prev_hash/prev_height, so linkage is
 * tested against exactly what the fixture declares (including deliberately wrong
 * linkage for pruned/mismatch cases).
 */
function makeFakeCanonical({ finalHeight = 1_000_000, badHashes = new Set(), headers = new Map() } = {}) {
  const verified = [];
  return {
    verified,
    badHashes,
    headers,
    async lastFinalHeight() { return finalHeight; },
    async verifyBlock(height, hash) {
      verified.push({ height, hash });
      if (this.badHashes.has(hash)) throw new Error(`canonical check: canonical block at height ${height} has hash OTHER, expected ${hash}`);
      const header = this.headers.get(hash);
      if (!header || header.height !== height) throw new Error(`canonical check: no registered canonical header for ${hash}@${height}`);
      return { height, hash, prevHash: header.prevHash, prevHeight: header.prevHeight };
    },
  };
}

/** Register a fixture block's header with the fake canonical verifier. */
function registerBlock(canonical, block) {
  const existing = canonical.headers.get(block.hash);
  const header = { height: block.height, prevHash: block.prevHash, prevHeight: block.prevHeight };
  if (existing) {
    if (existing.height !== header.height || existing.prevHash !== header.prevHash || existing.prevHeight !== header.prevHeight) {
      throw new Error(`conflicting fake canonical registration for ${block.hash}`);
    }
    return;
  }
  canonical.headers.set(block.hash, header);
}

async function seedDeployment(client, { id = DEPLOYMENT_ID, contractId = DEP.contractId, startBlock = FIXTURE_START } = {}) {
  await client.query(`
    INSERT INTO deployments (id, environment, network, contract_id, ft_contract_id, ft_decimals, start_block, code_hash)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (network, contract_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, start_block = EXCLUDED.start_block`,
    [id, DEP.environment, DEP.network, contractId, DEP.ftContractId, DEP.ftDecimals, startBlock, DEP.codeHash]);
}

const workerCfg = () => ({ ...connectConfig(DB(), SOCKET()), user: SERVICE_USER });

async function main() {
  if (!SOCKET()) throw new Error('SHOWSTAKE_PG_SOCKET is required');

  const client = await rawClient(DB());
  const pools = [];
  try {
    const migrations = await listMigrations(SCHEMA_DIR);
    const applied = await runMigrations(client, migrations);
    check('DB_MIGRATIONS_APPLIED', applied.length >= 2, '>=2 migrations applied', `applied=${applied.length}`);

    await seedDeployment(client);
    await seedDeployment(client, { id: OTHER_DEPLOYMENT_ID, contractId: 'showstake-other-endpx.testnet' });

    // Dedicated unprivileged NOINHERIT service LOGIN (activates via SET ROLE).
    await client.query(`CREATE ROLE ${SERVICE_USER} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await client.query(`GRANT showstake_worker TO ${SERVICE_USER} WITH INHERIT FALSE, SET TRUE`);
    await client.query('CREATE ROLE showstake_worker_unsafe LOGIN NOINHERIT CREATEDB NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    await client.query('GRANT showstake_worker TO showstake_worker_unsafe WITH INHERIT FALSE, SET TRUE');
    await client.query('CREATE ROLE showstake_worker_createrole LOGIN NOINHERIT NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS');
    await client.query('GRANT showstake_worker TO showstake_worker_createrole WITH INHERIT FALSE, SET TRUE');
    await client.query('CREATE ROLE showstake_worker_replication LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE REPLICATION NOBYPASSRLS');
    await client.query('GRANT showstake_worker TO showstake_worker_replication WITH INHERIT FALSE, SET TRUE');
    await client.query('CREATE ROLE showstake_worker_bypassrls LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS');
    await client.query('GRANT showstake_worker TO showstake_worker_bypassrls WITH INHERIT FALSE, SET TRUE');
    await client.query('CREATE ROLE showstake_worker_inherit LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    await client.query('GRANT showstake_worker TO showstake_worker_inherit WITH INHERIT FALSE, SET TRUE');
    await client.query('CREATE ROLE showstake_worker_inherit_member LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    await client.query('GRANT showstake_worker TO showstake_worker_inherit_member WITH INHERIT TRUE, SET TRUE');
    await client.query('CREATE ROLE showstake_api_service LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    await client.query('GRANT showstake_api TO showstake_api_service WITH INHERIT FALSE, SET TRUE');

    const pool = createWorkerPool({ ...workerCfg(), application_name: 'showstake-worker-acceptance' });
    pools.push(pool);
    await assertWorkerLeastPrivilege(pool);
    check('DB_WORKER_RESTRICTED_LOGIN', true, 'service LOGIN + SET ROLE showstake_worker validated', SERVICE_USER);
    check('DB_WORKER_RESET_ROLE_GUARDED', true, 'RESET ROLE cannot restore projection/cursor write authority', 'denied 42501');

    const unsafePool = createWorkerPool({ ...connectConfig(DB(), SOCKET()), user: 'showstake_worker_unsafe', application_name: 'unsafe' });
    pools.push(unsafePool);
    await expectReject('DB_CREATEDB_LOGIN_REJECTED', () => unsafePool.query('SELECT 1'), 'unprivileged NOINHERIT LOGIN');

    for (const [role, id] of [
      ['showstake_worker_createrole', 'DB_CREATEROLE_LOGIN_REJECTED'],
      ['showstake_worker_replication', 'DB_REPLICATION_LOGIN_REJECTED'],
      ['showstake_worker_bypassrls', 'DB_BYPASSRLS_LOGIN_REJECTED'],
      ['showstake_worker_inherit', 'DB_INHERIT_LOGIN_REJECTED'],
      ['showstake_worker_inherit_member', 'DB_INHERITING_MEMBERSHIP_REJECTED'],
    ]) {
      const p = createWorkerPool({ ...connectConfig(DB(), SOCKET()), user: role, application_name: role });
      pools.push(p);
      await expectReject(id, () => p.query('SELECT 1'), 'unprivileged NOINHERIT LOGIN');
    }

    const operatorPool = createWorkerPool({ ...connectConfig(DB(), SOCKET()), application_name: 'operator' });
    pools.push(operatorPool);
    await expectReject('DB_OPERATOR_LOGIN_REJECTED', () => operatorPool.query('SELECT 1'), 'unprivileged NOINHERIT LOGIN');

    // API role cannot write projections (re-asserted; already owned by API tests).
    await client.query('SET ROLE showstake_api');
    let apiDenied = false;
    try { await client.query(`UPDATE events_projection SET deposit_atomic='1' WHERE false`); } catch (e) { apiDenied = e.code === '42501'; }
    await client.query('RESET ROLE');
    check('DB_API_NO_PROJECTION_WRITE', apiDenied, 'showstake_api UPDATE projection denied 42501', `denied=${apiDenied}`);

    const { blocks, localView } = localFixtureBlocks();
    const canonical = makeFakeCanonical();
    for (const b of [blocks.publish, blocks.deposit, blocks.wrongExecutor, blocks.failed, blocks.malformed, blocks.unsupported, blocks.crash, blocks.provenance]) {
      registerBlock(canonical, b);
    }
    const store = new WorkerStore(pool, { ...DEP, startHeight: FIXTURE_START }, CONSUMER, makeFakeLiveChain(localView), canonical);

    // Identity fail-closed: wrong live code hash / wrong ACTUAL FT metadata decimals.
    const wrongLive = new WorkerStore(pool, { ...DEP, startHeight: FIXTURE_START }, 'other', makeFakeLiveChain(localView, { codeHash: 'A'.repeat(44) }), canonical);
    await expectReject('DB_WRONG_CODE_HASH_DENIED', () => wrongLive.verifyLiveIdentity(), 'live code hash');
    const wrongFt = new WorkerStore(pool, { ...DEP, startHeight: FIXTURE_START }, 'other', makeFakeLiveChain(localView, { decimals: 8 }), canonical);
    await expectReject('DB_WRONG_FT_DECIMALS_DENIED', () => wrongFt.verifyLiveIdentity(), 'ft_metadata.decimals');

    const wrongDeploy = new WorkerStore(pool, { ...DEP, contractId: 'showstake-absent-endpx.testnet', startHeight: FIXTURE_START }, 'other', makeFakeLiveChain(localView), canonical);
    await expectReject('DB_WRONG_DEPLOYMENT_DENIED', () => wrongDeploy.resolveDeployment(), 'no deployment row');

    const { id: deploymentId, startBlock } = await store.resolveDeployment();
    check('DB_DEPLOYMENT_RESOLVED', deploymentId === DEPLOYMENT_ID && startBlock === FIXTURE_START, 'deployment resolved at fixture start_block 100', `${deploymentId}/${startBlock}`);

    // Exact-start gate (fresh cursor) vs resume.
    const gateStore = new WorkerStore(pool, { ...DEP, startHeight: FIXTURE_START + 1 }, 'gate-no-cursor', makeFakeLiveChain(localView), canonical);
    await expectReject('DB_EXACT_START_GATE', () => gateStore.resolveStartHeight(deploymentId, startBlock), 'exact-start gate');
    check('DB_FRESH_START_IS_DEPLOYMENT_START', (await store.resolveStartHeight(deploymentId, startBlock)) === FIXTURE_START, 'fresh start == deployment start_block', FIXTURE_START);

    // A missing INITIAL block must fail closed (never silently start at start+1).
    const freshGap = new WorkerStore(pool, { ...DEP, startHeight: FIXTURE_START }, 'fresh-start-gap', makeFakeLiveChain(localView), canonical);
    await expectReject('DB_INITIAL_START_MISSING_FAIL_CLOSED', () => freshGap.ingestBlock(deploymentId, blocks.deposit), 'first cursor must be created exactly');

    // Source predecessor fields must equal the official canonical header.
    await expectReject('DB_SOURCE_HEADER_MISMATCH_DENIED', () => store.ingestBlock(deploymentId, { ...blocks.failed, prevHash: 'H-OTHER' }), 'source/official header mismatch');
    check('DB_SOURCE_HEADER_CURSOR', (await store.readCursorHeight(deploymentId)) === null, 'no cursor after source/official header mismatch', await store.readCursorHeight(deploymentId));

    // 1. Publish projection (first cursor creation under the lock).
    const pub = await store.ingestBlock(deploymentId, blocks.publish);
    check('DB_PUBLISH_INGESTED', pub.publishedEvents === 1 && pub.cursorHeight === 100, 'one publish projected, cursor created at 100', JSON.stringify({ published: pub.publishedEvents, cursor: pub.cursorHeight }));
    const pubRows = await client.query(`SELECT * FROM events_projection WHERE deployment_id=$1`, [deploymentId]);
    check('DB_EVENT_ROW', pubRows.rows.length === 1 && pubRows.rows[0].state === 'PUBLISHED', 'event projection row PUBLISHED', pubRows.rows.length);
    const ev = pubRows.rows[0];
    check('DB_EVENT_MONEY', ev.deposit_atomic === '5000000' && ev.accepted_atomic === '0' && ev.liability_atomic === '0', 'money canonical numeric', ev.deposit_atomic);
    const chainCount = async () => (await client.query(`SELECT count(*)::int AS n FROM chain_events WHERE deployment_id=$1`, [deploymentId])).rows[0].n;
    check('DB_CHAIN_EVENT_PUBLISH', (await chainCount()) === 1, 'one chain_events row', await chainCount());

    // 2. Deposit projection.
    const dep = await store.ingestBlock(deploymentId, blocks.deposit);
    check('DB_DEPOSIT_INGESTED', dep.committedRegistrations === 1 && dep.cursorHeight === 101, 'one commit projected, cursor 101', JSON.stringify({ committed: dep.committedRegistrations, cursor: dep.cursorHeight }));
    const regs = await client.query(`SELECT * FROM registrations_projection`);
    check('DB_REGISTRATION_ROW', regs.rows.length === 1 && regs.rows[0].participant_account === 'bob.testnet' && regs.rows[0].state === 'COMMITTED', 'registration COMMITTED', regs.rows.length);
    const passes = await client.query(`SELECT * FROM passes_projection`);
    check('DB_PASS_ROW', passes.rows.length === 1 && passes.rows[0].owner_account === 'bob.testnet' && passes.rows[0].pass_id === 'pass-local-0', 'pass owner = participant', passes.rows.length);
    const tot = await client.query(`SELECT accepted_atomic::text a, liability_atomic::text l FROM events_projection WHERE id=$1`, [ev.id]);
    check('DB_EVENT_TOTALS_AFTER_COMMIT', tot.rows[0].a === '5000000' && tot.rows[0].l === '5000000', 'accepted=liability=5000000', JSON.stringify(tot.rows[0]));

    // 3. Public API role read (the same EVENT_SELECT the API uses) + pass read.
    await client.query('SET ROLE showstake_api');
    const apiRead = await client.query(`
      SELECT e.id, d.network, d.contract_id, e.organizer_account, e.asset_contract, e.state,
             e.deposit_atomic::text AS deposit_atomic, e.capacity,
             e.accepted_atomic::text AS accepted_atomic, e.liability_atomic::text AS liability_atomic
      FROM events_projection e JOIN deployments d ON d.id = e.deployment_id WHERE e.id = $1`, [ev.id]);
    const apiPass = await client.query(`SELECT pass_id, owner_account FROM passes_projection WHERE deployment_id=$1`, [deploymentId]);
    await client.query('RESET ROLE');
    check('DB_API_CAN_READ_EVENT', apiRead.rows[0]?.deposit_atomic === '5000000' && apiRead.rows[0]?.contract_id === DEP.contractId, 'API EVENT_SELECT returns projected event', apiRead.rows[0]?.deposit_atomic);
    check('DB_API_CAN_READ_PASS', apiPass.rows[0]?.pass_id === 'pass-local-0' && apiPass.rows[0]?.owner_account === 'bob.testnet', 'API role reads the projected pass', apiPass.rows[0]?.pass_id);

    // 4. Idempotent OLD replay: no duplicate rows and NO cursor regression.
    const countsBefore = { ch: await chainCount(), regs: regs.rows.length, pass: passes.rows.length };
    const oldReplay = await store.ingestBlock(deploymentId, blocks.publish);
    const cursorAfterOld = await store.readCursor(deploymentId);
    check('DB_OLD_REPLAY_NO_REGRESSION', cursorAfterOld.block_height === 101 && oldReplay.publishedEvents === 0 && (await chainCount()) === countsBefore.ch,
      'old replay is idempotent and cursor stays 101', `${cursorAfterOld.block_height}/${oldReplay.publishedEvents}`);

    // An old replay that introduces a previously-unseen event is refused.
    const oldUnknown = { ...blocks.publish, receipts: [{ receiptId: 'unknown-old-receipt', executorId: DEP.contractId, success: true, logs: [blocks.deposit.receipts[0].logs[0].replace('reg-local-0', 'reg-OLD-NEW')] }] };
    await expectReject('DB_OLD_REPLAY_UNKNOWN_EVENT_DENIED', () => store.ingestBlock(deploymentId, oldUnknown), 'unknown chain event');
    check('DB_OLD_REPLAY_UNKNOWN_CURSOR', (await store.readCursorHeight(deploymentId)) === 101, 'cursor still 101 after refused old replay', await store.readCursorHeight(deploymentId));

    // 5. Fork (same height, different hash) refused.
    registerBlock(canonical, { ...blocks.deposit, hash: 'H101F' });
    await expectReject('DB_FORK_DENIED', () => store.ingestBlock(deploymentId, { ...blocks.deposit, hash: 'H101F' }), 'fork');
    check('DB_FORK_CURSOR', (await store.readCursorHeight(deploymentId)) === 101, 'cursor still 101 after fork', await store.readCursorHeight(deploymentId));

    // 6. A source 404 / RPC UNKNOWN_BLOCK is NOT skip evidence. Heights 102
    //    "exists but is unavailable": the next block links to H102, not the cursor.
    const prunedGap = { height: 103, hash: 'H103G', prevHash: 'H102', prevHeight: 102, timestampMs: 1794000003000, receipts: [] };
    registerBlock(canonical, prunedGap);
    await expectReject('DB_PRUNED_HEIGHT_NOT_SKIPPED', () => store.ingestBlock(deploymentId, prunedGap), 'chain linkage');
    check('DB_PRUNED_GAP_CURSOR', (await store.readCursorHeight(deploymentId)) === 101, 'cursor still 101 after pruned-height attempt', await store.readCursorHeight(deploymentId));

    const hashGap = { ...prunedGap, hash: 'H103H', prevHash: 'H999', prevHeight: 101 };
    registerBlock(canonical, hashGap);
    await expectReject('DB_LINKAGE_PREVHASH_MISMATCH', () => store.ingestBlock(deploymentId, hashGap), 'chain linkage');

    const heightGap = { ...prunedGap, hash: 'H103I', prevHash: 'H101', prevHeight: 100 };
    registerBlock(canonical, heightGap);
    await expectReject('DB_LINKAGE_PREVHEIGHT_MISMATCH', () => store.ingestBlock(deploymentId, heightGap), 'chain linkage');

    // 7. Legitimate height gap: the next block's OFFICIAL prev_hash/prev_height
    //    link directly to the cursor, proving height 102 carries no canonical block.
    const skipped = await store.ingestBlock(deploymentId, blocks.wrongExecutor);
    check('DB_SKIP_LINKAGE_ACCEPTED', skipped.cursorHeight === 103, 'canonical prev-hash linkage advances across a legitimate gap to 103', `cursor=${skipped.cursorHeight}`);
    check('DB_RESUME_AFTER_SKIP', (await store.resolveStartHeight(deploymentId, startBlock)) === 104, 'resume gate returns cursor+1 = 104', 104);

    // 8. Failed receipt denied; cursor still advances past a fully-processed block.
    await store.ingestBlock(deploymentId, blocks.failed);
    const badReg = await client.query(`SELECT count(*)::int n FROM registrations_projection WHERE chain_registration_id='reg-BAD'`);
    check('DB_FAILED_RECEIPT_DENIED', badReg.rows[0].n === 0, 'failed receipt logs never project', badReg.rows[0].n);
    check('DB_CURSOR_AFTER_FAILED', (await store.readCursorHeight(deploymentId)) === 104, 'cursor 104 after failed-receipt block', await store.readCursorHeight(deploymentId));

    // 9. Crash rollback: fails INSIDE the tx after the chain_event insert.
    const chainBeforeCrash = await chainCount();
    await expectReject('DB_CRASH_ROLLBACK', () => store.ingestBlock(deploymentId, blocks.crash), 'not projected yet');
    const crashEvent = await client.query(`SELECT count(*)::int n FROM chain_events WHERE deployment_id=$1 AND receipt_id='local-receipt-crash'`, [deploymentId]);
    check('DB_CRASH_ROLLBACK_PROVEN', (await chainCount()) === chainBeforeCrash && crashEvent.rows[0].n === 0 && (await store.readCursorHeight(deploymentId)) === 104,
      'chain_event insert + projections + cursor all rolled back', `chain=${await chainCount()} event=${crashEvent.rows[0].n}`);

    // 10. Pre-transaction parse failures fail closed (cursor stays behind).
    await expectReject('DB_MALFORMED_THREW', () => store.ingestBlock(deploymentId, blocks.malformed), 'canonical u128');
    await expectReject('DB_UNSUPPORTED_THREW', () => store.ingestBlock(deploymentId, blocks.unsupported), 'unsupported showstake event');
    check('DB_CURSOR_AFTER_MALFORMED', (await store.readCursorHeight(deploymentId)) === 104, 'cursor still 104', await store.readCursorHeight(deploymentId));

    // 11. A valid provenance-only block at 105 advances the cursor.
    const prov = await store.ingestBlock(deploymentId, blocks.provenance);
    check('DB_PROVENANCE_ADVANCES', prov.provenanceEvents === 1 && prov.cursorHeight === 105, 'StorageDeposited captured as provenance, cursor 105', JSON.stringify({ provenance: prov.provenanceEvents, cursor: prov.cursorHeight }));

    // Same-height replay with an ALTERED payload must not be silently dropped by
    // ON CONFLICT: existing provenance is compared verbatim and the replay fails.
    const alteredProvenance = {
      ...blocks.provenance,
      receipts: [{ ...blocks.provenance.receipts[0], logs: [blocks.provenance.receipts[0].logs[0].replace('1250000000000000000000', '1')] }],
    };
    await expectReject('DB_REPLAY_PAYLOAD_MISMATCH_DENIED', () => store.ingestBlock(deploymentId, alteredProvenance), 'replay provenance mismatch');
    const storedPayload = await client.query(`SELECT payload::text AS p FROM chain_events WHERE deployment_id=$1 AND receipt_id='local-receipt-storage'`, [deploymentId]);
    check('DB_REPLAY_PAYLOAD_UNCHANGED', storedPayload.rows[0]?.p.includes('1250000000000000000000') && (await store.readCursorHeight(deploymentId)) === 105,
      'existing chain_event payload unchanged and cursor 105 after altered replay', storedPayload.rows[0]?.p);

    // 12. Foreign deployment id is refused INSIDE the transaction.
    const foreignBlock = commitBlock({ height: 106, hash: 'H106', registrationId: 'reg-foreign', passId: 'pass-foreign', eventSequence: 1, prevHash: 'H105P', prevHeight: 105 });
    registerBlock(canonical, foreignBlock);
    await expectReject('DB_FOREIGN_DEPLOYMENT_ID_DENIED', () => store.ingestBlock(OTHER_DEPLOYMENT_ID, foreignBlock), 'deployment contract_id mismatch');
    check('DB_FOREIGN_ID_CURSOR', (await store.readCursorHeight(deploymentId)) === 105, 'cursor still 105 after foreign-id ingest', await store.readCursorHeight(deploymentId));

    // 13. Canonical mismatch and non-final block are refused before any write.
    canonical.badHashes.add('H106BAD');
    await expectReject('DB_CANONICAL_MISMATCH_DENIED', () => store.ingestBlock(deploymentId, { height: 106, hash: 'H106BAD', timestampMs: 1794000106000, receipts: [] }), 'canonical check');
    const notFinal = new WorkerStore(pool, { ...DEP, startHeight: FIXTURE_START }, CONSUMER, makeFakeLiveChain(localView), makeFakeCanonical({ finalHeight: 100, headers: canonical.headers }));
    await expectReject('DB_NOT_FINAL_DENIED', () => notFinal.ingestBlock(deploymentId, blocks.deposit), 'is not final');
    check('DB_CANONICAL_CURSOR', (await store.readCursorHeight(deploymentId)) === 105, 'cursor still 105 after canonical/finality refusal', await store.readCursorHeight(deploymentId));

    // 14. Pinned view mismatch refused.
    const pinnedWrong = new WorkerStore(pool, { ...DEP, startHeight: FIXTURE_START }, CONSUMER, makeFakeLiveChain(localView, { pin: { height: 999, hash: 'H999' } }), canonical);
    const pubLog109 = blocks.publish.receipts[0].logs[0];
    const republish106 = { height: 106, hash: 'H106', prevHash: 'H105P', prevHeight: 105, timestampMs: 1794000106000, receipts: [{ receiptId: 'republish-109', executorId: DEP.contractId, success: true, logs: [pubLog109] }] };
    registerBlock(canonical, republish106);
    await expectReject('DB_PINNED_VIEW_MISMATCH_DENIED', () => pinnedWrong.ingestBlock(deploymentId, republish106), 'pinned to block 999');

    // 15. Two connections, DIFFERENT heights, higher height attempted FIRST:
    //     the higher block must be rejected as a gap (no skip), the lower block
    //     applies, then the retry of the higher block advances — never a skip or
    //     regression, exactly once.
    const poolA = await createWorkerPool({ ...workerCfg(), application_name: 'showstake-worker-acceptance-A' });
    const poolB = await createWorkerPool({ ...workerCfg(), application_name: 'showstake-worker-acceptance-B' });
    pools.push(poolA, poolB);
    const storeA = new WorkerStore(poolA, { ...DEP, startHeight: FIXTURE_START }, CONSUMER, makeFakeLiveChain(localView), canonical);
    const storeB = new WorkerStore(poolB, { ...DEP, startHeight: FIXTURE_START }, CONSUMER, makeFakeLiveChain(localView), canonical);
    const block106 = commitBlock({ height: 106, hash: 'H106', registrationId: 'reg-local-1', passId: 'pass-local-1', eventSequence: 1, participant: 'carol.testnet', prevHash: 'H105P', prevHeight: 105 });
    const block107 = commitBlock({ height: 107, hash: 'H107', registrationId: 'reg-local-2', passId: 'pass-local-2', eventSequence: 2, participant: 'dave.testnet', prevHash: 'H106', prevHeight: 106 });
    registerBlock(canonical, block106);
    registerBlock(canonical, block107);

    const blocker = await rawClient(DB());
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`${deploymentId}:${CONSUMER}`]);
      const highFirst = storeB.ingestBlock(deploymentId, block107).then(() => null, (e) => e);
      let waiters = 0;
      for (let i = 0; i < 100 && waiters === 0; i++) {
        const r = await blocker.query(`SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND NOT granted`);
        waiters = r.rows[0].n;
        if (waiters === 0) await sleep(25);
      }
      check('DB_CONCURRENT_LOCK_WAITER', waiters >= 1, 'higher-height ingest waits on the transaction advisory lock', `waiters=${waiters}`);
      await blocker.query('COMMIT');
      const highErr = await highFirst;
      check('DB_CONCURRENT_HIGHER_FIRST_GAP_DENIED', highErr instanceof Error && highErr.message.includes('chain linkage'), 'higher block first is rejected by canonical prev-hash linkage', highErr instanceof Error ? highErr.message : 'no error');
      check('DB_CONCURRENT_GAP_CURSOR', (await store.readCursorHeight(deploymentId)) === 105, 'cursor still 105 after higher-first gap', await store.readCursorHeight(deploymentId));

      const low = await storeA.ingestBlock(deploymentId, block106);
      check('DB_CONCURRENT_LOWER_APPLIED', low.cursorHeight === 106, 'lower block applies after the higher rejection', low.cursorHeight);
      const retry = await storeB.ingestBlock(deploymentId, block107);
      check('DB_CONCURRENT_RETRY_ADVANCES', retry.cursorHeight === 107, 'retried higher block advances to 107', retry.cursorHeight);
    } finally {
      await blocker.end().catch(() => {});
    }
    const concurrencyRows = await client.query(`
      SELECT chain_registration_id, count(*)::int n FROM registrations_projection
       WHERE chain_registration_id IN ('reg-local-1','reg-local-2') GROUP BY chain_registration_id ORDER BY 1`);
    const concurrencyPasses = await client.query(`SELECT count(*)::int n FROM passes_projection WHERE pass_id IN ('pass-local-1','pass-local-2')`);
    const concurrentTotals = await client.query(`SELECT accepted_atomic::text a, liability_atomic::text l FROM events_projection WHERE id=$1`, [ev.id]);
    check('DB_CONCURRENT_EXACTLY_ONCE', concurrencyRows.rows.length === 2 && concurrencyRows.rows.every((r) => r.n === 1) && concurrencyPasses.rows[0].n === 2 && concurrentTotals.rows[0].a === '15000000' && concurrentTotals.rows[0].l === '15000000',
      'both concurrent commits applied exactly once, totals 15000000', JSON.stringify({ regs: concurrencyRows.rows, passes: concurrencyPasses.rows[0].n, totals: concurrentTotals.rows[0] }));

    // 16. Same-height overlap on two connections => exactly once.
    const block108 = commitBlock({ height: 108, hash: 'H108', registrationId: 'reg-local-3', passId: 'pass-local-3', eventSequence: 3, participant: 'erin.testnet', prevHash: 'H107', prevHeight: 107 });
    registerBlock(canonical, block108);
    await Promise.all([storeA.ingestBlock(deploymentId, block108), storeB.ingestBlock(deploymentId, block108)]);
    const reg108 = await client.query(`SELECT count(*)::int n FROM registrations_projection WHERE chain_registration_id='reg-local-3'`);
    const pass108 = await client.query(`SELECT count(*)::int n FROM passes_projection WHERE pass_id='pass-local-3'`);
    const totals108 = await client.query(`SELECT accepted_atomic::text a FROM events_projection WHERE id=$1`, [ev.id]);
    check('DB_OVERLAP_SAME_HEIGHT_EXACTLY_ONCE', reg108.rows[0].n === 1 && pass108.rows[0].n === 1 && totals108.rows[0].a === '20000000',
      'overlapping same-height ingest applies exactly once', `${reg108.rows[0].n}/${pass108.rows[0].n}/${totals108.rows[0].a}`);
    check('DB_CURSOR_FINAL', (await store.readCursor(deploymentId))?.block_height === 108, 'cursor 108', (await store.readCursorHeight(deploymentId)));

    // 16b. Conditional expected-previous cursor write: a stale expected state is
    //      refused (and rolled back), and first creation cannot race an existing row.
    await client.query('BEGIN');
    await client.query(`UPDATE worker_cursors SET cursor_value=$3::jsonb WHERE deployment_id=$1 AND consumer=$2`, [deploymentId, CONSUMER, JSON.stringify({ block_height: 109, block_hash: 'H109' })]);
    await expectReject('DB_CURSOR_EXPECTED_PREVIOUS_GUARD', () => store.writeCursor(client, deploymentId, { block_height: 110, block_hash: 'H110' }, { block_height: 108, block_hash: 'H108' }), 'expected-previous-state');
    await client.query('ROLLBACK');
    check('DB_CURSOR_AFTER_STALE_WRITE', (await store.readCursorHeight(deploymentId)) === 108, 'stale conditional write rolled back; cursor 108', await store.readCursorHeight(deploymentId));

    const raceStore = new WorkerStore(pool, { ...DEP, startHeight: FIXTURE_START }, 'cursor-race', makeFakeLiveChain(localView), canonical);
    await client.query(`INSERT INTO worker_cursors (deployment_id, consumer, cursor_value, updated_at) VALUES ($1, 'cursor-race', $2::jsonb, now())`, [deploymentId, JSON.stringify({ block_height: 108, block_hash: 'H108' })]);
    await expectReject('DB_CURSOR_CREATION_RACE_GUARD', () => raceStore.writeCursor(client, deploymentId, { block_height: 109, block_hash: 'H109' }, null), 'creation raced');
    await client.query(`DELETE FROM worker_cursors WHERE deployment_id=$1 AND consumer='cursor-race'`, [deploymentId]);

    // 17. Malformed cursor state fails closed (never "restart at null").
    await client.query(`UPDATE worker_cursors SET cursor_value='null'::jsonb WHERE deployment_id=$1 AND consumer=$2`, [deploymentId, CONSUMER]);
    await expectReject('DB_MALFORMED_CURSOR_READ', () => store.readCursor(deploymentId), 'not an object');
    const malformedCursorBlock = { height: 109, hash: 'H109', prevHash: 'H108', prevHeight: 108, timestampMs: 1794000109000, receipts: [] };
    registerBlock(canonical, malformedCursorBlock);
    await expectReject('DB_MALFORMED_CURSOR_INGEST', () => store.ingestBlock(deploymentId, malformedCursorBlock), 'not an object');
    const malformedRow = await client.query(`SELECT cursor_value::text v FROM worker_cursors WHERE deployment_id=$1 AND consumer=$2`, [deploymentId, CONSUMER]);
    check('DB_MALFORMED_CURSOR_UNCHANGED', malformedRow.rows[0].v === 'null', 'malformed cursor state is not repaired/overwritten', malformedRow.rows[0].v);
    await client.query(`UPDATE worker_cursors SET cursor_value=$3::jsonb WHERE deployment_id=$1 AND consumer=$2`, [deploymentId, CONSUMER, JSON.stringify({ block_height: 108, block_hash: 'H108' })]);
    check('DB_CURSOR_RESTORED', (await store.readCursor(deploymentId))?.block_hash === 'H108', 'cursor restored after malformed-state proof', 'H108');

    // 18. Whole-suite consistency: one projection per committed chain event.
    const finalChain = await client.query(`SELECT event_name, count(*)::int n FROM chain_events WHERE deployment_id=$1 GROUP BY event_name ORDER BY event_name`, [deploymentId]);
    const finalRegs = await client.query(`SELECT count(*)::int n FROM registrations_projection`);
    const finalPasses = await client.query(`SELECT count(*)::int n FROM passes_projection`);
    const expectedCommits = finalChain.rows.find((r) => r.event_name === 'RegistrationCommitted')?.n ?? 0;
    check('DB_PROJECTION_CONSISTENCY', expectedCommits === 4 && finalRegs.rows[0].n === 4 && finalPasses.rows[0].n === 4 && finalChain.rows.find((r) => r.event_name === 'StorageDeposited')?.n === 1,
      '4 committed chain events -> 4 registrations/passes; storage provenance captured', JSON.stringify({ chain: finalChain.rows, regs: finalRegs.rows[0].n, passes: finalPasses.rows[0].n }));

    // 19. v6 settlement lifecycle (separate settle deployment + consumer):
    //      attendance provisional -> finalize freeze -> settlement allocation with
    //      no-show forfeit -> payout start/fail/retry/success (no double count).
    const DEP6 = SETTLE_DEPLOYMENT;
    const SO_SETTLE_DEPLOYMENT_ID = '00000000-0000-4000-8000-0000000000d1';
    await client.query(`
      INSERT INTO deployments (id, environment, network, contract_id, ft_contract_id, ft_decimals, start_block, code_hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (network, contract_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, start_block = EXCLUDED.start_block`,
      [SO_SETTLE_DEPLOYMENT_ID, DEP6.environment, DEP6.network, DEP6.contractId, DEP6.ftContractId, DEP6.ftDecimals, 200, DEP6.codeHash]);

    const settleView = {
      event_id: 'evt-settle-1', organizer: DEP6.organizer, canonical_ft: DEP6.ftContractId, rules_hash: 'rules-settle-1',
      deposit: '5000000', capacity: 5,
      reg_open: 1794050511780, reg_close: 1794072171780, cancel_cutoff: 1794072171780,
      checkin_open: 1794072171780, checkin_close: 1794075771780, finalize_deadline: 1794162171780,
      policy_version: DEP6.policyVersion, state: 'Published',
    };
    const settlementView = {
      event_id: 'evt-settle-1', state: 'Settled', attendance_frozen: true, attendee_count: 2, no_show_count: 1,
      registrations: 3, pool: '5000000', base_share: '2500000', remainder: '0', allocated_total: '15000000', complete: true, claims_enabled: true,
    };
    const totalsFor = (h) => {
      if (h <= 207) return { event_id: 'evt-settle-1', state: 'Settled', accepted_principal: '15000000', paid: '0', pending: '0', liability: '15000000' };
      if (h === 208 || h === 210) return { event_id: 'evt-settle-1', state: 'Settled', accepted_principal: '15000000', paid: '0', pending: '7500000', liability: '7500000' };
      if (h === 209) return { event_id: 'evt-settle-1', state: 'Settled', accepted_principal: '15000000', paid: '0', pending: '0', liability: '15000000' };
      if (h === 211) return { event_id: 'evt-settle-1', state: 'Settled', accepted_principal: '15000000', paid: '7500000', pending: '0', liability: '7500000' };
      return { event_id: 'evt-settle-1', state: 'Settled', accepted_principal: '15000000', paid: '15000000', pending: '0', liability: '0' };
    };
    const payoutFor = (payoutId, h) => {
      // state is end-of-block terminal; the worker derives transitions from EVENT
      // data and only verifies identity+amount against this view (no state assert).
      if (payoutId === 'pay-reg-s-0-1') return { payout_id: payoutId, registration_id: 'reg-s-0', event_id: 'evt-settle-1', beneficiary: 'bob.testnet', amount: '7500000', state: h >= 209 ? 'Failed' : 'Pending' };
      if (payoutId === 'pay-reg-s-0-2') return { payout_id: payoutId, registration_id: 'reg-s-0', event_id: 'evt-settle-1', beneficiary: 'bob.testnet', amount: '7500000', state: 'Succeeded' };
      return { payout_id: payoutId, registration_id: 'reg-s-1', event_id: 'evt-settle-1', beneficiary: 'carol.testnet', amount: '7500000', state: 'Succeeded' };
    };
    function makeSettleLiveChain() {
      return {
        viewSource: {
          async callView(method, args, blockRef) {
            const h = Number(String(blockRef).replace(/^S/, ''));
            if (method === 'get_config') return { result: { organizer: DEP6.organizer, canonical_ft: DEP6.ftContractId, network: DEP6.network, policy_version: DEP6.policyVersion }, blockHeight: h, blockHash: blockRef };
            if (method === 'ft_metadata') return { result: { decimals: DEP6.ftDecimals, symbol: 'SS' }, blockHeight: h, blockHash: blockRef };
            if (method === 'get_event') return { result: settleView, blockHeight: h, blockHash: blockRef };
            if (method === 'get_settlement') return { result: settlementView, blockHeight: h, blockHash: blockRef };
            if (method === 'get_event_totals') return { result: totalsFor(h), blockHeight: h, blockHash: blockRef };
            if (method === 'get_payout') return { result: payoutFor(args.args.payout_id, h), blockHeight: h, blockHash: blockRef };
            throw new Error(`unexpected view ${method}`);
          },
        },
        async accountCodeHash() { return DEP6.codeHash; },
      };
    }

    const settleCanonical = makeFakeCanonical();
    const settleBlock = (height, receiptId, logs) => {
      const b = block({
        height, hash: `S${height}`, prevHash: `S${height - 1}`, prevHeight: height - 1,
        timestampMs: 1794100000000 + height * 1000,
        receipts: [receipt({ id: receiptId, executorId: DEP6.contractId, logs })],
      });
      registerBlock(settleCanonical, b);
      return b;
    };
    const settleBlocks = {
      publish: settleBlock(200, 's-receipt-publish', [log('EventPublished', { event_id: 'evt-settle-1', organizer: DEP6.organizer, deposit: '5000000', capacity: 5, finalize_deadline: 1794162171780, policy_version: DEP6.policyVersion, storage_cost_yocto: '0' })]),
      c0: settleBlock(201, 's-receipt-c0', [log('RegistrationCommitted', { event_id: 'evt-settle-1', registration_id: 'reg-s-0', pass_id: 'pass-s-0', participant: 'bob.testnet', beneficiary: 'bob.testnet', commitment_id: 'commit-s-0', amount: '5000000', event_sequence: 0, storage_cost_yocto: '0' })]),
      c1: settleBlock(202, 's-receipt-c1', [log('RegistrationCommitted', { event_id: 'evt-settle-1', registration_id: 'reg-s-1', pass_id: 'pass-s-1', participant: 'carol.testnet', beneficiary: 'carol.testnet', commitment_id: 'commit-s-1', amount: '5000000', event_sequence: 1, storage_cost_yocto: '0' })]),
      c2: settleBlock(203, 's-receipt-c2', [log('RegistrationCommitted', { event_id: 'evt-settle-1', registration_id: 'reg-s-2', pass_id: 'pass-s-2', participant: 'dave.testnet', beneficiary: 'dave.testnet', commitment_id: 'commit-s-2', amount: '5000000', event_sequence: 2, storage_cost_yocto: '0' })]),
      a0: settleBlock(204, 's-receipt-a0', [log('AttendanceMarked', { event_id: 'evt-settle-1', registration_id: 'reg-s-0', attended: true, changed: true })]),
      a1: settleBlock(205, 's-receipt-a1', [log('AttendanceMarked', { event_id: 'evt-settle-1', registration_id: 'reg-s-1', attended: true, changed: true })]),
      fin: settleBlock(206, 's-receipt-fin', [log('EventFinalized', { event_id: 'evt-settle-1', attendee_count: 2, no_show_count: 1, total_registrations: 3, finalized_at: 1794100000000 })]),
      settle: settleBlock(207, 's-receipt-settle', [log('SettlementStarted', { event_id: 'evt-settle-1', pool: '5000000', base_share: '2500000', remainder: '0', attendee_count: 2, actor: DEP6.organizer }), log('EventSettled', { event_id: 'evt-settle-1', allocated_total: '15000000', attendee_count: 2, no_show_count: 1, total_registrations: 3 })]),
      pstart: settleBlock(208, 's-receipt-pstart', [log('PayoutStarted', { payout_id: 'pay-reg-s-0-1', registration_id: 'reg-s-0', event_id: 'evt-settle-1', beneficiary: 'bob.testnet', amount: '7500000' })]),
      pfail: settleBlock(209, 's-receipt-pfail', [log('PayoutFailed', { payout_id: 'pay-reg-s-0-1', registration_id: 'reg-s-0', event_id: 'evt-settle-1', beneficiary: 'bob.testnet', amount: '7500000' })]),
      pretry: settleBlock(210, 's-receipt-pretry', [log('PayoutStarted', { payout_id: 'pay-reg-s-0-2', registration_id: 'reg-s-0', event_id: 'evt-settle-1', beneficiary: 'bob.testnet', amount: '7500000' })]),
      pok: settleBlock(211, 's-receipt-pok', [log('PayoutSucceeded', { payout_id: 'pay-reg-s-0-2', registration_id: 'reg-s-0', event_id: 'evt-settle-1', beneficiary: 'bob.testnet', amount: '7500000' })]),
      // reg-s-1 start + private callback SUCCEEDED in the SAME block: the pinned
      // end-of-block get_payout already reads Succeeded, so the start event must
      // not assert Pending (event-derived transitions + one per-block reconcile).
      sameBlock: settleBlock(212, 's-receipt-sameblock', [log('PayoutStarted', { payout_id: 'pay-reg-s-1-1', registration_id: 'reg-s-1', event_id: 'evt-settle-1', beneficiary: 'carol.testnet', amount: '7500000' }), log('PayoutSucceeded', { payout_id: 'pay-reg-s-1-1', registration_id: 'reg-s-1', event_id: 'evt-settle-1', beneficiary: 'carol.testnet', amount: '7500000' })]),
    };

    const settleStore = new WorkerStore(pool, { ...DEP6, startHeight: 200 }, 'showstake-worker-settle', makeSettleLiveChain(), settleCanonical);
    const { id: settleDeploymentId, startBlock: settleStartBlock } = await settleStore.resolveDeployment();
    check('DB_SETTLE_DEPLOYMENT_RESOLVED', settleDeploymentId === SO_SETTLE_DEPLOYMENT_ID && settleStartBlock === 200, 'settle deployment resolved at start 200', `${settleDeploymentId}/${settleStartBlock}`);

    await settleStore.ingestBlock(settleDeploymentId, settleBlocks.publish);
    await settleStore.ingestBlock(settleDeploymentId, settleBlocks.c0);
    await settleStore.ingestBlock(settleDeploymentId, settleBlocks.c1);
    await settleStore.ingestBlock(settleDeploymentId, settleBlocks.c2);
    await settleStore.ingestBlock(settleDeploymentId, settleBlocks.a0);
    await settleStore.ingestBlock(settleDeploymentId, settleBlocks.a1);
    await settleStore.ingestBlock(settleDeploymentId, settleBlocks.fin);

    const settleEvent = await client.query(`SELECT id, state FROM events_projection WHERE deployment_id=$1 AND chain_event_id='evt-settle-1'`, [settleDeploymentId]);
    check('DB_SETTLE_FINALIZED', settleEvent.rows[0]?.state === 'ATTENDANCE_FINALIZED', 'event ATTENDANCE_FINALIZED after finalize', settleEvent.rows[0]?.state);
    const finRegs = await client.query(`SELECT chain_registration_id, state, attended FROM registrations_projection WHERE event_id=$1 ORDER BY sequence_no ASC`, [settleEvent.rows[0].id]);
    check('DB_SETTLE_ATTENDANCE_FROZEN', finRegs.rows.length === 3 && finRegs.rows.filter((r) => r.state === 'ATTENDED').length === 2 && finRegs.rows.filter((r) => r.state === 'NO_SHOW').length === 1,
      'attendance frozen: 2 ATTENDED, 1 NO_SHOW', JSON.stringify(finRegs.rows.map((r) => [r.chain_registration_id, r.state])));

    await settleStore.ingestBlock(settleDeploymentId, settleBlocks.settle);
    const settledEvent = await client.query(`SELECT id, state, accepted_atomic::text a, paid_atomic::text p, pending_atomic::text pen, liability_atomic::text l FROM events_projection WHERE deployment_id=$1 AND chain_event_id='evt-settle-1'`, [settleDeploymentId]);
    check('DB_SETTLE_SETTLED', settledEvent.rows[0]?.state === 'SETTLED' && settledEvent.rows[0].a === '15000000' && settledEvent.rows[0].l === '15000000', 'event SETTLED with accepted=liability=15000000', JSON.stringify(settledEvent.rows[0]));
    const settleAllocs = await client.query(`SELECT chain_registration_id, claim_atomic::text c, payout_state s, principal_atomic::text d FROM registrations_projection WHERE event_id=$1 ORDER BY sequence_no ASC`, [settleEvent.rows[0].id]);
    const allocs = settleAllocs.rows;
    check('DB_SETTLE_ALLOCATION', allocs.length === 3 && allocs[0].c === '7500000' && allocs[0].s === 'CLAIMABLE' && allocs[1].c === '7500000' && allocs[1].s === 'CLAIMABLE' && allocs[2].c === '0' && allocs[2].s === 'ZERO',
      'attendees 7500000 CLAIMABLE; no-show 0 ZERO (Forfeited->ZERO)', JSON.stringify(allocs.map((r) => [r.chain_registration_id, r.c, r.s])));
    check('DB_SETTLE_PRINCIPAL_UNCHANGED', allocs.every((r) => r.d === '5000000'), 'principal stays D=5000000 (claim is reward+principal)', JSON.stringify(allocs.map((r) => r.d)));
    check('DB_SETTLE_CONSERVATION', allocs.reduce((s, r) => s + BigInt(r.c), 0n).toString() === '15000000', 'sum(claim_atomic) == accepted == allocated_total', allocs.reduce((s, r) => s + BigInt(r.c), 0n).toString());

    await settleStore.ingestBlock(settleDeploymentId, settleBlocks.pstart);
    const afterStart = await client.query(`SELECT paid_atomic::text p, pending_atomic::text pen, liability_atomic::text l FROM events_projection WHERE id=$1`, [settleEvent.rows[0].id]);
    check('DB_SETTLE_PAYOUT_PENDING', afterStart.rows[0].p === '0' && afterStart.rows[0].pen === '7500000' && afterStart.rows[0].l === '7500000', 'PayoutStarted -> pending 7500000, liability 7500000', JSON.stringify(afterStart.rows[0]));

    await settleStore.ingestBlock(settleDeploymentId, settleBlocks.pfail);
    const afterFail = await client.query(`SELECT pending_atomic::text pen, liability_atomic::text l FROM events_projection WHERE id=$1`, [settleEvent.rows[0].id]);
    const regs0AfterFail = await client.query(`SELECT payout_state FROM registrations_projection WHERE chain_registration_id='reg-s-0' AND event_id=$1`, [settleEvent.rows[0].id]);
    check('DB_SETTLE_PAYOUT_FAIL_RESTORES', afterFail.rows[0].pen === '0' && afterFail.rows[0].l === '15000000' && regs0AfterFail.rows[0].payout_state === 'CLAIMABLE',
      'PayoutFailed restores claimable + liability; no double count', JSON.stringify({ t: afterFail.rows[0], st: regs0AfterFail.rows[0].payout_state }));

    await settleStore.ingestBlock(settleDeploymentId, settleBlocks.pretry);
    await settleStore.ingestBlock(settleDeploymentId, settleBlocks.pok);
    const afterOk = await client.query(`SELECT paid_atomic::text p, pending_atomic::text pen, liability_atomic::text l FROM events_projection WHERE id=$1`, [settleEvent.rows[0].id]);
    const regs0AfterOk = await client.query(`SELECT payout_state FROM registrations_projection WHERE chain_registration_id='reg-s-0' AND event_id=$1`, [settleEvent.rows[0].id]);
    const payouts = await client.query(`SELECT payout_id, state, amount_atomic::text a FROM payouts_projection ORDER BY payout_id ASC`);
    check('DB_SETTLE_RETRY_PAID_ONCE', afterOk.rows[0].p === '7500000' && afterOk.rows[0].pen === '0' && afterOk.rows[0].l === '7500000' && regs0AfterOk.rows[0].payout_state === 'PAID',
      'retry paid once: paid 7500000, liability 7500000, registration PAID', JSON.stringify({ t: afterOk.rows[0], st: regs0AfterOk.rows[0].payout_state }));
    check('DB_SETTLE_NO_DOUBLE_COUNT', payouts.rows.length === 2 && payouts.rows.some((r) => r.payout_id === 'pay-reg-s-0-1' && r.state === 'FAILED') && payouts.rows.some((r) => r.payout_id === 'pay-reg-s-0-2' && r.state === 'SUCCEEDED' && r.a === '7500000'),
      'two payout rows: FAILED + SUCCEEDED, exactly once', JSON.stringify(payouts.rows));

    // Same-block start + callback: event-derived transitions + ONE per-block
    // totals reconcile (the start's get_payout already reads Succeeded).
    await settleStore.ingestBlock(settleDeploymentId, settleBlocks.sameBlock);
    const afterSame = await client.query(`SELECT paid_atomic::text p, pending_atomic::text pen, liability_atomic::text l FROM events_projection WHERE id=$1`, [settleEvent.rows[0].id]);
    const regs1 = await client.query(`SELECT payout_state FROM registrations_projection WHERE chain_registration_id='reg-s-1' AND event_id=$1`, [settleEvent.rows[0].id]);
    const payoutsSame = await client.query(`SELECT payout_id, state, amount_atomic::text a FROM payouts_projection WHERE payout_id='pay-reg-s-1-1'`);
    check('DB_SETTLE_SAME_BLOCK_CALLBACK', afterSame.rows[0].p === '15000000' && afterSame.rows[0].pen === '0' && afterSame.rows[0].l === '0' && regs1.rows[0].payout_state === 'PAID' && payoutsSame.rows.length === 1 && payoutsSame.rows[0].state === 'SUCCEEDED',
      'same-block start+callback: reg-s-1 PAID, totals paid=15000000, payout SUCCEEDED once', JSON.stringify({ t: afterSame.rows[0], st: regs1.rows[0].payout_state, po: payoutsSame.rows }));

    // Batch resume: a fresh store over the same durable cursor resumes at cursor+1.
    const resumeStore = new WorkerStore(pool, { ...DEP6, startHeight: 200 }, 'showstake-worker-settle', makeSettleLiveChain(), settleCanonical);
    const resumeFrom = await resumeStore.resolveStartHeight(settleDeploymentId, settleStartBlock);
    check('DB_SETTLE_BATCH_RESUME', resumeFrom === 213, 'resolveStartHeight resumes from cursor+1 = 213 (same DB lifecycle)', resumeFrom);

    await candidateDbTest({client, pool, canonical, registerBlock, check});
    await factoryDbTest({client, pool, check});
    await linkedDbTest({client, pool, canonical, registerBlock, check});
    const failed = results.filter((r) => !r.ok);
    const summary = {
      id: 'worker-increment-db',
      task: 'apps/worker receipt projection + v6 settlement lifecycle (disposable PostgreSQL acceptance)',
      classifier: failed.length === 0 ? 'PASS_LOCAL' : 'FAILED',
      ok: failed.length === 0,
      reviewer_pending: true,
      run_id: RUN_ID(),
      environment: { os: 'Windows + WSL2 (Linux Node over per-run Unix socket)', postgresql: 'disposable postgresql-18 cluster', database: DB(), socket: SOCKET() },
      executor: process.env.SHOWSTAKE_TEST_EXECUTOR || 'unspecified',
      totals: { checks: results.length, failed: failed.length },
      checks: results,
      commands: ['bash scripts/postgres-disposable/run-worker-suite.sh', 'node apps/worker/test/verify-worker-fixtures.mjs (no-DB adversarial)'],
      note: 'LABELED local: deterministic fixture receipts; real disposable PostgreSQL; NO network. Proves R1 cursor invariants (tx advisory lock incl. first creation, exact-start incl. fail-closed missing initial block, monotonic advancement only through official canonical prev_hash/prev_height linkage across legitimate gaps, fork and pruned-height/hash/height mismatch rejection, old replay without regression, verbatim replay provenance/payload comparison, conditional expected-previous upsert, malformed-cursor fail-closed, crash rollback, two-connection different-height opposite-order and same-height exactly-once), source-vs-official header consistency, R5 in-tx deployment/allowlist bind + actual FT metadata decimals + NOINHERIT/RESET ROLE guard, API-role read of the projected event and pass, AND the v6 settlement lifecycle: provisional attendance -> frozen ATTENDED/NO_SHOW, deterministic allocation (attendees D+share CLAIMABLE, no-show Forfeited->ZERO, principal D unchanged), conservation sum(claim)==accepted==allocated_total, payout start/fail/retry/success with exactly-once accounting and no double count, plus a same-block start+callback regression (event-derived transitions + one per-block totals reconcile) and a same-DB-lifecycle batch-resume regression (resolveStartHeight returns cursor+1).',
    };
    if (ARTIFACTS()) {
      await mkdir(ARTIFACTS(), { recursive: true });
      await writeFile(join(ARTIFACTS(), 'worker-db.json'), JSON.stringify(summary, null, 2));
    }
    await writeFile(join(ROOT, 'docs', 'evidence', `worker-db-${RUN_ID()}.json`), JSON.stringify(summary, null, 2) + '\n');
    console.log(`\nverify-worker-db: ${results.length - failed.length}/${results.length} checks`);
    return summary;
  } finally {
    for (const p of pools) await p.end().catch(() => {});
    await client.end().catch(() => {});
  }
}

const deadline = setTimeout(() => { console.error('verify-worker-db FAILED: suite deadline'); process.exit(1); }, 240000);
try {
  const summary = await main();
  clearTimeout(deadline);
  process.exit(summary.ok ? 0 : 1);
} catch (e) {
  clearTimeout(deadline);
  console.error('verify-worker-db FATAL:', e instanceof Error ? e.message : String(e));
  process.exit(1);
}
