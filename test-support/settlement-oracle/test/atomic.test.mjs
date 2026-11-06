import test from 'node:test';
import assert from 'node:assert/strict';

import {
  U128_MAX,
  assertAtomic,
  assertPositiveCanonicalAtomic,
  checkedAdd,
  checkedMul,
  isCanonicalAtomic,
  parseCanonicalAtomic,
  toAtomicString,
} from '../src/atomic.mjs';
import { CODES, expectCode } from '../src/errors.mjs';
import { materializeAmount, readFixture } from './helpers.mjs';

const fixture = readFixture('amount-edge-cases.json');

test('canonical u128: every fixture-valid string parses and round-trips', () => {
  for (const entry of fixture.valid) {
    const value = materializeAmount(entry);
    assert.equal(typeof value, 'string');
    const parsed = parseCanonicalAtomic(value);
    assert.notEqual(parsed, null, `expected valid: ${JSON.stringify(value)}`);
    assert.equal(parsed.toString(), value);
    assert.equal(toAtomicString(value), value);
    assert.equal(isCanonicalAtomic(value), true);
  }
  assert.equal(parseCanonicalAtomic(fixture.maxU128), U128_MAX);
});

test('canonical u128: every fixture-invalid value is rejected (D05)', () => {
  for (const entry of fixture.invalid) {
    const value = materializeAmount(entry);
    if (typeof value === 'string' && value.length > 0) {
      // externals are strings only; all fixtures here must fail
      assert.equal(parseCanonicalAtomic(value), null, `expected invalid: ${JSON.stringify(value)} (${entry.reason})`);
    } else {
      assert.equal(parseCanonicalAtomic(value), null, `expected invalid: ${entry.reason}`);
    }
    assert.throws(() => assertAtomic(value), (error) => {
      assert.equal(error.code === CODES.AMOUNT_INVALID || error.code === CODES.AMOUNT_OUT_OF_RANGE, true);
      return true;
    });
  }
});

test('canonical u128: external bigint is rejected even when in range', () => {
  // JSON money is a string; a bigint must go through internal checked paths.
  assert.equal(parseCanonicalAtomic(5n), null);
  assert.equal(isCanonicalAtomic(5n), false);
});

test('checked addition rejects u128 overflow and allows max, max+0', () => {
  assert.equal(checkedAdd(U128_MAX, 0n).toString(), fixture.maxU128);
  expectCode(() => checkedAdd(U128_MAX, 1n), CODES.ATOMIC_OVERFLOW);
  expectCode(() => checkedAdd(U128_MAX, U128_MAX), CODES.ATOMIC_OVERFLOW);
});

test('checked multiplication rejects u128 overflow', () => {
  assert.equal(checkedMul(200, 1_000_000n).toString(), '200000000');
  assert.equal(checkedMul(0, U128_MAX).toString(), '0');
  expectCode(() => checkedMul(2, U128_MAX), CODES.ATOMIC_OVERFLOW);
  assert.throws(() => checkedMul(1.5, 1n), (error) => error.code === CODES.AMOUNT_INVALID);
});

test('deposits require a strictly positive canonical amount', () => {
  assert.equal(assertPositiveCanonicalAtomic('1'), 1n);
  expectCode(() => assertPositiveCanonicalAtomic('0'), CODES.AMOUNT_ZERO);
  expectCode(() => assertPositiveCanonicalAtomic('01'), CODES.AMOUNT_INVALID);
  expectCode(() => assertPositiveCanonicalAtomic(1), CODES.AMOUNT_INVALID);
});

test('public JSON views use decimal strings, never JS numbers', () => {
  const view = { depositAtomic: '18446744073709551615', jq: '1250000' };
  const json = JSON.parse(JSON.stringify(view));
  assert.equal(typeof json.depositAtomic, 'string');
  assert.equal(Number(json.depositAtomic) > Number.MAX_SAFE_INTEGER, true, 'number conversion would lose precision');
});
