#!/usr/bin/env node
// Intents-adapter probe CLI.
//
//   node packages/intents-adapter/src/cli.mjs --offline   # local fixtures only (no network)
//   node packages/intents-adapter/src/cli.mjs             # local fixtures + public read-only catalog + dry-quote attempt
//
// Deterministic local checks are `scope:"local"` and FAIL THE PROCESS EXIT on any
// failed check regardless of label. Live provider attempts are read-only and
// never spend; a network/engine block records BLOCKED_EXTERNAL (scope:"external")
// and does NOT fail the local exit. No funded swap, no deployment, no wallet export.
//
// CLASSIFIER VOCABULARY (matches domain `CLASSIFIERS`): a record's `classifier`
// is one of PASS_LOCAL/PASS_TESTNET/PASS_LIVE/BLOCKED_EXTERNAL/FAILED/NOT_RUN.
// `TESTED_PROVIDER` is an EVIDENCE LEVEL (`level` field), NOT a PASS classifier.

import {
  validateTokenResponse, validateQuoteRequest, validateQuoteResponse,
  validateStatusResponse, assertQuoteIdentity, ONECLICK_BASE_URL, STATUSES,
  ONECLICK_ENDPOINT_AUTH,
} from './schema.mjs';
import { buildFtTransferCall, buildCommitMsg, preflightStorageSteps, FT_LIFECYCLE_NOTE } from './ft-transfer.mjs';
import { assertAtomic, isPositiveAtomic } from '../../domain/src/index.mjs';

const results = [];
function record(id, requirement, expected, observed, ok, classifier, opts = {}) {
  const { level = null, scope = 'local', limits = [] } = opts;
  results.push({ id, requirement, expected, observed, ok, classifier, level, scope, limits });
}
function fail(msg) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }

// --- FT deposit leg (NEP-141) ------------------------------------------------
{
  const call = buildFtTransferCall({
    ftContractId: 'ft.showstake.testnet', // placeholder, NOT a real token id
    escrowContractId: 'escrow.showstake.testnet',
    amount: '5000000',
    participantAccount: 'alice.testnet',
    eventId: 'evt-1',
    commitmentId: 'cmt-abc',
  });
  const msg = buildCommitMsg({ eventId: 'evt-1', commitmentId: 'cmt-abc' });
  record(
    'FT-TRANSFER-CALL',
    'C01: build exact NEP-141 ft_transfer_call to escrow (deposit leg)',
    'args.receiver_id=escrow; amount=5000000; 1 yocto attached',
    `method=${call.method} receiver_id=${call.args.receiver_id} amount=${call.args.amount} msg=${msg}`,
    call.args.receiver_id === 'escrow.showstake.testnet' && call.args.amount === '5000000' && call.attachedDepositYocto === '1',
    'PASS_LOCAL',
    { limits: ['placeholders never treated as real token/contract ids; no broadcast'] },
  );

  let amountRejected = false;
  try { buildFtTransferCall({ ftContractId: 'ft', escrowContractId: 'esc', amount: '5.5', participantAccount: 'a', eventId: 'e', commitmentId: 'c' }); }
  catch { amountRejected = true; }
  record(
    'FT-AMOUNT-EXACT',
    'D05: non-integer deposit amount rejected at the builder boundary',
    'TypeError for amount "5.5"',
    `rejected=${amountRejected}`,
    amountRejected === true,
    'PASS_LOCAL',
    { limits: ['builder-level only'] },
  );

  const pre = preflightStorageSteps({ ftContractId: 'ft.showstake.testnet', escrowContractId: 'escrow.showstake.testnet', participantAccount: 'alice.testnet' });
  record(
    'FT-STORAGE-PREFLIGHT',
    'G06: NEP-145 storage preflight order documented (not executed)',
    '5 ordered steps (participant + escrow FT registration, escrow storage)',
    `steps=${pre.steps.length}`,
    pre.steps.length === 5,
    'PASS_LOCAL',
    { limits: ['documentation only; no storage_deposit executed'] },
  );
}

// --- 1Click quote schema (local) --------------------------------------------
const validQuoteRequest = {
  dry: true, swapType: 'EXACT_INPUT', slippageTolerance: 100,
  originAsset: 'nep141:wrap.near', depositType: 'INTENTS',
  destinationAsset: 'nep141:eth.bridge.near', amount: '1000',
  refundTo: 'alice.testnet', refundType: 'INTENTS', recipient: 'alice.testnet',
  recipientType: 'DESTINATION_CHAIN', deadline: new Date(Date.now() + 3600_000).toISOString(),
};
{
  const vr = validateQuoteRequest(validQuoteRequest);
  record('QUOTE-REQUEST-VALID', 'G04: validate a dry QuoteRequest', 'ok:true', `ok=${vr.ok} errors=${JSON.stringify(vr.errors)}`, vr.ok === true, 'PASS_LOCAL', { limits: ['local schema; authoritative = OpenAPI note: asset ids here are REAL catalog ids, not placeholders'] });
}

