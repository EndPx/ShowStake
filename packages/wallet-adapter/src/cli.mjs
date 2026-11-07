#!/usr/bin/env node
// Wallet-adapter probe CLI. Runs LOCAL CRYPTOGRAPHY FIXTURES only; none of this
// proves a live wallet login (W01/W02/W03 remain open — blocked externally).
//
// Usage:
//   node packages/wallet-adapter/src/cli.mjs            # fixtures + negative checks
// Exit: 0 when every expected outcome is observed; 1 otherwise.

import { capabilityPrivyNear, PRIVY_NEAR_CRYPTO_PATH, PRIVY_SDK_PINS, buildPrivySignRawHashArgs } from './privy-near.mjs';
import {
  makeLocalFixtureKeypair, signNep413ForFixtures,
  nonceOf, verifyNep413SignedMessage,
} from './nep413.mjs';
import { makeChallenge, verifyChallengeProof } from './verify-binding.mjs';
import { isAtomic, assertAtomic } from '../../domain/src/index.mjs';

const results = [];
function record(id, requirement, expected, observed, ok, classifier = null, limits = []) {
  results.push({ id, requirement, expected, observed, ok, classifier, limits });
}
function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
}

const DOMAIN = 'showstake.app';
const NETWORK = 'testnet';
const PURPOSE = 'login';

// Build a challenge + an implicit-account proof from a fresh local keypair.
// `account` defaults to the keypair's implicit hex id; pass a named account to
// model a foreign-key claim against it.
function signedProof({ account = null, domain = DOMAIN, network = NETWORK, purpose = PURPOSE, times = {} } = {}) {
  const nonce = nonceOf(`seed-${Date.now()}-${Math.random()}`);
  const kp = makeLocalFixtureKeypair();
  const accountId = account ?? kp.accountId;
  const ch = makeChallenge({ purpose, domain, network, accountId, nonce, ...times });
  const signature = signNep413ForFixtures(kp.privateKey, {
    message: ch.message, nonce, recipient: ch.domain, callbackUrl: ch.callbackUrl ?? undefined,
  });
  return { ch, nonce, kp, proof: { accountId, publicKey: kp.publicKey, signature } };
}

