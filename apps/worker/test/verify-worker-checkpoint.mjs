// LOCAL checkpoint dump/stop/restore/resume driver (NO network, NO public RPC).
//
// Phases (driven by scripts/postgres-disposable/run-worker-checkpoint.sh):
//   seed      — ingest batch A (publish..finalize) into a fresh disposable DB,
//               leaving the durable cursor at block 206 for pg_dump.
//   resume    — after restoring the dump into a NEW DB, verify the cursor==206
//               (restored identity), ingest batch B (settle..payouts), and assert
//               the final projection EQUALS the uninterrupted single-run result.
//   wrongdeploy — after restoring a dump whose deployment differs from the
//               allowlist, resolveDeployment must fail closed (no event rights).
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createWorkerPool, WorkerStore } from '../dist/store.js';
import { listMigrations, runMigrations, connectConfig } from '../../../migrations/runner.mjs';
import { SETTLE_DEPLOYMENT, block, receipt, log } from './fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../../..');
const SCHEMA_DIR = join(ROOT, 'migrations', 'schema');

const DB = () => process.env.SHOWSTAKE_PG_DB1 || 'showstake_disposable';
const SOCKET = () => process.env.SHOWSTAKE_PG_SOCKET || null;
const SERVICE_USER = () => process.env.SHOWSTAKE_PG_SERVICE_USER || 'showstake_worker_service';

const DEP = SETTLE_DEPLOYMENT;
const DEPLOYMENT_ID = '00000000-0000-4000-8000-0000000000d1';
const CONSUMER = 'showstake-worker-checkpoint';

