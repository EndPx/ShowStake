// Minimal base58 (Bitcoin alphabet) codec for NEAR public keys ("ed25519:<b58>").
// Self-contained so the probe has zero runtime dependencies. The algorithm is a
// standard public-spec integer/base conversion; byte length prefixes are handled
// by leading zero bytes (base58 of leading 0x00 byte is "1").
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_MAP = new Map([...ALPHABET].map((c, i) => [c, i]));

/** @param {Uint8Array} bytes @returns {string} */
export function base58Encode(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros += 1;
  const digits = [0];
  for (let i = zeros; i < buf.length; i += 1) {
    let carry = buf[i];
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '1'.repeat(zeros);
  for (let k = digits.length - 1; k >= 0; k -= 1) out += ALPHABET[digits[k]];
  return out;
}

/** @param {string} s @returns {Uint8Array} */
export function base58Decode(s) {
  if (typeof s !== 'string' || s.length === 0) throw new Error('base58: empty input');
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros += 1;
  const bytes = [0];
  for (let i = zeros; i < s.length; i += 1) {
    const val = ALPHABET_MAP.get(s[i]);
    if (val === undefined) throw new Error(`base58: invalid character '${s[i]}'`);
    let carry = val;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  out.set(bytes, zeros);
  // Bytes accumulate big-endian in the running array; reverse the non-zero part.
  const body = out.subarray(zeros);
  body.reverse();
  return out;
}