// Privy embedded-NEAR signing path — documented capability, not an executed login.
//
// This module encodes, at a typed boundary, exactly how Privy's embedded NEAR
// wallet signs, so future adapters do not guess. It is derived from the official
// NEAR x Privy example (near-examples/hello-privy, main @ 5aa847a) and the NEAR
// docs tutorial, both inspected 2026-11-06. It does NOT run a login: a real
// Privy session needs an app ID and a browser origin, both external and absent
// here, so the capability is classified BLOCKED_EXTERNAL (level: DOCUMENTED).
//
// KEY SECURITY FACT (anti-hallucination gate): an EVM wallet signature is a
// secp256k1 signature over a different key. It CANNOT bind an arbitrary NEAR
// account. Privy's NEAR embedded wallet is a SEPARATE key from an EVM/Solana
// wallet on the same user; the adapter must select account.type==='wallet' &&
// chainType==='near', and the recovery-of-control proof must use that NEAR key.

import { capabilityResult } from '../../domain/src/index.mjs';

export const PRIVY_SDK_PINS = Object.freeze({
  // Inspected versions/licenses (npm registry + hello-privy, 2026-11-06). NOT
  // installed by this probe (kept dependency-free); listed for the real adapter.
  '@privy-io/react-auth': { version: '3.51.2', license: 'Apache-2.0', subpath: './extended-chains' },
  'near-api-js': { version: '7.4.0', license: '(MIT AND Apache-2.0)', subpath: './nep413' },
  // Transitive pins from near-api-js@7.4.0 and hello-privy, recorded for lockfile readiness:
  '@noble/hashes': '2.2.0 (near-api-js) / 1.8.0 (hello-privy peer)',
  '@scure/base': '2.2.0 (near-api-js) / 1.2.6 (hello-privy)',
  borsh: '2.0.0 (near-api-js)',
});

export const PRIVY_NEAR_CRYPTO_PATH = Object.freeze([
  'User signs in (Google/email or EVM/MetaMask) -> Privy issues an app identity (sub).',
  'Adapter checks user.linkedAccounts for { type:"wallet", chainType:"near" }; else calls useCreateWallet({chainType:"near"}) from @privy-io/react-auth/extended-chains.',            'The NEAR wallet `.address` is the NEAR account id. Privy embedded NEAR wallets are implicit accounts: 64-hex, where the account id IS the ed25519 public key (keyType 0).',
  'near-api-js serializes a Transaction/SignedMessage, computes SHA-256 over the bytes, and hands the 32-byte hash to the adapter signer.',
  'Adapter calls Privy signRawHash({ address:NearAccountId, chainType:"near", hash:"0x"+hex }) from @privy-io/react-auth/extended-chains.',
  'Privy signs the SHA-256 hash with the embedded NEAR ed25519 key and returns a 0x-hex signature.',
  'near-api-js assembles the Ed25519 signature of the SHA-256 hash (NEAR convention, not a plain message signature).',
]);

/**
 * Translate a Privy NEAR implicit account id into its public key bytes.
 * Named accounts return `ok:false` (recovery requires an RPC access-key lookup).
 *
 * @param {string} accountId
 * @returns {{ok:boolean, code:string, keyType?:string, publicKeyHex?:string}}
 */
export function deriveImplicitAccountKey(accountId) {
  if (typeof accountId === 'string' && /^[0-9a-f]{64}$/.test(accountId)) {
    return { ok: true, code: 'IMPLICIT_ED25519', keyType: 'ed25519', publicKeyHex: accountId };
  }
  return { ok: false, code: 'NAMED_ACCOUNT_NEEDS_RPC_KEY_LOOKUP' };
}

/**
 * Build the exact `signRawHash` argument object Privy's extended-chains hook
 * expects. This is a typed boundary only — the caller must have a live Privy
 * session to execute it.
 *
 * @param {object} p
 * @param {string} p.address          NEAR account id
 * @param {Uint8Array} p.hashBytes    32-byte SHA-256 digest to sign
 * @returns {{address:string, chainType:'near', hash:string}}
 */
export function buildPrivySignRawHashArgs({ address, hashBytes }) {
  if (typeof address !== 'string' || !/^[0-9a-f]{64}$/.test(address)) {
    throw new Error('Privy NEAR embedded wallets are implicit accounts (64-hex address)');
  }
  const bytes = hashBytes instanceof Uint8Array ? hashBytes : null;
  if (!bytes || bytes.length !== 32) {
    throw new Error('Privy NEAR signRawHash hash must be exactly 32 bytes (a SHA-256 digest)');
  }
  return { address, chainType: 'near', hash: `0x${Buffer.from(bytes).toString('hex')}` };
}

/** Capability probe result for G01/G02 (Privy NEAR). Never `done` without a live session. */
export function capabilityPrivyNear() {
  return capabilityResult({
    id: 'W01-PRIVY-NEAR',
    capability: 'G01_PRIVY_NEAR_SIGNING',
    level: 'DOCUMENTED',
    classifier: 'BLOCKED_EXTERNAL',
    done: false,
    observations: [
      'Privy embedded NEAR signing path documented (implicit ed25519 account, signRawHash over SHA-256).',
      'EVM signature cannot bind a NEAR account; separate NEAR key must be selected and proved.',
      'No Privy app ID / browser origin available in this run -> no authenticated login/signing performed.',
    ],
    details: {
      source: 'https://github.com/near-examples/hello-privy (5aa847a) + https://docs.near.org/web3-apps/tutorials/privy',
      access_date: '2026-11-06',
      sdk_pins: PRIVY_SDK_PINS,
    },
  });
}