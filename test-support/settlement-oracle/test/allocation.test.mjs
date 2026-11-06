import test from 'node:test';
import assert from 'node:assert/strict';

import { U128_MAX } from '../src/atomic.mjs';
import { CODES, expectCode } from '../src/errors.mjs';
import {
  allocationAmounts,
  assertSequenceOrdered,
  computeAllocation,
  normalizeRegistrations,
  remainderRecipientCount,
  verifyAllocation,
} from '../src/settlement.mjs';
import { readFixture, vectorRegistrations } from './helpers.mjs';

const vectors = readFixture('acceptance-vectors.json');
const D = (vector) => BigInt(vector.deposit);
const sum = (amounts) => Object.values(amounts).reduce((acc, value) => acc + BigInt(value), 0n);

test('all frozen acceptance vectors match independently expected payouts', () => {
  for (const vector of vectors.cases) {
    const allocation = computeAllocation({
      deposit: vector.deposit,
      registrations: vectorRegistrations(vector),
    });
    assert.equal(Number(allocation.n), vector.expected.n, `${vector.id}: N`);
    assert.equal(Number(allocation.a), vector.expected.a, `${vector.id}: A`);
    assert.equal(Number(allocation.m), vector.expected.m, `${vector.id}: M`);
    assert.equal(Number(allocation.w), vector.expected.w, `${vector.id}: W`);
    assert.equal(allocation.pool.toString(), vector.expected.pool, `${vector.id}: pool`);
    assert.equal(allocation.q.toString(), vector.expected.q, `${vector.id}: q`);
    assert.equal(allocation.r.toString(), vector.expected.r, `${vector.id}: r`);

    const actual = Object.create(null);
    for (const entry of allocation.entries) actual[entry.sequence] = entry.payout.toString();
    assert.deepEqual({ ...actual }, vector.expected.bySequence, `${vector.id}: payout per sequence`);
    assert.equal(allocation.totals.total.toString(), vector.expected.total, `${vector.id}: total`);
    assert.equal(sum(actual), BigInt(vector.expected.total), `${vector.id}: independent sum`);
    assert.equal(allocation.totals.total, allocation.totals.expectedTotal, `${vector.id}: total == (N+W)*D`);
    assertSequenceOrdered(allocation);
  }
});

test('packet worked examples F01-F03 and 01-PRODUCT examples are reproduced exactly', () => {
  const byId = new Map(vectors.cases.map((vector) => [vector.id, vector]));
  // F01: 20 deposits of 5,000,000 with 16 attendees -> each 6,250,000, total 100,000,000.
  assert.equal(byId.get('F01-packet').expected.total, '100000000');
  assert.equal(byId.get('F01-packet').expected.bySequence['15'], '6250000');
  // F02: 5 deposits of 10, 3 attendees -> 17,17,16 in registration order.
  assert.equal(byId.get('F02-packet').expected.bySequence['0'], '17');
  assert.equal(byId.get('F02-packet').expected.bySequence['2'], '17');
  assert.equal(byId.get('F02-packet').expected.bySequence['3'], '16');
  // F03: 6 deposits, 1 withdrawn, 3 attendees -> 10 + 17 + 17 + 16 = 60.
  assert.equal(byId.get('F03-packet').expected.bySequence['5'], '10');
  assert.equal(byId.get('F03-packet').expected.total, '60');
});

test('allocation is independent of input array order and claim order', () => {
  const vector = vectors.cases.find((candidate) => candidate.id === 'F02-packet');
  const registrations = vectorRegistrations(vector);
  const forward = computeAllocation({ deposit: vector.deposit, registrations });
  const reversed = computeAllocation({ deposit: vector.deposit, registrations: [...registrations].reverse() });
  assert.deepEqual(allocationAmounts(forward), allocationAmounts(reversed));
  const expectedByRegistration = Object.fromEntries(
    registrations.map((registration) => [registration.registrationId, vector.expected.bySequence[String(registration.sequence)]]),
  );
  assert.deepEqual(allocationAmounts(forward), expectedByRegistration);
});

test('remainder policy: exactly r attendees receive exactly one extra atomic unit', () => {
  for (const vector of vectors.cases) {
    const allocation = computeAllocation({ deposit: vector.deposit, registrations: vectorRegistrations(vector) });
    assert.equal(remainderRecipientCount(allocation), Number(allocation.r), vector.id);
    const attendees = allocation.entries.filter((entry) => entry.kind === 'ATTENDEE');
    attendees.forEach((entry, index) => {
      const expected = allocation.deposit + allocation.q + (index < Number(allocation.r) ? 1n : 0n);
      assert.equal(entry.payout, expected, `${vector.id} attendee ${index}`);
    });
    for (const entry of allocation.entries) {
      if (entry.kind === 'NO_SHOW') assert.equal(entry.payout, 0n);
      if (entry.kind === 'WITHDRAWN') assert.equal(entry.payout, allocation.deposit);
    }
  }
});

