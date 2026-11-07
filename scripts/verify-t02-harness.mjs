#!/usr/bin/env node
// T02 wallet harness acceptance (local): proves the deliverable is a REAL SDK
// browser harness, not a config-only report, and that the auth fallback fails
// closed. Runs in Node with NO live RPC and NO wallet:
//
//   PART A  SDK presence + exact pinned versions (guard against silent major
//           migration of near-api-js / @hot-labs/near-connect).
//   PART B  SDK capability assertions (imports resolve; NearConnector/
//           verifyMessage/JsonRpcProvider exist).
//   PART C  Fail-closed auth fallback: default live auth denies on a missing/
//           unavailable RPC resolver; the implicit-account local check is an
//           EXPLICIT fixture-only path (never reached by live auth).
//   PART D  Harness source integrity: the browser harness module imports the real
//           SDKs and pins domain/network/purpose/recipient constants.
//
// Exit 0 when every expected outcome is observed. Complementary to `pnpm
// build:t02-harness` (vite build) and the wallet-adapter fixture suites.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
function record(id, expected, observed, ok) {
  results.push({ id, expected, observed, ok });
  if (!ok) console.error(`HARNESS_FAIL: ${id} — ${observed} (expected ${expected})`);
}

function pkgVersion(pkgDir) {
  for (const rel of [pkgDir, join('node_modules', pkgDir)]) {
    const p = join(ROOT, rel, 'package.json');
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')).version;
  }
  return null;
}

// --- PART A: exact pinned versions ------------------------------------------
const EXPECTED = Object.freeze({
  'near-api-js': '7.4.0',
  '@hot-labs/near-connect': '0.12.0',
});
for (const [name, want] of Object.entries(EXPECTED)) {
  const got = pkgVersion(name);
  record(`VERSION-${name.replace('/', '-')}`, `exact ${want}`, `got ${got}`, got === want);
}

// --- PART B: SDK capability (imports resolve, no network) -------------------
const [nearApiJs, nearConnect, nep413] = await Promise.all([
  import('near-api-js'),
  import('@hot-labs/near-connect'),
  import('near-api-js/nep413'),
]);
record('SDK-NEAR-API-JS-JSONRPC', 'JsonRpcProvider importable', `typeof=${typeof nearApiJs.JsonRpcProvider}`, typeof nearApiJs.JsonRpcProvider === 'function');
record('SDK-NEP413-VERIFY', 'near-api-js/nep413 verifyMessage importable', `typeof=${typeof nep413.verifyMessage}`, typeof nep413.verifyMessage === 'function');
record('SDK-NEAR-CONNECT', 'NearConnector importable from @hot-labs/near-connect', `typeof=${typeof nearConnect.NearConnector}`, typeof nearConnect.NearConnector === 'function');
{
  const nc = new nearConnect.NearConnector({ network: 'testnet' });
  record('SDK-NEAR-CONNECT-API', 'NearConnector exposes connect/wallet/disconnect + availableWallets list',
    `connect=${typeof nc.connect} wallet=${typeof nc.wallet} disconnect=${typeof nc.disconnect} wallets=[${Array.isArray(nc.availableWallets)}]`,
    typeof nc.connect === 'function' && typeof nc.wallet === 'function' && typeof nc.disconnect === 'function' && Array.isArray(nc.availableWallets));
}

// --- PART C: fail-closed auth fallback (no resolver = no live auth) ---------
const verifyBinding = await import('../packages/wallet-adapter/src/verify-binding.mjs');
const nep413Local = await import('../packages/wallet-adapter/src/nep413.mjs');

async function signForFixture(accountId, domain = 'showstake.app', network = 'testnet', purpose = 'login') {
  const nonce = nep413Local.nonceOf(`harness-${accountId}-${Date.now()}-${Math.random()}`);
  const kp = nep413Local.makeLocalFixtureKeypair();
  const ch = verifyBinding.makeChallenge({ purpose, domain, network, accountId, nonce });
  const signature = nep413Local.signNep413ForFixtures(kp.privateKey, { message: ch.message, nonce, recipient: ch.domain, callbackUrl: ch.callbackUrl ?? undefined });
  return { ch, proof: { accountId, publicKey: kp.publicKey, signature } };
}

