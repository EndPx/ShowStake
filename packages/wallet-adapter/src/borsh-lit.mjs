// Minimal Borsh encoder for exactly the NEP-413 payload shapes. Zero-dependency.
// Borsh spec: little-endian integers, u32 length-prefixed vectors/strings,
// fixed-size arrays have no length prefix, Option<T> = 0x00 (None) | 0x01 + T.
// Scope limited on purpose; not a general Borsh implementation.

/** @param {number|bigint} n @returns {Buffer} u32 little-endian (4 bytes) */
export function borshU32(n) {
  const v = BigInt(n);
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(Number(v & 0xffffffffn), 0);
  return buf;
}

/** @param {string} s @returns {Buffer} u32 len prefix + utf8 bytes */
export function borshString(s) {
  const bytes = Buffer.from(String(s), 'utf8');
  return Buffer.concat([borshU32(bytes.length), bytes]);
}

/** @param {Uint8Array} bytes @returns {Buffer} raw fixed bytes (no length prefix) */
export function borshFixedBytes(bytes) {
  return Buffer.from(bytes);
}

/** @param {string|undefined|null} s @returns {Buffer} Option<string> */
export function borshOptionString(s) {
  if (s == null) return Buffer.from([0]);
  return Buffer.concat([Buffer.from([1]), borshString(s)]);
}

/**
 * Build the canonical NEP-413 payload bytes (see NEP-413 and the NEP's shipped
 * reference at gagdiez/near-login wallet.ts):
 *   u32 tag(2^31+413) + string message + [u8;32] nonce + string recipient + Option<string> callbackUrl
 *
 * @param {object} p
 * @param {string} p.message
 * @param {Uint8Array} p.nonce  (32 bytes)
 * @param {string} p.recipient
 * @param {string} [p.callbackUrl]
 * @returns {Buffer}
 */
export function buildNep413Payload({ message, nonce, recipient, callbackUrl }) {
  if (!(nonce instanceof Uint8Array) || nonce.length !== 32) {
    throw new Error('NEP-413 nonce must be exactly 32 bytes');
  }
  return Buffer.concat([
    borshU32(0x80000000n + 413n), // 2^31 + 413 = 2147484061
    borshString(message),
    borshFixedBytes(nonce),
    borshString(recipient),
    borshOptionString(callbackUrl),
  ]);
}