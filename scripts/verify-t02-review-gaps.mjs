#!/usr/bin/env node
// T02 remaining review gaps — resolver permission/freshness/network/key/account
// enforcement + linking user/session identity binding. Reproduces the specific
// Codex findings that the partial implementation did NOT close:
//   * a `{ok:true}` resolver stub was treated as proof (no declared-field checks);
//   * the canonical challenge did not bind the linking user/session identity.
//
// All checks are local fixtures/unit tests (PASS_LOCAL); the LIVE RPC read is
// a separate gated path and none of this proves W01-W04.
//
// Exit: 0 when every expected denial/allow is observed; non-zero otherwise.

import {
  validateResolvedAccessKey,
  interpretAccessKeyView,
  makeNearRpcAccessKeyVerifier,
  buildViewAccessKeyQuery,
} from '../packages/wallet-adapter/src/near-rpc-resolver.mjs';
import { makeChallenge, verifyChallengeProof, canonicalizeContext } from '../packages/wallet-adapter/src/verify-binding.mjs';
import { makeLocalFixtureKeypair, signNep413ForFixtures, nonceOf } from '../packages/wallet-adapter/src/nep413.mjs';

const results = [];
function record(id, expected, observed, ok) {
  results.push({ id, expected, observed, ok });
  if (!ok) console.error(`REG_FAIL: ${id} — ${observed} (expected ${expected})`);
}

const NOW = 10_000_000_000;

// Base fully-valid resolver context (named account).
function goodResolved({ accountId = 'alice.testnet', publicKey = 'ed25519:qy2SAs8jvqVSuxHLPFZ1AFyLFkhTpGUuPc4XiPkPnab', keyType = 'ed25519', network = 'testnet', accessKeyType = 'FullAccess', verifiedAt = NOW, blockHeight = 1234 } = {}) {
  return { ok: true, code: 'VERIFIED_ACCESS_KEY', accountId, publicKey, keyType, accessKeyType, verifiedAt, network, blockHeight };
}
function expectFailure(rv, overrides, wantCode) {
  const { failures, ok } = validateResolvedAccessKey(rv, overrides);
  return { ok, failures, wantCode };
}

// 1. The pure validator: a bare {ok:true} stub is NOT proof.
{
  const r = expectFailure({ ok: true }, { accountId: 'alice.testnet', network: 'testnet', publicKey: 'ed25519:qy2SAs8jvqVSuxHLPFZ1AFyLFkhTpGUuPc4XiPkPnab', keyType: 'ed25519', nowMs: NOW, requiredAccessKeyType: 'FullAccess', maxFreshnessMs: 5 * 60 * 1000 });
  record('RESOLVER-BARE-OK-DENIED', 'ok:false (MALFORMED_RESOLVER / BAD_KEY_VERIFIED_AT / ACCOUNT_MISMATCH)', `ok=${r.ok} failures=${r.failures.map((f) => f.code).join(',')}`, r.ok === false);
}

// 2. Denial matrix over the pure validator.
{
  const key = 'ed25519:qy2SAs8jvqVSuxHLPFZ1AFyLFkhTpGUuPc4XiPkPnab';
  const base = { accountId: 'alice.testnet', network: 'testnet', publicKey: key, keyType: 'ed25519', nowMs: NOW, requiredAccessKeyType: 'FullAccess' };
  const cases = [
    ['RESOLVER-WRONG-ACCOUNT', goodResolved({ accountId: 'bob.testnet' }), 'ACCOUNT_MISMATCH'],
    ['RESOLVER-WRONG-NETWORK', goodResolved({ network: 'mainnet' }), 'WRONG_NETWORK'],
    ['RESOLVER-KEY-MISMATCH', goodResolved({ publicKey: 'ed25519:4CXXSAdo9F4CuCHCC2yPAXJpGRoaHMMfLSjAZFvWWPKK' }), 'KEY_MISMATCH'],
    ['RESOLVER-KEY-TYPE-MISMATCH', goodResolved({ keyType: 'secp256k1' }), 'KEY_TYPE_MISMATCH'],
    ['RESOLVER-WRONG-PERMISSION', goodResolved({ accessKeyType: 'FunctionCall' }), 'WRONG_PERMISSION'],
    ['RESOLVER-STALE-KEY', goodResolved({ verifiedAt: NOW - 10 * 60 * 1000 }), 'STALE_KEY'],
    ['RESOLVER-FUTURE-VERIFIEDAT', goodResolved({ verifiedAt: NOW + 5000 }), 'BAD_KEY_VERIFIED_AT'],
    ['RESOLVER-MISSING-BLOCKHEIGHT', goodResolved({ blockHeight: null }), 'MALFORMED_RESOLVER'],
    ['RESOLVER-KEY-NOT-FOUND', { ok: false, code: 'KEY_NOT_FOUND', detail: 'removed' }, 'KEY_NOT_FOUND'],
    ['RESOLVER-ACCOUNT-NOT-FOUND', { ok: false, code: 'ACCOUNT_NOT_FOUND', detail: 'missing' }, 'ACCOUNT_NOT_FOUND'],
  ];
  for (const [id, rv, wantCode] of cases) {
    const r = expectFailure(rv, base, wantCode);
    const has = r.failures.some((f) => f.code === wantCode);
    record(id, `ok:false with ${wantCode}`, `ok=${r.ok} failures=${r.failures.map((f) => f.code).join(',')}`, r.ok === false && has);
  }
}

