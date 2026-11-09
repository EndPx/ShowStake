// Typed/validated NEAR Intents 1Click schemas.
//
// Schema source: the official OpenAPI spec published by NEAR Intents
// https://1click.chaindefuser.com/docs/v0/openapi.yaml (fetched 2026-11-06).
// These validators are a bounded interpretation for the ShowStake probes; the
// authoritative schema remains the OpenAPI doc and MUST be re-checked before
// freezing. Nothing here declares the API frozen.

import { isAtomic, isPositiveAtomic } from '../../domain/src/index.mjs';

export const ONECLICK_BASE_URL = 'https://1click.chaindefuser.com';

/**
 * Documented auth semantics per the official OpenAPI (fetched 2026-11-06 from
 * https://1click.chaindefuser.com/docs/v0/openapi.yaml):
 *   - GET /v0/tokens   -> NO security (public).
 *   - POST /v0/quote   -> security: [X-API-Key] OR [JWT-auth]; 401 = "API key or
 *                            JWT token is invalid"; 400 = "Bad Request - Invalid
 *                            input data".
 * The auth gate is therefore a DOCUMENTED fact (OpenAPI `security` field + 401
 * semantics), NOT something to be inferred from an observed 400/other status on
 * an unauthenticated request.
 */
export const ONECLICK_ENDPOINT_AUTH = Object.freeze({
  'GET /v0/tokens': { security: 'none', source: 'openapi paths./v0/tokens (no security key)' },
  'POST /v0/quote': { security: ['X-API-Key', 'JWT-auth'], source: 'openapi paths./v0/quote.security', unauthorizedStatus: 401 },
});

export const SWAP_TYPES = Object.freeze(['EXACT_INPUT', 'EXACT_OUTPUT', 'FLEX_INPUT', 'ANY_INPUT']);
export const DEPOSIT_TYPES = Object.freeze(['ORIGIN_CHAIN', 'INTENTS', 'CONFIDENTIAL_INTENTS']);
export const RECIPIENT_TYPES = Object.freeze(['DESTINATION_CHAIN', 'INTENTS', 'CONFIDENTIAL_INTENTS']);
export const REFUND_TYPES = Object.freeze(['ORIGIN_CHAIN', 'INTENTS', 'CONFIDENTIAL_INTENTS']);
export const STATUSES = Object.freeze([
  'KNOWN_DEPOSIT_TX', 'PENDING_DEPOSIT', 'INCOMPLETE_DEPOSIT', 'PROCESSING', 'SUCCESS', 'REFUNDED', 'FAILED',
]);

const inEnum = (v, e, path, errors) => {
  if (!e.includes(v)) errors.push({ path, code: 'ENUM', message: `${path} must be one of ${e.join('|')}` });
};
const isStr = (v, path, errors) => {
  if (typeof v !== 'string' || v.length === 0) errors.push({ path, code: 'STRING', message: `${path} must be a non-empty string` });
};
const isIso = (v, path, errors) => {
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) errors.push({ path, code: 'ISO', message: `${path} must be an ISO date-time` });
};
// Finite number guard: rejects NaN and +/-Infinity (which slip past typeof checks).
const isFiniteNumber = (v, path, errors, opts = {}) => {
  const bad = typeof v !== 'number' || !Number.isFinite(v) || (opts.integer && !Number.isInteger(v));
  if (bad) errors.push({ path, code: 'NUMBER', message: `${path} must be a finite${opts.integer ? ' integer' : ''} number` });
  else if (opts.min !== undefined && v < opts.min) errors.push({ path, code: 'NUMBER', message: `${path} must be >= ${opts.min}` });
};

/** Validate a supported-token catalog entry (GET /v0/tokens item). */
export function validateTokenResponse(t) {
  const errors = [];
  if (!t || typeof t !== 'object') return { ok: false, errors: [{ path: '$', code: 'OBJECT' }] };
  isStr(t.assetId, 'assetId', errors);
  if (typeof t.decimals !== 'number' || !Number.isInteger(t.decimals) || t.decimals < 0) {
    errors.push({ path: 'decimals', code: 'NUMBER', message: 'decimals must be a non-negative integer' });
  }
  isStr(t.blockchain, 'blockchain', errors);
  isStr(t.symbol, 'symbol', errors);
  isFiniteNumber(t.price, 'price', errors);
  isIso(t.priceUpdatedAt, 'priceUpdatedAt', errors);
  return { ok: errors.length === 0, errors };
}

/** Validate a dry/quote request object against the OpenAPI QuoteRequest. */
export function validateQuoteRequest(q) {
  const errors = [];
  if (!q || typeof q !== 'object') return { ok: false, errors: [{ path: '$', code: 'OBJECT' }] };
  if (typeof q.dry !== 'boolean') errors.push({ path: 'dry', code: 'BOOL', message: 'dry must be a boolean' });
  inEnum(q.swapType, SWAP_TYPES, 'swapType', errors);
  isFiniteNumber(q.slippageTolerance, 'slippageTolerance', errors, { min: 0 });
  isStr(q.originAsset, 'originAsset', errors);
  inEnum(q.depositType, DEPOSIT_TYPES, 'depositType', errors);
  isStr(q.destinationAsset, 'destinationAsset', errors);
  if (!isPositiveAtomic(q.amount)) errors.push({ path: 'amount', code: 'ATOMIC', message: 'amount must be a canonical positive u128 base-10 string' });
  isStr(q.refundTo, 'refundTo', errors);
  inEnum(q.refundType, REFUND_TYPES, 'refundType', errors);
  isStr(q.recipient, 'recipient', errors);
  inEnum(q.recipientType, RECIPIENT_TYPES, 'recipientType', errors);
  isIso(q.deadline, 'deadline', errors);
  return { ok: errors.length === 0, errors };
}

