import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectCanonicalNearUsdc,
  selectReceiptToken,
  buildEarnDepositQuote,
  validateDryEarnQuote,
  mapEarnStatus,
} from '../src/earn.mjs';

// Deliberately test-only catalog fixture; production resolves this id at runtime.
const TEST_FIXTURE_NEAR_USDC_ASSET_ID = 'nep141:test-native-usdc.near';
const catalog = [
  { assetId: TEST_FIXTURE_NEAR_USDC_ASSET_ID, blockchain: 'near', symbol: 'USDC', decimals: 6 },
  { assetId: 'nep141:rhea-usdc-receipt.near', blockchain: 'near', symbol: 'rUSDC', decimals: 6 },
  { assetId: 'nep141:base-rusdc.omft.near', blockchain: 'base', symbol: 'rUSDC', decimals: 6 },
];
const deadline = new Date(Date.now() + 60_000).toISOString();

test('selects canonical native NEAR USDC from catalog', () => {
  assert.equal(selectCanonicalNearUsdc(catalog).assetId, TEST_FIXTURE_NEAR_USDC_ASSET_ID);
});

test('rejects receipt asset absent from catalog', () => {
  assert.throws(() => selectReceiptToken(catalog, { assetId: 'nep141:missing' }), /UNSUPPORTED_RECEIPT_ASSET/);
});

test('dry quote identity change is rejected and dry address is forbidden', () => {
  const request = buildEarnDepositQuote({ catalog, originAsset: TEST_FIXTURE_NEAR_USDC_ASSET_ID, receiptAsset: catalog[1].assetId, amount: '1000000', recipient: 'factory.near', refundTo: 'factory.near', deadline });
  const response = { correlationId: 'c-1', timestamp: new Date().toISOString(), signature: 'sig', quoteRequest: request,
    quote: { amountIn: '1000000', minAmountIn: '1000000', amountOut: '990000', minAmountOut: '980000', timeEstimate: 1 } };
  const expected = { correlationId: 'c-1', originAsset: request.originAsset, destinationAsset: request.destinationAsset,
    swapType: request.swapType, amountIn: '1000000', minAmountIn: '1000000', amountOut: '990000', minAmountOut: '980000',
    recipient: request.recipient, refundTo: request.refundTo, deadline: request.deadline };
  assert.equal(validateDryEarnQuote(response, expected).ok, true);
  assert.equal(validateDryEarnQuote({ ...response, quote: { ...response.quote, depositAddress: 'must-not-exist' } }).code, 'INVALID_QUOTE');
  assert.equal(validateDryEarnQuote({ ...response, correlationId: 'c-2' }, expected).code, 'CHANGED_QUOTE_IDENTITY');
});

test('missing and expired statuses fail closed', () => {
  assert.deepEqual(mapEarnStatus(undefined), { state: 'FAILED', code: 'STATUS_MISSING' });
  assert.equal(mapEarnStatus('SUCCESS', { deadline: new Date(Date.now() - 1_000).toISOString() }).code, 'QUOTE_EXPIRED');
});

test('amount overflow and non-dry address are rejected', () => {
  assert.throws(() => buildEarnDepositQuote({ catalog, originAsset: TEST_FIXTURE_NEAR_USDC_ASSET_ID, receiptAsset: catalog[1].assetId, amount: '340282366920938463463374607431768211456', recipient: 'factory.near', refundTo: 'factory.near', deadline }), /positive canonical atomic/);
  const q = buildEarnDepositQuote({ catalog, originAsset: TEST_FIXTURE_NEAR_USDC_ASSET_ID, receiptAsset: catalog[1].assetId, amount: '1', recipient: 'factory.near', refundTo: 'factory.near', deadline });
  assert.equal(q.dry, true);
  assert.equal('depositAddress' in q, false);
});