{
  const quoteResponse = {
    correlationId: 'c1', timestamp: new Date().toISOString(), signature: '0xabc',
    quoteRequest: validQuoteRequest,
    quote: {
      amountIn: '1000', minAmountIn: '995', amountOut: '9950', minAmountOut: '9900',
      timeEstimate: 120, depositAddress: 'evil-near-placeholder', deadline: validQuoteRequest.deadline, timeWhenInactive: validQuoteRequest.deadline,
    },
    // depositAddress/deadline/timeWhenInactive must be absent for dry:true
  };
  const vr = validateQuoteResponse(quoteResponse);
  record(
    'QUOTE-DRY-FIELD-GUARD',
    'P03: dry quote must not carry a deposit address/deadline',
    'ok:false with DRY_FIELD error',
    `ok=${vr.ok} codes=${vr.errors.map((e) => e.code).join(',')}`,
    vr.ok === false && vr.errors.some((e) => e.code === 'DRY_FIELD'),
    'PASS_LOCAL',
    { limits: ['local schema'] },
  );
}

{
  // Changed quote identity: the returned quote no longer matches the approved
  // attempt (full binding: attempt id, assets, type, exact+min amounts, recipient,
  // refund, expiry, controlling account).
  const base = {
    correlationId: 'att-1',
    originAsset: 'nep141:wrap.near', destinationAsset: 'nep141:eth.bridge.near',
    swapType: 'EXACT_INPUT',
    amountIn: '1000', minAmountIn: '995', amountOut: '9950', minAmountOut: '9900',
    recipient: 'alice.testnet', refundTo: 'alice.testnet',
    deadline: new Date(Date.now() + 3600_000).toISOString(),
    accountId: 'alice.testnet',
  };
  const tampered = { ...base, amountIn: '5000' };
  const r = assertQuoteIdentity(tampered, base);
  record(
    'QUOTE-CHANGED-IDENTITY',
    'P03: changed quote identity rejected (attempt/assets/type/min/recipient/refund/expiry/account all bound)',
    'ok:false code=CHANGED_QUOTE_IDENTITY',
    `ok=${r.ok} code=${r.code} mismatches=${r.mismatches.join(';')}`,
    r.ok === false && r.code === 'CHANGED_QUOTE_IDENTITY',
    'PASS_LOCAL',
    { limits: ['local fixture; no provider call'] },
  );
}

{
  // NaN/Infinity numeric fields must be rejected (review defect).
  const nanReq = { ...validQuoteRequest, slippageTolerance: NaN };
  const infPrice = validateTokenResponse({ assetId: 'nep141:x', decimals: 6, blockchain: 'near', symbol: 'X', price: Infinity, priceUpdatedAt: new Date().toISOString() });
  const vr = validateQuoteRequest(nanReq);
  record(
    'NUMERIC-NAN-INFINITY',
    'request validators reject NaN/Infinity numeric fields (slippage/price/timeEstimate)',
    'slippage NaN rejected; price Infinity rejected',
    `slippageNaN=${vr.errors.some((e) => e.path === 'slippageTolerance')} ; priceInf=${infPrice.errors.some((e) => e.path === 'price')}`,
    vr.ok === false && infPrice.ok === false,
    'PASS_LOCAL',
    { limits: ['local schema'] },
  );
}

{
  const statusFixture = {
    correlationId: 'c1',
    quoteResponse: { correlationId: 'c1', timestamp: new Date().toISOString(), signature: '0x1', quoteRequest: { ...validQuoteRequest, dry: false }, quote: { amountIn: '1000', minAmountIn: '995', amountOut: '9950', minAmountOut: '9900', timeEstimate: 120, depositAddress: 'nep141-placeholder', deadline: new Date(Date.now() + 3600_000).toISOString() } },
    status: 'SUCCESS', updatedAt: new Date().toISOString(), swapDetails: {},
  };
  const vr = validateStatusResponse(statusFixture);
  record(
    'STATUS-SCHEMA-VALID',
    'G08: validate execution-status envelope shape',
    'ok:true',
    `ok=${vr.ok} errors=${vr.errors.length}`,
    vr.ok === true,
    'PASS_LOCAL',
    { limits: ['status enum values from OpenAPI; not a real execution'] },
  );
}