/** Validate a QuoteResponse envelope (POST /v0/quote 200 body). */
export function validateQuoteResponse(r) {
  const errors = [];
  if (!r || typeof r !== 'object') return { ok: false, errors: [{ path: '$', code: 'OBJECT' }] };
  isStr(r.correlationId, 'correlationId', errors);
  isIso(r.timestamp, 'timestamp', errors);
  isStr(r.signature, 'signature', errors);
  const qreq = validateQuoteRequest(r.quoteRequest);
  if (!qreq.ok) errors.push(...qreq.errors.map((e) => ({ ...e, path: `quoteRequest.${e.path}` })));
  const quote = r.quote;
  if (!quote || typeof quote !== 'object') {
    errors.push({ path: 'quote', code: 'OBJECT' });
  } else {
    for (const f of ['amountIn', 'minAmountIn', 'amountOut', 'minAmountOut']) {
      if (!isAtomic(quote[f])) errors.push({ path: `quote.${f}`, code: 'ATOMIC' });
    }
    isFiniteNumber(quote.timeEstimate, 'quote.timeEstimate', errors, { min: 0, integer: true });
    const dry = r.quoteRequest && r.quoteRequest.dry;
    if (dry === true) {
      for (const f of ['depositAddress', 'deadline', 'timeWhenInactive']) {
        if (quote[f] !== undefined) errors.push({ path: `quote.${f}`, code: 'DRY_FIELD', message: `${f} must be absent for dry quote` });
      }
    } else if (dry === false) {
      isStr(quote.depositAddress, 'quote.depositAddress', errors);
      isIso(quote.deadline, 'quote.deadline', errors);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Validate an execution-status response (GET /v0/status 200 body). */
export function validateStatusResponse(r) {
  const errors = [];
  if (!r || typeof r !== 'object') return { ok: false, errors: [{ path: '$', code: 'OBJECT' }] };
  isStr(r.correlationId, 'correlationId', errors);
  inEnum(r.status, STATUSES, 'status', errors);
  isIso(r.updatedAt, 'updatedAt', errors);
  const qr = validateQuoteResponse(r.quoteResponse);
  if (!qr.ok) errors.push(...qr.errors.map((e) => ({ ...e, path: `quoteResponse.${e.path}` })));
  if (!r.swapDetails || typeof r.swapDetails !== 'object') errors.push({ path: 'swapDetails', code: 'OBJECT' });
  return { ok: errors.length === 0, errors };
}

/**
 * Scalar identity fields a validated quote MUST bind. Includes attempt identity
 * (correlationId), asset pair + swap type, exact in/out amounts and their
 * minimums, recipient/refund, and expiry (deadline) — the review additions that
 * were previously omitted. accountId is a separate optional binding.
 */
export const QUOTE_IDENTITY_SCALAR_FIELDS = Object.freeze([
  'correlationId',   // attempt/quote identity
  'originAsset',
  'destinationAsset',
  'swapType',        // quote type (EXACT_INPUT/EXACT_OUTPUT/...)
  'amountIn',
  'minAmountIn',
  'amountOut',
  'minAmountOut',
  'recipient',
  'refundTo',
  'deadline',        // expiry
]);

/**
 * Binds a returned quote to the immutable funding-attempt identity it was issued
 * for. A quote whose identity fields changed after approval must never be used to
 * prompt a deposit (matches schema `funding_quotes.validated_payload` and the
 * P03 "quote validation binds assets/recipient/refund/deadline" requirement).
 *
 * Fail closed: any missing/extra/mismatched binding is a CHANGED_QUOTE_IDENTITY.
 *
 * @param {object} quote      provider quote response (or its .quote)
 * @param {object} expected   immutable attempt identity fields
 * @returns {{ok:boolean, code:string, mismatches:string[]}}
 */
export function assertQuoteIdentity(quote, expected) {
  const mismatches = [];
  const push = (f, got, want) => mismatches.push(`${f}: got=${String(got)} want=${String(want)}`);

  for (const f of QUOTE_IDENTITY_SCALAR_FIELDS) {
    const got = quote?.[f];
    const want = expected?.[f];
    if (got === undefined || got === null || want === undefined || want === null) {
      push(f, got, want);
    } else if (String(got) !== String(want)) {
      push(f, got, want);
    }
  }

  // Attempt/account binding: when the attempt pins the controlling account, the
  // quote must carry (or match) it; a mismatch blocks the deposit prompt.
  if (expected.accountId !== undefined) {
    if (quote?.accountId !== expected.accountId) push('accountId', quote?.accountId, expected.accountId);
  }

  // depositAddress: absent for a dry quote; if the identity pins one it must match,
  // else an unexpected address is a foreign-deposit hazard.
  if (expected.depositAddress !== undefined) {
    if (quote?.depositAddress !== expected.depositAddress) push('depositAddress', quote?.depositAddress, expected.depositAddress);
  } else if (quote?.depositAddress !== undefined) {
    push('depositAddress', quote?.depositAddress, '<absent for dry quote>');
  }

  return {
    ok: mismatches.length === 0,
    code: mismatches.length === 0 ? 'IDENTITY_OK' : 'CHANGED_QUOTE_IDENTITY',
    mismatches,
  };
}