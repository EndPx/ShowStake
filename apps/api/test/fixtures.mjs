// Shared LOCAL test fixtures for apps/api (used by scripts/verify-api.mjs and
// apps/api/test/verify-api-db.mjs). Everything here is LOCAL CRYPTOGRAPHY DATA:
// a generated ed25519 keypair + a fake final access-key resolver. It never calls
// a wallet, never proves a real NEAR account, and is labelled PASS_LOCAL in
// evidence (never wallet/testnet acceptance).
import { makeLocalFixtureKeypair, signNep413ForFixtures } from '@showstake/wallet-adapter';

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/i.test(hex)) throw new Error('bad nonce hex');
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

export function makeKeypair() {
  return makeLocalFixtureKeypair();
}

export function signChallenge(privateKey, { message, nonceHex, recipient }) {
  return signNep413ForFixtures(privateKey, { message, nonce: hexToBytes(nonceHex), recipient });
}

/**
 * A deterministic fake final access-key resolver: returns the presented key as a
 * CURRENT FullAccess key of `accountId` on `network`, stamped with a fixed
 * `verifiedAt` captured before the run (so it is never "in the future" relative
 * to the API's own clock). LOCAL ONLY.
 */
export function makeFakeResolver(accountId, publicKey, network) {
  const verifiedAt = Date.now() - 1;
  return async (q) => {
    if (q.accountId !== accountId) return { ok: false, code: 'ACCOUNT_NOT_FOUND', accountId: q.accountId, publicKey: q.publicKey, network, verifiedAt: Date.now() };
    return {
      ok: true,
      code: 'VERIFIED_ACCESS_KEY',
      accountId,
      publicKey,
      keyType: 'ed25519',
      accessKeyType: 'FullAccess',
      verifiedAt,
      network,
      blockHeight: 999,
    };
  };
}

export function makeDenyAllResolver(network) {
  return async (q) => ({
    ok: false,
    code: 'KEY_NOT_FOUND',
    accountId: q.accountId,
    publicKey: q.publicKey,
    keyType: 'ed25519',
    network,
    verifiedAt: Date.now(),
  });
}