// 3. interpretAccessKeyView maps RPC shapes (permission, not-found, unknown, malformed).
{
  const mk = (json) => interpretAccessKeyView(json, { accountId: 'alice.testnet', publicKey: 'ed25519:qy2SAs8jvqVSuxHLPFZ1AFyLFkhTpGUuPc4XiPkPnab', keyType: 'ed25519', network: 'testnet', nowMs: NOW });
  const full = mk({ result: { block_height: 100, permission: 'FullAccess' } });
  record('RPC-VIEW-ACCESS-KEY-FULL', 'ok:true accessKeyType=FullAccess', `ok=${full.ok} type=${full.accessKeyType}`, full.ok === true && full.accessKeyType === 'FullAccess' && full.blockHeight === 100);
  const fc = mk({ result: { block_height: 100, permission: { FunctionCall: { allowance: '0', receiver_id: 'x', method_names: [] } } } });
  record('RPC-VIEW-ACCESS-KEY-FUNCTIONCALL', 'ok:true accessKeyType=FunctionCall', `ok=${fc.ok} type=${fc.accessKeyType}`, fc.ok === true && fc.accessKeyType === 'FunctionCall');
  const kf = mk({ error: { code: -32000, message: 'access key ed25519:xxx does not exist while viewing' } });
  record('RPC-VIEW-ACCESS-KEY-NOTFOUND', 'ok:false KEY_NOT_FOUND', `ok=${kf.ok} code=${kf.code}`, kf.ok === false && kf.code === 'KEY_NOT_FOUND');
  const af = mk({ error: { code: -32000, message: 'account bob.testnet does not exist while viewing' } });
  record('RPC-VIEW-ACCESS-KEY-ACCOUNT-NOTFOUND', 'ok:false ACCOUNT_NOT_FOUND', `ok=${af.ok} code=${af.code}`, af.ok === false && af.code === 'ACCOUNT_NOT_FOUND');
  const unknown = mk({ error: { code: -32603, message: 'some other error' } });
  record('RPC-VIEW-ACCESS-KEY-UNKNOWN', 'ok:false RPC_ERROR', `ok=${unknown.ok} code=${unknown.code}`, unknown.ok === false && unknown.code === 'RPC_ERROR');
  const malformed = mk({ foo: 1 });
  record('RPC-VIEW-ACCESS-KEY-MALFORMED', 'ok:false MALFORMED_RPC_RESPONSE', `ok=${malformed.ok} code=${malformed.code}`, malformed.ok === false && malformed.code === 'MALFORMED_RPC_RESPONSE');
}

// 4. makeNearRpcAccessKeyVerifier wires transport + network pinning.
{
  const verifier = makeNearRpcAccessKeyVerifier({
    getRpcUrl: (n) => (n === 'testnet' ? 'https://rpc.testnet.near.org' : null),
    nowProvider: () => NOW,
    transport: async (_url, { body }) => {
      const req = JSON.parse(body);
      if (req.method !== 'query') return { error: { code: -32600, message: 'bad method' } };
      // model: only alice.testnet with the expected key exists
      if (req.params.account_id === 'alice.testnet') {
        return { result: { block_height: 777, permission: 'FullAccess' } };
      }
      return { error: { code: -32000, message: `account ${req.params.account_id} does not exist while viewing` } };
    },
  });
  const okV = await verifier({ accountId: 'alice.testnet', publicKey: 'ed25519:qy2SAs8jvqVSuxHLPFZ1AFyLFkhTpGUuPc4XiPkPnab', network: 'testnet' });
  record('RPC-VERIFIER-OK', 'ok:true with FullAccess + blockHeight 777', `ok=${okV.ok} type=${okV.accessKeyType} h=${okV.blockHeight}`, okV.ok === true && okV.accessKeyType === 'FullAccess' && okV.blockHeight === 777);
  const nf = await verifier({ accountId: 'bob.testnet', publicKey: 'ed25519:qy2SAs8jvqVSuxHLPFZ1AFyLFkhTpGUuPc4XiPkPnab', network: 'testnet' });
  record('RPC-VERIFIER-ACCOUNT-NOTFOUND', 'ok:false ACCOUNT_NOT_FOUND', `ok=${nf.ok} code=${nf.code}`, nf.ok === false && nf.code === 'ACCOUNT_NOT_FOUND');
  const unsupported = await verifier({ accountId: 'alice.testnet', publicKey: 'ed25519:qy2SAs8jvqVSuxHLPFZ1AFyLFkhTpGUuPc4XiPkPnab', network: 'mainnet' });
  record('RPC-VERIFIER-UNSUPPORTED-NETWORK', 'ok:false UNSUPPORTED_NETWORK', `ok=${unsupported.ok} code=${unsupported.code}`, unsupported.ok === false && unsupported.code === 'UNSUPPORTED_NETWORK');
}