// --- live read-only provider attempts (informational; never spend) -----------
const offline = process.argv.includes('--offline');

/** Sanitize a provider error body for evidence (no secrets are ever present, but keep bounded). */
function sanitizeBody(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  if (parsed) {
    if (Array.isArray(parsed.errors)) return JSON.stringify(parsed.errors.slice(0, 3));
    const { message, code, title, status, correlationId } = parsed;
    return JSON.stringify({ message, code, title, status, correlationId });
  }
  return text.slice(0, 300);
}

async function liveAttempts() {
  if (offline) {
    record('LIVE-CATALOG', 'G04/G10: public GET /v0/tokens', 'skipped (--offline)', 'skipped', true, 'NOT_RUN', { scope: 'external', limits: ['offline flag'] });
    record('LIVE-DRY-QUOTE', 'G04/G10: POST /v0/quote dry:true (auth required)', 'not attempted (--offline); auth is DOCUMENTED (OpenAPI security)', 'not attempted', true, 'NOT_RUN', { scope: 'external', limits: ['no X-API-Key/JWT; funded route gated'] });
    return;
  }

  // 1. Public catalog (documented NO security). Schema validation of EVERY entry
  //    is a LOCAL check: if the response is 200 but fails our schema, it FAILS.
  let catalogTokens = null;
  try {
    const startedAt = Date.now();
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(`${ONECLICK_BASE_URL}/v0/tokens`, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    clearTimeout(to);
    const text = await res.text();
    let parsed = null; try { parsed = JSON.parse(text); } catch { /* non-json */ }

    const isArray = Array.isArray(parsed);
    if (res.status === 200 && isArray && parsed.length > 0) {
      catalogTokens = parsed;
      const invalid = parsed.filter((t) => !validateTokenResponse(t).ok);
      const allValid = invalid.length === 0;
      record(
        'LIVE-CATALOG',
        'G04: verify current 1Click asset catalog schema via public GET /v0/tokens (documented NO auth)',
        'HTTP 200 + non-empty array + EVERY entry validates against TokenResponse',
        `HTTP ${res.status} (${Date.now() - startedAt}ms); items=${parsed.length}; invalid=${invalid.length}`,
        allValid,
        allValid ? 'PASS_LOCAL' : 'FAILED',
        { level: 'TESTED_PROVIDER', scope: 'local', limits: ['read-only provider response; schema validation affects verdict'] },
      );
      record('LIVE-CATALOG-SAMPLE', 'G04: catalog assetId examples', 'real nep141:... ids', JSON.stringify(parsed.slice(0, 3).map((t) => t.assetId)), true, 'PASS_LOCAL', { level: 'TESTED_PROVIDER', scope: 'local', limits: ['sample only, non-authoritative'] });
    } else {
      record(
        'LIVE-CATALOG',
        'G04: public GET /v0/tokens',
        'HTTP 200 + non-empty array',
        `HTTP ${res.status}; items=${isArray ? parsed.length : 'n/a'}`,
        false,
        'BLOCKED_EXTERNAL',
        { scope: 'external', limits: ['catalog unexpectedly unavailable/non-array from this sandbox'] },
      );
    }
  } catch (e) {
    record('LIVE-CATALOG', 'G04: public GET /v0/tokens', 'HTTP 200', `error: ${e && e.name}: ${e && e.message}`, false, 'BLOCKED_EXTERNAL', { scope: 'external', limits: ['network unavailable from this sandbox'] });
  }

  // 2. Dry quote. Auth is DOCUMENTED (OpenAPI `security: [X-API-Key] | [JWT-auth]`,
  //    401 = invalid key/JWT). We use REAL catalog asset ids (not placeholders) so
  //    a 400/other is a body/input signal, never evidence of the auth gate.
  const quoteAuth = ONECLICK_ENDPOINT_AUTH['POST /v0/quote'];
  if (!catalogTokens) {
    record('LIVE-DRY-QUOTE', 'G04/G10: POST /v0/quote dry:true', 'requires auth (documented); BLOCKED_EXTERNAL', 'not attempted (no catalog to source real asset ids)', true, 'BLOCKED_EXTERNAL', { scope: 'external', limits: [`auth documented: ${quoteAuth.security.join('|')}`] });
    return;
  }
  const pair = pickRealCatalogPair(catalogTokens);
  if (!pair) {
    record('LIVE-DRY-QUOTE', 'G04/G10: POST /v0/quote dry:true', 'requires auth (documented); BLOCKED_EXTERNAL', 'not attempted (no usable nep141: asset pair)', true, 'BLOCKED_EXTERNAL', { scope: 'external', limits: [`auth documented: ${quoteAuth.security.join('|')}`] });
    return;
  }
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 12000);
    const body = {
      dry: true, swapType: 'EXACT_INPUT', slippageTolerance: 100,
      originAsset: pair.originAsset, depositType: 'INTENTS',
      destinationAsset: pair.destinationAsset, amount: '1000000',
      refundTo: 'alice.testnet', refundType: 'INTENTS', recipient: 'alice.testnet',
      recipientType: 'DESTINATION_CHAIN', deadline: new Date(Date.now() + 3600_000).toISOString(),
    };
    const res = await fetch(`${ONECLICK_BASE_URL}/v0/quote`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    clearTimeout(to);
    const text = await res.text();
    const sanitized = sanitizeBody(text);
    const authNoted = `auth is DOCUMENTED (OpenAPI security ${quoteAuth.security.join('|')}; 401 = invalid key/JWT), NOT inferred from this status`;
    record(
      'LIVE-DRY-QUOTE',
      'G04/G10: POST /v0/quote dry:true with REAL catalog asset ids, no auth',
      'requires X-API-Key/JWT (documented) -> endpoint unresolved without auth; 401 is the documented auth status, 400 is documented invalid-input',
      `HTTP ${res.status}; origin=${pair.originAsset} dest=${pair.destinationAsset}; body=${sanitized} | ${authNoted}`,
      true,
      'BLOCKED_EXTERNAL',
      { scope: 'external', limits: ['dry quote never spends; funded route gated; auth documented, not inferred from the 400/401 status'] },
    );
  } catch (e) {
    record('LIVE-DRY-QUOTE', 'G04/G10: POST /v0/quote dry:true', `requires auth (documented ${quoteAuth.security.join('|')})`, `error: ${e && e.name}: ${e && e.message}`, true, 'BLOCKED_EXTERNAL', { scope: 'external', limits: ['network unavailable; auth documented'] });
  }
}

