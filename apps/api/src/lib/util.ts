import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** 32-byte random challenge nonce. */
export function randomNonce(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

/** Hex (lowercase, 64 chars) of a 32-byte nonce. */
export function nonceToHex(nonce: Uint8Array): string {
  return Buffer.from(nonce).toString('hex');
}

/** Decode a 64-hex-char string back to 32 bytes, or null when malformed. */
export function hexToNonce(hex: string): Uint8Array | null {
  if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/i.test(hex)) return null;
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/** sha256 hex digest (used for nonce_hash and opaque session token_hash). */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Opaque random session token (returned to the client once; only its hash is stored). */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** true for a canonical UUID string. */
export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

/** random v4 UUID. */
export function newUuid(): string {
  return randomUUID();
}