test('zero attendees refunds every remaining registrant D and each withdrawn D', () => {
  const vector = vectors.cases.find((candidate) => candidate.id === 'zero-attendees-with-withdrawal');
  const allocation = computeAllocation({ deposit: vector.deposit, registrations: vectorRegistrations(vector) });
  assert.equal(allocation.a, 0);
  for (const entry of allocation.entries) assert.equal(entry.payout, D(vector));
  assert.equal(allocation.totals.total.toString(), vector.expected.total);
});

test('max u128 deposit settles exactly at the ceiling with one registration', () => {
  for (const id of ['max-u128-single', 'max-u128-zero-attendee']) {
    const vector = vectors.cases.find((candidate) => candidate.id === id);
    const allocation = computeAllocation({ deposit: vector.deposit, registrations: vectorRegistrations(vector) });
    assert.equal(allocation.entries[0].payout, U128_MAX);
    assert.equal(allocation.totals.total, U128_MAX);
  }
});

test('allocation rejects individual payout overflow when handed an impossible aggregate', () => {
  // Two max-u128 deposits (aggregate 2*u128) are unreachable through the engine
  // because the second deposit is refused; the pure function must still fail closed.
  expectCode(
    () => computeAllocation({
      deposit: U128_MAX.toString(),
      registrations: [
        { registrationId: 'a', sequence: 0, state: 'ACTIVE', attended: true },
        { registrationId: 'b', sequence: 1, state: 'ACTIVE', attended: false },
      ],
    }),
    CODES.ATOMIC_OVERFLOW,
  );
});

test('allocation rejects malformed registration inputs', () => {
  const base = { deposit: '10', registrations: vectorRegistrations(vectors.cases[0]) };
  expectCode(
    () => computeAllocation({ deposit: '10', registrations: [base.registrations[0], base.registrations[0]] }),
    CODES.RULES_INVALID,
  );
  expectCode(
    () => computeAllocation({
      deposit: '10',
      registrations: [
        { registrationId: 'a', sequence: 0, state: 'ACTIVE', attended: false },
        { registrationId: 'b', sequence: 0, state: 'ACTIVE', attended: false },
      ],
    }),
    CODES.RULES_INVALID,
  );
  expectCode(
    () => computeAllocation({
      deposit: '10',
      registrations: [{ registrationId: 'a', sequence: 0, state: 'WITHDRAWN', attended: true }],
    }),
    CODES.RULES_INVALID,
  );
  expectCode(() => computeAllocation({ deposit: '0', registrations: [] }), CODES.AMOUNT_ZERO);
  expectCode(() => computeAllocation({ deposit: 'x', registrations: [] }), CODES.AMOUNT_INVALID);
  expectCode(() => normalizeRegistrations([{ registrationId: 'a', sequence: 0, state: 'WHAT', attended: false }]), CODES.RULES_INVALID);
});

test('verifyAllocation detects missing, duplicate, corrupted and overflowing entries', () => {
  const vector = vectors.cases.find((candidate) => candidate.id === 'F02-packet');
  const registrations = vectorRegistrations(vector);
  const allocation = computeAllocation({ deposit: vector.deposit, registrations });
  assert.equal(verifyAllocation(allocation, { deposit: vector.deposit, registrations }), true);

  const corruptedSum = structuredClone(allocation);
  corruptedSum.entries[0].payout += 1n;
  expectCode(() => verifyAllocation(corruptedSum, { deposit: vector.deposit, registrations }), CODES.SUM_VERIFICATION_FAILED);

  const missing = structuredClone(allocation);
  missing.entries.pop();
  expectCode(() => verifyAllocation(missing, { deposit: vector.deposit, registrations }), CODES.SUM_VERIFICATION_FAILED);

  const duplicate = structuredClone(allocation);
  duplicate.entries[1] = { ...duplicate.entries[0] };
  expectCode(() => verifyAllocation(duplicate, { deposit: vector.deposit, registrations }), CODES.SUM_VERIFICATION_FAILED);

  const huge = structuredClone(allocation);
  huge.entries[0].payout = U128_MAX + 1n;
  expectCode(() => verifyAllocation(huge, { deposit: vector.deposit, registrations }), CODES.ATOMIC_OVERFLOW);
});

test('allocation order is the immutable registration sequence, not attendance-mark order', () => {
  // Bonus order follows registration sequence, not call order.
  const registrations = [
    { registrationId: 'r0', sequence: 0, state: 'ACTIVE', attended: true },
    { registrationId: 'r1', sequence: 1, state: 'ACTIVE', attended: true },
    { registrationId: 'r2', sequence: 2, state: 'ACTIVE', attended: false },
  ];
  const allocation = computeAllocation({ deposit: '10', registrations });
  // N=3,A=2,M=1,pool=10,q=5,r=0 -> both attendees 15.
  assert.deepEqual(allocationAmounts(allocation), { r0: '15', r1: '15', r2: '0' });
  assertSequenceOrdered(allocation);
});
