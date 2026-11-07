#!/usr/bin/env node
// T02 adversarial behavior regressions — reproduces the FOUR Codex harness-review
// defects against the ACTUAL browser harness logic (not string-presence scans),
// using an injected verifyMessage seam + fixed clock (fixture-labeled) and a
// synthetic key signature. Zero network / wallet / transaction.
//
//   1. future-issued proof          -> FUTURE_ISSUANCE (was VERIFIED)
//   2. TTL > 5m proof               -> EXPIRY_TOO_LONG (was VERIFIED)
//   3. same-nonce second verify     -> REUSED_NONCE (was VERIFIED)
//   4. one connect = SIGN_IN_EVENT + CONNECTED -> NEED_TWO_SESSIONS (was SAME_ACCOUNT)
//       + a genuine connect/disconnect/reconnect -> SAME_ACCOUNT
//
// Also asserts the adapter's fixture-only `allowLocalImplicitFallback` gate now
// controls the ACCOUNT_NOT_FOUND exception (deny without the flag; allow with it),
// and that overlapping/await-interleaved verifications of one nonce cannot both pass.
//
// Exit 0 when every expected outcome is observed.

import * as harness from '../apps/web/onboarding-probe/src/harness.mjs';
import { makeChallenge, verifyChallengeProof } from '../packages/wallet-adapter/src/verify-binding.mjs';
import { makeLocalFixtureKeypair, signNep413ForFixtures, nonceOf } from '../packages/wallet-adapter/src/nep413.mjs';

const results = [];
function record(id, expected, observed, ok) {
  results.push({ id, expected, observed, ok });
  if (!ok) console.error(`ADVERSARIAL_FAIL: ${id} — ${observed} (expected ${expected})`);
}

const FIXED_NOW = 10_000_000_000;
const SIGNATURE = 'AA=='; // base64; the injected verifyMessage never inspects it
const PUBLIC_KEY = 'ed25519:Dsf1EF88NT979mTwyhywdaG3eUzeiFSUujid1UDdthU7';
const toHex = (b) => Buffer.from(b).toString('hex');

function setHarnessFixture({ issuedAtMs, expiresAtMs, accountId = 'fixture.testnet' }) {
  const st = harness.getState();
  st.deps = { verifyMessage: async () => {}, now: () => FIXED_NOW };
  st.consumedNonces.clear();
  st.verifyingNonces.clear();
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const message = harness.canonicalMessage({ accountId, nonce, issuedAtMs, expiresAtMs });
  st.lastChallenge = {
    message,
    recipient: harness.APP_DOMAIN,
    nonceHex: toHex(nonce),
    nonce,
    accountId,
    publicKey: PUBLIC_KEY,
    signature: SIGNATURE,
    issuedAtMs,
    expiresAtMs,
  };
  return st;
}

// --- harness real-behavior defense checks ------------------------------------
{
  const st = setHarnessFixture({ issuedAtMs: FIXED_NOW + 60_000, expiresAtMs: FIXED_NOW + 6 * 60_000 });
  void st;
  const r = await harness.verifyChallenge();
  record('HARNESS-FUTURE-ISSUANCE-DENIED', 'ok:false FUTURE_ISSUANCE', `ok=${r.ok} code=${r.code}`, r.ok === false && r.code === 'FUTURE_ISSUANCE');
}
{
  setHarnessFixture({ issuedAtMs: FIXED_NOW - 1000, expiresAtMs: FIXED_NOW - 1000 + 10 * 60 * 1000 });
  const r = await harness.verifyChallenge();
  record('HARNESS-EXCESSIVE-TTL-DENIED', 'ok:false EXPIRY_TOO_LONG', `ok=${r.ok} code=${r.code}`, r.ok === false && r.code === 'EXPIRY_TOO_LONG');
}
{
  setHarnessFixture({ issuedAtMs: FIXED_NOW - 6 * 60 * 1000, expiresAtMs: FIXED_NOW - 60 * 1000 });
  const r = await harness.verifyChallenge();
  record('HARNESS-EXPIRED-DENIED', 'ok:false STALE_PROOF', `ok=${r.ok} code=${r.code}`, r.ok === false && r.code === 'STALE_PROOF');
}
{
  setHarnessFixture({ issuedAtMs: FIXED_NOW, expiresAtMs: FIXED_NOW - 1 });
  const r = await harness.verifyChallenge();
  record('HARNESS-NONPOSITIVE-TTL-DENIED', 'ok:false NONPOSITIVE_TTL', `ok=${r.ok} code=${r.code}`, r.ok === false && r.code === 'NONPOSITIVE_TTL');
}
{
  setHarnessFixture({ issuedAtMs: FIXED_NOW + 0.5, expiresAtMs: FIXED_NOW + 300_000 });
  const r = await harness.verifyChallenge();
  record('HARNESS-NONINTEGER-TIMESTAMP-DENIED', 'ok:false BAD_TIMESTAMP', `ok=${r.ok} code=${r.code}`, r.ok === false && r.code === 'BAD_TIMESTAMP');
}
{
  const st = setHarnessFixture({ issuedAtMs: FIXED_NOW - 1000, expiresAtMs: FIXED_NOW - 1000 + 5 * 60 * 1000 });
  const first = await harness.verifyChallenge();
  const second = await harness.verifyChallenge();
  record('HARNESS-NONCE-REPLAY-DENIED', 'first VERIFIED then REUSED_NONCE', `first=${first.code} second=${second.code}`,
    first.ok === true && first.code === 'VERIFIED' && second.ok === false && second.code === 'REUSED_NONCE');
}