async function main() {
  // --- G01/G02: Privy NEAR capability (documented, externally blocked) ------
  const privyCap = capabilityPrivyNear();
  record(
    'W01-PRIVY-NEAR',
    'Privy Google/email + EVM login -> controlled NEAR account signing path',
    'capability documented; classifier BLOCKED_EXTERNAL (no app id/origin)',
    `documented; level=${privyCap.level}; classifier=${privyCap.classifier}`,
    privyCap.classifier === 'BLOCKED_EXTERNAL' && !privyCap.done,
    'BLOCKED_EXTERNAL',
    ['no Privy app id / browser origin; no authenticated login/signing performed'],
  );

  // signRawHash args must be exactly 32 bytes (review defect).
  let privy32 = true;
  try { buildPrivySignRawHashArgs({ address: 'f'.repeat(64), hashBytes: new Uint8Array(33) }); privy32 = false; } catch { /* expected */ }
  record(
    'PRIVY-SIGNRAWHASH-32B',
    'buildPrivySignRawHashArgs rejects non-32-byte hash',
    'throw on 33 bytes',
    `rejected=${privy32}`,
    privy32 === true,
    'PASS_LOCAL',
    ['typed boundary; not an executed Privy session'],
  );

  const consumed = new Set();

  // positive: implicit account + canonical message + correct context.
  {
    const { ch, proof } = signedProof();
    const r = await verifyChallengeProof({
      challenge: ch, proof, consumedNonces: consumed,
      expectedDomain: DOMAIN, expectedNetwork: NETWORK, expectedPurpose: PURPOSE,
      allowLocalImplicitFallback: true,
    });
    record(
      'NEP413-POSITIVE',
      'NEP-413 signed message verifies for correct domain/account/network/purpose',
      'ok:true code=OK',
      `ok=${r.ok} code=${r.code}`,
      r.ok === true && r.code === 'OK',
      'PASS_LOCAL',
      ['local ed25519 fixture; not a wallet login (W01-W03 open)'],
    );
  }

  // negative: wrong domain (proof signed for evil.app, expected showstake.app)
  {
    const { ch, proof } = signedProof({ domain: 'evil.app' });
    const r = await verifyChallengeProof({
      challenge: ch, proof, consumedNonces: consumed,
      expectedDomain: DOMAIN, expectedNetwork: NETWORK, expectedPurpose: PURPOSE,
      allowLocalImplicitFallback: true,
    });
    record(
      'NEP413-WRONG-DOMAIN',
      'A01: wrong-domain proof rejected',
      'ok:false code=WRONG_DOMAIN',
      `ok=${r.ok} code=${r.code}`,
      r.ok === false && r.code === 'WRONG_DOMAIN',
      'PASS_LOCAL',
      ['fixture only'],
    );
  }

  // negative: wrong network
  {
    const { ch, proof } = signedProof({ network: 'mainnet' });
    const r = await verifyChallengeProof({
      challenge: ch, proof, consumedNonces: consumed,
      expectedDomain: DOMAIN, expectedNetwork: NETWORK, expectedPurpose: PURPOSE,
      allowLocalImplicitFallback: true,
    });
    record(
      'NEP413-WRONG-NETWORK',
      'A01: wrong-network proof rejected',
      'ok:false code=WRONG_NETWORK',
      `ok=${r.ok} code=${r.code}`,
      r.ok === false && (r.code === 'WRONG_NETWORK' || r.code === 'MESSAGE_NOT_BOUND'),
      'PASS_LOCAL',
      ['fixture only'],
    );
  }

  // negative: canonical message not bound (swap network without re-signing).
  {
    const { ch, proof } = signedProof();
    ch.network = 'mainnet'; // mutate after signing; signed message still says testnet
    const r = await verifyChallengeProof({
      challenge: ch, proof, consumedNonces: consumed,
      expectedDomain: DOMAIN, expectedNetwork: NETWORK, expectedPurpose: PURPOSE,
      allowLocalImplicitFallback: true,
    });
    record(
      'NEP413-MESSAGE-NOT-BOUND',
      'A01: context change not reflected in the signed message is rejected',
      'ok:false code=MESSAGE_NOT_BOUND (or WRONG_NETWORK)',
      `ok=${r.ok} code=${r.code}`,
      r.ok === false,
      'PASS_LOCAL',
      ['fixture demonstrates canonical message binding'],
    );
  }

  // negative: foreign key cannot bind an arbitrary NAMED account (reviewed defect #1)
  {
    const { ch, proof } = signedProof({ account: 'victim.testnet' });
    // proof.accountId is forced to equal challenge.accountId (attacker lies); the
    // key is a fresh local key with NO on-chain relation to victim.testnet.
    const forcible = { accountId: 'victim.testnet', publicKey: proof.publicKey, signature: proof.signature };
    const r = await verifyChallengeProof({
      challenge: ch, proof: forcible, consumedNonces: consumed,
      expectedDomain: DOMAIN, expectedNetwork: NETWORK, expectedPurpose: PURPOSE,
    });
    record(
      'NAMED-ACCOUNT-FOREIGN-KEY',
      'A02/W04: a foreign key cannot claim a NAMED account (fail closed without RPC)',
      'ok:false code=ACCOUNT_KEY_UNVERIFIED',
      `ok=${r.ok} code=${r.code}`,
      r.ok === false && r.code === 'ACCOUNT_KEY_UNVERIFIED',
      'PASS_LOCAL',
      ['named accounts need a trusted network access-key resolver; fixture has none'],
    );
  }

  // negative: implicit-account key binding (Privy embedded-wallet path)
  {
    const otherHex = 'f'.repeat(64); // a DIFFERENT implicit account id (foreign)
    const fresh = signedProof({ account: otherHex });
    const forged = { accountId: otherHex, publicKey: fresh.proof.publicKey, signature: fresh.proof.signature };
    const r = await verifyChallengeProof({
      challenge: fresh.ch, proof: forged, consumedNonces: consumed,
      expectedDomain: DOMAIN, expectedNetwork: NETWORK, expectedPurpose: PURPOSE,
      allowLocalImplicitFallback: true,
    });
    record(
      'PRIVY-IMPLICIT-KEY-BINDING',
      'A02: an implicit NEAR account id IS its public key; a foreign key cannot bind it',
      'ok:false code=ACCOUNT_KEY_MISMATCH',
      `ok=${r.ok} code=${r.code}`,
      r.ok === false && r.code === 'ACCOUNT_KEY_MISMATCH',
      'PASS_LOCAL',
      ['modeled on Privy implicit-account path; fixture only'],
    );
  }

  // negative: stale proof (expired)
  {
    const now = Date.now();
    const { ch, proof } = signedProof({ times: { issuedAtMs: now - 6 * 60 * 1000, expiresAtMs: now - 60 * 1000 } });
    const r = await verifyChallengeProof({
      challenge: ch, proof, consumedNonces: consumed,
      expectedDomain: DOMAIN, expectedNetwork: NETWORK, expectedPurpose: PURPOSE, nowMs: now,
      allowLocalImplicitFallback: true,
    });
    record(
      'NEP413-STALE',
      'A01: expired challenge rejected',
      'ok:false code=STALE_PROOF',
      `ok=${r.ok} code=${r.code}`,
      r.ok === false && r.code === 'STALE_PROOF',
      'PASS_LOCAL',
      ['fixture only'],
    );
  }

  // negative: non-finite timestamps (reviewed defect #2)
  {
    const { ch, proof } = signedProof();
    ch.issuedAtMs = NaN; ch.expiresAtMs = NaN;
    const r = await verifyChallengeProof({
      challenge: ch, proof, consumedNonces: consumed,
      expectedDomain: DOMAIN, expectedNetwork: NETWORK, expectedPurpose: PURPOSE,
      allowLocalImplicitFallback: true,
    });
    record(
      'NEP413-NONFINITE-TIMESTAMPS',
      'A01: NaN/Infinity/absent/non-integer timestamps rejected',
      'ok:false code=BAD_TIMESTAMP',
      `ok=${r.ok} code=${r.code}`,
      r.ok === false && r.code === 'BAD_TIMESTAMP',
      'PASS_LOCAL',
      ['fixture only'],
    );
  }

  // negative: future issuance
  {
    const now = Date.now();
    const { ch, proof } = signedProof({ times: { issuedAtMs: now + 60 * 1000, expiresAtMs: now + 10 * 60 * 1000 } });
    const r = await verifyChallengeProof({
      challenge: ch, proof, consumedNonces: consumed,
      expectedDomain: DOMAIN, expectedNetwork: NETWORK, expectedPurpose: PURPOSE, nowMs: now,
      allowLocalImplicitFallback: true,
    });
    record(
      'NEP413-FUTURE-ISSUANCE',
      'A01: future-issued challenge rejected',
      'ok:false code=FUTURE_ISSUANCE',
      `ok=${r.ok} code=${r.code}`,
      r.ok === false && r.code === 'FUTURE_ISSUANCE',
      'PASS_LOCAL',
      ['fixture only'],
    );
  }

  // negative: overlong TTL
  {
    const now = Date.now();
    const { ch, proof } = signedProof({ times: { issuedAtMs: now, expiresAtMs: now + 6 * 60 * 1000 } });
    const r = await verifyChallengeProof({
      challenge: ch, proof, consumedNonces: consumed,
      expectedDomain: DOMAIN, expectedNetwork: NETWORK, expectedPurpose: PURPOSE, nowMs: now,
      allowLocalImplicitFallback: true,
    });
    record(
      'NEP413-OVERLONG-TTL',
      'A01: TTL > 5m rejected',
      'ok:false code=EXPIRY_TOO_LONG',
      `ok=${r.ok} code=${r.code}`,
      r.ok === false && r.code === 'EXPIRY_TOO_LONG',
      'PASS_LOCAL',
      ['fixture only'],
    );
  }

  // negative: missing expected domain/network/purpose (reviewed defect)
  {
    const { ch, proof } = signedProof();
    const r = await verifyChallengeProof({ challenge: ch, proof, consumedNonces: consumed, allowLocalImplicitFallback: true });
    record(
      'NEP413-MISSING-EXPECTATIONS',
      'A01: absent expected domain/network/purpose fail closed',
      'ok:false code=MISSING_EXPECTED_DOMAIN',
      `ok=${r.ok} code=${r.code}`,
      r.ok === false && r.code === 'MISSING_EXPECTED_DOMAIN',
      'PASS_LOCAL',
      ['verifier refuses to run without its protection context'],
    );
  }

  // negative: key-type mismatch (secp256k1 label over ed25519 bytes)
  {
    const { ch, kp } = signedProof();
    const mislabeled = `secp256k1:${kp.publicKey.replace('ed25519:', '')}`;
    const signature = signNep413ForFixtures(kp.privateKey, {
      message: ch.message, nonce: ch.nonce, recipient: ch.domain, callbackUrl: ch.callbackUrl ?? undefined,
    });
    const crypto = verifyNep413SignedMessage({
      message: ch.message, nonce: ch.nonce, recipient: DOMAIN,
      accountId: kp.accountId, publicKey: mislabeled, signature,
    });
    record(
      'NEP413-KEY-TYPE-MISMATCH',
      'NEP-413: a key-type label is respected; secp256k1 label fails closed',
      'ok:false code=UNSUPPORTED_KEY_TYPE',
      `ok=${crypto.ok} code=${crypto.code}`,
      crypto.ok === false && crypto.code === 'UNSUPPORTED_KEY_TYPE',
      'PASS_LOCAL',
      ['ed25519 verify only; secp256k1 requires SDK'],
    );
  }

  // negative: reused nonce
  {
    const { ch, proof } = signedProof();
    const first = await verifyChallengeProof({
      challenge: ch, proof, consumedNonces: consumed,
      expectedDomain: DOMAIN, expectedNetwork: NETWORK, expectedPurpose: PURPOSE,
      allowLocalImplicitFallback: true,
    });
    const second = await verifyChallengeProof({
      challenge: ch, proof, consumedNonces: consumed,
      expectedDomain: DOMAIN, expectedNetwork: NETWORK, expectedPurpose: PURPOSE,
      allowLocalImplicitFallback: true,
    });
    record(
      'NEP413-REUSED-NONCE',
      'A01: replayed challenge rejected (single-use nonce)',
      `first ok=${first.ok}; second ok:false code=REUSED_NONCE`,
      `first=${first.ok}; second ok=${second.ok} code=${second.code}`,
      first.ok === true && second.ok === false && second.code === 'REUSED_NONCE',
      'PASS_LOCAL',
      ['fixture only; local Set is NOT production atomic nonce persistence'],
    );
  }

  // --- domain sanity: exact atomic amount handling ---------------------------
  record(
    'DOMAIN-ATOMIC',
    'exact atomic u128 amounts enforced (no floats)',
    'assertAtomic("5000000") ok; "5.0" and "00" rejected',
    `isAtomic("5000000")=${isAtomic('5000000')} ; isAtomic("5.0")=${isAtomic('5.0')} ; isAtomic("00")=${isAtomic('00')} ; parse=7500000 for 7500000`,
    isAtomic('5000000') === true && isAtomic('5.0') === false && isAtomic('00') === false && assertAtomic('7500000') === 7500000n,
    'PASS_LOCAL',
    ['zero-dependency; not chain-tested'],
  );

  console.log(JSON.stringify({
    capability: {
      privy_near: privyCap,
      privy_sdk_pins: PRIVY_SDK_PINS,
      crypto_path: PRIVY_NEAR_CRYPTO_PATH,
    },
    results,
    summary: { total: results.length, failed: results.filter((r) => !r.ok).length },
  }, null, 2));

  if (results.some((r) => !r.ok)) {
    fail('one or more expected outcomes were not observed');
  } else {
    console.log('ALL WALLET-ADAPTER FIXTURE/negative checks: PASS_LOCAL (live paths remain BLOCKED_EXTERNAL)');
  }
}

main();