// Deployment/token identity helpers. Fail-closed: a mismatch throws so the
// worker refuses to ingest rather than projecting against an unverified code or
// token identity.
import type { DeploymentAllowlist } from './config.js';

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = new Map<string, number>(B58_ALPHABET.split('').map((c, i) => [c, i]));

/** Decode a Bitcoin base58 string to bytes (preserves leading-zero bytes). */
export function base58Decode(s: string): Uint8Array {
  if (typeof s !== 'string' || s.length === 0) throw new Error('empty base58 string');
  let zeroes = 0;
  while (zeroes < s.length && s[zeroes] === '1') zeroes++;
  const bytes: number[] = [0];
  for (let i = zeroes; i < s.length; i++) {
    const digit = B58_MAP.get(s[i]!);
    if (digit === undefined) throw new Error(`invalid base58 character: ${s[i]}`);
    let carry = digit;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < zeroes; i++) bytes.push(0);
  bytes.reverse();
  return new Uint8Array(bytes);
}

/** Lowercase hex of a byte array. */
export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/**
 * Verify the allowlisted base58 code hash decodes to the expected wasm sha256,
 * so a deployed code identity is pinned twice (RPC `code_hash` and hex sha256).
 */
export function verifyCodeIdentity(codeHash: string, wasmSha256: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(wasmSha256)) return false;
  try {
    return toHex(base58Decode(codeHash)) === wasmSha256.toLowerCase();
  } catch {
    return false;
  }
}

/** Assert the deployment allowlist is internally consistent (throws). */
export function assertAllowlistIdentity(d: DeploymentAllowlist): void {
  if (!verifyCodeIdentity(d.codeHash, d.wasmSha256)) {
    throw new Error(`code identity mismatch: code_hash ${d.codeHash} does not encode wasm_sha256 ${d.wasmSha256}`);
  }
}