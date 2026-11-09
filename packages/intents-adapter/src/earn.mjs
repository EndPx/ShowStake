import { isPositiveAtomic } from '../../domain/src/index.mjs';
import { assertQuoteIdentity, validateQuoteRequest, validateQuoteResponse } from './schema.mjs';

// Asset ids are resolved from GET /v0/tokens; they are never synthesized from a ticker.
const SWAP_TYPES = new Set(['EXACT_INPUT', 'EXACT_OUTPUT', 'FLEX_INPUT', 'ANY_INPUT']);
const DELIVERY_TYPES = new Set(['DESTINATION_CHAIN', 'INTENTS', 'CONFIDENTIAL_INTENTS']);
const REFUND_TYPES = new Set(['ORIGIN_CHAIN', 'INTENTS', 'CONFIDENTIAL_INTENTS']);
const required = (v, name) => { if (typeof v !== 'string' || v.length === 0) throw new TypeError(`${name} required`); };
const iso = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const entries = (catalog) => {
  if (!Array.isArray(catalog)) throw new TypeError('catalog must be an array from GET /v0/tokens');
  return catalog.filter((t) => t && typeof t === 'object' && typeof t.assetId === 'string');
};

/** Resolve the catalog's canonical native NEAR USDC entry. */
export function selectCanonicalNearUsdc(catalog) {
  const matches = entries(catalog).filter((t) => String(t.blockchain).toLowerCase() === 'near'
    && String(t.symbol).toUpperCase() === 'USDC' && t.decimals === 6);
  if (matches.length !== 1) throw new Error(matches.length === 0 ? 'CANONICAL_NEAR_USDC_UNAVAILABLE' : 'CANONICAL_NEAR_USDC_AMBIGUOUS');
  return Object.freeze({ ...matches[0] });
}

/** Select a receipt only when its exact asset id is present in the live catalog. */
export function selectReceiptToken(catalog, { assetId, blockchain, symbol } = {}) {
  required(assetId, 'receipt assetId');
  const matches = entries(catalog).filter((t) => t.assetId === assetId
    && (blockchain === undefined || String(t.blockchain).toLowerCase() === String(blockchain).toLowerCase())
    && (symbol === undefined || String(t.symbol).toUpperCase() === String(symbol).toUpperCase()));
  if (matches.length !== 1) throw new Error('UNSUPPORTED_RECEIPT_ASSET');
  const token = matches[0];
  return Object.freeze({ ...token, custodyBoundary: token.blockchain === 'near'
    ? 'NEAR_RECEIPT_POSITION_NOT_EVENT_ESCROW' : 'NON_NEAR_RECEIPT_POSITION_NOT_EVENT_ESCROW' });
}

function assertAsset(catalog, value, label) {
  required(value, label);
  if (catalog !== undefined && !entries(catalog).some((t) => t.assetId === value)) throw new Error(`UNSUPPORTED_${label.toUpperCase()}_ASSET`);
}
function assertAmount(value, label) {
  if (!isPositiveAtomic(value)) throw new TypeError(`${label} must be a positive canonical atomic string`);
}

/** Build a dry Earn deposit quote. No deposit address is requested or retained. */
export function buildEarnDepositQuote({ catalog, originAsset, receiptAsset, amount, recipient, recipientType = 'INTENTS', refundTo, refundType = 'ORIGIN_CHAIN', swapType = 'EXACT_INPUT', deadline }) {
  assertAsset(catalog, originAsset, 'originAsset');
  assertAsset(catalog, receiptAsset, 'receiptAsset');
  assertAmount(amount, 'amount');
  if (!DELIVERY_TYPES.has(recipientType)) throw new TypeError('recipientType invalid');
  required(recipient, 'recipient'); required(refundTo, 'refundTo');
  if (!REFUND_TYPES.has(refundType)) throw new TypeError('refundType invalid');
  if (!SWAP_TYPES.has(swapType)) throw new TypeError('swapType invalid');
  if (!iso(deadline)) throw new TypeError('deadline must be ISO');
  const quote = Object.freeze({ dry: true, swapType, slippageTolerance: 100, originAsset, destinationAsset: receiptAsset, amount,
    depositType: 'ORIGIN_CHAIN', recipient, recipientType, refundTo, refundType, deadline });
  const valid = validateQuoteRequest(quote);
  if (!valid.ok) throw new TypeError(`invalid Earn deposit quote: ${valid.errors.map((e) => e.message).join('; ')}`);
  return quote;
}

