// Exact atomic amounts.
//
// NEAR FT amounts and the ShowStake `atomic_amount` database column are unsigned
// 128-bit integers serialized as canonical base-10 strings ("5000000"), never
// floats and never JS numbers. This module is the single enforcement point for
// that invariant across wallet/intents probes and future API/worker code.
//
// Matching evidence: docs/planning/showstake-v2/schema.sql atomic_amount domain
// (0 .. 2^128-1 integer) and NEP-141/NEP-145 (u128 base-10 string amounts).

/** 2^128 - 1 (the maximum unsigned 128-bit integer). */
export const U128_MAX = (1n << 128n) - 1n;

/**
 * Parse a canonical u128 amount. Accepts a base-10 string or a bigint. Returns
 * the bigint, or `null` when the value is not a canonical u128 (negative, empty,
 * non-integer, leading zeros, or > 2^128-1).
 *
 * @param {string|bigint} value
 * @returns {bigint|null}
 */
export function parseAtomic(value) {
  let s;
  if (typeof value === 'bigint') {
    if (value < 0n || value > U128_MAX) return null;
    return value;
  }
  if (typeof value !== 'string') return null;
  s = value;
  // Canonical form: /^0$/ or /^[1-9][0-9]*$/ (no leading zeros, no sign, no fraction).
  if (!/^(0|[1-9][0-9]*)$/.test(s)) return null;
  const n = BigInt(s);
  if (n > U128_MAX) return null;
  return n;
}

/** @param {string|bigint} value @returns {boolean} */
export function isAtomic(value) {
  return parseAtomic(value) !== null;
}

/**
 * Enforce a canonical u128 amount; throws a TypeError with a precise message on
 * failure. Use at every trust boundary before amounts flow into logic.
 *
 * @param {string|bigint} value
 * @param {string} [label]
 * @returns {bigint}
 */
export function assertAtomic(value, label = 'amount') {
  const n = parseAtomic(value);
  if (n === null) {
    throw new TypeError(`${label} must be a canonical u128 base-10 string (0..18446744073709551615 style), got ${String(value)}`);
  }
  return n;
}

/** Canonical base-10 string form of an atomic amount. */
export function toAtomicString(value) {
  return assertAtomic(value).toString();
}

/** true when the value is a strictly positive atomic amount (> 0). */
export function isPositiveAtomic(value) {
  const n = parseAtomic(value);
  return n !== null && n > 0n;
}

/** Return `null` when parts, else a fixed error code — a typed exact-amount check. */
export function requiredPositiveAmount(value, label = 'amount') {
  const n = parseAtomic(value);
  if (n === null) return { code: 'AMOUNT_INVALID', label, value: String(value) };
  if (n === 0n) return { code: 'AMOUNT_ZERO', label, value: String(value) };
  return null;
}

/** Subtract two exact amounts; returns null on underflow (keeps money lossless). */
export function atomicSub(a, b) {
  const na = assertAtomic(a, 'atomicSub.a');
  const nb = assertAtomic(b, 'atomicSub.b');
  if (nb > na) return null;
  return (na - nb).toString();
}

/** Add two exact amounts; returns null on u128 overflow. */
export function atomicAdd(a, b) {
  const na = assertAtomic(a, 'atomicAdd.a');
  const nb = assertAtomic(b, 'atomicAdd.b');
  const sum = na + nb;
  if (sum > U128_MAX) return null;
  return sum.toString();
}