{
  // C1: NAMED account + missing resolver (default live auth w/o a resolver) denies.
  const { ch, proof } = await signForFixture('alice.testnet');
  const r = await verifyBinding.verifyChallengeProof({
    challenge: ch, proof, consumedNonces: new Set(),
    expectedDomain: 'showstake.app', expectedNetwork: 'testnet', expectedPurpose: 'login',
  });
  record('AUTH-NAMED-NO-RESOLVER-DENIED', 'ok:false ACCOUNT_KEY_UNVERIFIED',
    `ok=${r.ok} code=${r.code}`, r.ok === false && r.code === 'ACCOUNT_KEY_UNVERIFIED');
}
{
  // C2: NAMED account + unavailable resolver (RPC down) denies — the "fail closed
  //     on unavailable RPC resolver" requirement; no implicit-account fallback.
  const { ch, proof } = await signForFixture('alice.testnet');
  const unavailable = async () => ({ ok: false, code: 'RPC_ERROR', detail: 'simulated RPC unavailable' });
  const r = await verifyBinding.verifyChallengeProof({
    challenge: ch, proof, consumedNonces: new Set(),
    expectedDomain: 'showstake.app', expectedNetwork: 'testnet', expectedPurpose: 'login',
    accessKeyVerifier: unavailable,
  });
  record('AUTH-RPC-UNAVAILABLE-DENIED', 'ok:false RPC_ERROR (no fallback)',
    `ok=${r.ok} code=${r.code}`, r.ok === false && (r.failures || []).some((f) => f.code === 'RPC_ERROR'));
}
{
  // C3: IMPLICIT account WITHOUT a resolver but WITH the explicit
  //     `allowLocalImplicitFallback` opt-in passes locally ONLY because id==key.
  //     This documents the fallback is a fixture-only, explicit opt-in — never the
  //     default for live/auth code (which always injects a resolver).
  //     Sign with the SAME keypair whose account id is the challenge account.
  const kp = nep413Local.makeLocalFixtureKeypair();
  const accountId = kp.accountId; // 64-hex == this key's ed25519 public key
  const nonce = nep413Local.nonceOf(`harness-impl-${Date.now()}-${Math.random()}`);
  const ch = verifyBinding.makeChallenge({ purpose: 'login', domain: 'showstake.app', network: 'testnet', accountId, nonce });
  const signature = nep413Local.signNep413ForFixtures(kp.privateKey, { message: ch.message, nonce, recipient: ch.domain, callbackUrl: ch.callbackUrl ?? undefined });
  const r = await verifyBinding.verifyChallengeProof({
    challenge: ch, proof: { accountId, publicKey: kp.publicKey, signature }, consumedNonces: new Set(),
    expectedDomain: 'showstake.app', expectedNetwork: 'testnet', expectedPurpose: 'login',
    allowLocalImplicitFallback: true,
  });
  record('AUTH-IMPLICIT-FIXTURE-ONLY-ALLOWED', 'ok:true (explicit allowLocalImplicitFallback opt-in only)',
    `ok=${r.ok} code=${r.code}`, r.ok === true && r.code === 'OK');
}
{
  // C3b: IMPLICIT account WITHOUT a resolver and WITHOUT the flag DENIES — the
  //      default for a missing resolver is fail-closed for implicit accounts too
  //      (no silent local id==key acceptance in live auth).
  const kp = nep413Local.makeLocalFixtureKeypair();
  const accountId = kp.accountId;
  const nonce = nep413Local.nonceOf(`harness-impl1-${Date.now()}-${Math.random()}`);
  const ch = verifyBinding.makeChallenge({ purpose: 'login', domain: 'showstake.app', network: 'testnet', accountId, nonce });
  const signature = nep413Local.signNep413ForFixtures(kp.privateKey, { message: ch.message, nonce, recipient: ch.domain, callbackUrl: ch.callbackUrl ?? undefined });
  const r = await verifyBinding.verifyChallengeProof({
    challenge: ch, proof: { accountId, publicKey: kp.publicKey, signature }, consumedNonces: new Set(),
    expectedDomain: 'showstake.app', expectedNetwork: 'testnet', expectedPurpose: 'login',
  });
  record('AUTH-IMPLICIT-NO-RESOLVER-DENIED', 'ok:false ACCOUNT_KEY_UNVERIFIED (default fail-closed for implicit)',
    `ok=${r.ok} code=${r.code}`, r.ok === false && r.code === 'ACCOUNT_KEY_UNVERIFIED');
}
{
  // C4: IMPLICIT account WITH a resolver that says RPC_ERROR must deny — i.e. once a
  //     resolver IS wired (as live/browser auth always is), the implicit fixture
  //     fallback is NOT consulted and RPC failure fails closed.
  const kp = nep413Local.makeLocalFixtureKeypair();
  const accountId = kp.accountId;
  const nonce = nep413Local.nonceOf(`harness-impl2-${Date.now()}-${Math.random()}`);
  const ch = verifyBinding.makeChallenge({ purpose: 'login', domain: 'showstake.app', network: 'testnet', accountId, nonce });
  const signature = nep413Local.signNep413ForFixtures(kp.privateKey, { message: ch.message, nonce, recipient: ch.domain, callbackUrl: ch.callbackUrl ?? undefined });
  const unavailable = async () => ({ ok: false, code: 'RPC_ERROR', detail: 'simulated RPC unavailable' });
  const r = await verifyBinding.verifyChallengeProof({
    challenge: ch, proof: { accountId, publicKey: kp.publicKey, signature }, consumedNonces: new Set(),
    expectedDomain: 'showstake.app', expectedNetwork: 'testnet', expectedPurpose: 'login',
    accessKeyVerifier: unavailable,
  });
  record('AUTH-IMPLICIT-WITH-RESOLVER-UNAVAILABLE-DENIED', 'ok:false RPC_ERROR (not fixture fallback)',
    `ok=${r.ok} code=${r.code}`, r.ok === false && (r.failures || []).some((f) => f.code === 'RPC_ERROR'));
}

