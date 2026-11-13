// apps/api LOCAL (no-DB) verification — proves the fail-closed challenge/
// verify/session/logout lifecycle with an in-memory store and a fake final
// access-key resolver. Classifier for every check is PASS_LOCAL: a fixture or a
// generated ed25519 keypair is NEVER a wallet or testnet proof.
//
// Round-2 additions (this run must NOT overwrite the prior round-1 evidence):
//   * conservative meta.stale (old seeded projection -> stale:true),
//   * challenge 10/min/IP rate limit incl. X-Forwarded-For spoof no-bypass,
//   * CSRF/origin defense on session writes (+/-/spoof),
//   * expiry-during-RPC regression (clock advances past expiresAt inside the
//     awaited resolver -> STALE_PROOF, nonce unconsumed),
//   * official near-account-id account-validator equivalence vectors.
import { buildApp } from '../apps/api/dist/app.js';
import { MemoryStore } from '../apps/api/dist/store/memory-store.js';
import { loadConfig } from '../apps/api/dist/config.js';
import { makeDenyResolver } from '../apps/api/dist/auth/rpc.js';
import { issueLoginChallenge } from '../apps/api/dist/auth/challenge.js';
import { verifyLogin } from '../apps/api/dist/auth/verify.js';
import { isValidNearAccountId } from '../apps/api/dist/lib/account-id.js';
import { isMoneyString, U128_MAX } from '../packages/domain/src/index.mjs';
import { makeKeypair, signChallenge, makeFakeResolver } from '../apps/api/test/fixtures.mjs';
import { OK_ACCOUNT_IDS, BAD_ACCOUNT_IDS, EXTRA_OK_ACCOUNT_IDS, EXTRA_BAD_ACCOUNT_IDS } from '../apps/api/test/account-id-official-vectors.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DOMAIN = 'app.showstake.local';
const NETWORK = 'testnet';
const ORIGIN = 'http://app.showstake.local';

const results = [];
function check(id, ok, expected, observed, extra = {}) {
  results.push({ id, ok: Boolean(ok), expected, observed, classifier: 'PASS_LOCAL', ...extra });
  const mark = ok ? 'OK  ' : 'FAIL';
  console.log(`  ${mark} ${id}  (observed: ${observed})`);
}

function redactCookie(cookie) {
  if (!cookie) return '<none>';
  const eq = cookie.indexOf('=');
  const name = eq >= 0 ? cookie.slice(0, eq) : cookie;
  const val = eq >= 0 ? cookie.slice(eq + 1) : '';
  const shown = val.length > 0 ? '[REDACTED]' : '<empty>';
  return `${name}=${shown}`;
}

function makeConfig(env = {}) {
  return loadConfig({ AUTH_DOMAIN: DOMAIN, AUTH_NETWORK: NETWORK, COOKIE_SECURE: 'false', ...env });
}

function makeApp(store) {
  const config = makeConfig();
  const app = buildApp({ store, config, accessKeyVerifier: makeDenyResolver(config) });
  return { app, config };
}

async function req(app, method, url, payload, headers = {}) {
  const h = { ...headers };
  if (payload !== undefined) h['content-type'] = 'application/json';
  return app.inject({ method, url, payload, headers: h });
}
async function post(app, url, payload, headers = {}) {
  return req(app, 'POST', url, payload, headers);
}
async function get(app, url, headers = {}) {
  return req(app, 'GET', url, undefined, headers);
}

function cookieFrom(res) {
  const sc = res.headers['set-cookie'];
  if (!sc) return null;
  const arr = Array.isArray(sc) ? sc : [sc];
  const first = arr[0] ?? '';
  return first.split(';')[0] || null;
}

// Build a fresh app whose access-key resolver is pinned to `kp`.
function makeVerifiedApp(store, kp, env = {}) {
  const config = makeConfig(env);
  const app = buildApp({ store, config, accessKeyVerifier: makeFakeResolver(kp.accountId, kp.publicKey, NETWORK) });
  return { app, config };
}