// --- genuine disconnect/reconnect (relogin) ----------------------------------
{
  const st = harness.getState();
  st.sessions = [
    { seq: 1, event: 'SIGN_IN_EVENT', accountId: 'fixture.testnet' },
    { seq: 2, event: 'CONNECTED', accountId: 'fixture.testnet' },
  ];
  const cmp = harness.sameAccountAcrossSessions();
  record('HARNESS-SINGLE-CONNECT-NOT-TWO-SESSIONS', 'ok:false NEED_TWO_SESSIONS', `ok=${cmp.ok} code=${cmp.code}`, cmp.ok === false && cmp.code === 'NEED_TWO_SESSIONS');
}
{
  const st = harness.getState();
  st.sessions = [
    { seq: 1, event: 'SIGN_IN_EVENT', accountId: 'fixture.testnet' },
    { seq: 2, event: 'CONNECTED', accountId: 'fixture.testnet' },
    { seq: 3, event: 'DISCONNECTED', accountId: null },
    { seq: 4, event: 'SIGN_IN_EVENT', accountId: 'fixture.testnet' },
    { seq: 5, event: 'CONNECTED', accountId: 'fixture.testnet' },
  ];
  const cmp = harness.sameAccountAcrossSessions();
  record('HARNESS-GENUINE-RECONNECT-SAME-ACCOUNT', 'ok:true SAME_ACCOUNT', `ok=${cmp.ok} code=${cmp.code}`, cmp.ok === true && cmp.code === 'SAME_ACCOUNT');
}

// --- adapter: ACCOUNT_NOT_FOUND is fixture-only gated ------------------------
async function implicitAccountFixture() {
  const kp = makeLocalFixtureKeypair(); // 64-hex account id == this key's ed25519 public key
  const accountId = kp.accountId;
  const nonce = nonceOf(`adv-${Date.now()}-${Math.random()}`);
  const issuedAtMs = FIXED_NOW - 1000;
  const expiresAtMs = FIXED_NOW + 4 * 60 * 1000;
  const ch = makeChallenge({ purpose: 'login', domain: 'showstake.app', network: 'testnet', accountId, nonce, issuedAtMs, expiresAtMs });
  const signature = signNep413ForFixtures(kp.privateKey, { message: ch.message, nonce, recipient: ch.domain, callbackUrl: ch.callbackUrl ?? undefined });
  return { ch, proof: { accountId, publicKey: kp.publicKey, signature } };
}
{
  const { ch, proof } = await implicitAccountFixture();
  const acctNotFound = async () => ({ ok: false, code: 'ACCOUNT_NOT_FOUND', detail: 'account does not exist' });
  const r = await verifyChallengeProof({
    challenge: ch, proof, consumedNonces: new Set(),
    expectedDomain: 'showstake.app', expectedNetwork: 'testnet', expectedPurpose: 'login',
    accessKeyVerifier: acctNotFound, nowMs: FIXED_NOW, // flag omitted -> false
  });
  record('ADAPTER-ACCOUNT-NOT-FOUND-NO-FLAG-DENIED', 'ok:false ACCOUNT_NOT_FOUND (fail-closed)',
    `ok=${r.ok} code=${r.code}`, r.ok === false && (r.failures || []).some((f) => f.code === 'ACCOUNT_NOT_FOUND'));
}
{
  const { ch, proof } = await implicitAccountFixture();
  const acctNotFound = async () => ({ ok: false, code: 'ACCOUNT_NOT_FOUND', detail: 'account does not exist' });
  const r = await verifyChallengeProof({
    challenge: ch, proof, consumedNonces: new Set(),
    expectedDomain: 'showstake.app', expectedNetwork: 'testnet', expectedPurpose: 'login',
    accessKeyVerifier: acctNotFound, nowMs: FIXED_NOW, allowLocalImplicitFallback: true,
  });
  record('ADAPTER-ACCOUNT-NOT-FOUND-FIXTURE-FLAG-ALLOWED', 'ok:true (explicit fixture-only flag)', `ok=${r.ok} code=${r.code}`, r.ok === true && r.code === 'OK');
}

