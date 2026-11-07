// NEP-413 signed-message verification (native NEAR wallet path).
//
// Implements the off-chain challenge format from NEP-413:
//   signature = Ed25519( SHA256( borsh(u32(2^31+413) + Payload{message,nonce[32],recipient,callbackUrl}) ) )
// NEAR signatures are "Ed25519 of a SHA-256 hash" (nearcore#2835). This matches
// what Privy's embedded NEAR `signRawHash` and near-api-js both produce.
//
// REFERENCE (inspected 2026-11-06):
//   NEP-413 Final:  https://github.com/near/NEPs/blob/master/neps/nep-0413.md
//   Borsh field order: gagdiez/near-login server/tests/wallet.ts (NEP-shipped example)
//   near-api-js@7.4.0 exposes a `./nep413` subpath entrypoint (canonical for production).

import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { base58Decode, base58Encode } from './base58.mjs';
import { buildNep413Payload, borshU32 } from './borsh-lit.mjs';

export const NEP413_TAG = 0x80000000n + 413n; // 2147484061

/** @param {Buffer|Uint8Array} payload @returns {Buffer} */
export function nep413Hash(payload) {
  return createHash('sha256').update(payload).digest();
}

/**
 * Parse "keytype:base58" into 32 raw bytes.
 *
 * NEAR account access keys may be either ed25519 OR secp256k1; "full-access" is
 * a *permission*, not a key type (an account can hold full-access keys of either
 * curve). This probe implements ed25519 verification only and FAILS CLOSED on a
 * secp256k1 label rather than silently treating secp256k1 bytes as ed25519.
 * No universal "full-access keys are ed25519" claim is made here.
 *
 * @param {string} publicKey
 * @returns {{keyType:string, bytes:Uint8Array}}
 */
export function parseNearPublicKey(publicKey) {
  const m = /^(ed25519|secp256k1):([1-9A-HJ-NP-Za-km-z]+)$/.exec(String(publicKey));
  if (!m) throw new Error(`invalid NEAR public key format: ${publicKey}`);
  const bytes = base58Decode(m[2]);
  return { keyType: m[1], bytes };
}

/** @param {Uint8Array} raw32 @returns {import('node:crypto').KeyObject} */
export function ed25519PublicKeyFromBytes(raw32) {
  const x = Buffer.from(raw32).toString('base64url');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
}

/**
 * Verify a NEP-413 SignedMessage.
 *
 * @param {object} s
 * @param {string} s.message
 * @param {Uint8Array} s.nonce      32-byte nonce
 * @param {string} s.recipient      domain/account the user was shown
 * @param {string} [s.callbackUrl]
 * @param {string} s.accountId      claimed signer account
 * @param {string} s.publicKey      "ed25519:<base58>"
 * @param {string} s.signature      base64 signature
 * @returns {{ok:boolean, code:string, hashHex?:string, detail?:string}}
 */
export function verifyNep413SignedMessage({ message, nonce, recipient, callbackUrl, accountId, publicKey, signature }) {
  try {
    if (typeof accountId !== 'string' || accountId.length === 0) {
      return { ok: false, code: 'MISSING_ACCOUNT' };
    }
    const { keyType, bytes } = parseNearPublicKey(publicKey);
    if (bytes.length !== 32) return { ok: false, code: 'BAD_PUBLIC_KEY' };
    // Fail closed on a key type we do not verify. A secp256k1 label over
    // ed25519 bytes must never ``VERIFIED`` as if it were ed25519 (reviewed).
    if (keyType !== 'ed25519') {
      return { ok: false, code: 'UNSUPPORTED_KEY_TYPE', detail: `only ed25519 is verified here; got '${keyType}' (use the SDK for secp256k1)` };
    }
    const payload = buildNep413Payload({ message, nonce, recipient, callbackUrl });
    const hash = nep413Hash(payload);
    const sig = Buffer.from(signature, 'base64');
    if (sig.length !== 64) return { ok: false, code: 'BAD_SIGNATURE_LENGTH' };
    const key = ed25519PublicKeyFromBytes(bytes);
    const ok = verify(null, hash, key, sig);
    return { ok, code: ok ? 'VERIFIED' : 'SIGNATURE_MISMATCH', hashHex: hash.toString('hex') };
  } catch (e) {
    return { ok: false, code: 'INVALID_INPUT', detail: String(e && e.message ? e.message : e) };
  }
}

/**
 * Generate an ed25519 fixture keypair. LOCAL CRYPTOGRAPHY FIXTURE — never a
 * wallet login proof. Exposes the private key so a fixture can sign a chosen
 * (e.g. canonical) message; do not use outside fixture code.
 */
export function makeLocalFixtureKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ type: 'spki', format: 'der' });
  // Ed25519 SPKI is a fixed 12-byte header + 32-byte key.
  const pubBytes = rawPub.subarray(rawPub.length - 32);
  // NEAR implicit account id == hex(public key).
  const accountId = Buffer.from(pubBytes).toString('hex');
  return {
    accountId,
    publicKey: `ed25519:${base58Encode(pubBytes)}`,
    publicKeyBytes: pubBytes,
    privateKey,
  };
}

/** Sign a NEP-413 payload with a fixture ed25519 private key. Returns base64. */
export function signNep413ForFixtures(privateKey, { message, nonce, recipient, callbackUrl }) {
  const payload = buildNep413Payload({ message, nonce, recipient, callbackUrl });
  const hash = nep413Hash(payload);
  const sig = sign(null, hash, privateKey);
  return sig.toString('base64');
}

/**
 * Generate an ed25519 fixture keypair and sign a NEP-413 challenge locally.
 * Clearly labeled LOCAL CRYPTOGRAPHY FIXTURE — never a wallet login proof.
 *
 * @param {object} c
 * @param {string} c.message
 * @param {Uint8Array} c.nonce
 * @param {string} c.recipient
 * @param {string} [c.callbackUrl]
 * @returns {{accountId:string, publicKey:string, signature:string, signer:{publicKey:Uint8Array, keyType:string}}}
 */
export function makeLocalFixtureSignature({ message, nonce, recipient, callbackUrl }) {
  const kp = makeLocalFixtureKeypair();
  return {
    accountId: kp.accountId,
    publicKey: kp.publicKey,
    signature: signNep413ForFixtures(kp.privateKey, { message, nonce, recipient, callbackUrl }),
    signer: { publicKey: kp.publicKeyBytes, keyType: 'ed25519' },
  };
}

/** Deterministic helpers for fixture nonces; keep fixtures reproducible. */
export function nonceOf(seed) {
  const bytes = Buffer.alloc(32);
  const h = createHash('sha256').update(String(seed)).digest();
  bytes.set(h.subarray(0, 32));
  return bytes;
}

/** Borsh tag bytes helper (exposed for documentation/tests). */
export function nep413TagBytes() {
  return borshU32(NEP413_TAG);
}