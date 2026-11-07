#!/usr/bin/env node
// T02 security regressions — reproduces the Codex adversarial probes that
// PASSED against the interrupted partial implementation and asserts they now
// FAIL CLOSED. Every assertion is an expected DENIAL; a zero exit means all of
// them were observed, a non-zero exit means a regression.
//
// Preserves the original failed evidence:
//   docs/evidence/t02-interrupted-review.json  (namedAccountForeignKey, nonfiniteTimestamps)
//   docs/evidence/t02-provider-recurrence.json (mislabeledKeyType, missingExpectedDomainNetwork)
//
// These are local cryptographic fixtures only — they do NOT satisfy W01–W06.

import { makeLocalFixtureSignature, makeLocalFixtureKeypair, signNep413ForFixtures, nonceOf, verifyNep413SignedMessage } from '../packages/wallet-adapter/src/nep413.mjs';
import { makeChallenge, verifyChallengeProof, validateChallengeTimes } from '../packages/wallet-adapter/src/verify-binding.mjs';

const results = [];
function record(id, expected, observed, ok) {
  results.push({ id, expected, observed, ok });
  if (!ok) console.error(`REG_FAIL: ${id} — ${observed} (expected ${expected})`);
}

async function run() {
  // 1. named-account foreign key: attacker key signs, claims victim.testnet.
  {
    const nonce = nonceOf('codex-negative-review');
    const sig = makeLocalFixtureSignature({ message: 'fixture', nonce, recipient: 'showstake.example' });
    const base = { purpose: 'login', domain: 'showstake.example', network: 'testnet', accountId: 'victim.testnet', nonce, message: 'fixture' };
    const forged = { accountId: 'victim.testnet', publicKey: sig.publicKey, signature: sig.signature };
    const r = await verifyChallengeProof({ challenge: makeChallenge(base), proof: forged, consumedNonces: new Set(), expectedDomain: 'showstake.example', expectedNetwork: 'testnet' });
    record('NAMED_ACCOUNT_FOREIGN_KEY', 'ok:false', `ok=${r.ok} code=${r.code}`, r.ok === false);

    // Targeted: all expectations supplied + canonical message, so the ONLY reason
    // to deny is the missing on-chain access-key relation for a named account.
    const nonce2 = nonceOf('t02-targeted-named-account');
    const kp = makeLocalFixtureKeypair();
    const ch = makeChallenge({ purpose: 'login', domain: 'showstake.app', network: 'testnet', accountId: 'victim.testnet', nonce: nonce2 });
    const signature = signNep413ForFixtures(kp.privateKey, { message: ch.message, nonce: nonce2, recipient: 'showstake.app' });
    const r2 = await verifyChallengeProof({
      challenge: ch,
      proof: { accountId: 'victim.testnet', publicKey: kp.publicKey, signature },
      consumedNonces: new Set(),
      expectedDomain: 'showstake.app', expectedNetwork: 'testnet', expectedPurpose: 'login',
    });
    record('NAMED_ACCOUNT_KEY_UNVERIFIED', 'code=ACCOUNT_KEY_UNVERIFIED', `ok=${r2.ok} code=${r2.code}`, r2.ok === false && r2.code === 'ACCOUNT_KEY_UNVERIFIED');
  }

  // 2. non-finite timestamps (NaN) — original repro then a fuller matrix.
  {
    const nonce = nonceOf('codex-negative-review');
    const sig = makeLocalFixtureSignature({ message: 'fixture', nonce, recipient: 'showstake.example' });
    const base = { purpose: 'login', domain: 'showstake.example', network: 'testnet', accountId: sig.accountId, nonce, message: 'fixture' };
    const malformed = makeChallenge(base);
    malformed.expiresAtMs = NaN; malformed.issuedAtMs = NaN;
    const r = await verifyChallengeProof({ challenge: malformed, proof: { accountId: sig.accountId, publicKey: sig.publicKey, signature: sig.signature }, consumedNonces: new Set(), expectedDomain: 'showstake.example', expectedNetwork: 'testnet', expectedPurpose: 'login' });
    record('NONFINITE_TIMESTAMPS', 'ok:false with BAD_TIMESTAMP', `ok=${r.ok} code=${r.code}`, r.ok === false && (r.failures || []).some((f) => f.code === 'BAD_TIMESTAMP'));
  }

  // Timestamp matrix (each must deny).
  {
    const now = Date.now();
    const cases = [
      ['FUTURE_ISSUANCE', { issuedAtMs: now + 60_000, expiresAtMs: now + 10 * 60_000 }],
      ['NON_INTEGER_TIMESTAMP', { issuedAtMs: now + 0.5, expiresAtMs: now + 300_000 }],
      ['NONPOSITIVE_TTL', { issuedAtMs: now, expiresAtMs: now - 1 }],
      ['OVERLONG_TTL', { issuedAtMs: now, expiresAtMs: now + 6 * 60_000 }],
    ];
    for (const [id, times] of cases) {
      const nonce = nonceOf(`ts-${id}`);
      const kp = makeLocalFixtureKeypair();
      const ch = makeChallenge({ purpose: 'login', domain: 'showstake.app', network: 'testnet', accountId: kp.accountId, nonce, ...times });
      const signature = signNep413ForFixtures(kp.privateKey, { message: ch.message, nonce, recipient: 'showstake.app' });
      const r = await verifyChallengeProof({
        challenge: ch, proof: { accountId: kp.accountId, publicKey: kp.publicKey, signature },
        consumedNonces: new Set(), expectedDomain: 'showstake.app', expectedNetwork: 'testnet', expectedPurpose: 'login', nowMs: now,
      });
      record(`TIMESTAMPS_${id}`, 'ok:false', `ok=${r.ok} code=${r.code}`, r.ok === false);
    }
    // Absent timestamps exercised directly against the validator (makeChallenge
    // would otherwise fill defaults).
    record('TIMESTAMPS_ABSENT', 'was rejected (BAD_TIMESTAMP)', JSON.stringify(validateChallengeTimes({ issuedAtMs: undefined, expiresAtMs: undefined }, now)), validateChallengeTimes({ issuedAtMs: undefined, expiresAtMs: undefined }, now).some((f) => f.code === 'BAD_TIMESTAMP'));
  }

  // 3. key-type mismatch: secp256k1 label must fail closed (not VERIFIED).
  {
    const nonce = nonceOf('codex-domain-review-2');
    const s = makeLocalFixtureSignature({ message: 'fixture', nonce, recipient: 'showstake.example' });
    const mislabeled = verifyNep413SignedMessage({ message: 'fixture', nonce, recipient: 'showstake.example', accountId: s.accountId, publicKey: s.publicKey.replace('ed25519:', 'secp256k1:'), signature: s.signature });
    record('MISLABELED_KEY_TYPE', 'ok:false code=UNSUPPORTED_KEY_TYPE', `ok=${mislabeled.ok} code=${mislabeled.code}`, mislabeled.ok === false && mislabeled.code === 'UNSUPPORTED_KEY_TYPE');
  }

  // 4. absent expected domain/network (and purpose) must fail closed.
  {
    const nonce = nonceOf('codex-domain-review-2');
    const s = makeLocalFixtureSignature({ message: 'fixture', nonce, recipient: 'showstake.example' });
    const challenge = makeChallenge({ purpose: 'login', domain: 'showstake.example', network: 'testnet', accountId: s.accountId, nonce, message: 'fixture' });
    const r = await verifyChallengeProof({ challenge, proof: { accountId: s.accountId, publicKey: s.publicKey, signature: s.signature }, consumedNonces: new Set() });
    record('MISSING_EXPECTED_DOMAIN_NETWORK', 'ok:false', `ok=${r.ok} code=${r.code}`, r.ok === false && r.code === 'MISSING_EXPECTED_DOMAIN');
  }

  // 5. canonical message binding: mutating context after signing must deny.
  {
    const nonce = nonceOf('canonical-binding');
    const kp = makeLocalFixtureKeypair();
    const ch = makeChallenge({ purpose: 'login', domain: 'showstake.app', network: 'testnet', accountId: kp.accountId, nonce });
    const signature = signNep413ForFixtures(kp.privateKey, { message: ch.message, nonce, recipient: 'showstake.app' });
    ch.network = 'mainnet'; // mutate after signing
    const r = await verifyChallengeProof({
      challenge: ch, proof: { accountId: kp.accountId, publicKey: kp.publicKey, signature },
      consumedNonces: new Set(), expectedDomain: 'showstake.app', expectedNetwork: 'testnet', expectedPurpose: 'login',
    });
    record('CANONICAL_MESSAGE_BINDING', 'ok:false', `ok=${r.ok} code=${r.code}`, r.ok === false);
  }

  console.log(JSON.stringify(results, null, 2));
  const bad = results.filter((r) => !r.ok);
  if (bad.length) {
    console.error(`\n${bad.length}/${results.length} T02 security regression(s) NOT observed (or code mismatch).`);
    process.exit(1);
  }
  console.log(`\nPASS: all ${results.length} T02 security regressions now deny as required (local fixtures; live gates still BLOCKED_EXTERNAL).`);
}

run();