// --- Integration: named account passes only with a fully-valid resolver. -----
async function signChallenge({ accountId, domain = 'showstake.app', network = 'testnet', purpose = 'login', context }) {
  const nonce = nonceOf(`rg-${accountId}-${Date.now()}-${Math.random()}`);
  const kp = makeLocalFixtureKeypair();
  const issuedAtMs = NOW - 1000;
  const expiresAtMs = NOW + 4 * 60 * 1000;
  const ch = makeChallenge({ purpose, domain, network, accountId, nonce, issuedAtMs, expiresAtMs, ...(context !== undefined ? { context } : {}) });
  const signature = signNep413ForFixtures(kp.privateKey, { message: ch.message, nonce, recipient: ch.domain, callbackUrl: ch.callbackUrl ?? undefined });
  return { ch, nonce, kp, proof: { accountId, publicKey: kp.publicKey, signature } };
}

{
  // good resolver: fully-declared context for the presented key/account/network.
  const { ch, proof } = await signChallenge({ accountId: 'alice.testnet' });
  const good = async ({ accountId, publicKey, network }) => goodResolved({ accountId, publicKey, keyType: 'ed25519', network, blockHeight: 1234 });
  const r = await verifyChallengeProof({ challenge: ch, proof, consumedNonces: new Set(), expectedDomain: 'showstake.app', expectedNetwork: 'testnet', expectedPurpose: 'login', accessKeyVerifier: good, nowMs: NOW });
  record('NAMED-ACCOUNT-RESOLVER-POSITIVE', 'ok:true with fully-declared resolver', `ok=${r.ok} code=${r.code}`, r.ok === true);
}

{
  // bare {ok:true} resolver must NOT pass a named account.
  const { ch, proof } = await signChallenge({ accountId: 'alice.testnet' });
  const stub = async () => ({ ok: true });
  const r = await verifyChallengeProof({ challenge: ch, proof, consumedNonces: new Set(), expectedDomain: 'showstake.app', expectedNetwork: 'testnet', expectedPurpose: 'login', accessKeyVerifier: stub, nowMs: NOW });
  record('NAMED-ACCOUNT-STUB-DENIED', 'ok:false (stub not proof)', `ok=${r.ok} code=${r.code} failures=${(r.failures || []).map((f) => f.code).join(',')}`, r.ok === false);
}

{
  // removed key (resolver says KEY_NOT_FOUND) denies.
  const { ch, proof } = await signChallenge({ accountId: 'alice.testnet' });
  const removed = async () => ({ ok: false, code: 'KEY_NOT_FOUND', detail: 'key no longer on account' });
  const r = await verifyChallengeProof({ challenge: ch, proof, consumedNonces: new Set(), expectedDomain: 'showstake.app', expectedNetwork: 'testnet', expectedPurpose: 'login', accessKeyVerifier: removed, nowMs: NOW });
  record('NAMED-ACCOUNT-REMOVED-KEY-DENIED', 'ok:false KEY_NOT_FOUND', `ok=${r.ok} code=${r.code}`, r.ok === false && (r.failures || []).some((f) => f.code === 'KEY_NOT_FOUND'));
}

{
  // wrong-network resolver (final-network mismatch) denies.
  const { ch, proof } = await signChallenge({ accountId: 'alice.testnet' });
  const wrongNet = async ({ accountId, publicKey }) => goodResolved({ accountId, publicKey, keyType: 'ed25519', network: 'mainnet', blockHeight: 1234 });
  const r = await verifyChallengeProof({ challenge: ch, proof, consumedNonces: new Set(), expectedDomain: 'showstake.app', expectedNetwork: 'testnet', expectedPurpose: 'login', accessKeyVerifier: wrongNet, nowMs: NOW });
  record('NAMED-ACCOUNT-FINAL-NETWORK-DENIED', 'ok:false WRONG_NETWORK', `ok=${r.ok} code=${r.code}`, r.ok === false && (r.failures || []).some((f) => f.code === 'WRONG_NETWORK'));
}