function pickRealCatalogPair(tokens) {
  const nepars = tokens.filter((t) => typeof t?.assetId === 'string' && t.assetId.startsWith('nep141:'))
    .map((t) => t.assetId);
  if (nepars.length >= 2) return { originAsset: nepars[0], destinationAsset: nepars[1] };
  const any = tokens.filter((t) => typeof t?.assetId === 'string').map((t) => t.assetId);
  return any.length >= 2 ? { originAsset: any[0], destinationAsset: any[1] } : null;
}

await liveAttempts();

// --- print ---------------------------------------------------------------
console.log(JSON.stringify({
  base_url: ONECLICK_BASE_URL,
  statuses: STATUSES,
  quote_endpoint_auth: quoteAuthSafe(),
  ft_lifecycle_note: FT_LIFECYCLE_NOTE,
  results,
  summary: {
    total: results.length,
    failedLocal: results.filter((r) => r.scope === 'local' && !r.ok).length,
    externalBlocked: results.filter((r) => r.scope === 'external' && (r.classifier === 'BLOCKED_EXTERNAL' || r.classifier === 'NOT_RUN')).length,
  },
}, null, 2));

function quoteAuthSafe() {
  return ONECLICK_ENDPOINT_AUTH['POST /v0/quote'];
}

// A failed LOCAL check (schema/builder/validation) fails the process exit,
// regardless of its classifier. External provider blocks do NOT.
const localFails = results.filter((r) => r.scope === 'local' && !r.ok);
if (localFails.length > 0) fail(`${localFails.length} local check(s) failed: ${localFails.map((r) => r.id).join(', ')}`);

const catalog = results.find((r) => r.id === 'LIVE-CATALOG');
if (catalog && catalog.classifier === 'PASS_LOCAL') {
  console.log('1CLICK CATALOG: PASS_LOCAL (read-only, schema-validated, level=TESTED_PROVIDER).');
} else if (catalog && catalog.classifier === 'FAILED') {
  console.log('1CLICK CATALOG: FAILED (provider returned 200 but schema validation failed).');
} else {
  console.log('1CLICK CATALOG: live path BLOCKED_EXTERNAL (no auth/network).');
}
console.log('1CLICK DRY QUOTE: auth required by DOCUMENTED OpenAPI security (X-API-Key|JWT-auth); BLOCKED_EXTERNAL without auth. Status/body captured above — never treated as auth proof on its own.');
console.log('INEPTS-ADAPTER local fixtures done; funded route is NOT resolved by a public quote.');