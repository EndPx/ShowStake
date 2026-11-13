// migrations/tests/run-t01.mjs — T01 database acceptance: D01–D06.
//
// Runs against a REAL disposable PostgreSQL cluster (started by
// scripts/postgres-disposable/run-suite.sh). The orchestrator exports, per run:
//   SHOWSTAKE_PG_SOCKET  — per-run Unix socket directory (loopback/TCP never used)
//   SHOWSTAKE_PG_PORT / SHOWSTAKE_PG_USER / SHOWSTAKE_PG_DB1 / SHOWSTAKE_PG_DB2
//   SHOWSTAKE_PG_ARTIFACTS — UNIQUE per-run artifact dir (never a fixed path)
//   SHOWSTAKE_PG_RUN_ID    — run id stamped into every phase file
// Each D-group is a separate phase so the WSL orchestrator can insert the
// pg_dump/pg_restore step between D04-fixtures and D04-verify. Money is authored
// exclusively as canonical u128 strings; the DB `atomic_amount` domain is the
// authority.
//
// Phases: d01 d02 d03 d04-fixtures d04-verify d05 d06 finalize.
// `all` = SMOKE (no pg_dump/pg_restore) — it can NEVER finalize full acceptance.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { connect, recordPhase, expectSqlError, result, uuid, artifactsDir, runId } from './lib.mjs';
import {
  runMigrations, applyMigrations, listMigrations, status, sha256, bootstrap,
  acquireMigrationLock, releaseMigrationLock,
} from '../runner.mjs';
import { seedBase, seedReplayLedger, FIX, REPLAY } from './fixtures.mjs';
import { replayFromChainEvents } from './replay.mjs';
import { aggregate, readDumpInfo, readOrchestrator } from './aggregate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');
const SCHEMA_DIR = join(here, '..', 'schema');

const DB1 = () => process.env.SHOWSTAKE_PG_DB1;
const DB2 = () => process.env.SHOWSTAKE_PG_DB2;
const baseCommit = () => process.env.SHOWSTAKE_BASE_COMMIT || null;
const BASE_TABLES = ['app_users', 'auth_identities', 'wallet_bindings', 'auth_challenges', 'sessions',
  'deployments', 'event_drafts', 'events_projection', 'event_content_versions', 'registrations_projection',
  'passes_projection', 'payouts_projection', 'funding_attempts', 'funding_quotes', 'qr_challenges',
  'checkin_requests', 'protected_resources', 'chain_events', 'worker_cursors', 'idempotency_keys',
  'outbox_jobs', 'audit_records', 'schema_migrations'];

const EVENT_COLS = `(id, deployment_id, chain_event_id, organizer_account, asset_contract, deposit_atomic,
  capacity, reg_open, reg_close, cancel_cutoff, checkin_open, checkin_close, finalize_deadline,
  state, policy_version, rules_hash, accepted_atomic, paid_atomic, pending_atomic, liability_atomic,
  observed_at, projection_version)`;
const EVENT_VALS = `($1,$2,$3,'bob.testnet','ft.showstake.testnet','1',
  50,'2026-11-06T00:00:00Z','2026-11-07T00:00:00Z','2026-11-07T12:00:00Z',
  '2026-11-07T12:00:00Z','2026-11-08T12:00:00Z','2026-11-09T12:00:00Z',
  'PUBLISHED','policy-1','rules-hash-1','0','0','0','0',now(),0)`;