// --- Linking user/session identity binding -----------------------------------
{
  // canonicalizeContext basics.
  record('CONTEXT-CANONICAL-STABLE', 'canonical string stable + sorted', JSON.stringify(canonicalizeContext({ b: 1, a: 'x', s: 's1' })), canonicalizeContext({ a: 'x', b: 1, s: 's1' }) === canonicalizeContext({ s: 's1', b: 1, a: 'x' }));
}

{
  // positive linking: matching expectedContext passes.
  const ctx = { sessionId: 'sess-1', userId: 'user-1', targetAccountId: 'alice.testnet' };
  const { ch, proof } = await signChallenge({ accountId: 'carol.testnet', purpose: 'link', context: ctx });
  const good = async ({ accountId, publicKey, network }) => goodResolved({ accountId, publicKey, keyType: 'ed25519', network, blockHeight: 1234 });
  const r = await verifyChallengeProof({ challenge: ch, proof, consumedNonces: new Set(), expectedDomain: 'showstake.app', expectedNetwork: 'testnet', expectedPurpose: 'link', expectedContext: ctx, accessKeyVerifier: good, nowMs: NOW });
  record('LINKING-CONTEXT-POSITIVE', 'ok:true with matching expectedContext', `ok=${r.ok} code=${r.code}`, r.ok === true);
}

{
  // context present but no expectedContext -> fail closed.
  const ctx = { sessionId: 'sess-1', userId: 'user-1', targetAccountId: 'alice.testnet' };
  const { ch, proof } = await signChallenge({ accountId: 'carol.testnet', purpose: 'link', context: ctx });
  const good = async ({ accountId, publicKey, network }) => goodResolved({ accountId, publicKey, keyType: 'ed25519', network, blockHeight: 1234 });
  const r = await verifyChallengeProof({ challenge: ch, proof, consumedNonces: new Set(), expectedDomain: 'showstake.app', expectedNetwork: 'testnet', expectedPurpose: 'link', accessKeyVerifier: good, nowMs: NOW });
  record('LINKING-MISSING-EXPECTED-CONTEXT', 'ok:false MISSING_EXPECTED_CONTEXT', `ok=${r.ok} code=${r.code}`, r.ok === false && (r.failures || []).some((f) => f.code === 'MISSING_EXPECTED_CONTEXT'));
}

{
  // cross-session/user replay: context swapped after signing (and signed message
  // no longer matches) -> denied.
  const ctx = { sessionId: 'sess-1', userId: 'user-1', targetAccountId: 'alice.testnet' };
  const { ch, proof } = await signChallenge({ accountId: 'carol.testnet', purpose: 'link', context: ctx });
  const good = async ({ accountId, publicKey, network }) => goodResolved({ accountId, publicKey, keyType: 'ed25519', network, blockHeight: 1234 });
  const attackerContext = { sessionId: 'sess-2', userId: 'user-2', targetAccountId: 'alice.testnet' };
  const r = await verifyChallengeProof({ challenge: ch, proof, consumedNonces: new Set(), expectedDomain: 'showstake.app', expectedNetwork: 'testnet', expectedPurpose: 'link', expectedContext: attackerContext, accessKeyVerifier: good, nowMs: NOW });
  record('LINKING-CROSS-SESSION-REJECTED', 'ok:false (CONTEXT_MISMATCH or MESSAGE_NOT_BOUND)', `ok=${r.ok} code=${r.code}`, r.ok === false);
}

{
  // malformed context (nested object) denied.
  const { ch, proof } = await signChallenge({ accountId: 'carol.testnet', purpose: 'link' });
  ch.context = { nested: { a: 1 } };
  const good = async ({ accountId, publicKey, network }) => goodResolved({ accountId, publicKey, keyType: 'ed25519', network, blockHeight: 1234 });
  const r = await verifyChallengeProof({ challenge: ch, proof, consumedNonces: new Set(), expectedDomain: 'showstake.app', expectedNetwork: 'testnet', expectedPurpose: 'link', expectedContext: { a: 1 }, accessKeyVerifier: good, nowMs: NOW });
  record('LINKING-MALFORMED-CONTEXT', 'ok:false MALFORMED_CONTEXT', `ok=${r.ok} code=${r.code}`, r.ok === false);
}

console.log(JSON.stringify(results, null, 2));
const bad = results.filter((r) => !r.ok);
if (bad.length) {
  console.error(`\n${bad.length}/${results.length} T02 review-gap check(s) NOT observed.`);
  process.exit(1);
}
console.log(`\nPASS: all ${results.length} T02 review-gap checks observed (resolver context enforcement + linking identity binding; local fixtures only).`);