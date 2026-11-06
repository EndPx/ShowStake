// packages/domain/verify.mjs — static self-check of the shared domain vocabulary.
//
// Covers the D05 "typed envelopes + canonical u128 money strings" regression at
// the JSON boundary: bigint / JS number / fraction / negative / overflow are all
// rejected, only canonical base-10 strings are accepted, and JSON serialization
// stays exact (no float conversion). Exits non-zero on any failure.

import {
  parseAtomic, assertAtomic, toAtomicString, isMoneyString, assertMoneyString,
  atomicAdd, atomicSub, U128_MAX,
  isEventState, isFundingState, assertState, isValidState,
  envelope, okEnvelope, errEnvelope, isEnvelope, paginationLimit,
} from './src/index.mjs';

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`OK   ${label}`);
  else { console.error(`FAIL ${label}`); failures++; }
}

// --- canonical u128 money boundary ---
check(isMoneyString('0') === true, 'isMoneyString("0")');
check(isMoneyString('5000000') === true, 'isMoneyString("5000000")');
check(isMoneyString('00') === false, 'isMoneyString("00") leading zeros rejected');
check(isMoneyString('-1') === false, 'isMoneyString("-1") negative rejected');
check(isMoneyString('1.5') === false, 'isMoneyString("1.5") fraction rejected');
check(isMoneyString(0.1) === false, 'isMoneyString(0.1) JS float rejected');
check(isMoneyString(NaN) === false, 'isMoneyString(NaN) rejected');
check(isMoneyString(5000000) === false, 'isMoneyString(number) rejected');
check(isMoneyString(1n) === false, 'isMoneyString(1n) bigint rejected (JSON boundary)');
check(isMoneyString(undefined) === false, 'isMoneyString(undefined) rejected');
check(isMoneyString(U128_MAX.toString()) === true, 'isMoneyString(u128max string) accepted');
check(isMoneyString((U128_MAX + 1n).toString()) === false, 'isMoneyString(2^128) overflow rejected');

let threw = false;
try { assertMoneyString(1n); } catch { threw = true; }
check(threw, 'assertMoneyString(1n) throws');
check(assertMoneyString('42') === 42n, 'assertMoneyString("42") -> 42n');
check(toAtomicString(340282366920938463463374607431768211455n) === '340282366920938463463374607431768211455', 'toAtomicString(u128max) exact');

// internal bigint arithmetic still works (not the JSON boundary)
check(atomicAdd('1', '2') === '3', 'atomicAdd("1","2") -> "3"');
check(atomicSub('5', '2') === '3', 'atomicSub("5","2") -> "3"');
check(atomicSub('2', '5') === null, 'atomicSub underflow -> null');
check(atomicAdd(U128_MAX.toString(), '1') === null, 'atomicAdd overflow -> null');
check(parseAtomic(7n) === 7n, 'parseAtomic(7n) internal bigint still accepted');

// JSON serialization is exact: bigint never leaks into JSON.stringify without string form
const jsonOut = JSON.stringify({ amount: toAtomicString(9007199254740993n) });
check(jsonOut === '{"amount":"9007199254740993"}', 'JSON money serialization is an exact string');

// --- states ---
check(isEventState('PUBLISHED') === true && isEventState('BOGUS') === false, 'isEventState boundary');
check(isFundingState('UNKNOWN') === true && isFundingState('') === false, 'isFundingState boundary');
check(assertState('event_state', 'BAD')?.code === 'STATE_INVALID', 'assertState invalid -> STATE_INVALID');
check(assertState('event_state', 'PUBLISHED') === null, 'assertState valid -> null');
check(isValidState('job_state', 'RUNNING') === true, 'isValidState job RUNNING');
check(assertState('nope', 'x')?.code === 'STATE_KIND_UNKNOWN', 'assertState unknown kind');

// --- typed envelope ---
const e = okEnvelope({ ok: true }, { network: 'testnet', requestId: 'r1' });
check(isEnvelope(e) && e.error === null && e.meta.stale === false, 'okEnvelope shape');
check(e.meta.network === 'testnet' && e.meta.requestId === 'r1', 'okEnvelope meta');
const er = errEnvelope('E_CODE', 'boom', { retryable: true });
check(er.error.code === 'E_CODE' && er.error.retryable === true && er.data === null, 'errEnvelope shape');
check(paginationLimit() === 50 && paginationLimit(999) === 100 && paginationLimit(0) === 50 && paginationLimit(7.9) === 7, 'paginationLimit clamps');

if (failures) { console.error(`\n${failures} domain check(s) failed`); process.exit(1); }
console.log('\nPASS: domain verify (exact money strings, states, envelopes).');