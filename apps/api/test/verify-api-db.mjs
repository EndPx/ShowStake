// apps/api disposable-PostgreSQL acceptance (D-acceptance for the API layer).
// Runs under WSL/Linux Node over the per-run Unix socket (same convention as
// migrations/tests). Requires the env exported by scripts/postgres-disposable:
//   SHOWSTAKE_PG_SOCKET / _PORT / _USER / _DB1 / _ARTIFACTS / _RUN_ID
//
// Classifier: PASS_LOCAL (generated ed25519 keypair + fake final access-key
// resolver; NO wallet/testnet proof is claimed). The DB is a real disposable
// PostgreSQL cluster; projections are seeded by the worker role, the API role's
// read-only projection grants are re-asserted, and challenge/session rows are
// written through the real PgStore (transactional single-use nonce).
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../dist/app.js';
import { PgStore } from '../dist/store/pg-store.js';
import { loadConfig } from '../dist/config.js';
import { createScopedPool, assertRuntimeLeastPrivilege } from '../dist/db.js';
import { sha256Hex, newUuid } from '../dist/lib/util.js';
import { listMigrations, runMigrations, connectConfig } from '../../../migrations/runner.mjs';
import { makeKeypair, signChallenge, makeFakeResolver } from './fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../../..');
const SCHEMA_DIR = join(ROOT, 'migrations', 'schema');

const DOMAIN = 'app.showstake.local';
const NETWORK = 'testnet';
const ORIGIN = 'http://app.showstake.local';

const DB = () => process.env.SHOWSTAKE_PG_DB1 || 'showstake_disposable';
const SOCKET = () => process.env.SHOWSTAKE_PG_SOCKET || null;
const ARTIFACTS = () => process.env.SHOWSTAKE_PG_ARTIFACTS || null;
const RUN_ID = () => process.env.SHOWSTAKE_PG_RUN_ID || 'local';