// ---------------------------------------------------------------------------
async function runD01() {
  const client = await connect(DB1());
  const checks = [];
  try {
    const migrations = await listMigrations(SCHEMA_DIR);
    const applied = await runMigrations(client, migrations); // bootstrap UNDER the lock
    const again = await applyMigrations(client, migrations); // idempotent (re-entrant lock)
    checks.push(result('D01_APPLY_AND_REAPPLY', applied.length === migrations.length && again.length === 0,
      `${migrations.length} migrations applied, then 0 on re-run`,
      `applied=${applied.map((m) => m.version).join(',')} re-run=${again.length}`));

    const st = await status(client, migrations);
    checks.push(result('D01_NO_DRIFT_OR_PENDING', st.drift.length === 0 && st.pending.length === 0 && st.stale.length === 0,
      'no drift, no pending, no stale', `drift=${st.drift.length} pending=${st.pending.length} stale=${st.stale.length}`));

    const t = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
    const names = new Set(t.rows.map((r) => r.table_name));
    const missing = BASE_TABLES.filter((n) => !names.has(n));
    checks.push(result('D01_TABLES', missing.length === 0, `${BASE_TABLES.length} tables present`, missing.length ? `missing=${missing.join(',')}` : 'all present'));

    const env = await client.query(`SELECT version() AS v, current_setting('listen_addresses') AS la, current_setting('port') AS p`);
    checks.push(result('D01_REAL_POSTGRESQL', /PostgreSQL/.test(env.rows[0].v),
      'real PostgreSQL server reports version', env.rows[0].v));
    const la = env.rows[0].la ?? '';
    checks.push(result('D01_LOOPBACK_OR_SOCKET_ONLY', la === '127.0.0.1' || la === 'localhost' || la === '',
      'listener is loopback or Unix-socket only (never all-interfaces)', `listen_addresses=${JSON.stringify(la)}`));

    // TEMP minimization: api/worker roles must NOT create temp tables.
    await client.query('SET ROLE showstake_api');
    const apiTemp = await expectSqlError(client, 'CREATE TEMP TABLE t_tmp_a (id int)', [], null);
    await client.query('RESET ROLE');
    checks.push(result('D01_API_NO_TEMP', apiTemp.threw === true, 'API role denied TEMP table creation', apiTemp.threw ? `denied=${apiTemp.code}` : 'NOT denied (leak)'));

    // Drift + atomic rollback + stale, isolated in a separate same-cluster DB.
    await client.query('DROP DATABASE IF EXISTS showstake_drift').catch(() => {});
    await client.query('CREATE DATABASE showstake_drift');
    const dc = await connect('showstake_drift');
    let driftThrew = false;
    let atomicThrew = false;
    let rollbackAbsent = false;
    let noBadRow = false;
    let staleThrew = false;
    let lockReleasedOnError = false;
    const tmp = await mkdtemp(join(tmpdir(), 'showstake-mig-'));
    try {
      await bootstrap(dc); // bootstrap roles + schema_migrations ONLY (no base migrations)
      const f1 = join(tmp, '9001_probe.sql');
      const f2 = join(tmp, '9002_bad.sql');
      await writeFile(f1, 'CREATE TABLE t9001 (id integer);');
      await applyMigrations(dc, await listMigrations(tmp)); // 9001 applies cleanly (2025=no, 9001 is 9001 — but FILE_RE is ^\d{4}_)

      // atomicity: 9002 fails after a successful statement; must roll back fully.
      await writeFile(f2, 'CREATE TABLE t_should_rollback (id integer);\nTHIS IS NOT VALID SQL;');
      try { await applyMigrations(dc, await listMigrations(tmp)); } catch { atomicThrew = true; }
      const rb = await dc.query(`SELECT to_regclass('public.t_should_rollback') AS t`);
      const nbr = await dc.query('SELECT 1 FROM schema_migrations WHERE version = 9002');
      rollbackAbsent = !rb.rows[0].t;
      noBadRow = nbr.rowCount === 0;
      // lock must be released after the failed apply above
      lockReleasedOnError = await lockAcquirable('showstake_drift');
      await rm(f2, { force: true }); // remove the bad migration so drift test is isolated

      // drift: change an already-applied file's checksum.
      await writeFile(f1, 'CREATE TABLE t9001 (id integer, extra integer);');
      try { await applyMigrations(dc, await listMigrations(tmp)); } catch (e) { driftThrew = /checksum drift/.test(e.message); }

      // stale: apply a second migration, then remove it from disk and re-run.
      const f3 = join(tmp, '9003_stale.sql');
      await writeFile(f1, 'CREATE TABLE t9001 (id integer);'); // restore 9001 checksum
      await writeFile(f3, 'CREATE TABLE t9003 (id integer);');
      await applyMigrations(dc, await listMigrations(tmp)); // 9001 (idempotent) + 9003 (new)
      await rm(f3, { force: true }); // now 9003 is applied but missing from disk
      try { await applyMigrations(dc, await listMigrations(tmp)); } catch (e) { staleThrew = /stale migration/.test(e.message); }
    } finally {
      await dc.end().catch(() => {});
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
      await client.query('DROP DATABASE showstake_drift').catch(() => {});
    }
    checks.push(result('D01_ATOMIC_ROLLBACK', atomicThrew && rollbackAbsent && noBadRow,
      'failed migration rolled back fully (no table, no tracking row)',
      `threw=${atomicThrew} table-absent=${rollbackAbsent} no-row=${noBadRow}`));
    checks.push(result('D01_DRIFT', driftThrew, 'checksum drift fails closed', `drift-threw=${driftThrew}`));
    checks.push(result('D01_STALE_REFUSAL', staleThrew, 'stale (removed) migration refused', `stale-threw=${staleThrew}`));
    checks.push(result('D01_LOCK_RELEASED_ON_ERROR', lockReleasedOnError,
      'migration lock released after a failed apply', `released=${lockReleasedOnError}`));
  } finally {
    await client.end().catch(() => {});
  }
  return recordPhase('d01', 'D01 apply + checksum + idempotency + drift + atomic rollback + stale + TEMP', checks);
}

