// Exact atomic u128 amounts — oracle-local implementation.
//
// Independent of the read-only packages/domain reference (a differential test
// compares the two classifications; neither is treated as the other's source).
//
// Sources:
//  - docs/planning/showstake-v2/03-DATABASE.md: "PostgreSQL exact numeric
//    atomic_amount is limited to u128".
//  - docs/planning/showstake-v2/schema.sql: CHECK(VALUE = trunc(VALUE) AND
//    VALUE >= 0 AND VALUE <= 340282366920938463463374607431768211455).
//  - docs/planning/showstake-v2/02-ARCHITECTURE.md: "JSON money strings".
//  - docs/planning/showstake-v2/05-EXECUTION-AND-TESTS.md D05: float/overflow/
//    negative atomic values rejected.

import { CODES, fail } from './errors.mjs';

/** 2^128 - 1 */
export const U128_MAX = (1n << 128n) - 1n;
/** decimal form, kept as a string so JSON/CLI output never becomes a JS number */
export const U128_MAX_STRING = '340282366920938463463374607431768211455';
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;

/**
 * Parse an EXTERNAL atomic amount. Only canonical base-10 strings are accepted:
 * no sign, no whitespace, no leading zeros, no fraction/exponent, no separators
 * and no JS number (JSON money is a string).
 *
 * @param {unknown} value
 * @returns {bigint|null} null when not a canonical u128 string
 */
export function parseCanonicalAtomic(value) {
  if (typeof value !== 'string') return null;
  if (!CANONICAL_DECIMAL.test(value)) return null;
  const n = BigInt(value);
  if (n > U128_MAX) return null;
  return n;
}

/** @param {unknown} value @returns {boolean} */
export function isCanonicalAtomic(value) {
  return parseCanonicalAtomic(value) !== null;
}

/**
 * Internal helper: accept a bigint already inside u128, or a canonical string.
 * Public/external APIs use assertCanonicalAtomic; internal arithmetic may pass
 * bigints directly.
 *
 * @param {string|bigint} value
 * @param {string} [label]
 * @returns {bigint}
 */
export function assertAtomic(value, label = 'amount') {
  if (typeof value === 'bigint') {
    if (value < 0n || value > U128_MAX) {
      fail(CODES.AMOUNT_OUT_OF_RANGE, `${label} is outside u128`, { label, value: value.toString() });
    }
    return value;
  }
  const n = parseCanonicalAtomic(value);
  if (n === null) {
    fail(CODES.AMOUNT_INVALID, `${label} must be a canonical u128 base-10 string`, {
      label,
      value: typeof value === 'string' ? value : String(value),
      valueType: typeof value,
    });
  }
  return n;
}

/**
 * Validate an externally supplied amount. Rejects zero as well, for values the
 * packet requires to be strictly positive (event deposit D).
 *
 * @param {unknown} value
 * @param {string} [label]
 * @returns {bigint}
 */
export function assertPositiveCanonicalAtomic(value, label = 'amount') {
  const n = assertAtomic(value, label);
  if (n === 0n) fail(CODES.AMOUNT_ZERO, `${label} must be > 0`, { label });
  return n;
}

/** Canonical base-10 string for a bigint/string atomic value. */
export function toAtomicString(value) {
  return assertAtomic(value).toString();
}

/** Checked u128 addition. */
export function checkedAdd(a, b, label = 'sum') {
  const na = assertAtomic(a, `${label}.a`);
  const nb = assertAtomic(b, `${label}.b`);
  const sum = na + nb;
  if (sum > U128_MAX) {
    fail(CODES.ATOMIC_OVERFLOW, `${label} overflows u128`, {
      label,
      a: na.toString(),
      b: nb.toString(),
      sum: sum.toString(),
      max: U128_MAX_STRING,
    });
  }
  return sum;
}

/** Checked u128 multiplication; `a` must be a non-negative safe integer count. */
export function checkedMul(count, amount, label = 'product') {
  if (!Number.isSafeInteger(count) || count < 0) {
    fail(CODES.AMOUNT_INVALID, `${label} count must be a non-negative safe integer`, { label, count });
  }
  const na = assertAtomic(amount, `${label}.amount`);
  const product = BigInt(count) * na;
  if (product > U128_MAX) {
    fail(CODES.ATOMIC_OVERFLOW, `${label} overflows u128`, {
      label,
      count,
      amount: na.toString(),
      product: product.toString(),
      max: U128_MAX_STRING,
    });
  }
  return product;
}

/** Checked subtraction that never goes negative. */
export function checkedSub(a, b, label = 'difference') {
  const na = assertAtomic(a, `${label}.a`);
  const nb = assertAtomic(b, `${label}.b`);
  if (nb > na) {
    fail(CODES.CONSERVATION_BROKEN, `${label} would go negative`, {
      label,
      a: na.toString(),
      b: nb.toString(),
    });
  }
  return na - nb;
}