const results = [];
function check(id, ok, expected, observed) {
  results.push({ id, ok: Boolean(ok), expected, observed, classifier: 'PASS_LOCAL' });
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${id}  (observed: ${observed})`);
}

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

async function makePool(db) {
  return createScopedPool({ ...connectConfig(db, SOCKET()), user: 'showstake_api_service', application_name: 'showstake-api-acceptance' }, 'showstake_api');
}

async function inject(app, method, url, payload, cookie, origin = ORIGIN) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  const opts = { method, url, headers };
  if (payload !== undefined) opts.payload = payload;
  const res = await app.inject(opts);
  return res;
}

function cookieFrom(res) {
  const sc = res.headers['set-cookie'];
  if (!sc) return null;
  const arr = Array.isArray(sc) ? sc : [sc];
  const first = arr[0] ?? '';
  return first.split(';')[0] || null;
}
function tokenFromCookie(cookie) {
  if (!cookie) return null;
  const eq = cookie.indexOf('=');
  return eq >= 0 ? cookie.slice(eq + 1) : null;
}

const EVENT_ID = '00000000-0000-4000-8000-0000000000a1';
const DEPLOYMENT_ID = '00000000-0000-4000-8000-0000000000b1';

async function seedEvent(client) {
  // Seed as superuser; the worker role owns projections, so SET ROLE to prove the
  // worker path writes them (the API only reads them).
  await client.query(`
    INSERT INTO deployments (id, environment, network, contract_id, ft_contract_id, ft_decimals, start_block, code_hash)
    VALUES ($1, 'testnet', 'testnet', 'escrow.showstake.testnet', 'ft.showstake.testnet', 6, 1, $2)
    ON CONFLICT (network, contract_id) DO NOTHING`,
    [DEPLOYMENT_ID, '0'.repeat(64)]);
  await client.query('SET ROLE showstake_worker');
  await client.query(`
    INSERT INTO events_projection
      (id, deployment_id, chain_event_id, organizer_account, asset_contract, deposit_atomic, capacity,
       reg_open, reg_close, cancel_cutoff, checkin_open, checkin_close, finalize_deadline,
       state, policy_version, rules_hash, accepted_atomic, paid_atomic, pending_atomic, liability_atomic, observed_at)
    VALUES ($1, $2, $3, 'bob.testnet', 'ft.showstake.testnet', '5000000', 50,
       '2026-11-06T00:00:00Z', '2026-11-07T00:00:00Z', '2026-11-07T12:00:00Z',
       '2026-11-07T12:00:00Z', '2026-11-08T12:00:00Z', '2026-11-09T12:00:00Z',
       'PUBLISHED', 'policy-1', 'rules-hash-1', '10000000', '0', '0', '10000000', now())
    ON CONFLICT (deployment_id, chain_event_id) DO NOTHING`,
    [EVENT_ID, DEPLOYMENT_ID, 'evt-api-1']);
  await client.query('RESET ROLE');
}

async function run() {
  if (!SOCKET()) throw new Error('SHOWSTAKE_PG_SOCKET is required (run via scripts/postgres-disposable/run-api-suite.sh)');

  const client = await rawClient(DB());
  try {
    // 1. Apply migrations (bootstrap + all pending) on the disposable cluster.
    const migrations = await listMigrations(SCHEMA_DIR);
    const applied = await runMigrations(client, migrations);
    check('DB_MIGRATIONS_APPLIED', applied.length >= 2, '>=2 migrations applied', `applied=${applied.length}`);

    // 2. Seed a projection event as the worker role.
    await seedEvent(client);

    // 3. API role cannot update financial projections (no DB financial authority).
    await client.query('SET ROLE showstake_api');
    let apiWriteDenied = false;
    try {
      await client.query(`UPDATE events_projection SET deposit_atomic='1' WHERE id=$1`, [EVENT_ID]);
    } catch (e) { apiWriteDenied = e.code === '42501'; }
    await client.query('RESET ROLE');
    check('API_ROLE_NO_PROJECTION_WRITE', apiWriteDenied, 'showstake_api UPDATE projection denied 42501', `denied=${apiWriteDenied}`);

    // The service LOGIN has no operator credentials or direct table rights.
    await client.query('CREATE ROLE showstake_api_service LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    await client.query('GRANT showstake_api TO showstake_api_service');
    const pool = await makePool(DB());
    await assertRuntimeLeastPrivilege(pool, 'showstake_api');
    check('DB_RUNTIME_RESTRICTED_LOGIN', true, 'actual service LOGIN and API role validated', 'showstake_api_service / showstake_api');
    const service = await pool.connect();
    try {
      await service.query('RESET ROLE');
      let denied = false;
      try { await service.query('DELETE FROM public.events_projection WHERE false'); } catch (e) { denied = e.code === '42501'; }
      check('DB_RESET_ROLE_CANNOT_ESCALATE', denied, 'RESET ROLE cannot restore operator authority', String(denied));
      await service.query('SET ROLE showstake_api');
    } finally { service.release(); }
    const unsafePool = createScopedPool(connectConfig(DB(), SOCKET()), 'showstake_api');
    let unsafeRejected = false;
    try { await assertRuntimeLeastPrivilege(unsafePool, 'showstake_api'); } catch { unsafeRejected = true; }
    await unsafePool.end();
    check('DB_OPERATOR_LOGIN_REJECTED', unsafeRejected, 'operator credentials rejected by pool', String(unsafeRejected));
    const store = new PgStore(pool);
    const journalSeed={approvalId:'00000000-0000-4000-8000-0000000000e1',treasury:'journal.test.near',planHash:'a'.repeat(64),nativeReservedAtomic:'0',usdcReservedAtomic:'0',journal:{}};
    let winners=0;await Promise.all(Array.from({length:5},()=>store.updateRheaRun(journalSeed,run=>{if(!run.journal.operation){winners++;run.journal.operation='one';run.nativeReservedAtomic='50';}return run;})));
    const journal=await new PgStore(pool).getRheaRun(journalSeed.approvalId);check('DB_RHEA_SINGLE_RESERVATION',winners===1&&journal?.nativeReservedAtomic==='50'&&journal?.journal.operation==='one','restricted role serializes one reservation and survives new store',JSON.stringify({winners,native:journal?.nativeReservedAtomic}));
    let mismatch=false;try{await store.updateRheaRun({...journalSeed,planHash:'b'.repeat(64)},r=>r);}catch{mismatch=true;}check('DB_RHEA_IMMUTABLE_PLAN',mismatch,'same approval cannot be reused with another plan',String(mismatch));
    const config = loadConfig({ AUTH_DOMAIN: DOMAIN, AUTH_NETWORK: NETWORK, COOKIE_SECURE: 'false' });
    const kp = makeKeypair();
    // Real PostgreSQL QR consumption is atomic under concurrent scans and cannot
    // change the worker-owned attendance projection.
    const registrationId='00000000-0000-4000-8000-0000000000d1';
    const passId='00000000-0000-4000-8000-0000000000d2';
    await client.query('SET ROLE showstake_worker');
    await client.query(`INSERT INTO registrations_projection(id,event_id,chain_registration_id,sequence_no,participant_account,beneficiary_account,commitment_id,principal_atomic,state,attended,claim_atomic,payout_state,observed_at) VALUES($1,$2,'chain-reg',0,$3,$3,'commitment','10','COMMITTED',false,'0','NOT_CLAIMABLE',now())`,[registrationId,EVENT_ID,kp.accountId]);
    await client.query(`INSERT INTO passes_projection(id,registration_id,deployment_id,pass_id,owner_account,issued_at,observed_at,event_id) VALUES($1,$2,$3,'chain-pass',$4,now(),now(),$5)`,[passId,registrationId,DEPLOYMENT_ID,kp.accountId,EVENT_ID]);
    await client.query('RESET ROLE');
    const found=await store.findPass(EVENT_ID,passId,kp.accountId);
    check('DB_QR_PASS_LOOKUP',found?.chainPassId==='chain-pass' && found.registrationId===registrationId,'projection lookup maps to chain pass',String(found?.chainPassId));
    const [projectedPass,projectedClaim,projectedAttendance]=await Promise.all([store.listPasses(kp.accountId,'testnet'),store.listClaims(kp.accountId,'testnet'),store.getAttendance(EVENT_ID,'bob.testnet','testnet')]);
    check('DB_PRIVATE_CHAIN_IDENTITY',projectedPass[0]?.chainPassId==='chain-pass'&&projectedPass[0]?.chainRegistrationId==='chain-reg'&&projectedPass[0]?.contractId==='escrow.showstake.testnet'&&projectedClaim[0]?.chainEventId==='evt-api-1'&&projectedClaim[0]?.chainPassId==='chain-pass'&&projectedClaim[0]?.bonusAtomic==='0'&&projectedAttendance?.[0]?.chainRegistrationId==='chain-reg'&&projectedAttendance?.[0]?.network==='testnet','restricted role reads exact chain tuple and unsigned pre-settlement bonus',JSON.stringify({passes:projectedPass.length,claims:projectedClaim.length}));
    const qrId=newUuid(), nonceHash=sha256Hex('fixture-nonce'), issued=Date.now();
    await store.createQr({id:qrId,registrationId,nonceHash,owner:kp.accountId,issuedAt:issued,expiresAt:issued+60000});
    const base={id:qrId,eventId:EVENT_ID,nonceHash,owner:kp.accountId,organizer:'bob.testnet'};
    const consumed=await Promise.all([store.consumeQr({...base,requestId:newUuid()}),store.consumeQr({...base,requestId:newUuid()})]);
    const stored=await client.query(`SELECT q.consumed_at, r.attended, c.state FROM qr_challenges q JOIN registrations_projection r ON r.id=q.registration_id JOIN checkin_requests c ON c.qr_challenge_id=q.id WHERE q.id=$1`,[qrId]);
    check('DB_QR_CONCURRENT_SINGLE_PROPOSAL',consumed.filter(Boolean).length===1 && stored.rows.length===1 && stored.rows[0].state==='PROPOSED' && stored.rows[0].attended===false,'one proposal, no attendance mutation',JSON.stringify(consumed));
    const expiredId=newUuid(), old=Date.now()-61000;
    await store.createQr({id:expiredId,registrationId,nonceHash:sha256Hex('expired-fixture'),owner:kp.accountId,issuedAt:old,expiresAt:old+60000});
    const expiredResult=await store.consumeQr({id:expiredId,eventId:EVENT_ID,nonceHash:sha256Hex('expired-fixture'),owner:kp.accountId,organizer:'bob.testnet',requestId:newUuid()});
    check('DB_QR_EXPIRED',expiredResult===false,'expired QR cannot be consumed',String(expiredResult));
    const app = buildApp({ store, config, accessKeyVerifier: makeFakeResolver(kp.accountId, kp.publicKey, NETWORK) });

    // 5. Health against a real DB.
    const h = await inject(app, 'GET', '/health');
    check('DB_HEALTH_UP', h.statusCode === 200 && h.json().db === 'up', 'health 200 db up', JSON.stringify(h.json()));
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const httpHealth = await fetch(`${address}/health`, { signal: AbortSignal.timeout(5000) });
    check('DB_REAL_HTTP_SERVER', httpHealth.status === 200 && (await httpHealth.json()).db === 'up', 'real loopback HTTP server reads real DB', httpHealth.status);

    // 6. Public event reads from the projection (exact-money string roundtrip).
    const list = await inject(app, 'GET', '/v1/events');
    const lbody = list.json();
    check('DB_EVENT_LIST', list.statusCode === 200 && lbody.data && lbody.data.items.length === 1, 'one published event listed', `count=${lbody.data?.items?.length}`);
    check('DB_EVENT_MONEY', lbody.data?.items?.[0]?.depositAtomic === '5000000' && typeof lbody.data.items[0].depositAtomic === 'string', 'deposit serialized as canonical string', lbody.data?.items?.[0]?.depositAtomic);
    check('DB_EVENT_TOTALS', lbody.data?.items?.[0]?.totals?.acceptedAtomic === '10000000' && lbody.data?.items?.[0]?.totals?.liabilityAtomic === '10000000', 'projection totals exact', JSON.stringify(lbody.data?.items?.[0]?.totals));
    const detail = await inject(app, 'GET', `/v1/events/${EVENT_ID}`);
    check('DB_EVENT_DETAIL', detail.statusCode === 200 && detail.json().data?.organizerAccount === 'bob.testnet', 'event detail', String(detail.statusCode));
    check('DB_CHAIN_EVENT_ID', detail.json().data?.chainEventId === 'evt-api-1' && detail.json().data?.chainEventId !== EVENT_ID, 'contract event ID is distinct from database UUID', detail.json().data?.chainEventId);
    const mainDep='00000000-0000-4000-8000-0000000000e2',mainEvent='00000000-0000-4000-8000-0000000000e3';
    await client.query(`INSERT INTO deployments(id,environment,network,contract_id,ft_contract_id,ft_decimals,start_block,code_hash) VALUES($1,'mainnet','mainnet','fixture.near','token.near',6,1,$2)`,[mainDep,'0'.repeat(64)]);
    await client.query('SET ROLE showstake_worker');
    await client.query(`INSERT INTO events_projection(id,deployment_id,chain_event_id,organizer_account,asset_contract,deposit_atomic,capacity,reg_open,reg_close,cancel_cutoff,checkin_open,checkin_close,finalize_deadline,state,policy_version,rules_hash,observed_at) SELECT $1,$2,chain_event_id,organizer_account,'token.near',9007199254740993,capacity,reg_open,reg_close,cancel_cutoff,checkin_open,checkin_close,finalize_deadline,state,policy_version,rules_hash,observed_at FROM events_projection WHERE id=$3`,[mainEvent,mainDep,EVENT_ID]);
    await client.query('RESET ROLE');
    const mainApp=buildApp({store,config:{...config,authNetwork:'mainnet'},accessKeyVerifier:makeFakeResolver(kp.accountId,kp.publicKey,'mainnet')});
    try {const ml=await inject(mainApp,'GET','/v1/events'),tl=await inject(app,'GET','/v1/events');const md=await inject(mainApp,'GET','/v1/events/evt-api-1'),td=await inject(app,'GET','/v1/events/evt-api-1');const mr=await inject(mainApp,'GET','/v1/events/evt-api-1/results'),tr=await inject(app,'GET','/v1/events/evt-api-1/results');const cross=await inject(mainApp,'GET',`/v1/events/${EVENT_ID}/results`);check('DB_PUBLIC_NETWORK_ISOLATION',ml.json().data.items.length===1&&ml.json().data.items[0].id===mainEvent&&tl.json().data.items.length===1&&tl.json().data.items[0].id===EVENT_ID&&md.json().data.id===mainEvent&&md.json().data.depositAtomic==='9007199254740993'&&td.json().data.id===EVENT_ID&&mr.json().data.eventId===mainEvent&&tr.json().data.eventId===EVENT_ID&&cross.statusCode===404,'network-scoped list and colliding chain ids on real PG',String(cross.statusCode));
      const otherDep='00000000-0000-4000-8000-0000000000e4',otherEvent='00000000-0000-4000-8000-0000000000e5',uuidEvent='00000000-0000-4000-8000-0000000000e6',uuidChain='00000000-0000-4000-8000-0000000000e7';
      await client.query(`INSERT INTO deployments(id,environment,network,contract_id,ft_contract_id,ft_decimals,start_block,code_hash) VALUES($1,'mainnet','mainnet','other.near','token.near',6,1,$2)`,[otherDep,'0'.repeat(64)]);await client.query('SET ROLE showstake_worker');
      await client.query(`INSERT INTO events_projection(id,deployment_id,chain_event_id,organizer_account,asset_contract,deposit_atomic,capacity,reg_open,reg_close,cancel_cutoff,checkin_open,checkin_close,finalize_deadline,state,policy_version,rules_hash,observed_at) SELECT $1,$2,chain_event_id,organizer_account,asset_contract,deposit_atomic,capacity,reg_open,reg_close,cancel_cutoff,checkin_open,checkin_close,finalize_deadline,state,policy_version,rules_hash,observed_at FROM events_projection WHERE id=$3`,[otherEvent,otherDep,mainEvent]);
      await client.query(`INSERT INTO events_projection(id,deployment_id,chain_event_id,organizer_account,asset_contract,deposit_atomic,capacity,reg_open,reg_close,cancel_cutoff,checkin_open,checkin_close,finalize_deadline,state,policy_version,rules_hash,observed_at) SELECT $1,$2,$3,organizer_account,asset_contract,deposit_atomic,capacity,reg_open,reg_close,cancel_cutoff,checkin_open,checkin_close,finalize_deadline,state,policy_version,rules_hash,observed_at FROM events_projection WHERE id=$4`,[uuidEvent,otherDep,uuidChain,mainEvent]);await client.query('RESET ROLE');
      const ambiguous=await inject(mainApp,'GET','/v1/events/evt-api-1'),exact=await inject(mainApp,'GET','/v1/events/evt-api-1/results?contractId=other.near'),uuid=await inject(mainApp,'GET',`/v1/events/${uuidChain}`),wrong=await inject(mainApp,'GET',`/v1/events/${uuidChain}?contractId=fixture.near`);
      check('DB_PUBLIC_CONTRACT_IDENTITY',ambiguous.statusCode===404&&exact.statusCode===200&&exact.json().data.eventId===otherEvent&&uuid.statusCode===200&&uuid.json().data.id===uuidEvent&&wrong.statusCode===404,'ambiguous chain id fails closed, contract and UUID-like chain id resolve exactly',`${ambiguous.statusCode}/${exact.statusCode}/${uuid.statusCode}/${wrong.statusCode}`);
    }finally{await mainApp.close();}

    // 7. Full NEP-413 challenge -> verify -> session (real DB rows).
    const chal = await inject(app, 'POST', '/v1/auth/challenge', { accountId: kp.accountId, network: NETWORK, domain: DOMAIN });
    const c = chal.json();
    check('DB_CHALLENGE_ROW', chal.statusCode === 200 && c.data?.challengeId, 'challenge persisted', String(chal.statusCode));
    const chId = c.data.challengeId;
    const sig = signChallenge(kp.privateKey, { message: c.data.message, nonceHex: c.data.nonce, recipient: DOMAIN });
    const verify = await inject(app, 'POST', '/v1/auth/verify', { challengeId: chId, accountId: kp.accountId, network: NETWORK, domain: DOMAIN, nonce: c.data.nonce, publicKey: kp.publicKey, signature: sig }, undefined, ORIGIN);
    check('DB_VERIFY_OK', verify.statusCode === 200 && verify.json().data?.userId, 'verify 200 + userId', String(verify.statusCode));
    const cookie = cookieFrom(verify);
    check('DB_SESSION_COOKIE', !!cookie, 'session cookie set', cookie ? '[REDACTED]' : 'absent');
    if (!cookie) throw new Error('verification did not create a session cookie');
    const me = await inject(app, 'GET', '/v1/me', undefined, cookie);
    check('DB_ME_ACTIVE', me.statusCode === 200 && me.json().data?.active === true, 'session active', String(me.statusCode));

    // Exercise the endpoint through the real restricted PgStore with candidate-shaped final views.
    config.accessContractAllowlist=['testnet:escrow.showstake.testnet'];
    config.accessContractAbis={'testnet:escrow.showstake.testnet':'candidate-v1'};
    config.qrHmacKey='0123456789abcdef0123456789abcdef';
    const privateDir=await mkdtemp(join(tmpdir(),'showstake-api-db-content-'));config.privateContentDir=privateDir;
    const realFetch=globalThis.fetch;
    globalThis.fetch=async (_url,options)=>{
      const request=JSON.parse(options.body), now=Date.now();
      const view=request.params?.method_name==='get_event'
        ? {event_id:'evt-api-1',organizer:kp.accountId,phase:'RegistrationClosed',checkin_open:now-1000,checkin_close:now+60000}
        : {event_id:'evt-api-1',pass_id:'chain-pass',owner:kp.accountId,registration_status:'Active',attendance_status:'Unmarked'};
      const result=request.method==='block' ? {header:{hash:'final-block',timestamp_nanosec:String(BigInt(now)*1000000n)}} : {block_hash:'final-block',result:[...Buffer.from(JSON.stringify(view))]};
      return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}),{status:200});
    };
    try {
      const endpoint=await inject(app,'POST',`/v1/events/${EVENT_ID}/checkin/challenge`,{passId},cookie);
      check('DB_QR_ENDPOINT_CANDIDATE',endpoint.statusCode===200 && !!endpoint.json().data?.token,'restricted PgStore and finalized candidate view issue challenge',String(endpoint.statusCode));
      const uploaded=await inject(app,'POST',`/v1/events/${EVENT_ID}/content`,{title:'Fixture',mimeType:'text/plain',contentBase64:Buffer.from('private').toString('base64')},cookie,ORIGIN);
      check('DB_CONTENT_PUBLISH',uploaded.statusCode===201 && /^[a-f0-9]{64}$/.test(uploaded.json().data?.id ?? ''),'restricted PgStore publishes after chain organizer check',String(uploaded.statusCode));
      const count=await client.query('SELECT count(*)::int n FROM protected_resources WHERE event_id=$1',[EVENT_ID]);check('DB_CONTENT_ROW',count.rows[0].n===1,'one protected resource row',String(count.rows[0].n));
    } finally { globalThis.fetch=realFetch;await rm(privateDir,{recursive:true,force:true}); }

    // 8. Replay -> 401.
    const replay = await inject(app, 'POST', '/v1/auth/verify', { challengeId: chId, accountId: kp.accountId, network: NETWORK, domain: DOMAIN, nonce: c.data.nonce, publicKey: kp.publicKey, signature: sig }, undefined, ORIGIN);
    check('DB_REPLAY', replay.statusCode === 401 && replay.json().error?.code === 'CHALLENGE_ALREADY_CONSUMED', 'replay 401 consumed', `${replay.statusCode} ${replay.json().error?.code}`);

    // 9. Concurrent nonce: two parallel verifies of one challenge -> exactly one 200.
    const chal2 = await inject(app, 'POST', '/v1/auth/challenge', { accountId: kp.accountId, network: NETWORK, domain: DOMAIN });
    const c2 = chal2.json();
    const sig2 = signChallenge(kp.privateKey, { message: c2.data.message, nonceHex: c2.data.nonce, recipient: DOMAIN });
    const body2 = { challengeId: c2.data.challengeId, accountId: kp.accountId, network: NETWORK, domain: DOMAIN, nonce: c2.data.nonce, publicKey: kp.publicKey, signature: sig2 };
    const [rA, rB] = await Promise.all([
      inject(app, 'POST', '/v1/auth/verify', body2, undefined, ORIGIN),
      inject(app, 'POST', '/v1/auth/verify', body2, undefined, ORIGIN),
    ]);
    const codes = [rA.statusCode, rB.statusCode].sort((a, b) => a - b);
    check('DB_CONCURRENT_NONCE', codes[0] === 200 && codes[1] === 401, 'parallel verify yields exactly one 200 and one 401', JSON.stringify(codes));

    // 10. Session lifecycle failures via real DB rows.
    //    a) logout revokes.
    const out = await inject(app, 'POST', '/v1/auth/logout', {}, cookie, ORIGIN);
    check('DB_LOGOUT', out.statusCode === 200 && out.json().data?.revoked === true, 'logout revokes', String(out.statusCode));
    const meRevoked = await inject(app, 'GET', '/v1/me', undefined, cookie);
    check('DB_REVOKED_REJECTED', meRevoked.statusCode === 401 && meRevoked.json().error?.code === 'SESSION_REVOKED', 'revoked session rejected', String(meRevoked.json().error?.code));

    //    b) fresh login -> absolute expiry -> rejected.
    const chal3 = await inject(app, 'POST', '/v1/auth/challenge', { accountId: kp.accountId, network: NETWORK, domain: DOMAIN });
    const c3 = chal3.json();
    const sig3 = signChallenge(kp.privateKey, { message: c3.data.message, nonceHex: c3.data.nonce, recipient: DOMAIN });
    const v3 = await inject(app, 'POST', '/v1/auth/verify', { challengeId: c3.data.challengeId, accountId: kp.accountId, network: NETWORK, domain: DOMAIN, nonce: c3.data.nonce, publicKey: kp.publicKey, signature: sig3 }, undefined, ORIGIN);
    const cookie3 = cookieFrom(v3);
    const tok3 = tokenFromCookie(cookie3);
    if (tok3) await client.query(`UPDATE sessions SET absolute_expires_at = to_timestamp(1), idle_expires_at = to_timestamp(1) WHERE token_hash = $1`, [sha256Hex(tok3)]);
    const meAbs = await inject(app, 'GET', '/v1/me', undefined, cookie3);
    check('DB_ABSOLUTE_EXPIRY', meAbs.statusCode === 401 && meAbs.json().error?.code === 'SESSION_EXPIRED', 'absolute-expired session rejected', String(meAbs.json().error?.code));

    //    c) fresh login -> idle expiry -> rejected.
    const chal4 = await inject(app, 'POST', '/v1/auth/challenge', { accountId: kp.accountId, network: NETWORK, domain: DOMAIN });
    const c4 = chal4.json();
    const sig4 = signChallenge(kp.privateKey, { message: c4.data.message, nonceHex: c4.data.nonce, recipient: DOMAIN });
    const v4 = await inject(app, 'POST', '/v1/auth/verify', { challengeId: c4.data.challengeId, accountId: kp.accountId, network: NETWORK, domain: DOMAIN, nonce: c4.data.nonce, publicKey: kp.publicKey, signature: sig4 });
    const cookie4 = cookieFrom(v4);
    await client.query(`UPDATE sessions SET idle_expires_at = to_timestamp(1) WHERE token_hash = $1`, [sha256Hex(tokenFromCookie(cookie4))]);
    const meIdle = await inject(app, 'GET', '/v1/me', undefined, cookie4);
    check('DB_IDLE_EXPIRY', meIdle.statusCode === 401 && meIdle.json().error?.code === 'SESSION_IDLE_EXPIRED', 'idle-expired session rejected', String(meIdle.json().error?.code));

    //    d) challenge expiry at the DB row level.
    const chal5 = await inject(app, 'POST', '/v1/auth/challenge', { accountId: kp.accountId, network: NETWORK, domain: DOMAIN });
    const c5 = chal5.json();
    await client.query(`UPDATE auth_challenges SET issued_at = to_timestamp(1), expires_at = to_timestamp(2) WHERE id = $1`, [c5.data.challengeId]);
    const sig5 = signChallenge(kp.privateKey, { message: c5.data.message, nonceHex: c5.data.nonce, recipient: DOMAIN });
    const v5 = await inject(app, 'POST', '/v1/auth/verify', { challengeId: c5.data.challengeId, accountId: kp.accountId, network: NETWORK, domain: DOMAIN, nonce: c5.data.nonce, publicKey: kp.publicKey, signature: sig5 });
    check('DB_CHALLENGE_EXPIRY', v5.statusCode === 401, 'expired challenge denied 401', `${v5.statusCode} ${v5.json().error?.code}`);

    await app.close();
    // A competing transaction locks the challenge WITHOUT changing it. Expiry
    // must be evaluated after that wait, not in an earlier UPDATE predicate.
    const shortApp = buildApp({ store, config: { ...config, challengeTtlMs: 500 }, accessKeyVerifier: makeFakeResolver(kp.accountId, kp.publicKey, NETWORK) });
    const short = (await inject(shortApp, 'POST', '/v1/auth/challenge', { accountId: kp.accountId, network: NETWORK, domain: DOMAIN })).json().data;
    await client.query('BEGIN');
    await client.query('SELECT id FROM auth_challenges WHERE id = $1 FOR UPDATE', [short.challengeId]);
    const expiredTokenHash = sha256Hex('local-expired-lock-regression');
    const pending = store.consumeAndOpenSession({ challengeId: short.challengeId, namespace: 'near', network: NETWORK, accountId: kp.accountId, walletKind: 'participant', sessionId: newUuid(), tokenHash: expiredTokenHash, idleMs: config.sessionIdleMs, absoluteMs: config.sessionAbsoluteMs });
    let lockObserved = false;
    for (let i = 0; i < 40; i++) {
      const waiting = await client.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = 'showstake-api-acceptance' AND wait_event_type = 'Lock'");
      if (waiting.rows[0].count > 0) { lockObserved = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await client.query('SELECT pg_sleep(0.7)');
    await client.query('COMMIT');
    const openedAfterExpiry = await pending;
    check('DB_EXPIRY_LOCK_OVERLAP', lockObserved, 'actual overlapping lock wait observed', String(lockObserved));
    check('DB_EXPIRY_AFTER_LOCK_DENIED', openedAfterExpiry === null, 'expired challenge cannot open session after lock wait', String(openedAfterExpiry === null));
    const afterLock = await client.query('SELECT consumed_at FROM auth_challenges WHERE id = $1', [short.challengeId]);
    check('DB_EXPIRY_AFTER_LOCK_UNCONSUMED', afterLock.rows[0].consumed_at === null, 'rejected expired nonce stays unconsumed', String(afterLock.rows[0].consumed_at === null));
    await shortApp.close();
    await app.close();
    await pool.end();

    const failed = results.filter((r) => !r.ok);
    if (results.length < 20 || !results.some(r => r.id === 'DB_EXPIRY_AFTER_LOCK_DENIED') || !results.some(r => r.id === 'DB_RUNTIME_RESTRICTED_LOGIN')) throw new Error('incomplete DB acceptance inventory');
    const summary = {
      id: 'api-increment-db',
      task: 'apps/api challenge/verify/session + public event reads (DB acceptance)',
      classifier: failed.length === 0 ? 'PASS_LOCAL' : 'FAILED',
      ok: failed.length === 0,
      reviewer_pending: true,
      run_id: RUN_ID(),
      environment: {
        os: 'Windows + WSL2 (Linux Node over per-run Unix socket)',
        postgresql: 'disposable postgresql-18 cluster',
        database: DB(),
        socket: SOCKET(),
      },
      totals: { checks: results.length, failed: failed.length },
      checks: results,
      commands: [
        'wsl -d Ubuntu -- bash scripts/postgres-disposable/run-api-suite.sh',
        'node scripts/verify-api.mjs (LOCAL no-DB unit checks)',
      ],
      note: 'LABELED local only: generated ed25519 keypair + fake final access-key resolver (never a wallet/testnet proof). Real disposable PostgreSQL: migrations applied, worker-seeded projection, API role read-only on projections re-asserted, transactional single-use nonce (replay/concurrent), and secure session lifecycle (revoke/idle/absolute/challenge expiry) exercised through the PgStore.',
    };
    if (ARTIFACTS()) {
      await mkdir(ARTIFACTS(), { recursive: true });
      await writeFile(join(ARTIFACTS(), 'api-db.json'), JSON.stringify(summary, null, 2));
    }
    await writeFile(join(ROOT, 'docs', 'evidence', `api-db-${RUN_ID()}.json`), JSON.stringify(summary, null, 2) + '\n');

    console.log(`\nverify-api-db: ${results.length - failed.length}/${results.length} checks passed`);
    return summary;
  } finally {
    await client.end().catch(() => {});
  }
}

const deadline = setTimeout(() => { console.error('verify-api-db FAILED: suite deadline'); process.exit(1); }, 120000);
try {
  const summary = await run();
  clearTimeout(deadline);
  process.exit(summary.ok ? 0 : 1);
} catch (e) {
  clearTimeout(deadline);
  console.error('verify-api-db FATAL:', e instanceof Error ? e.message : String(e));
  process.exit(1);
}