const results = [];
function check(id, ok, expected, observed) {
  results.push({ id, ok: Boolean(ok), expected, observed, classifier: 'PASS_LOCAL' });
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${id}  (observed: ${observed})`);
}
async function expectReject(id, fn, contains) {
  try { await fn(); check(id, false, `rejects (${contains})`, 'did not reject'); }
  catch (e) { const m = e instanceof Error ? e.message : String(e); check(id, m.includes(contains), `rejects (${contains})`, m); }
}
async function pgMod() { const m = await import('pg'); return m.default ?? m; }
async function rawClient() { const { Client } = await pgMod(); const c = new Client(connectConfig(DB(), SOCKET())); await c.connect(); return c; }

const settleView = {
  event_id: 'evt-settle-1', organizer: DEP.organizer, canonical_ft: DEP.ftContractId, rules_hash: 'rules-settle-1',
  deposit: '5000000', capacity: 5, reg_open: 1794050511780, reg_close: 1794072171780, cancel_cutoff: 1794072171780,
  checkin_open: 1794072171780, checkin_close: 1794075771780, finalize_deadline: 1794162171780, policy_version: DEP.policyVersion, state: 'Published',
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
  if (payoutId === 'pay-reg-s-0-1') return { payout_id: payoutId, registration_id: 'reg-s-0', event_id: 'evt-settle-1', beneficiary: 'bob.testnet', amount: '7500000', state: h >= 209 ? 'Failed' : 'Pending' };
  if (payoutId === 'pay-reg-s-0-2') return { payout_id: payoutId, registration_id: 'reg-s-0', event_id: 'evt-settle-1', beneficiary: 'bob.testnet', amount: '7500000', state: 'Succeeded' };
  return { payout_id: payoutId, registration_id: 'reg-s-1', event_id: 'evt-settle-1', beneficiary: 'carol.testnet', amount: '7500000', state: 'Succeeded' };
};
function makeLiveChain() {
  return {
    viewSource: {
      async callView(method, args, blockRef) {
        const h = Number(String(blockRef).replace(/^S/, ''));
        if (method === 'get_config') return { result: { organizer: DEP.organizer, canonical_ft: DEP.ftContractId, network: DEP.network, policy_version: DEP.policyVersion }, blockHeight: h, blockHash: blockRef };
        if (method === 'ft_metadata') return { result: { decimals: DEP.ftDecimals, symbol: 'SS' }, blockHeight: h, blockHash: blockRef };
        if (method === 'get_event') return { result: settleView, blockHeight: h, blockHash: blockRef };
        if (method === 'get_settlement') return { result: settlementView, blockHeight: h, blockHash: blockRef };
        if (method === 'get_event_totals') return { result: totalsFor(h), blockHeight: h, blockHash: blockRef };
        if (method === 'get_payout') return { result: payoutFor(args.args.payout_id, h), blockHeight: h, blockHash: blockRef };
        throw new Error(`unexpected view ${method}`);
      },
    },
    async accountCodeHash() { return DEP.codeHash; },
  };
}
function makeCanonical() {
  const headers = new Map();
  const reg = (b) => headers.set(b.hash, { height: b.height, prevHash: b.prevHash, prevHeight: b.prevHeight });
  return { headers, async lastFinalHeight() { return 1_000_000; }, async verifyBlock(height, hash) { const h = headers.get(hash); if (!h || h.height !== height) throw new Error(`canonical check: no header for ${hash}@${height}`); return { height, hash, prevHash: h.prevHash, prevHeight: h.prevHeight }; }, reg };
}
const mk = (height, receiptId, logs) => block({ height, hash: `S${height}`, prevHash: `S${height - 1}`, prevHeight: height - 1, timestampMs: 1794100000000 + height * 1000, receipts: [receipt({ id: receiptId, executorId: DEP.contractId, logs })] });
const blocks = {
  publish: mk(200, 's-receipt-publish', [log('EventPublished', { event_id: 'evt-settle-1', organizer: DEP.organizer, deposit: '5000000', capacity: 5, finalize_deadline: 1794162171780, policy_version: DEP.policyVersion, storage_cost_yocto: '0' })]),
  c0: mk(201, 's-receipt-c0', [log('RegistrationCommitted', { event_id: 'evt-settle-1', registration_id: 'reg-s-0', pass_id: 'pass-s-0', participant: 'bob.testnet', beneficiary: 'bob.testnet', commitment_id: 'commit-s-0', amount: '5000000', event_sequence: 0, storage_cost_yocto: '0' })]),
  c1: mk(202, 's-receipt-c1', [log('RegistrationCommitted', { event_id: 'evt-settle-1', registration_id: 'reg-s-1', pass_id: 'pass-s-1', participant: 'carol.testnet', beneficiary: 'carol.testnet', commitment_id: 'commit-s-1', amount: '5000000', event_sequence: 1, storage_cost_yocto: '0' })]),
  c2: mk(203, 's-receipt-c2', [log('RegistrationCommitted', { event_id: 'evt-settle-1', registration_id: 'reg-s-2', pass_id: 'pass-s-2', participant: 'dave.testnet', beneficiary: 'dave.testnet', commitment_id: 'commit-s-2', amount: '5000000', event_sequence: 2, storage_cost_yocto: '0' })]),
  a0: mk(204, 's-receipt-a0', [log('AttendanceMarked', { event_id: 'evt-settle-1', registration_id: 'reg-s-0', attended: true, changed: true })]),
  a1: mk(205, 's-receipt-a1', [log('AttendanceMarked', { event_id: 'evt-settle-1', registration_id: 'reg-s-1', attended: true, changed: true })]),
  fin: mk(206, 's-receipt-fin', [log('EventFinalized', { event_id: 'evt-settle-1', attendee_count: 2, no_show_count: 1, total_registrations: 3, finalized_at: 1794100000000 })]),
  settle: mk(207, 's-receipt-settle', [log('SettlementStarted', { event_id: 'evt-settle-1', pool: '5000000', base_share: '2500000', remainder: '0', attendee_count: 2, actor: DEP.organizer }), log('EventSettled', { event_id: 'evt-settle-1', allocated_total: '15000000', attendee_count: 2, no_show_count: 1, total_registrations: 3 })]),
  pstart: mk(208, 's-receipt-pstart', [log('PayoutStarted', { payout_id: 'pay-reg-s-0-1', registration_id: 'reg-s-0', event_id: 'evt-settle-1', beneficiary: 'bob.testnet', amount: '7500000' })]),
  pfail: mk(209, 's-receipt-pfail', [log('PayoutFailed', { payout_id: 'pay-reg-s-0-1', registration_id: 'reg-s-0', event_id: 'evt-settle-1', beneficiary: 'bob.testnet', amount: '7500000' })]),
  pretry: mk(210, 's-receipt-pretry', [log('PayoutStarted', { payout_id: 'pay-reg-s-0-2', registration_id: 'reg-s-0', event_id: 'evt-settle-1', beneficiary: 'bob.testnet', amount: '7500000' })]),
  pok: mk(211, 's-receipt-pok', [log('PayoutSucceeded', { payout_id: 'pay-reg-s-0-2', registration_id: 'reg-s-0', event_id: 'evt-settle-1', beneficiary: 'bob.testnet', amount: '7500000' })]),
  sameBlock: mk(212, 's-receipt-sameblock', [log('PayoutStarted', { payout_id: 'pay-reg-s-1-1', registration_id: 'reg-s-1', event_id: 'evt-settle-1', beneficiary: 'carol.testnet', amount: '7500000' }), log('PayoutSucceeded', { payout_id: 'pay-reg-s-1-1', registration_id: 'reg-s-1', event_id: 'evt-settle-1', beneficiary: 'carol.testnet', amount: '7500000' })]),
};

async function main() {
  const phase = process.argv[2] || 'seed';
  const client = await rawClient();

  // Schema + roles (migrations) are re-applied on each fresh cluster; the DATA
  // (deployments/cursor/projections) is seeded here in `seed` and restored from
  // the pg_dump in `resume`.
  const migrations = await listMigrations(SCHEMA_DIR);
  await runMigrations(client, migrations);
  const svc = SERVICE_USER();
  await client.query(`CREATE ROLE ${svc} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`).catch(() => {});
  await client.query(`GRANT showstake_worker TO ${svc} WITH INHERIT FALSE, SET TRUE`).catch(() => {});

  if (phase === 'prep') {
    // schema + roles only (restore-ahead phase); no deployment/data/cursor.
    results.push({ id: 'CKPT_PREP_SCHEMA', ok: true, expected: 'schema+roles applied', observed: 'prep', classifier: 'PASS_LOCAL' });
    await client.end().catch(() => {});
    console.log(`\nverify-worker-checkpoint(prep): ${results.length}/${results.length} passed`);
    process.exit(0);
  }

  if (phase === 'seed') {
    await client.query(`
      INSERT INTO deployments (id, environment, network, contract_id, ft_contract_id, ft_decimals, start_block, code_hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (network, contract_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, start_block = EXCLUDED.start_block`,
      [DEPLOYMENT_ID, DEP.environment, DEP.network, DEP.contractId, DEP.ftContractId, DEP.ftDecimals, 200, DEP.codeHash]);
  } else if (phase === 'wrongdeploy') {
    // Corrupt the restored deployment's code_hash so the allowlist binding must
    // fail closed (a wrong-artifact dump must never create event rights).
    await client.query(`UPDATE deployments SET code_hash='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' WHERE id=$1`, [DEPLOYMENT_ID]);
  }

  const canonical = makeCanonical();
  for (const b of Object.values(blocks)) canonical.reg(b);
  const pool = createWorkerPool({ ...connectConfig(DB(), SOCKET()), user: svc, application_name: 'showstake-worker-checkpoint' });
  const store = new WorkerStore(pool, { ...DEP, startHeight: 200 }, CONSUMER, makeLiveChain(), canonical);
  try {
    if (phase === 'wrongdeploy') {
      await expectReject('CKPT_WRONG_DEPLOYMENT_FAILCLOSED', () => store.resolveDeployment(), 'code_hash mismatch');
    } else {
      const { id: deploymentId, startBlock } = await store.resolveDeployment();
      check('CKPT_DEPLOYMENT_RESOLVED', deploymentId === DEPLOYMENT_ID && startBlock === 200, 'deployment resolved at 200', `${deploymentId}/${startBlock}`);

      if (phase === 'seed') {
        for (const b of [blocks.publish, blocks.c0, blocks.c1, blocks.c2, blocks.a0, blocks.a1, blocks.fin]) await store.ingestBlock(deploymentId, b);
        const cursor = await store.readCursor(deploymentId);
        check('CKPT_SEED_BATCH_A', cursor?.block_height === 206, 'batch A ingests publish..finalize, cursor 206', JSON.stringify(cursor));
      } else if (phase === 'resume') {
        const cursor = await store.readCursor(deploymentId);
        check('CKPT_RESUME_CURSOR_IDENTITY', cursor?.block_height === 206 && cursor?.block_hash === 'S206', 'restored durable cursor == 206/S206', JSON.stringify(cursor));
        // Verify the MANIFEST's exact deploymentId + consumer + cursor match the restored DB
        // (post-restore identity; the runner sets CKPT_MANIFEST to the restored manifest).
        if (process.env.CKPT_MANIFEST) {
          const m = JSON.parse(await readFile(process.env.CKPT_MANIFEST, 'utf8'));
          check('CKPT_MANIFEST_IDENTITY',
            m.deploymentId === deploymentId && m.consumer === CONSUMER &&
            m.cursor && m.cursor.block_height === cursor?.block_height && m.cursor.block_hash === cursor?.block_hash,
            'manifest deploymentId+consumer+cursor == restored DB', JSON.stringify({ mDeploy: m.deploymentId, deploy: deploymentId, mConsumer: m.consumer, consumer: CONSUMER, mCursor: m.cursor, cursor }));
        }
        const next = await store.resolveStartHeight(deploymentId, startBlock);
        check('CKPT_RESUME_NEXT', next === 207, 'resolveStartHeight resumes at cursor+1 = 207', next);
        for (const b of [blocks.settle, blocks.pstart, blocks.pfail, blocks.pretry, blocks.pok, blocks.sameBlock]) await store.ingestBlock(deploymentId, b);

        const ev = (await client.query(`SELECT state, accepted_atomic::text a, paid_atomic::text p, pending_atomic::text pen, liability_atomic::text l FROM events_projection WHERE deployment_id=$1 AND chain_event_id='evt-settle-1'`, [deploymentId])).rows[0];
        check('CKPT_FINAL_SETTLED', ev?.state === 'SETTLED', 'event SETTLED', ev?.state);
        check('CKPT_FINAL_TOTALS', ev && ev.a === '15000000' && ev.p === '15000000' && ev.pen === '0' && ev.l === '0', 'totals accepted=paid=15000000, liability=0 (== uninterrupted)', `${ev?.a}/${ev?.p}/${ev?.l}`);
        const regs = (await client.query(`SELECT chain_registration_id, state, claim_atomic::text c, payout_state s FROM registrations_projection WHERE event_id=(SELECT id FROM events_projection WHERE deployment_id=$1 AND chain_event_id='evt-settle-1') ORDER BY sequence_no ASC`, [deploymentId])).rows;
        check('CKPT_FINAL_ALLOCATION', regs.length === 3 && regs.filter((r) => r.state === 'ATTENDED').every((r) => r.c === '7500000' && r.s === 'PAID') && regs.filter((r) => r.state === 'NO_SHOW').every((r) => r.c === '0' && r.s === 'ZERO'),
          '2 attendees 7500000 PAID, 1 no-show 0 ZERO (== uninterrupted)', JSON.stringify(regs.map((r) => [r.chain_registration_id, r.c, r.s])));
        const payouts = (await client.query(`SELECT payout_id, state FROM payouts_projection ORDER BY payout_id ASC`)).rows;
        check('CKPT_FINAL_PAYOUTS', payouts.length === 3 && payouts.filter((r) => r.state === 'SUCCEEDED').length === 2 && payouts.some((r) => r.payout_id === 'pay-reg-s-0-1' && r.state === 'FAILED'),
          'three payouts: failed attempt stays FAILED, retry+callback SUCCEEDED exactly once (== uninterrupted)', JSON.stringify(payouts));
      }
    }
  } finally {
    await client.end().catch(() => {});
    await pool.end().catch(() => {});
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nverify-worker-checkpoint(${phase}): ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error('verify-worker-checkpoint FATAL:', e instanceof Error ? e.message : String(e)); process.exit(1); });