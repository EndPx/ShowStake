import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, recordPhase, result, uuid } from './lib.mjs';
import { FIX, seedBase } from './fixtures.mjs';
import { listMigrations, runMigrations } from '../runner.mjs';

// This suite truncates fixture tables and upgrades a fresh disposable database.
if (!process.env.SHOWSTAKE_PG_SOCKET || !process.env.SHOWSTAKE_PG_ARTIFACTS || !process.env.SHOWSTAKE_PG_DB1) {
  throw new Error('SHOWSTAKE_PG_SOCKET, SHOWSTAKE_PG_ARTIFACTS and SHOWSTAKE_PG_DB1 are required for the disposable database');
}
const client = await connect(process.env.SHOWSTAKE_PG_DB1);
const checks = [];
const check = (id, ok, observed) => checks.push(result(id, ok, 'true', String(observed)));
async function rejects(id, sql, args) {
  await client.query('SAVEPOINT negative_case');
  try {
    await client.query(sql, args);
    check(id, false, 'unexpected success');
  } catch (error) {
    check(id, error.code === '23503', error.code);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT negative_case');
    await client.query('RELEASE SAVEPOINT negative_case');
  }
}
try {
  const existing = await client.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')");
  if (existing.rows[0].n !== 0) throw new Error('refusing nonempty database');
  const migrations = await listMigrations(join(dirname(fileURLToPath(import.meta.url)), '..', 'schema'));
  await runMigrations(client, migrations.filter(m => m.version <= 7));
  await seedBase(client);
  await client.query(`INSERT INTO passes_projection(id,registration_id,deployment_id,pass_id,owner_account,issued_at,observed_at) VALUES($1,$2,$3,'upgrade-pass','alice.testnet',now(),now())`, [FIX.passActive, FIX.regActive, FIX.deployment]);
  await client.query("UPDATE passes_projection SET owner_account='wrong.testnet' WHERE id=$1", [FIX.passActive]);
  let invalidUpgrade;
  try { await runMigrations(client, migrations); } catch (error) { invalidUpgrade=error; }
  const failedState=await client.query(`SELECT
    (SELECT count(*) FROM schema_migrations WHERE version=8)::int AS applied,
    (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='passes_projection' AND column_name='event_id')::int AS event_column,
    (SELECT owner_account FROM passes_projection WHERE id=$1) AS owner`,[FIX.passActive]);
  check('invalid_existing_rows_abort_migration',invalidUpgrade?.code==='23503'&&failedState.rows[0].applied===0&&failedState.rows[0].event_column===0&&failedState.rows[0].owner==='wrong.testnet',JSON.stringify(failedState.rows[0]));
  // Correct only this explicitly synthetic legacy fixture, then retry the migration.
  await client.query("UPDATE passes_projection SET owner_account='alice.testnet' WHERE id=$1", [FIX.passActive]);
  await runMigrations(client, migrations);
  check('migration_reapply_idempotent',(await runMigrations(client,migrations)).length===0,'no migrations reapplied');
  const backfill = await client.query('SELECT event_id FROM passes_projection WHERE id=$1', [FIX.passActive]);
  check('upgrade_backfill', backfill.rows[0]?.event_id === FIX.event, backfill.rows[0]?.event_id);
  await client.query('BEGIN');
  const user2=uuid(), binding2=uuid(), event2=uuid(), reg2=uuid(), dep2=uuid(), qr1=uuid(), qr2=uuid();
  await client.query('INSERT INTO app_users(id) VALUES($1)', [user2]);
  await client.query("INSERT INTO wallet_bindings(id,user_id,namespace,network,account_id,wallet_kind,verified_at) VALUES($1,$2,'near','testnet','carol.testnet','wallet',now())", [binding2,user2]);
  await client.query("INSERT INTO deployments(id,environment,network,contract_id,ft_contract_id,ft_decimals,start_block,code_hash) VALUES($1,'testnet','testnet','other.testnet','ft.testnet',6,1,'hash')", [dep2]);
  await client.query(`INSERT INTO events_projection(id,deployment_id,chain_event_id,organizer_account,asset_contract,deposit_atomic,capacity,reg_open,reg_close,cancel_cutoff,checkin_open,checkin_close,finalize_deadline,state,policy_version,rules_hash,observed_at)
    SELECT $1,deployment_id,'event-2','carol.testnet',asset_contract,deposit_atomic,capacity,reg_open,reg_close,cancel_cutoff,checkin_open,checkin_close,finalize_deadline,state,policy_version,rules_hash,now() FROM events_projection WHERE id=$2`, [event2,FIX.event]);
  await client.query(`INSERT INTO registrations_projection(id,event_id,chain_registration_id,sequence_no,participant_account,beneficiary_account,commitment_id,principal_atomic,state,payout_state,observed_at)
    VALUES($1,$2,'reg-2',0,'carol.testnet','carol.testnet','commit-2',1,'COMMITTED','NOT_CLAIMABLE',now())`, [reg2,event2]);
  await client.query(`INSERT INTO qr_challenges(id,registration_id,nonce_hash,owner_account,key_id,issued_at,expires_at) VALUES($1,$2,'nonce-1','alice.testnet','key',now(),now()+interval '30 seconds'),($3,$4,'nonce-2','carol.testnet','key',now(),now()+interval '30 seconds')`, [qr1,FIX.regActive,qr2,reg2]);
  await client.query(`INSERT INTO checkin_requests(id,registration_id,organizer_account,manual_reason,state) VALUES($1,$2,'carol.testnet','manual','PROPOSED')`, [uuid(),reg2]);
  await client.query(`INSERT INTO sessions(id,token_hash,user_id,created_at,last_seen_at,idle_expires_at,absolute_expires_at) VALUES($1,'null-binding',$2,now(),now(),now(),now())`, [uuid(),user2]);
  await client.query(`INSERT INTO passes_projection(id,registration_id,deployment_id,event_id,pass_id,owner_account,issued_at,observed_at) VALUES($1,$2,$3,$4,'pass-2','carol.testnet',now(),now())`, [uuid(),reg2,FIX.deployment,event2]);
  await client.query(`INSERT INTO payouts_projection(id,registration_id,payout_id,recipient_account,amount_atomic,state,observed_at) VALUES($1,$2,'pay-2','carol.testnet',1,'PENDING',now())`, [uuid(),reg2]);
  await client.query(`UPDATE funding_attempts SET source_binding_id=NULL, registration_id=$1 WHERE id=$2`, [FIX.regActive,FIX.fundingAttempt]);
  await client.query(`INSERT INTO checkin_requests(id,registration_id,qr_challenge_id,organizer_account,state) VALUES($1,$2,$3,'carol.testnet','PROPOSED')`, [uuid(),reg2,qr2]);
  check('two_events_and_optional_nulls', true, 'inserted');
  const session = `INSERT INTO sessions(id,token_hash,user_id,wallet_binding_id,created_at,last_seen_at,idle_expires_at,absolute_expires_at) VALUES($1,$2,$3,$4,now(),now(),now(),now())`;
  await rejects('event_deployment_asset',`UPDATE events_projection SET asset_contract='wrong-ft.testnet' WHERE id=$1`,[FIX.event]);
  await rejects('session_owner',session,[uuid(),uuid(),user2,FIX.bindingParticipant]);
  await rejects('draft_owner',`INSERT INTO event_drafts(id,owner_user_id,organizer_binding_id,body) VALUES($1,$2,$3,'{}')`,[uuid(),user2,FIX.bindingOrganizer]);
  await rejects('funding_near_owner',`UPDATE funding_attempts SET user_id=$1 WHERE id=$2`,[user2,FIX.fundingAttempt]);
  await rejects('funding_near_account',`UPDATE funding_attempts SET participant_account='carol.testnet' WHERE id=$1`,[FIX.fundingAttempt]);
  await rejects('funding_source_owner',`UPDATE funding_attempts SET source_binding_id=$1 WHERE id=$2`,[binding2,FIX.fundingAttempt]);
  await rejects('funding_registration_event',`UPDATE funding_attempts SET registration_id=$1 WHERE id=$2`,[reg2,FIX.fundingAttempt]);
  await rejects('pass_registration_event',`UPDATE passes_projection SET event_id=$1 WHERE id=$2`,[event2,FIX.passActive]);
  await rejects('pass_event_deployment',`UPDATE passes_projection SET deployment_id=$1 WHERE id=$2`,[dep2,FIX.passActive]);
  await rejects('pass_owner',`UPDATE passes_projection SET owner_account='carol.testnet' WHERE id=$1`,[FIX.passActive]);
  await rejects('payout_recipient',`INSERT INTO payouts_projection(id,registration_id,payout_id,recipient_account,amount_atomic,state,observed_at) VALUES($1,$2,'pay','carol.testnet',1,'PENDING',now())`,[uuid(),FIX.regActive]);
  await rejects('qr_owner',`UPDATE qr_challenges SET owner_account='carol.testnet' WHERE id=$1`,[qr1]);
  await rejects('checkin_qr_registration',`INSERT INTO checkin_requests(id,registration_id,qr_challenge_id,organizer_account,state) VALUES($1,$2,$3,'carol.testnet','PROPOSED')`,[uuid(),reg2,qr1]);
  await rejects('delete_registration_parent',`DELETE FROM registrations_projection WHERE id=$1`,[FIX.regActive]);
  await rejects('delete_event_parent',`DELETE FROM events_projection WHERE id=$1`,[event2]);
  await rejects('registration_owner_immutable',`UPDATE registrations_projection SET participant_account='other.testnet',beneficiary_account='other.testnet' WHERE id=$1`,[FIX.regActive]);
  const catalog = await client.query(`SELECT c.relname AS table_name, EXISTS(SELECT 1 FROM pg_constraint p WHERE p.conrelid=c.oid AND p.contype='p') AS has_pk FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname`);
  const fks = await client.query(`SELECT c.conname, c.convalidated,child.relname AS child_table,parent.relname AS parent_table,
    pg_get_constraintdef(c.oid) AS definition,c.confdeltype AS on_delete
    FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
    JOIN pg_class child ON child.oid=c.conrelid JOIN pg_class parent ON parent.oid=c.confrelid
    WHERE n.nspname='public' AND c.contype='f' ORDER BY c.conname`);
  check('all_tables_have_primary_keys',catalog.rows.every(r=>r.has_pk),JSON.stringify(catalog.rows));
  check('all_foreign_keys_validated',fks.rows.length > 0 && fks.rows.every(r=>r.convalidated),JSON.stringify(fks.rows));
  check('history_foreign_keys_do_not_cascade',fks.rows.every(r=>['a','r'].includes(r.on_delete)),'NO ACTION or RESTRICT only');
  await client.query('ROLLBACK');
  const summary = await recordPhase('relations','Relational isolation upgrade',checks,{primary_keys:catalog.rows,foreign_keys:fks.rows});
  if (!summary.ok) process.exitCode=1;
} finally {
  await client.end();
}
