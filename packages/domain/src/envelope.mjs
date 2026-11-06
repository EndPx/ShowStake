// Typed API envelope + money-string helpers.
//
// The /v1 contract in docs/planning/showstake-v2/02-ARCHITECTURE.md requires every
// response to be `{data, meta, error}` and every money amount to be a canonical
// unsigned-128 base-10 string (never a JS float). This module is the single,
// dependency-free enforcement point for both, shared by API/worker/web.

import { isAtomic, assertAtomic } from './atomic.mjs';

/**
 * Canonical money representation at the JSON / OpenAPI boundary: a base-10
 * string of an unsigned 128-bit integer ("5000000"), and ONLY a string.
 * `isMoneyString` is the predicate used by the OpenAPI `Money` schema
 * (`type: string, pattern: ^(0|[1-9][0-9]*)$`). Bigints are legal for internal
 * arithmetic (atomic.mjs) but are NOT a JSON money value, so they are rejected
 * here.
 *
 * @param {*} v @returns {boolean}
 */
export function isMoneyString(v) {
  return typeof v === 'string' && isAtomic(v);
}

/**
 * Assert the JSON-boundary money form and return the exact bigint. Rejects
 * bigint, JS numbers, fractions, signs, leading zeros and > 2^128-1.
 *
 * @param {*} v
 * @param {string} [label]
 * @returns {bigint} the exact bigint, throwing on any non-canonical input
 */
export function assertMoneyString(v, label = 'money') {
  if (typeof v !== 'string' || !isAtomic(v)) {
    const shown = typeof v === 'bigint' ? `${v}n (bigint)` : String(v);
    throw new TypeError(`${label} must be a canonical u128 base-10 string at the JSON boundary, got ${shown}`);
  }
  return assertAtomic(v, label);
}

/**
 * Response envelope shape from 02-ARCHITECTURE.md.
 *
 * @param {object} p
 * @param {*} [p.data]
 * @param {object} [p.meta] {requestId, observedAt, network, stale}
 * @param {{code:string,message:string,retryable?:boolean}|null} [p.error]
 * @returns {{data:*, meta:object, error:object|null}}
 */
export function envelope({ data = null, meta = {}, error = null } = {}) {
  const m = {
    requestId: meta?.requestId ?? null,
    observedAt: meta?.observedAt ?? new Date().toISOString(),
    network: meta?.network ?? null,
    stale: meta?.stale ?? false,
  };
  const e = error
    ? { code: String(error.code ?? 'ERROR'), message: String(error.message ?? ''), retryable: Boolean(error.retryable) }
    : null;
  return { data, meta: m, error: e };
}

/** Success envelope shortcut. */
export function okEnvelope(data, meta = {}) {
  return envelope({ data, meta });
}

/** Error envelope shortcut (retryable is explicit, never guessed). */
export function errEnvelope(code, message, { retryable = false, meta = {} } = {}) {
  return envelope({ data: null, meta, error: { code, message, retryable } });
}

/** true when the value is a valid ShowStake API envelope object. */
export function isEnvelope(v) {
  return (
    v !== null && typeof v === 'object' &&
    'data' in v && 'meta' in v && 'error' in v &&
    (v.meta === null || typeof v.meta === 'object')
  );
}

/**
 * Opaque-cursor pagination defaults from 02-ARCHITECTURE.md (default 50, max 100).
 * Accepts and clamps a caller `limit`; returns never-below-1 and never-above-max.
 *
 * @param {number} [limit]
 * @returns {number}
 */
export function paginationLimit(limit) {
  const MAX = 100;
  const DEFAULT = 50;
  if (limit === undefined || limit === null) return DEFAULT;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) return DEFAULT;
  return Math.min(Math.floor(limit), MAX);
}