async function run() {
  // 1. Money/envelope boundary (semantic u128 via @showstake/domain).
  check('MONEY_CANONICAL', isMoneyString('5000000') === true, 'canonical money string accepted', String(isMoneyString('5000000')));
  check('MONEY_U128_MAX', isMoneyString(U128_MAX.toString()) === true, '2^128-1 accepted', String(isMoneyString(U128_MAX.toString())));
  check('MONEY_OVERFLOW', isMoneyString((U128_MAX + 1n).toString()) === false, '2^128 rejected', String(isMoneyString((U128_MAX + 1n).toString())));
  check('MONEY_LEADING_ZERO', isMoneyString('0005') === false, 'leading zeros rejected', String(isMoneyString('0005')));

  // 2. Health + public event reads (memory store) + conservative meta.stale.
  {
    const store = new MemoryStore();
    const { app } = makeApp(store);
    const h = await get(app, '/health');
    check('HEALTH_200', h.statusCode === 200 && h.json().status === 'ok' && h.json().db === 'up', 'health 200 db up', JSON.stringify(h.json()));

    const ev = (id, regOpen, deposit, observedAt) => ({
      id, network: NETWORK, contractId: 'escrow.testnet', organizerAccount: 'bob.testnet', assetContract: 'ft.showstake.testnet',
      state: 'PUBLISHED', depositAtomic: deposit, capacity: 10,
      times: { regOpen, regClose: '2026-12-01T00:00:00.000Z', cancelCutoff: '2026-12-01T12:00:00.000Z', checkinOpen: '2026-12-01T12:00:00.000Z', checkinClose: '2026-12-02T12:00:00.000Z', finalizeDeadline: '2026-12-03T12:00:00.000Z' },
      totals: { acceptedAtomic: '0', paidAtomic: '0', pendingAtomic: '0', liabilityAtomic: '0' },
      registeredCount: 0, observedAt,
    });
    store.seedEvent(ev('00000000-0000-4000-8000-000000000001', '2026-11-10T00:00:00.000Z', '5000000', '2026-11-07T00:00:00.000Z'));
    store.seedEvent(ev('00000000-0000-4000-8000-000000000002', '2026-11-11T00:00:00.000Z', '10000000', '2026-11-07T00:00:00.000Z'));
    store.seedEvent(ev('00000000-0000-4000-8000-000000000003', '2026-11-12T00:00:00.000Z', '0', '2026-11-07T00:00:00.000Z'));
    store.seedEvent(ev('00000000-0000-4000-8000-000000000004', '2026-11-13T00:00:00.000Z', '2000000', new Date().toISOString()));

    const list = await get(app, '/v1/events?limit=2');
    const body = list.json();
    check('EVENT_LIST_ENVELOPE', list.statusCode === 200 && body.data && Array.isArray(body.data.items) && body.error === null, '200 list envelope', JSON.stringify({ status: list.statusCode, error: body.error }));
    check('EVENT_LIST_MONEY_STRING', body.data && body.data.items.length === 2 && typeof body.data.items[0].depositAtomic === 'string', 'money stays a string', body.data?.items?.[0]?.depositAtomic ?? null);
    check('EVENT_LIST_CURSOR', body.data && typeof body.data.nextCursor === 'string' && body.data.nextCursor.length > 0, 'nextCursor present', String(body.data?.nextCursor));
    // Old seeded projections (observedAt ~today 00:00Z, well outside the window) must report stale:true.
    check('EVENT_LIST_STALE_OLD_SEED', body.meta && body.meta.stale === true, 'old seeded projection list reports meta.stale=true', String(body.meta?.stale));

    const page2 = await get(app, `/v1/events?limit=2&cursor=${encodeURIComponent(body.data.nextCursor)}`);
    const p2 = page2.json();
    check('EVENT_LIST_PAGE2', page2.statusCode === 200 && p2.data && p2.data.items.length === 2, 'second page returns remaining 2 (4 total seeded)', `count=${p2.data?.items?.length}`);

    const detail = await get(app, '/v1/events/00000000-0000-4000-8000-000000000001');
    const dbody = detail.json();
    check('EVENT_DETAIL', detail.statusCode === 200 && dbody.data && dbody.data.depositAtomic === '5000000', 'event detail money string', dbody.data?.depositAtomic ?? null);
    check('EVENT_DETAIL_STALE_OLD', dbody.meta && dbody.meta.stale === true, 'old seeded event detail meta.stale=true', String(dbody.meta?.stale));

    const fresh = await get(app, '/v1/events/00000000-0000-4000-8000-000000000004');
    const fbody = fresh.json();
    check('EVENT_DETAIL_STALE_FRESH', fresh.statusCode === 200 && fbody.meta && fbody.meta.stale === false, 'recent observedAt event detail meta.stale=false', String(fbody.meta?.stale));

    const notFound = await get(app, '/v1/events/00000000-0000-4000-8000-0000000000ff');
    check('EVENT_DETAIL_404', notFound.statusCode === 404 && notFound.json().error?.code === 'NOT_FOUND', 'unknown event 404', String(notFound.statusCode));

    const badUuid = await get(app, '/v1/events/not-a-uuid');
    check('EVENT_DETAIL_BAD_UUID', badUuid.statusCode === 422, 'bad uuid 422', String(badUuid.statusCode));

    const badCursor = await get(app, '/v1/events?cursor=garbage');
    check('EVENT_LIST_BAD_CURSOR', badCursor.statusCode === 422, 'bad cursor 422', String(badCursor.statusCode));
  }

  // 3. NEP-413 challenge/verify/session lifecycle (local fixture + fake resolver).
  {
    const store = new MemoryStore();
    const kp = makeKeypair();
    const { app } = makeVerifiedApp(store, kp);

    const chal = await post(app, '/v1/auth/challenge', { accountId: kp.accountId, network: NETWORK, domain: DOMAIN });
    const c = chal.json();
    check('CHALLENGE_ISSUED', chal.statusCode === 200 && c.data && c.data.challengeId && c.data.message && /^[0-9a-f]{64}$/.test(c.data.nonce), 'challenge issued with canonical message + 32-byte nonce', String(chal.statusCode));
    const challengeId = c.data.challengeId;
    const message = c.data.message;
    const nonceHex = c.data.nonce;

    const sig = signChallenge(kp.privateKey, { message, nonceHex, recipient: DOMAIN });
    const verify = await post(app, '/v1/auth/verify', { challengeId, accountId: kp.accountId, network: NETWORK, domain: DOMAIN, nonce: nonceHex, publicKey: kp.publicKey, signature: sig }, { origin: ORIGIN });
    const vbody = verify.json();
    check('VERIFY_OK', verify.statusCode === 200 && vbody.data && typeof vbody.data.userId === 'string', 'verify 200 + userId', String(verify.statusCode));
    const cookie = cookieFrom(verify);
    check('VERIFY_SET_COOKIE', typeof cookie === 'string' && cookie.startsWith('showstake_session='), 'HttpOnly session cookie set (token never printed)', redactCookie(cookie));

    const me = await get(app, '/v1/me', { cookie });
    check('ME_ACTIVE', me.statusCode === 200 && me.json().data?.active === true, 'session active via cookie', String(me.statusCode));
    check('ME_VERIFIED_BINDING', me.json().data?.accountId===kp.accountId && me.json().data?.network===NETWORK && me.json().meta?.network===NETWORK, 'identity is immutable verified session binding', JSON.stringify({accountId:me.json().data?.accountId,network:me.json().data?.network}));
    const spoof=await get(app,'/v1/me?accountId=attacker.near&network=mainnet',{cookie,'x-account-id':'attacker.near'});
    check('ME_SPOOF_IGNORED',spoof.json().data?.accountId===kp.accountId && spoof.json().data?.network===NETWORK,'unsigned account and network ignored',String(spoof.statusCode));
    const switched=await get(app,'/v1/me',{cookie,'x-wallet-account':'other.near','x-wallet-network':NETWORK});
    check('ME_SWITCHED_WALLET_DENIED',switched.statusCode===401 && switched.json().error?.code==='WALLET_BINDING_MISMATCH','wallet hints may only deny a mismatched session',String(switched.statusCode));

    const replay = await post(app, '/v1/auth/verify', { challengeId, accountId: kp.accountId, network: NETWORK, domain: DOMAIN, nonce: nonceHex, publicKey: kp.publicKey, signature: sig }, { origin: ORIGIN });
    check('REPLAY_REJECTED', replay.statusCode === 401 && replay.json().error?.code === 'CHALLENGE_ALREADY_CONSUMED', 'replayed nonce 401 already-consumed', `${replay.statusCode} ${replay.json().error?.code}`);

    const out = await post(app, '/v1/auth/logout', {}, { origin: ORIGIN, cookie });
    check('LOGOUT_200', out.statusCode === 200 && out.json().data?.revoked === true, 'logout revokes session', String(out.statusCode));
    const meAfter = await get(app, '/v1/me', { cookie });
    check('LOGOUT_REVOKES', meAfter.statusCode === 401 && meAfter.json().error?.code === 'SESSION_REVOKED', 'revoked session rejected after logout', `${meAfter.statusCode} ${meAfter.json().error?.code}`);

    const meNoCookie = await get(app, '/v1/me', {});
    check('ME_NO_SESSION', meNoCookie.statusCode === 401 && meNoCookie.json().error?.code === 'NO_SESSION', 'missing session 401', String(meNoCookie.statusCode));
  }

  // 4. Fail-closed negatives: wrong account (key not this account's), expiry, wrong domain, nonce mismatch.
  {
    const store = new MemoryStore();
    const kp = makeKeypair();
    const other = makeKeypair();
    const { app } = makeVerifiedApp(store, kp);

    const chal = await post(app, '/v1/auth/challenge', { accountId: other.accountId, network: NETWORK, domain: DOMAIN });
    const c = chal.json();
    const sig = signChallenge(other.privateKey, { message: c.data.message, nonceHex: c.data.nonce, recipient: DOMAIN });
    const verify = await post(app, '/v1/auth/verify', { challengeId: c.data.challengeId, accountId: other.accountId, network: NETWORK, domain: DOMAIN, nonce: c.data.nonce, publicKey: other.publicKey, signature: sig }, { origin: ORIGIN });
    check('WRONG_ACCOUNT_DENIED', verify.statusCode === 401 && (verify.json().error?.code === 'ACCOUNT_NOT_FOUND' || verify.json().error?.code === 'ACCOUNT_KEY_UNVERIFIED'), 'unresolved account key denied 401', `${verify.statusCode} ${verify.json().error?.code}`);

    const chal2 = await post(app, '/v1/auth/challenge', { accountId: kp.accountId, network: NETWORK, domain: DOMAIN });
    const c2 = chal2.json();
    const sig2 = signChallenge(kp.privateKey, { message: c2.data.message, nonceHex: c2.data.nonce, recipient: DOMAIN });
    const v2 = await post(app, '/v1/auth/verify', { challengeId: c2.data.challengeId, accountId: kp.accountId, network: NETWORK, domain: 'evil.example', nonce: c2.data.nonce, publicKey: kp.publicKey, signature: sig2 }, { origin: ORIGIN });
    check('WRONG_DOMAIN_DENIED', v2.statusCode === 401 && v2.json().error?.code === 'WRONG_DOMAIN', 'mismatched domain denied', String(v2.json().error?.code));

    const chal3 = await post(app, '/v1/auth/challenge', { accountId: kp.accountId, network: NETWORK, domain: DOMAIN });
    const c3 = chal3.json();
    store.expireChallenge(c3.data.challengeId);
    const sig3 = signChallenge(kp.privateKey, { message: c3.data.message, nonceHex: c3.data.nonce, recipient: DOMAIN });
    const v3 = await post(app, '/v1/auth/verify', { challengeId: c3.data.challengeId, accountId: kp.accountId, network: NETWORK, domain: DOMAIN, nonce: c3.data.nonce, publicKey: kp.publicKey, signature: sig3 }, { origin: ORIGIN });
    check('EXPIRY_DENIED', v3.statusCode === 401, 'expired challenge denied 401', `${v3.statusCode} ${v3.json().error?.code}`);

    const chal4 = await post(app, '/v1/auth/challenge', { accountId: kp.accountId, network: NETWORK, domain: DOMAIN });
    const c4 = chal4.json();
    const sig4 = signChallenge(kp.privateKey, { message: c4.data.message, nonceHex: c4.data.nonce, recipient: DOMAIN });
    const badNonce = 'ab'.repeat(32);
    const v4 = await post(app, '/v1/auth/verify', { challengeId: c4.data.challengeId, accountId: kp.accountId, network: NETWORK, domain: DOMAIN, nonce: badNonce, publicKey: kp.publicKey, signature: sig4 }, { origin: ORIGIN });
    check('NONCE_MISMATCH_DENIED', v4.statusCode === 401 && v4.json().error?.code === 'NONCE_MISMATCH', 'mismatched nonce denied', String(v4.json().error?.code));
  }

  // 5. Expiry during awaited RPC: the clock advances PAST expiresAtMs inside the
  //    resolver, so verify must deny (STALE_PROOF) and leave the nonce unconsumed.
  {
    const store = new MemoryStore();
    const kp = makeKeypair();
    const config = makeConfig();
    const c = await issueLoginChallenge(store, config, { accountId: kp.accountId, network: NETWORK, domain: DOMAIN });
    let clockMs = c.issuedAtMs + 1;
    const resolver = async () => {
      clockMs = c.expiresAtMs + 1; // advance past expiry during the awaited SDK/resolver step
      return { ok: true, code: 'VERIFIED_ACCESS_KEY', accountId: kp.accountId, publicKey: kp.publicKey, keyType: 'ed25519', accessKeyType: 'FullAccess', verifiedAt: c.issuedAtMs, network: NETWORK, blockHeight: 1 };
    };
    const sig = signChallenge(kp.privateKey, { message: c.message, nonceHex: c.nonce, recipient: DOMAIN });
    let deniedCode = null;
    let sessionOpened = false;
    try {
      const r = await verifyLogin(store, config, resolver, {
        challengeId: c.id, accountId: kp.accountId, network: NETWORK, domain: DOMAIN, nonce: c.nonce, publicKey: kp.publicKey, signature: sig,
      }, () => clockMs);
      sessionOpened = Boolean(r.sessionId);
    } catch (e) {
      deniedCode = e?.code ?? 'ERROR';
    }
    check('EXPIRY_DURING_RPC_DENIED', deniedCode === 'STALE_PROOF' && sessionOpened === false, 'expiry advanced during awaited RPC denies (STALE_PROOF, no session)', `code=${deniedCode} session=${sessionOpened}`);
    const after = await store.getChallenge(c.id);
    check('EXPIRY_DURING_RPC_NONCE_UNCONSUMED', after && after.consumedAt === null, 'expired-during-RPC nonce left unconsumed', String(after?.consumedAt));
  }

  // A fresh RPC reply is stamped on arrival, after the request started.
  {
    const store = new MemoryStore();
    const config = makeConfig();
    const kp = makeKeypair();
    const c = await issueLoginChallenge(store, config, { accountId: kp.accountId, network: NETWORK, domain: DOMAIN });
    let clock = c.issuedAtMs + 1;
    const resolver = async () => { clock += 50; return { ok: true, accountId: kp.accountId, publicKey: kp.publicKey, keyType: 'ed25519', accessKeyType: 'FullAccess', verifiedAt: clock, network: NETWORK, blockHeight: 999 }; };
    const signature = signChallenge(kp.privateKey, { message: c.message, nonceHex: c.nonce, recipient: DOMAIN });
    const result = await verifyLogin(store, config, resolver, { challengeId: c.id, accountId: kp.accountId, network: NETWORK, domain: DOMAIN, nonce: c.nonce, publicKey: kp.publicKey, signature }, () => clock);
    check('RPC_REPLY_AFTER_REQUEST_ACCEPTED', Boolean(result.sessionId), 'fresh post-request RPC timestamp accepted', Boolean(result.sessionId));
  }

  // 6. Challenge rate limit: 10/min/IP (fixed window) + X-Forwarded-For no-bypass.
  {
    const store = new MemoryStore();
    const { app } = makeApp(store);
    let lastStatus = null;
    for (let i = 0; i < 10; i += 1) {
      const r = await post(app, '/v1/auth/challenge', { accountId: 'alice.testnet', network: NETWORK, domain: DOMAIN });
      lastStatus = r.statusCode;
    }
    check('RATE_LIMIT_10_ALLOWED', lastStatus === 200, 'first 10 challenges per IP allowed', String(lastStatus));
    const eleventh = await post(app, '/v1/auth/challenge', { accountId: 'alice.testnet', network: NETWORK, domain: DOMAIN });
    check('RATE_LIMIT_11TH_429', eleventh.statusCode === 429 && eleventh.json().error?.code === 'RATE_LIMITED', '11th challenge in window 429 RATE_LIMITED', `${eleventh.statusCode} ${eleventh.json().error?.code}`);

    // trustProxy=true still must not let X-Forwarded-For rotate the bucket.
    const store2 = new MemoryStore();
    const { app: proxyApp } = makeAppWithStoreAndConfig(store2, { TRUST_PROXY: 'true' });
    for (let i = 0; i < 10; i += 1) {
      await post(proxyApp, '/v1/auth/challenge', { accountId: 'bob.testnet', network: NETWORK, domain: DOMAIN }, { 'x-forwarded-for': `198.51.100.${i + 1}` });
    }
    const spoofed = await post(proxyApp, '/v1/auth/challenge', { accountId: 'bob.testnet', network: NETWORK, domain: DOMAIN }, { 'x-forwarded-for': '203.0.113.99' });
    check('RATE_LIMIT_XFF_SPOOF_NO_BYPASS', spoofed.statusCode === 429, 'X-Forwarded-For rotation does not bypass challenge rate limit', String(spoofed.statusCode));
  }

  // 7. CSRF / origin defense on session writes (+/-/spoof).
  {
    const store = new MemoryStore();
    const kp = makeKeypair();
    const { app } = makeVerifiedApp(store, kp);
    const chal = await post(app, '/v1/auth/challenge', { accountId: kp.accountId, network: NETWORK, domain: DOMAIN });
    const c = chal.json();
    const sig = signChallenge(kp.privateKey, { message: c.data.message, nonceHex: c.data.nonce, recipient: DOMAIN });
    const body = { challengeId: c.data.challengeId, accountId: kp.accountId, network: NETWORK, domain: DOMAIN, nonce: c.data.nonce, publicKey: kp.publicKey, signature: sig };

    const ok = await post(app, '/v1/auth/verify', body, { origin: ORIGIN });
    check('ORIGIN_ALLOWED', ok.statusCode === 200, 'verify with allowed Origin accepted', String(ok.statusCode));

    // Wrong origin => 403 before any crypto/nonce work.
    const wrongStore = new MemoryStore();
    const { app: app2 } = makeVerifiedApp(wrongStore, kp);
    const chal2 = await post(app2, '/v1/auth/challenge', { accountId: kp.accountId, network: NETWORK, domain: DOMAIN });
    const c2 = chal2.json();
    const sig2 = signChallenge(kp.privateKey, { message: c2.data.message, nonceHex: c2.data.nonce });
    const body2 = { challengeId: c2.data.challengeId, accountId: kp.accountId, network: NETWORK, domain: DOMAIN, nonce: c2.data.nonce, publicKey: kp.publicKey, signature: sig2 };
    const wrongOrigin = await post(app2, '/v1/auth/verify', body2, { origin: 'https://evil.example' });
    check('ORIGIN_WRONG_403', wrongOrigin.statusCode === 403 && wrongOrigin.json().error?.code === 'ORIGIN_MISMATCH', 'foreign Origin on session write 403', `${wrongOrigin.statusCode} ${wrongOrigin.json().error?.code}`);

    const missing = await post(app2, '/v1/auth/verify', body2, { origin: null });
    check('ORIGIN_MISSING_403', missing.statusCode === 403 && missing.json().error?.code === 'ORIGIN_REQUIRED', 'missing Origin on session write 403', `${missing.statusCode} ${missing.json().error?.code}`);

    const spoofed = await post(app2, '/v1/auth/verify', body2, { 'x-forwarded-origin': ORIGIN, 'x-forwarded-host': DOMAIN });
    check('ORIGIN_SPOOF_HEADER_NO_BYPASS', spoofed.statusCode === 403 && spoofed.json().error?.code === 'ORIGIN_REQUIRED', 'X-Forwarded-Origin spoof does not satisfy origin check', `${spoofed.statusCode} ${spoofed.json().error?.code}`);
  }

  // 8. Account-id validator equivalence to the official near-account-id crate.
  {
    let badVecs = 0;
    for (const v of OK_ACCOUNT_IDS) if (!isValidNearAccountId(v)) { badVecs += 1; console.log(`      BAD OK_VECTOR ${JSON.stringify(v)}`); }
    for (const v of EXTRA_OK_ACCOUNT_IDS) if (!isValidNearAccountId(v)) { badVecs += 1; console.log(`      BAD EXTRA_OK ${JSON.stringify(v)}`); }
    for (const v of BAD_ACCOUNT_IDS) if (isValidNearAccountId(v)) { badVecs += 1; console.log(`      BAD BAD_VECTOR ${JSON.stringify(v)}`); }
    for (const v of EXTRA_BAD_ACCOUNT_IDS) if (isValidNearAccountId(v)) { badVecs += 1; console.log(`      BAD EXTRA_BAD ${JSON.stringify(v)}`); }
    check('ACCOUNT_ID_OFFICIAL_VECTORS', badVecs === 0, 'validator matches all official near-account-id OK/BAD vectors', `mismatches=${badVecs}`);
    check('ACCOUNT_ID_IMPLICIT', isValidNearAccountId(makeKeypair().accountId) === true, '64-hex implicit account accepted', 'implicit');
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nverify-api: ${results.length - failed.length}/${results.length} checks passed`);
  for (const r of failed) console.log(`  FAIL ${r.id}: expected ${r.expected}, observed ${r.observed}`);
  return { total: results.length, failed: failed.length, results };
}

function makeAppWithStoreAndConfig(store, env = {}) {
  const config = makeConfig(env);
  const app = buildApp({ store, config, accessKeyVerifier: makeDenyResolver(config) });
  return { app, config };
}

let suiteCompleted = false;
const deadline = setTimeout(() => { console.error('verify-api FAILED: suite did not complete before deadline'); process.exit(1); }, 30000);
process.once('beforeExit', () => { if (!suiteCompleted) { console.error('verify-api FAILED: missing completion'); process.exitCode = 1; } });
const execution = process.env.SHOWSTAKE_VERIFY_HANG_CONTROL === '1' ? new Promise(() => {}) : run();
execution
  .then((summary) => {
    const ids = new Set(summary.results.map(r => r.id));
    if (summary.total < 39 || ids.size !== summary.total || !ids.has('ORIGIN_ALLOWED') || !ids.has('EXPIRY_DURING_RPC_DENIED')) throw new Error('incomplete or duplicate check inventory');
    suiteCompleted = true;
    clearTimeout(deadline);
    const evidence = {
      id: 'api-increment-round2-local',
      run_id: `round2-local-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      task: 'apps/api challenge/verify/session/logout + public event reads (LOCAL, no DB) — round 2',
      classifier: summary.failed === 0 ? 'PASS_LOCAL' : 'FAILED',
      ok: summary.failed === 0,
      reviewer_pending: true,
      environment: { os: process.platform, node: process.version, db: 'none (MemoryStore)' },
      totals: { checks: summary.total, failed: summary.failed },
      checks: summary.results,
      note: 'LOCAL only: generated ed25519 keypair + fake final access-key resolver (never a wallet/testnet proof). Round-2 adds conservative meta.stale, challenge 10/min/IP rate limit (incl. X-Forwarded-For spoof no-bypass), CSRF/origin defense on session writes, expiry-during-RPC regression, and official near-account-id account-validator vectors. No cookie/token/private-key material is printed.',
    };
    try {
      mkdirSync(join(ROOT, 'docs', 'evidence'), { recursive: true });
      // Unique filename: preserve prior round-1 attempt; never overwrite it.
      writeFileSync(join(ROOT, 'docs', 'evidence', `api-local-${Date.now()}-${process.pid}.json`), JSON.stringify(evidence, null, 2) + '\n');
    } catch { /* evidence write is best-effort */ }
    if (summary.failed > 0) process.exit(1);
    process.exit(0);
  })
  .catch((e) => {
    console.error('verify-api FATAL:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