// --- adapter: overlapping awaits cannot both consume the same nonce ----------
{
  const nonce = nonceOf(`adv-overlap-${Date.now()}-${Math.random()}`);
  const issuedAtMs = FIXED_NOW - 1000;
  const expiresAtMs = FIXED_NOW + 4 * 60 * 1000;
  const ch = makeChallenge({ purpose: 'login', domain: 'showstake.app', network: 'testnet', accountId: 'alice.testnet', nonce, issuedAtMs, expiresAtMs });
  const kp = makeLocalFixtureKeypair();
  const signature = signNep413ForFixtures(kp.privateKey, { message: ch.message, nonce, recipient: ch.domain, callbackUrl: ch.callbackUrl ?? undefined });
  const proof = { accountId: 'alice.testnet', publicKey: kp.publicKey, signature };
  const consumed = new Set();
  const slowResolved = async ({ accountId, publicKey, network }) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { ok: true, code: 'VERIFIED_ACCESS_KEY', accountId, publicKey, keyType: 'ed25519', accessKeyType: 'FullAccess', verifiedAt: FIXED_NOW, network, blockHeight: 1234 };
  };
  const [a, b] = await Promise.all([
    verifyChallengeProof({ challenge: ch, proof, consumedNonces: consumed, expectedDomain: 'showstake.app', expectedNetwork: 'testnet', expectedPurpose: 'login', accessKeyVerifier: slowResolved, nowMs: FIXED_NOW }),
    verifyChallengeProof({ challenge: ch, proof, consumedNonces: consumed, expectedDomain: 'showstake.app', expectedNetwork: 'testnet', expectedPurpose: 'login', accessKeyVerifier: slowResolved, nowMs: FIXED_NOW }),
  ]);
  const okCount = (a.ok ? 1 : 0) + (b.ok ? 1 : 0);
  const reuseCount = (a.code === 'REUSED_NONCE' ? 1 : 0) + (b.code === 'REUSED_NONCE' ? 1 : 0);
  record('ADAPTER-OVERLAPPING-NONCE-ONCE', 'exactly one OK and one REUSED_NONCE', `a=${a.code} b=${b.code}`, okCount === 1 && reuseCount === 1);
}

// --- async stale-completion defenses (deferred promises + injected clock) -----
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function resetHarnessState() {
  const st = harness.getState();
  st.candidate = 'near-connect';
  st.connector = null;
  st.wallet = null;
  st.accounts = [];
  st.status = 'IDLE';
  st.sequence = 0;
  st.sessions = [];
  st.connectCycle = 0;
  st.lastConnectedAccount = null;
  st.lastChallenge = null;
  st.lastResult = null;
  st.verificationGeneration = 0;
  st.consumedNonces = new Set();
  st.verifyingNonces = new Set();
  st.deps = null;
}
function setLastChallenge(st, { accountId = 'fixture.testnet', issuedAtMs, expiresAtMs }) {
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  st.lastChallenge = {
    message: harness.canonicalMessage({ accountId, nonce, issuedAtMs, expiresAtMs }),
    recipient: harness.APP_DOMAIN,
    nonceHex: Buffer.from(nonce).toString('hex'),
    nonce,
    accountId,
    publicKey: PUBLIC_KEY,
    signature: SIGNATURE,
    issuedAtMs,
    expiresAtMs,
  };
  return st.lastChallenge;
}