/** Build a dry reverse quote from receipt shares to the factory payout asset. */
export function buildFactoryYieldRedeemQuote({ catalog, receiptAsset, payoutAsset, shareAmount, factoryAccount, refundTo = factoryAccount, deadline }) {
  assertAsset(catalog, receiptAsset, 'receiptAsset');
  assertAsset(catalog, payoutAsset, 'payoutAsset');
  assertAmount(shareAmount, 'shareAmount');
  required(factoryAccount, 'factoryAccount'); required(refundTo, 'refundTo');
  if (!iso(deadline)) throw new TypeError('deadline must be ISO');
  const quote = Object.freeze({ dry: true, swapType: 'EXACT_INPUT', slippageTolerance: 100, originAsset: receiptAsset,
    destinationAsset: payoutAsset, amount: shareAmount, depositType: 'INTENTS', recipient: factoryAccount,
    recipientType: 'DESTINATION_CHAIN', refundTo, refundType: 'INTENTS', deadline });
  const valid = validateQuoteRequest(quote);
  if (!valid.ok) throw new TypeError(`invalid Earn redeem quote: ${valid.errors.map((e) => e.message).join('; ')}`);
  return quote;
}

/** Validate a provider quote for this dry-only boundary. */
export function validateDryEarnQuote(response, expected) {
  const valid = validateQuoteResponse(response);
  if (!valid.ok) return { ok: false, code: 'INVALID_QUOTE', errors: valid.errors };
  if (response.quoteRequest.dry !== true || response.quote.depositAddress !== undefined) return { ok: false, code: 'DRY_DEPOSIT_ADDRESS_FORBIDDEN' };
  if (Date.parse(response.quoteRequest.deadline) <= Date.now()) return { ok: false, code: 'QUOTE_EXPIRED' };
  const req = response.quoteRequest;
  const quote = response.quote;
  if (req.swapType === 'EXACT_INPUT' && String(quote.amountIn) !== String(req.amount)) return { ok: false, code: 'QUOTE_AMOUNT_MISMATCH' };
  const identityExpected = expected ?? {
    correlationId: response.correlationId, originAsset: req.originAsset, destinationAsset: req.destinationAsset,
    swapType: req.swapType, amountIn: quote.amountIn, minAmountIn: quote.minAmountIn, amountOut: quote.amountOut,
    minAmountOut: quote.minAmountOut, recipient: req.recipient, refundTo: req.refundTo, deadline: req.deadline,
  };
  return assertQuoteIdentity({ ...req, ...quote, correlationId: response.correlationId }, identityExpected);
}

/** Reduce provider statuses to the adapter's deliberately small state set. */
export function mapEarnStatus(status, { deadline, now = new Date() } = {}) {
  const expired = deadline !== undefined && (!iso(deadline) || Date.parse(deadline) <= new Date(now).getTime());
  if (expired) return { state: 'FAILED', code: 'QUOTE_EXPIRED' };
  if (typeof status !== 'string' || status.length === 0) return { state: 'FAILED', code: 'STATUS_MISSING' };
  if (status === 'PENDING_DEPOSIT' || status === 'KNOWN_DEPOSIT_TX' || status === 'INCOMPLETE_DEPOSIT') return { state: 'PENDING', providerStatus: status };
  if (status === 'PROCESSING') return { state: 'PROCESSING', providerStatus: status };
  if (status === 'SUCCESS') return { state: 'SUCCESS', providerStatus: status };
  if (status === 'REFUNDED') return { state: 'REFUNDED', providerStatus: status };
  return { state: 'FAILED', providerStatus: status, code: 'STATUS_FAILED' };
}

/** The only balance eligible for factory yield deployment is idle balance. */
export function buildFactoryYieldPlan({ idleAsset, receiptAsset, amount, factoryAccount, factoryContractId }) {
  required(idleAsset, 'idleAsset'); required(receiptAsset, 'receiptAsset'); required(factoryAccount, 'factoryAccount'); required(factoryContractId, 'factoryContractId');
  assertAmount(amount, 'amount');
  return Object.freeze({ source: Object.freeze({ account: factoryAccount, asset: idleAsset, amount, class: 'IDLE_FACTORY_BALANCE' }), earn: Object.freeze({ receiptAsset, custody: 'factory-controlled-yield-vault', broadcast: false, eventEscrowCustody: false }), redeem: Object.freeze({ destination: factoryAccount, principalAndYield: true, broadcast: false }), eventEscrowFundsExcluded: true });
}

export const createDryEarnClient = (catalog) => Object.freeze({
  catalog, selectCanonicalNearUsdc: () => selectCanonicalNearUsdc(catalog), selectReceiptToken: (criteria) => selectReceiptToken(catalog, criteria),
  buildDepositQuote: (args) => buildEarnDepositQuote({ ...args, catalog }), buildRedeemQuote: (args) => buildFactoryYieldRedeemQuote({ ...args, catalog }),
  validateQuote: validateDryEarnQuote, mapStatus: mapEarnStatus, dry: true, allowBroadcast: false,
});

// Descriptive aliases kept for callers that prefer resolver terminology.
export const resolveCanonicalNearUsdc = selectCanonicalNearUsdc;
export const resolveReceiptToken = selectReceiptToken;