/** true when the migration advisory lock is immediately acquirable on a fresh connection. */
async function lockAcquirable(dbName) {
  const probe = await connect(dbName);
  try {
    await acquireMigrationLock(probe);
    await releaseMigrationLock(probe);
    return true;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
async function runD02() {
  const client = await connect(DB1());
  const checks = [];
  try {
    await seedBase(client);

    const fk = await expectSqlError(client,
      `INSERT INTO registrations_projection
         (id,event_id,chain_registration_id,sequence_no,participant_account,beneficiary_account,
          commitment_id,principal_atomic,state,claim_atomic,payout_state,observed_at)
       VALUES ($1,$2,'reg-bad',99,'alice.testnet','alice.testnet','commit-bad','1','COMMITTED',0,'NOT_CLAIMABLE',now())`,
      [uuid(), uuid()], '23503');
    checks.push(result('D02_FK_EVENT', fk.code === '23503', 'foreign key violation 23503', `code=${fk.code}`));

    const active = await expectSqlError(client,
      `INSERT INTO registrations_projection
         (id,event_id,chain_registration_id,sequence_no,participant_account,beneficiary_account,
          commitment_id,principal_atomic,state,claim_atomic,payout_state,observed_at)
       VALUES ($1,$2,'reg-dup',2,'alice.testnet','alice.testnet','commit-dup','5000000','COMMITTED',0,'NOT_CLAIMABLE',now())`,
      [uuid(), FIX.event], '23505');
    checks.push(result('D02_ONE_ACTIVE_REGISTRATION', active.code === '23505',
      'partial unique active-registration index 23505', `code=${active.code}`));

    const withdrawn = await expectSqlError(client,
      `INSERT INTO registrations_projection
         (id,event_id,chain_registration_id,sequence_no,participant_account,beneficiary_account,
          commitment_id,principal_atomic,state,claim_atomic,payout_state,observed_at)
       VALUES ($1,$2,'reg-wd',1,'alice.testnet','alice.testnet','commit-wd','5000000','WITHDRAWN',0,'NOT_CLAIMABLE',now())`,
      [FIX.regWithdrawn, FIX.event], null);
    checks.push(result('D02_WITHDRAWN_EXCLUDED', withdrawn.threw === false,
      'WITHDRAWN excluded from active-registration uniqueness (insert ok)',
      withdrawn.threw ? `unexpected code=${withdrawn.code}` : 'inserted'));

    const identity = await expectSqlError(client,
      `INSERT INTO auth_identities (id,user_id,provider,subject,verified_at) VALUES ($1,$2,'google','sub-google-1',now())`,
      [uuid(), FIX.appUser], '23505');
    checks.push(result('D02_IDENTITY_CONFLICT', identity.code === '23505',
      'duplicate provider+subject 23505', `code=${identity.code}`));

    const wallet = await expectSqlError(client,
      `INSERT INTO wallet_bindings (id,user_id,namespace,network,account_id,wallet_kind,verified_at)
       VALUES ($1,$2,'near','testnet','alice.testnet','participant',now())`,
      [uuid(), FIX.appUser], '23505');
    checks.push(result('D02_WALLET_BINDING_CONFLICT', wallet.code === '23505',
      'duplicate namespace+network+account 23505', `code=${wallet.code}`));

    await client.query(`INSERT INTO idempotency_keys (scope,key,body_hash,expires_at) VALUES ('funding','k1','h1',now()+interval '1 hour')`);
    const idem = await expectSqlError(client,
      `INSERT INTO idempotency_keys (scope,key,body_hash,expires_at) VALUES ('funding','k1','h2',now()+interval '1 hour')`,
      [], '23505');
    checks.push(result('D02_IDEMPOTENCY_KEY', idem.code === '23505',
      'duplicate (scope,key) 23505', `code=${idem.code}`));

    const account = await expectSqlError(client,
      `INSERT INTO registrations_projection
         (id,event_id,chain_registration_id,sequence_no,participant_account,beneficiary_account,
          commitment_id,principal_atomic,state,claim_atomic,payout_state,observed_at)
       VALUES ($1,$2,'reg-acct',3,'alice.testnet','mallory.testnet','commit-acct','1','COMMITTED',0,'NOT_CLAIMABLE',now())`,
      [uuid(), FIX.event], '23514');
    checks.push(result('D02_PARTICIPANT_EQ_BENEFICIARY', account.code === '23514',
      'participant!=beneficiary CHECK 23514', `code=${account.code}`));

    await client.query('BEGIN');
    try {
      const yielded = await client.query(
        `UPDATE events_projection SET accepted_atomic=10, realized_yield_atomic=2, allocated_yield_atomic=2,
         paid_atomic=12, pending_atomic=0, liability_atomic=0 WHERE id=$1
         RETURNING realized_yield_atomic::text AS yield`, [FIX.event]);
      checks.push(result('D02_REALIZED_YIELD_CONSERVATION', yielded.rows[0]?.yield === '2',
        '10 principal + 2 realized yield supports 12 paid', yielded.rows[0]?.yield));
    } finally { await client.query('ROLLBACK'); }
    await client.query('BEGIN');
    try {
      const held = await client.query(
        `UPDATE events_projection SET accepted_atomic=10, realized_yield_atomic=2,
         allocated_yield_atomic=0, paid_atomic=0, pending_atomic=0, liability_atomic=10
         WHERE id=$1 RETURNING (realized_yield_atomic-allocated_yield_atomic)::text AS held`, [FIX.event]);
      checks.push(result('D02_UNALLOCATED_YIELD_NOT_A_CLAIM', held.rows[0]?.held === '2',
        'realized funds may remain outside participant allocations', held.rows[0]?.held));
    } finally { await client.query('ROLLBACK'); }
    const wrongYield = await expectSqlError(client,
      `UPDATE events_projection SET accepted_atomic=10, realized_yield_atomic=2, allocated_yield_atomic=2,
       paid_atomic=13, pending_atomic=0, liability_atomic=0 WHERE id=$1`, [FIX.event], '23514');
    checks.push(result('D02_REALIZED_YIELD_MISMATCH', wrongYield.code === '23514',
      'yield conservation mismatch rejected', `code=${wrongYield.code}`));
    const overAllocated = await expectSqlError(client,
      `UPDATE events_projection SET accepted_atomic=10, realized_yield_atomic=2,
       allocated_yield_atomic=3, paid_atomic=13, pending_atomic=0, liability_atomic=0 WHERE id=$1`, [FIX.event], '23514');
    checks.push(result('D02_ALLOCATED_YIELD_BOUNDED', overAllocated.code === '23514',
      'allocated yield cannot exceed realized yield', `code=${overAllocated.code}`));
    const sumOverflow = await expectSqlError(client,
      `UPDATE events_projection SET accepted_atomic=$2, realized_yield_atomic=1, allocated_yield_atomic=1,
       paid_atomic=$2, pending_atomic=1, liability_atomic=0 WHERE id=$1`,
      [FIX.event, '340282366920938463463374607431768211455'], '23514');
    checks.push(result('D02_PRINCIPAL_PLUS_YIELD_U128', sumOverflow.code === '23514',
      'combined principal and yield must fit u128', `code=${sumOverflow.code}`));

    const capacity = await expectSqlError(client,
      `INSERT INTO events_projection
         (id,deployment_id,chain_event_id,organizer_account,asset_contract,deposit_atomic,capacity,
          reg_open,reg_close,cancel_cutoff,checkin_open,checkin_close,finalize_deadline,state,policy_version,
          rules_hash,accepted_atomic,paid_atomic,pending_atomic,liability_atomic,observed_at)
       VALUES ($1,$2,'evt-cap-0','bob.testnet','ft','1',0,
         '2026-11-06T00:00:00Z','2026-11-07T00:00:00Z','2026-11-07T12:00:00Z','2026-11-07T12:00:00Z',
         '2026-11-08T12:00:00Z','2026-11-09T12:00:00Z','PUBLISHED','p','h','0','0','0','0',now())`,
      [uuid(), FIX.deployment], '23514');
    checks.push(result('D02_CAPACITY_RANGE', capacity.code === '23514',
      'capacity 0 CHECK 23514', `code=${capacity.code}`));

    const env = await expectSqlError(client,
      `INSERT INTO deployments (id,environment,network,contract_id,ft_contract_id,ft_decimals,start_block,code_hash)
       VALUES ($1,'prod','testnet','prod.escrow','ft',6,1,$2)`,
      [uuid(), '0'.repeat(64)], '23514');
    checks.push(result('D02_ENVIRONMENT_ENUM', env.code === '23514',
      "environment 'prod' CHECK 23514", `code=${env.code}`));

    const sess = await expectSqlError(client,
      `INSERT INTO sessions (id,token_hash,user_id,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
       VALUES ($1,$2,$3,now(),now(),now()+interval '1 hour',now()+interval '10 minutes')`,
      [uuid(), 'tok-x-' + uuid(), FIX.appUser], '23514');
    checks.push(result('D02_SESSION_EXPIRY_RULE', sess.code === '23514',
      'idle > absolute CHECK 23514', `code=${sess.code}`));
  } finally {
    await client.end().catch(() => {});
  }
  return recordPhase('d02', 'D02 FK/unique/identity/idempotency/rules', checks);
}

// ---------------------------------------------------------------------------
async function runD03() {
  const client = await connect(DB1());
  const checks = [];
  try {
    await seedBase(client);

    await client.query('SET ROLE showstake_api');
    const apiUpd = await expectSqlError(client,
      `UPDATE events_projection SET state='SETTLED' WHERE id=$1`, [FIX.event], '42501');
    checks.push(result('D03_API_NO_PROJECTION_UPDATE', apiUpd.code === '42501',
      'API update projection denied 42501', `code=${apiUpd.code}`));
    const apiIns = await expectSqlError(client,
      `INSERT INTO events_projection ${EVENT_COLS} VALUES ${EVENT_VALS}`,
      [uuid(), FIX.deployment, 'evt-api-x'], '42501');
    checks.push(result('D03_API_NO_PROJECTION_INSERT', apiIns.code === '42501',
      'API insert projection denied 42501', `code=${apiIns.code}`));

    const apiRead = await client.query('SELECT count(*) AS n FROM events_projection');
    checks.push(result('D03_API_CAN_READ_PROJECTION', apiRead.rowCount === 1,
      'API SELECT projection ok', `rows=${apiRead.rows[0].n}`));

    const sid = uuid();
    await client.query(
      `INSERT INTO sessions (id,token_hash,user_id,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
       VALUES ($1,$2,$3,now(),now(),now()+interval '10 minutes',now()+interval '1 hour')`,
      [sid, 'tok-' + sid, FIX.appUser]);
    checks.push(result('D03_API_CAN_INSERT_SESSION', true, 'API INSERT session allowed', 'inserted'));
    await client.query('RESET ROLE');

    await client.query('SET ROLE showstake_worker');
    const wSess = await expectSqlError(client,
      `INSERT INTO sessions (id,token_hash,user_id,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
       VALUES ($1,$2,$3,now(),now(),now()+interval '10 minutes',now()+interval '1 hour')`,
      [uuid(), 'tok-w-' + uuid(), FIX.appUser], '42501');
    checks.push(result('D03_WORKER_NO_SESSION', wSess.code === '42501',
      'worker INSERT session denied 42501', `code=${wSess.code}`));
    const wIdent = await expectSqlError(client,
      `INSERT INTO auth_identities (id,user_id,provider,subject,verified_at) VALUES ($1,$2,'google','sub-w',now())`,
      [uuid(), FIX.appUser], '42501');
    checks.push(result('D03_WORKER_NO_IDENTITY', wIdent.code === '42501',
      'worker INSERT identity denied 42501', `code=${wIdent.code}`));

    const wTemp = await expectSqlError(client, 'CREATE TEMP TABLE t_tmp_w (id int)', [], null);
    checks.push(result('D03_WORKER_NO_TEMP', wTemp.threw === true, 'worker denied TEMP table', wTemp.threw ? `denied=${wTemp.code}` : 'NOT denied'));

    await client.query(
      `INSERT INTO events_projection ${EVENT_COLS} VALUES ${EVENT_VALS}`,
      [uuid(), FIX.deployment, 'evt-worker-1']);
    checks.push(result('D03_WORKER_CAN_WRITE_PROJECTION', true,
      'worker INSERT projection allowed', 'inserted evt-worker-1'));

    await client.query(`UPDATE funding_attempts SET state='SOURCE_PENDING' WHERE id=$1`, [FIX.fundingAttempt]);
    checks.push(result('D03_WORKER_CAN_OBSERVE_FUNDING', true,
      'worker UPDATE funding observation allowed', 'state->SOURCE_PENDING'));
    await client.query('RESET ROLE');
  } finally {
    await client.end().catch(() => {});
  }
  return recordPhase('d03', 'D03 SET ROLE least-privilege', checks);
}

// ---------------------------------------------------------------------------
async function runD04Fixtures() {
  const client = await connect(DB1());
  try {
    await seedBase(client);
    await seedReplayLedger(client); // ONLY the immutable ledger; no projection rows seeded
  } finally {
    await client.end().catch(() => {});
  }
  return recordPhase('d04-fixtures', 'D04 immutable labeled replay ledger loaded', [
    result('D04_FIXTURES_LOADED', true, 'replay chain_events ledger stored (EventCreated + 4 registrations + 1 withdrawal)', 'loaded'),
  ]);
}

async function fingerprint(client, table) {
  const q = `SELECT coalesce(md5(string_agg(t::text, E'\\n' ORDER BY t::text)), 'empty') AS fp FROM ${table} t`;
  const r = await client.query(q);
  return r.rows[0].fp;
}

async function runD04Verify() {
  const c1 = await connect(DB1());
  const c2 = await connect(DB2());
  const checks = [];
  const tables = ['app_users', 'auth_identities', 'wallet_bindings', 'auth_challenges', 'sessions', 'deployments',
    'event_drafts', 'events_projection', 'event_content_versions', 'registrations_projection', 'passes_projection',
    'payouts_projection', 'funding_attempts', 'funding_quotes', 'qr_challenges', 'checkin_requests',
    'protected_resources', 'chain_events', 'worker_cursors', 'idempotency_keys', 'outbox_jobs', 'audit_records',
    'schema_migrations'];
  try {
    const dumpInfo = await readDumpInfo(artifactsDir());
    checks.push(result('D04_DUMP_RESTORE_EXITS', !!dumpInfo && dumpInfo.pg_dump === 0 && dumpInfo.pg_restore === 0,
      'pg_dump and pg_restore both exit 0', JSON.stringify(dumpInfo)));

    let equal = true;
    const diffs = [];
    for (const t of tables) {
      const a = await fingerprint(c1, t);
      const b = await fingerprint(c2, t);
      if (a !== b) { equal = false; diffs.push(t); }
    }
    checks.push(result('D04_ROUNDTRIP_EQUAL', equal,
      `all ${tables.length} tables byte-equal after pg_dump/pg_restore`,
      diffs.length ? `differ=${diffs.join(',')}` : 'identical'));

    // Independent replay from chain_events in BOTH DBs (never sums projection rows).
    // Canonical Product01 invariant: accepted = paid + pending + liability, and
    // accepted includes withdrawn principal; `active` (non-withdrawn) is a derived
    // quantity that is NOT renamed to accepted.
    const r1 = await replayFromChainEvents(c1, { deploymentId: FIX.deployment, eventId: FIX.replayEvent, consumer: 'd04-verify' });
    const r2 = await replayFromChainEvents(c2, { deploymentId: FIX.deployment, eventId: FIX.replayEvent, consumer: 'd04-verify' });
    const stored1 = await c1.query(
      'SELECT accepted_atomic::text AS a, paid_atomic::text AS p, pending_atomic::text AS pend, liability_atomic::text AS l FROM events_projection WHERE id=$1',
      [FIX.replayEvent]);
    const conserve = (r) => {
      const A = BigInt(r.accepted); const act = BigInt(r.active); const wc = BigInt(r.withdrawnCredit);
      const paid = BigInt(r.paid); const pend = BigInt(r.pending); const liab = BigInt(r.liability);
      return A === act + wc && A === paid + pend + liab;
    };
    const match = (r) => r.accepted === REPLAY.expectedAccepted && r.chainAccepted === REPLAY.expectedAccepted
      && r.active === REPLAY.expectedActive && r.chainActive === REPLAY.expectedActive
      && r.withdrawnCredit === REPLAY.expectedWithdrawnCredit && r.chainWithdrawnCredit === REPLAY.expectedWithdrawnCredit
      && r.paid === REPLAY.expectedPaid && r.pending === REPLAY.expectedPending && r.liability === REPLAY.expectedLiability
      && r.committed === REPLAY.expectedCommitted && r.withdrawn === REPLAY.expectedWithdrawn && conserve(r);
    const s1 = stored1.rows[0];
    checks.push(result('D04_REPLAY_RECONSTRUCT_DB1',
      match(r1) && s1.a === REPLAY.expectedAccepted && s1.p === '0' && s1.pend === '0' && s1.l === REPLAY.expectedLiability,
      'replay rebuilds projection from chain_events == independent fixture (accepted incl. withdrawn; pending=0; liability=accepted) in DB1',
      `accepted=${r1.accepted} active=${r1.active} wdCredit=${r1.withdrawnCredit} paid=${r1.paid} pending=${r1.pending} liability=${r1.liability}`));
    checks.push(result('D04_REPLAY_RECONSTRUCT_DB2', match(r2),
      'replay rebuilds projection from chain_events == independent fixture in DB2',
      `accepted=${r2.accepted} active=${r2.active} wdCredit=${r2.withdrawnCredit} liability=${r2.liability}`));
    checks.push(result('D04_REPLAY_EQUIVALENT', match(r1) && match(r2) && r1.accepted === r2.accepted && r1.active === r2.active,
      'DB1 and DB2 replay agree and both match the fixture', 'agreed'));
    checks.push(result('D04_CHAINEVENTS_TOTAL', r1.chainAccepted === r1.accepted && r1.chainAccepted === REPLAY.expectedAccepted,
      'accepted total is derived from chain_events (not summed from the projection) and equals the rebuilt projection',
      `chain_events=${r1.chainAccepted} projection=${r1.accepted}`));
    checks.push(result('D04_CONSERVATION', conserve(r1) && conserve(r2),
      'conservation holds: accepted = active + withdrawnCredit AND accepted = paid + pending + liability',
      `active+wdCredit=${BigInt(r1.active) + BigInt(r1.withdrawnCredit)} paid+pending+liability=${BigInt(r1.paid) + BigInt(r1.pending) + BigInt(r1.liability)}`));

    // Withdrawn row must rebuild a proper claim/refund status and retain its
    // historic owner (participant/beneficiary unchanged by the withdrawal).
    const wd = await c1.query(
      `SELECT state, claim_atomic::text AS c, payout_state, participant_account, beneficiary_account
       FROM registrations_projection
       WHERE event_id = $1 AND chain_registration_id = $2 AND state = 'WITHDRAWN'`,
      [FIX.replayEvent, REPLAY.withdrawn[0]]);
    const wdRow = wd.rows[0];
    checks.push(result('D04_WITHDRAWN_REFUND_CLAIM',
      !!wdRow && wdRow.state === 'WITHDRAWN' && wdRow.c === REPLAY.expectedWithdrawnCredit && wdRow.payout_state === 'CLAIMABLE',
      'withdrawn row retains a claimable refund credit (claim_atomic=D, payout_state=CLAIMABLE)',
      `state=${wdRow?.state} claim=${wdRow?.c} payout=${wdRow?.payout_state}`));
    checks.push(result('D04_WITHDRAWN_HISTORIC_OWNER',
      !!wdRow && wdRow.participant_account === 'replay.dan' && wdRow.beneficiary_account === 'replay.dan',
      'withdrawn row retains historic owner (participant/beneficiary unchanged)',
      `participant=${wdRow?.participant_account} beneficiary=${wdRow?.beneficiary_account}`));

    // Idempotent re-replay: a second rebuild over the same ledger must not change
    // any canonical total (accepted/active/withdrawn credit/liability/registered).
    const r1again = await replayFromChainEvents(c1, { deploymentId: FIX.deployment, eventId: FIX.replayEvent, consumer: 'd04-verify' });
    checks.push(result('D04_REPLAY_IDEMPOTENT',
      r1again.accepted === r1.accepted && r1again.active === r1.active && r1again.withdrawnCredit === r1.withdrawnCredit
        && r1again.liability === r1.liability,
      're-replay is idempotent (dedup by receipt/registration; canonical totals unchanged)',
      `again accepted=${r1again.accepted} active=${r1again.active} wdCredit=${r1again.withdrawnCredit} liability=${r1again.liability}`));

    // A duplicate receipt in the immutable ledger is rejected (23505) — the source dedups receipts.
    const dupReceipt = 'receipt-replay-0001'; // same as an already-committed registration receipt
    const dup = await expectSqlError(c1,
      `INSERT INTO chain_events
         (id,deployment_id,receipt_id,log_index,block_height,block_hash,block_time,event_name,schema_version,payload,ingested_at)
       VALUES ($1,$2,$3,0,999,$4,now(),'RegistrationCommitted','showstake/1.0.0',$5::jsonb,now())`,
      [uuid(), FIX.deployment, dupReceipt, '0'.repeat(64), JSON.stringify({ event_id: FIX.replayEvent, registration_id: '11000000-0000-4000-8000-000000000009', sequence_no: 99, participant: 'replay.dup', commitment_id: 'commit-dup', principal_atomic: '5000000' })],
      '23505');
    checks.push(result('D04_DUPLICATE_RECEIPT_REJECTED', dup.code === '23505',
      'immutable ledger rejects a duplicate receipt (23505)', `code=${dup.code}`));

    // Durable cursor advanced in the same transaction as the projection writes.
    await seedReplayLedger(c1); // reset so the following is a clean single replay
    await seedReplayLedger(c2);
    await replayFromChainEvents(c1, { deploymentId: FIX.deployment, eventId: FIX.replayEvent, consumer: 'cursor-proof' });
    const cur = await c1.query('SELECT cursor_value FROM worker_cursors WHERE deployment_id=$1 AND consumer=$2', [FIX.deployment, 'cursor-proof']);
    checks.push(result('D04_DURABLE_CURSOR', cur.rowCount === 1 && cur.rows[0].cursor_value?.event_id === String(FIX.replayEvent),
      'worker_cursors advanced for the replay consumer in the same transaction', `cursor=${JSON.stringify(cur.rows[0]?.cursor_value)}`));
  } finally {
    await c1.end().catch(() => {});
    await c2.end().catch(() => {});
  }
  return recordPhase('d04-verify', 'D04 dump/restore roundtrip + independent chain_events replay', checks);
}

// ---------------------------------------------------------------------------
async function runD05() {
  const client = await connect(DB1());
  const checks = [];
  try {
    const cases = [
      ['D05_NEGATIVE', '-1', '23514'],
      ['D05_FRACTION', '1.5', '23514'],
      ['D05_OVERFLOW', '340282366920938463463374607431768211456', '23514'], // 2^128
    ];
    for (const [id, v, expected] of cases) {
      const r = await expectSqlError(client, 'SELECT $1::atomic_amount AS v', [v], expected);
      checks.push(result(id, r.code === expected, `atomic_amount(${v}) -> ${expected}`, `code=${r.code}`));
    }
    const ok = await client.query('SELECT $1::atomic_amount AS v', ['340282366920938463463374607431768211455']);
    checks.push(result('D05_U128_MAX_OK', ok.rows[0].v === '340282366920938463463374607431768211455',
      '2^128-1 accepted exactly', ok.rows[0].v));

    await seedBase(client);
    const deposit = await client.query('SELECT deposit_atomic::text AS d, pg_typeof(deposit_atomic)::text AS ty FROM events_projection WHERE id=$1', [FIX.event]);
    checks.push(result('D05_DB_STRING_ROUNDTRIP', deposit.rows[0].d === '5000000' && deposit.rows[0].ty === 'atomic_amount',
      'DB atomic_amount domain round-trips as exact string via ::text',
      `d=${deposit.rows[0].d} type=${deposit.rows[0].ty}`));
  } finally {
    await client.end().catch(() => {});
  }
  return recordPhase('d05', 'D05 atomic_amount numeric boundary + canonical string round-trip', checks);
}

// ---------------------------------------------------------------------------
async function runD06() {
  const c1 = await connect(DB1());
  const c2 = await connect(DB1());
  const checks = [];
  try {
    // 1) Real two-connection outbox job lease (SKIP LOCKED).
    const jobId = uuid();
    await c1.query(`INSERT INTO outbox_jobs (id,kind,dedupe_key,payload,state,run_at,created_at)
                    VALUES ($1,'test-job',$2,'{}','READY',now()-interval '1 second',now())`,
      [jobId, 'dedupe-' + jobId]);
    const claim = `UPDATE outbox_jobs SET state='RUNNING', lease_until=now()+interval '5 minutes', attempts=attempts+1
                   WHERE id = (SELECT id FROM outbox_jobs WHERE state='READY' AND run_at<=now()
                               ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id`;
    await c1.query('BEGIN');
    const r1 = await c1.query(claim);
    const r2 = await c2.query(claim);
    await c1.query('COMMIT');
    checks.push(result('D06_JOB_LEASE_ONE_WINNER', r1.rowCount === 1 && r2.rowCount === 0,
      'exactly one connection claims the job lease', `winner=${r1.rowCount} loser=${r2.rowCount}`));

    // 2) Real two-connection auth-challenge nonce consumption.
    const chalId = uuid();
    await c1.query(
      `INSERT INTO auth_challenges (id,nonce_hash,purpose,domain,network,account_id,issued_at,expires_at)
       VALUES ($1,$2,'login','app.showstake','testnet','alice.testnet',now(),now()+interval '5 minutes')`,
      [chalId, 'nonce-' + chalId]);
    const consume = 'UPDATE auth_challenges SET consumed_at=now() WHERE id=$1 AND consumed_at IS NULL RETURNING id';
    const [n1, n2] = await Promise.all([c1.query(consume, [chalId]), c2.query(consume, [chalId])]);
    const wins = [n1.rowCount, n2.rowCount].filter((n) => n === 1).length;
    const zeros = [n1.rowCount, n2.rowCount].filter((n) => n === 0).length;
    checks.push(result('D06_NONCE_ONE_CONSUMER', wins === 1 && zeros === 1,
      'one nonce consumer wins, the other gets 0 rows', `rows=[${n1.rowCount},${n2.rowCount}]`));

    // 3) Overlapping two-connection cursor+projection transaction (NOT a PK insert).
    //    The worker_cursors row is the concurrency gate for projection writes.
    await c1.query(`DELETE FROM worker_cursors WHERE deployment_id=$1 AND consumer IN ('ov-a','ov-b')`, [FIX.deployment]);
    await c1.query(`INSERT INTO worker_cursors (deployment_id,consumer,cursor_value,updated_at) VALUES ($1,'ov-a','{"h":0}',now())`, [FIX.deployment]);
    await c1.query('BEGIN');
    const lockA = await c1.query(`SELECT consumer FROM worker_cursors WHERE deployment_id=$1 AND consumer='ov-a' FOR UPDATE NOWAIT`, [FIX.deployment]);
    const lockB = await expectSqlError(c2, `SELECT consumer FROM worker_cursors WHERE deployment_id=$1 AND consumer='ov-a' FOR UPDATE NOWAIT`, [FIX.deployment], '55P03');
    const insertProjection = async (c) => {
      await c.query(`INSERT INTO events_projection ${EVENT_COLS} VALUES ${EVENT_VALS}`, [uuid(), FIX.deployment, 'evt-ov-1']);
      await c.query(`UPDATE worker_cursors SET cursor_value='{"h":1}'::jsonb, updated_at=now() WHERE deployment_id=$1 AND consumer='ov-a'`, [FIX.deployment]);
    };
    await insertProjection(c1);
    await c1.query('COMMIT');
    checks.push(result('D06_CURSOR_PROJECTION_OVERLAP', lockA.rowCount === 1 && lockB.code === '55P03',
      'one connection locks the cursor (FOR UPDATE NOWAIT); the other is refused 55P03', `lockA=${lockA.rowCount} lockB=${lockB.code}`));

    // 4) Rollback recovery: a projection write + cursor advance that rolls back
    //    leaves no partial projection and leaves the cursor unchanged.
    await c1.query(`DELETE FROM worker_cursors WHERE deployment_id=$1 AND consumer='rb'`, [FIX.deployment]);
    await c1.query(`INSERT INTO worker_cursors (deployment_id,consumer,cursor_value,updated_at) VALUES ($1,'rb','{"h":0}',now())`, [FIX.deployment]);
    await c1.query('BEGIN');
    await c1.query(`INSERT INTO events_projection ${EVENT_COLS} VALUES ${EVENT_VALS}`, [uuid(), FIX.deployment, 'evt-rb-1']);
    await c1.query(`UPDATE worker_cursors SET cursor_value='{"h":9}'::jsonb, updated_at=now() WHERE deployment_id=$1 AND consumer='rb'`, [FIX.deployment]);
    await c1.query('ROLLBACK');
    const rbProj = await c1.query(`SELECT 1 FROM events_projection WHERE chain_event_id='evt-rb-1'`);
    const rbCur = await c1.query(`SELECT cursor_value FROM worker_cursors WHERE deployment_id=$1 AND consumer='rb'`, [FIX.deployment]);
    checks.push(result('D06_ROLLBACK_RECOVERY', rbProj.rowCount === 0 && rbCur.rows[0].cursor_value.h === 0,
      'rolled-back projection+cursor transaction leaves no partial state', `proj=${rbProj.rowCount} cursor_h=${rbCur.rows[0].cursor_value.h}`));

    // 5) Advisory-lock serializes concurrent migration runs INCLUDING bootstrap.
    await c1.query('DROP DATABASE IF EXISTS showstake_d06').catch(() => {});
    await c1.query('CREATE DATABASE showstake_d06');
    const da = await connect('showstake_d06');
    const db = await connect('showstake_d06');
    let loserRejected = false;
    let loserNoBootstrap = false;
    let winnerApplied = false;
    try {
      const migrations = await listMigrations(SCHEMA_DIR);
      await acquireMigrationLock(da); // hold the lock on connection A
      try { await runMigrations(db, migrations); } catch (e) { loserRejected = /another migration is already running/.test(e.message); }
      // loser must not have bootstrapped (bootstrap is under the same lock)
      const reg = await da.query(`SELECT to_regclass('public.schema_migrations') AS t`);
      loserNoBootstrap = !reg.rows[0].t;
      await releaseMigrationLock(da);
      const applied = await runMigrations(db, migrations); // winner now proceeds
      winnerApplied = applied.length === migrations.length;
    } finally {
      await da.end().catch(() => {});
      await db.end().catch(() => {});
      await c1.query('DROP DATABASE showstake_d06').catch(() => {});
    }
    checks.push(result('D06_MIGRATION_LOCK_CONCURRENT', loserRejected && loserNoBootstrap && winnerApplied,
      'concurrent migration runs serialize: loser fails fast, bootstrap is under the lock', `rejected=${loserRejected} noBootstrap=${loserNoBootstrap} winnerApplied=${winnerApplied}`));
  } finally {
    await c1.end().catch(() => {});
    await c2.end().catch(() => {});
  }
  return recordPhase('d06', 'D06 two-connection cursor/projection tx, rollback recovery, migration lock', checks);
}

// ---------------------------------------------------------------------------
async function buildSummary(summary) {
  const dumpInfo = summary.dump.info || await readDumpInfo(artifactsDir()) || { pg_dump: null, pg_restore: null };
  let sourceManifest = null;
  try { sourceManifest = JSON.parse(await readFile(join(artifactsDir(), 'source-manifest.json'), 'utf8')); } catch { /* optional */ }
  const out = {
    id: 't01-migration-db',
    task: 'T01 database/interfaces (D01-D06)',
    classifier: summary.classifier,
    ok: summary.ok,
    reviewer_pending: true,
    base_commit: baseCommit() ?? sourceManifest?.base_commit ?? null,
    run_id: runId(),
    mode: summary.mode,
    problems: summary.problems,
    source: sourceManifest,
    environment: {
      os: 'Windows + WSL2 (Linux Node over per-run Unix socket)',
      distro: 'Ubuntu 26.04.1 LTS (WSL2)',
      node: process.version,
      postgresql: {
        cluster: 'disposable (official postgresql-18 apt extracted to owned temp dir)',
        listener: 'per-run Unix socket (loopback TCP disabled for the client)',
        port: process.env.SHOWSTAKE_PG_PORT || null,
        superuser: process.env.SHOWSTAKE_PG_USER || 'showstake',
        databases: [process.env.SHOWSTAKE_PG_DB1, process.env.SHOWSTAKE_PG_DB2, 'showstake_drift/06 (temporary)'],
      },
    },
    commands: [
      'wsl -d Ubuntu -- bash scripts/postgres-disposable/run-suite.sh',
      'node migrations/tests/run-t01.mjs d01|d02|d03|d04-fixtures|d04-verify|d05|d06|finalize (Linux Node, Unix socket)',
      'node migrations/cli.mjs status  (READ-ONLY, advisory-lock migration runner)',
      'node packages/domain/verify.mjs  (D05-static money strings/states/envelopes)',
      'node migrations/verify-baseline.mjs (baseline provenance, no edit)',
      'node scripts/verify-t01-aggregate.mjs (fail-closed aggregate regressions)',
      'node scripts/verify-openapi.mjs (pinned OpenAPI validation)',
      'pg_dump -Fc showstake_disposable | pg_restore --no-owner --no-privileges showstake_restore',
    ],
    d04_dump_restore: dumpInfo,
    stages: summary.stages,
    phases: summary.phases,
    totals: summary.totals,
    note: 'LABELED design-sample fixtures only; no chain/live data, no secrets. D04 replay rebuilds projections from immutable labeled chain_events with the Product01 invariant accepted=paid+pending+liability (withdrawn credit included). DB1==DB2 roundtrip and replay are local sandbox equivalence, never chained evidence. Full acceptance aggregates static/readiness/cli/dump/stop/cleanup plus every phase from the same run; a no-dump "all" run is NOT_RUN (partial), never PASS_LOCAL. Worker-authored; Codex review pending.',
  };
  await writeFile(join(ROOT, 'docs', 'evidence', 't01-migration-db.json'), JSON.stringify(out, null, 2) + '\n');
  await writeFile(join(ROOT, 'docs', 'evidence', 't01-migration-db.md'), markdown(out));
  return out;
}

function markdown(s) {
  const lines = [`# T01 migration/database evidence (D01–D06)`, ``,
    `Classifier: **${s.classifier}** — worker-authored, Codex review pending.`, ``,
    `Base commit: \`${s.base_commit ?? 'unknown'}\` · run id: \`${s.run_id ?? 'unknown'}\` · mode: \`${s.mode}\``, ``,
    `## Environment`, ``,
    `- OS: ${s.environment.os}`, `- WSL distro: ${s.environment.distro}`,
    `- Node: ${s.environment.node}`, `- PostgreSQL: ${s.environment.postgresql.cluster}`,
    `- listener: ${s.environment.postgresql.listener}`, `- port: \`${s.environment.postgresql.port}\``, ``,
    `## Totals`, ``, `- ${s.totals.checks} checks, ${s.totals.failed} failed`, ``];
  if (s.problems?.length) { lines.push('## Problems', ''); for (const p of s.problems) lines.push(`- ${p}`); lines.push(''); }
  lines.push('## Commands run', '');
  for (const c of s.commands) lines.push(`- \`${c}\``);
  lines.push('', '## Phase results', '');
  for (const [name, p] of Object.entries(s.phases)) {
    lines.push(`### ${name} — ${p.title}`, '', `${p.passed}/${p.checks?.length || 0} passed (${p.ok ? 'PASS' : 'FAIL'})`, '');
    for (const c of (p.checks || [])) {
      lines.push(`- ${c.ok ? 'OK' : 'FAIL'} **${c.id}** — expected ${c.expected}; observed \`${c.observed}\``);
    }
    lines.push('');
  }
  lines.push('## Limits / notes', '', s.note, '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
const PHASES = { d01: runD01, d02: runD02, d03: runD03, 'd04-fixtures': runD04Fixtures, 'd04-verify': runD04Verify, d05: runD05, d06: runD06 };

async function finalize(mode = 'full') {
  const orchestrator = await readOrchestrator(artifactsDir());
  const summary = await aggregate(artifactsDir(), runId(), orchestrator, { mode });
  await buildSummary(summary);
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

(async () => {
  const argv = process.argv.slice(2);
  const PHASE_NAMES = ['d01', 'd02', 'd03', 'd04-fixtures', 'd04-verify', 'd05', 'd06', 'finalize', 'all'];
  const phase = argv.find((a) => PHASE_NAMES.includes(a));
  if (!phase) { console.error('usage: run-t01.mjs <phase|all>'); process.exit(2); }
  if (!artifactsDir() || !runId()) {
    console.error('FATAL: SHOWSTAKE_PG_ARTIFACTS and SHOWSTAKE_PG_RUN_ID (per-run) are required');
    process.exit(2);
  }

  if (phase === 'all') {
    // NO-DUMP "all" run: every DB phase in-process WITHOUT pg_dump/pg_restore. It
    // can never finalize full acceptance and is classified NOT_RUN (partial), not
    // the invented "SMOKE" label and never PASS_LOCAL.
    for (const k of ['d01', 'd02', 'd03', 'd04-fixtures', 'd05', 'd06']) {
      await PHASES[k]();
    }
    await finalize('smoke');
    console.error('note: "all" is a no-dump smoke run -> NOT_RUN (partial); full acceptance requires pg_dump/pg_restore.');
    process.exit(1);
  }
  if (phase === 'finalize') {
    const s = await finalize('full');
    process.exit(s.ok ? 0 : 1);
  }
  const fn = PHASES[phase];
  if (!fn) { console.error(`unknown phase ${phase}`); process.exit(2); }
  const s = await fn();
  process.exit(s.ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
