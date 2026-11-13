// Exact atomic-money presentation. Replaces CommitPass's `viem` `formatUnits`
// (EVM) with a dependency-free formatter over the canonical unsigned-128
// base-10 string shape from packages/domain (never a JS float). Unknown or
// invalid amounts render "Unavailable", never "0".

/** 2^128 - 1: the largest canonical u128, as an exact base-10 string. */
const U128_MAX_STR = "340282366920938463463374607431768211455";
const U128_DIGITS = U128_MAX_STR.length; // 39

/** Canonical u128 base-10 amount string (same predicate as packages/domain). */
export function isAtomicString(value: unknown): value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    return false;
  }
  // Reject overflow: u128 holds at most 39 decimal digits, and a 39-digit
  // string must not exceed 2^128 - 1 (equal-length digit strings compare
  // numerically). Exactness is preserved by string comparison, never a float.
  if (value.length > U128_DIGITS) return false;
  if (value.length === U128_DIGITS && value > U128_MAX_STR) return false;
  return true;
}

/**
 * Format a canonical decimal amount from `units` (atomic integer string) and
 * asset `decimals`. Returns "Unavailable" when the input is not a canonical
 * u128 string, `decimals` is missing or out of range, or the value overflows
 * u128 — never a fabricated value. Trailing fractional zeros are trimmed; whole
 * amounts render without a point. Arithmetic is exact string padding, never a
 * JS float.
 */
export function formatUnits(units: string, decimals?: number, symbol?: string): string {
  if (!isAtomicString(units)) return "Unavailable";
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    return "Unavailable";
  }
  if (decimals === 0) return symbol ? `${units} ${symbol}` : units;

  const padded = units.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals) || "0";
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  const core = frac ? `${whole}.${frac}` : whole;
  return symbol ? `${core} ${symbol}` : core;
}

/** Alias keeping call sites readable; identical behavior to formatUnits. */
export const formatAtomic = formatUnits;

/** Whole-and-fraction split for an atomic amount; both null when unavailable. */
export function splitAtomic(units: string, decimals?: number): { whole: string; fraction: string } | null {
  if (!isAtomicString(units) || typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    return null;
  }
  const padded = units.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals) || "0";
  const fraction = padded.slice(padded.length - decimals);
  return { whole, fraction };
}/** Parse a human decimal into exact canonical atomic units, or null if invalid. */
export function parseUnits(value:string,decimals:number):string|null {
  if(!Number.isInteger(decimals)||decimals<0||decimals>77||! /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value))return null;
  const [whole,fraction=""]=value.split(".");if(fraction.length>decimals)return null;
  const atomic=(whole!+fraction.padEnd(decimals,"0")).replace(/^0+(?=\d)/,"");return isAtomicString(atomic)?atomic:null;
}