// --- PART D: harness source integrity ---------------------------------------
{
  const harnessUrl = new URL('../apps/web/onboarding-probe/src/harness.mjs', import.meta.url);
  const source = readFileSync(fileURLToPath(harnessUrl), 'utf8');
  const mustImport = [
    "@hot-labs/near-connect",
    "near-api-js",
    "near-api-js/nep413",
  ];
  for (const spec of mustImport) {
    record(`HARNESS-IMPORTS-${spec}`, `source imports ${spec}`, 'present', source.includes(spec));
  }
  const pins = [
    ["network", "testnet"],
    ["domain", "showstake.app"],
    ["purpose", "login"],
    ["rpc", "https://rpc.testnet.near.org"],
  ];
  for (const [label, want] of pins) {
    record(`HARNESS-PINS-${label}`, `source pins ${label}=${want}`, 'present', source.includes(want));
  }
  // The harness module must be importable in Node (top-level is logic-only).
  const harness = await import('../apps/web/onboarding-probe/src/harness.mjs');
  record('HARNESS-MODULE-IMPORTABLE', 'harness.mjs exports resolved (NETWORK/APP_DOMAIN/APP_PURPOSE/RPC_URL)',
    `network=${harness.NETWORK} domain=${harness.APP_DOMAIN} purpose=${harness.APP_PURPOSE}`,
    harness.NETWORK === 'testnet' && harness.APP_DOMAIN === 'showstake.app' && harness.APP_PURPOSE === 'login' && harness.RPC_URL === 'https://rpc.testnet.near.org');
  record('HARNESS-VERIFY-USES-SDK', 'harness does NOT reimplement ed25519 (uses near-api-js verifyMessage)',
    `verifyMessage imported + present`, source.includes('verifyMessage'));
}

console.log(JSON.stringify({ suite: 't02-wallet-harness', results, summary: { total: results.length, failed: results.filter((r) => !r.ok).length } }, null, 2));
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\n${failed.length}/${results.length} T02 wallet-harness check(s) NOT observed.`);
  process.exit(1);
}
console.log(`\nPASS: all ${results.length} T02 wallet-harness checks observed (real SDKs pinned + live auth fail-closed; no live RPC/wallet used).`);
console.log('NOTE: run `pnpm build:t02-harness` for the reproducible browser build; live login/sign stays BLOCKED_EXTERNAL (human + wallet).');