{
  // candidate switch while verification is pending -> stale deny, status preserved.
  resetHarnessState();
  const st = harness.getState();
  const d = deferred();
  let clock = FIXED_NOW;
  st.deps = { verifyMessage: () => d.promise, now: () => clock };
  setLastChallenge(st, { issuedAtMs: FIXED_NOW - 1000, expiresAtMs: FIXED_NOW - 1000 + 5 * 60 * 1000 });
  const p = harness.verifyChallenge();
  await new Promise((r) => setTimeout(r, 0));
  harness.selectCandidate('near-auth');
  d.resolve();
  const r = await p;
  record('HARNESS-CANDIDATE-SWITCH-STALE', 'ok:false STALE_OPERATION, newer status/lastResult untouched',
    `ok=${r.ok} code=${r.code} status=${st.status} result=${st.lastResult === null ? 'null' : 'set'}`,
    r.ok === false && r.code === 'STALE_OPERATION' && st.status === 'NOT_WIRED' && st.lastResult === null);
}
{
  // clock advanced past expiry while verification is pending -> stale proof deny.
  resetHarnessState();
  const st = harness.getState();
  const d = deferred();
  let clock = FIXED_NOW;
  st.deps = { verifyMessage: () => d.promise, now: () => clock };
  setLastChallenge(st, { issuedAtMs: FIXED_NOW - 1000, expiresAtMs: FIXED_NOW + 100 });
  const p = harness.verifyChallenge();
  await new Promise((r) => setTimeout(r, 0));
  clock = FIXED_NOW + 1000;
  d.resolve();
  const r = await p;
  record('HARNESS-EXPIRY-DURING-VERIFY', 'ok:false STALE_PROOF', `ok=${r.ok} code=${r.code}`, r.ok === false && r.code === 'STALE_PROOF');
}
{
  // disconnect invalidates immediately (before its await resolves).
  resetHarnessState();
  const st = harness.getState();
  const before = st.verificationGeneration;
  const d = deferred();
  st.connector = { disconnect: () => d.promise };
  st.lastChallenge = { message: 'x', recipient: harness.APP_DOMAIN };
  const p = harness.disconnectWallet();
  record('HARNESS-DISCONNECT-INVALIDATES-IMMEDIATELY', 'lastChallenge cleared and generation bumped before await',
    `gen ${before}->${st.verificationGeneration} challenge=${st.lastChallenge === null ? 'null' : 'set'}`,
    st.lastChallenge === null && st.verificationGeneration > before);
  d.resolve();
  const r = await p;
  record('HARNESS-DISCONNECT-COMPLETES', 'ok:true DISCONNECTED', `ok=${r.ok} code=${r.code}`, r.ok === true && r.code === 'DISCONNECTED');
}
{
  // late sign callback after a candidate switch must not (re)populate the challenge.
  resetHarnessState();
  const st = harness.getState();
  const d = deferred();
  st.wallet = { signMessage: () => d.promise };
  const p = harness.signChallenge('fixture.testnet');
  await new Promise((r) => setTimeout(r, 0));
  harness.selectCandidate('near-auth');
  d.resolve({ accountId: 'fixture.testnet', publicKey: PUBLIC_KEY, signature: SIGNATURE });
  const r = await p;
  record('HARNESS-LATE-SIGN-STALE', 'ok:false STALE_OPERATION, challenge not re-populated',
    `ok=${r.ok} code=${r.code} challenge=${st.lastChallenge === null ? 'null' : 'set'}`,
    r.ok === false && r.code === 'STALE_OPERATION' && st.lastChallenge === null);
}
{
  // Relogin boundary semantics the signOut handler feeds into: a FAILED signOut
  // produces no SIGNED_OUT boundary (so adjacent connects stay one session);
  // only a successful SIGNED_OUT/DISCONNECTED separates two connects.
  resetHarnessState();
  const st = harness.getState();
  st.sessions = [
    { seq: 1, event: 'SIGN_IN_EVENT', accountId: 'acctA.testnet' },
    { seq: 2, event: 'CONNECTED', accountId: 'acctA.testnet' },
    // a failed signOut inserts no row, so the next connect has no boundary
    { seq: 3, event: 'SIGN_IN_EVENT', accountId: 'acctA.testnet' },
    { seq: 4, event: 'CONNECTED', accountId: 'acctA.testnet' },
  ];
  const cmp = harness.sameAccountAcrossSessions();
  record('HARNESS-FAILED-SIGNOUT-NOT-RELOGIN', 'ok:false NEED_TWO_SESSIONS (no boundary between connects)',
    `ok=${cmp.ok} code=${cmp.code}`, cmp.ok === false && cmp.code === 'NEED_TWO_SESSIONS');
}
{
  resetHarnessState();
  const st = harness.getState();
  st.sessions = [
    { seq: 1, event: 'CONNECTED', accountId: 'acctA.testnet' },
    { seq: 2, event: 'SIGNED_OUT', accountId: null }, // successful external signOut boundary
    { seq: 3, event: 'CONNECTED', accountId: 'acctA.testnet' },
  ];
  const cmp = harness.sameAccountAcrossSessions();
  record('HARNESS-SUCCESS-SIGNOUT-ENABLES-RELOGIN', 'ok:true SAME_ACCOUNT',
    `ok=${cmp.ok} code=${cmp.code}`, cmp.ok === true && cmp.code === 'SAME_ACCOUNT');
}

console.log(JSON.stringify({ suite: 't02-adversarial', results, summary: { total: results.length, failed: results.filter((r) => !r.ok).length } }, null, 2));
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\n${failed.length}/${results.length} T02 adversarial check(s) NOT observed.`);
  process.exit(1);
}
console.log(`\nPASS: all ${results.length} T02 adversarial checks observed (real harness behavior + adapter gates; injected seams, no live RPC/wallet).`);