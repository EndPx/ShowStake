import test from 'node:test';
import assert from 'node:assert/strict';

import { SettlementOracle } from '../src/engine.mjs';
import { CODES, expectCode } from '../src/errors.mjs';
import {
  DEADLINE,
  ORGANIZER,
  TIMES,
  commitAs,
  executeVector,
  lcg,
  publishStandardEvent,
  readFixture,
  shuffled,
} from './helpers.mjs';

const vectors = readFixture('acceptance-vectors.json');
const boundaries = readFixture('lifecycle-boundaries.json');

test('every frozen acceptance vector settles end-to-end to its independent expected amounts', () => {
  for (const vector of vectors.cases) {
    const { oracle, eventId, registrationBySequence, settlement } = executeVector(vector);
    assert.equal(settlement.settled, true, vector.id);
    assert.equal(oracle.eventView(eventId).state, 'SETTLED', vector.id);
    assert.equal(oracle.ledgerView(eventId).acceptedAtomic, vector.expected.total, vector.id);

    for (const [sequence, registrationId] of registrationBySequence) {
      const expected = vector.expected.bySequence[String(sequence)];
      const view = oracle.registrationView(registrationId);
      assert.equal(view.claimAtomic, expected, `${vector.id} seq ${sequence}`);
      if (expected === '0') assert.equal(view.payoutState, 'ZERO', `${vector.id} seq ${sequence}`);
      else assert.equal(view.payoutState, 'CLAIMABLE', `${vector.id} seq ${sequence}`);
    }

    // Pay every positive claim in a deterministic shuffled order and prove the sum.
    const next = lcg(vector.id.length * 101 + vector.n);
    let paidTotal = 0n;
    for (const sequence of shuffled(next, [...registrationBySequence.keys()])) {
      const registrationId = registrationBySequence.get(sequence);
      const expected = BigInt(vector.expected.bySequence[String(sequence)]);
      if (expected === 0n) {
        expectCode(
          () => oracle.claim({
            eventId,
            registrationId,
            beneficiary: `acct-${sequence}.showstake.oracle`,
            now: TIMES.checkinClose + 5,
          }),
          CODES.NOTHING_TO_CLAIM,
        );
        continue;
      }
      const claim = oracle.claim({
        eventId,
        registrationId,
        beneficiary: `acct-${sequence}.showstake.oracle`,
        now: TIMES.checkinClose + 5,
      });
      assert.equal(claim.amountAtomic, expected.toString(), `${vector.id} seq ${sequence} claim`);
      oracle.onPayoutResult({
        eventId,
        payoutId: claim.payoutId,
        success: true,
        caller: oracle.contractId,
        receiptId: `receipt-${sequence}`,
        now: TIMES.checkinClose + 6,
      });
      paidTotal += expected;
      assert.equal(oracle.assertConservation(eventId).balanced, true, `${vector.id} during payouts`);
    }
    assert.equal(paidTotal.toString(), vector.expected.total, vector.id);
    assert.equal(oracle.ledgerView(eventId).paidAtomic, vector.expected.total, vector.id);
    assert.equal(oracle.ledgerView(eventId).pendingAtomic, '0', vector.id);
    assert.equal(oracle.ledgerView(eventId).liabilityAtomic, '0', vector.id);
  }
});

test('F01: 20 deposits of 5,000,000 with 16 attendees pay 6,250,000 each (100,000,000 total)', () => {
  const vector = vectors.cases.find((candidate) => candidate.id === 'F01-packet');
  const { oracle, eventId, registrationBySequence } = executeVector(vector);
  for (let sequence = 0; sequence < 16; sequence += 1) {
    assert.equal(oracle.registrationView(registrationBySequence.get(sequence)).claimAtomic, '6250000');
  }
  for (let sequence = 16; sequence < 20; sequence += 1) {
    assert.equal(oracle.registrationView(registrationBySequence.get(sequence)).payoutState, 'ZERO');
  }
  assert.equal(oracle.ledgerView(eventId).acceptedAtomic, '100000000');
  assert.equal(oracle.ledgerView(eventId).liabilityAtomic, '100000000');
});

test('F02: 5 deposits of 10 with 3 attendees allocate 17,17,16 by registration sequence', () => {
  const vector = vectors.cases.find((candidate) => candidate.id === 'F02-packet');
  const { oracle, registrationBySequence } = executeVector(vector);
  assert.equal(oracle.registrationView(registrationBySequence.get(0)).claimAtomic, '17');
  assert.equal(oracle.registrationView(registrationBySequence.get(2)).claimAtomic, '17');
  assert.equal(oracle.registrationView(registrationBySequence.get(3)).claimAtomic, '16');
  assert.equal(oracle.registrationView(registrationBySequence.get(1)).payoutState, 'ZERO');
  assert.equal(oracle.registrationView(registrationBySequence.get(4)).payoutState, 'ZERO');
});

test('F03: 6 deposits, 1 withdrawal, 3 attendees -> 10 refund + 17 + 17 + 16 = 60', () => {
  const vector = vectors.cases.find((candidate) => candidate.id === 'F03-packet');
  const { oracle, eventId, registrationBySequence } = executeVector(vector);
  assert.equal(oracle.registrationView(registrationBySequence.get(5)).claimAtomic, '10');
  assert.equal(oracle.registrationView(registrationBySequence.get(0)).claimAtomic, '17');
  assert.equal(oracle.registrationView(registrationBySequence.get(2)).claimAtomic, '17');
  assert.equal(oracle.registrationView(registrationBySequence.get(3)).claimAtomic, '16');
  assert.equal(oracle.ledgerView(eventId).acceptedAtomic, '60');
  assert.equal(oracle.ledgerView(eventId).liabilityAtomic, '60');
});

test('F04: zero attendees, cancellation and timeout all return full principal at exact boundaries', () => {
  const zero = executeVector(vectors.cases.find((candidate) => candidate.id === 'single-zero-attendee'));
  assert.equal(zero.oracle.registrationView(zero.registrationBySequence.get(0)).claimAtomic, '1');

  const cancelOracle = new SettlementOracle();
  const cancelEventId = publishStandardEvent(cancelOracle, { capacity: 2 });
  commitAs(cancelOracle, cancelEventId, 0);
  commitAs(cancelOracle, cancelEventId, 1);
  const cancelled = cancelOracle.cancelEvent({ eventId: cancelEventId, actor: ORGANIZER, now: TIMES.checkinClose + 1 });
  assert.equal(cancelled.claimTotal, '20');
  assert.equal(cancelled.reward, '0');

  const timeoutOracle = new SettlementOracle();
  const timeoutEventId = publishStandardEvent(timeoutOracle, { capacity: 2 });
  commitAs(timeoutOracle, timeoutEventId, 0);
  commitAs(timeoutOracle, timeoutEventId, 1);
  const refund = timeoutOracle.activateTimeoutRefund({ eventId: timeoutEventId, now: DEADLINE });
  assert.equal(refund.claimTotal, '20');
  assert.equal(refund.state, 'REFUND_ONLY');
});

test('F08: chunked allocation equals one-shot allocation and the frozen fixture', () => {
  const chunkCase = boundaries.settlementChunkCase;
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle, { capacity: 5, deposit: chunkCase.deposit });
  const regs = [0, 1, 2, 3, 4].map((sequence) => commitAs(oracle, eventId, sequence, { amount: chunkCase.deposit }));
  for (const sequence of [0, 2, 3]) {
    oracle.markAttendance({ eventId, registrationId: regs[sequence].registrationId, attended: true, actor: ORGANIZER, now: TIMES.checkinOpen });
  }
  oracle.finalizeAttendance({ eventId, actor: ORGANIZER, now: TIMES.checkinClose });
  const first = oracle.settle({ eventId, now: TIMES.checkinClose + 1, chunkSize: chunkCase.chunks[0] });
  assert.equal(first.settled, false);
  const second = oracle.settleChunk({ eventId, offset: first.cursor, limit: chunkCase.chunks[1], now: TIMES.checkinClose + 2 });
  assert.equal(second.settled, false);
  const third = oracle.settleChunk({ eventId, offset: second.cursor, limit: chunkCase.chunks[2], now: TIMES.checkinClose + 3 });
  assert.equal(third.settled, true);

  for (const [sequence, expected] of Object.entries(chunkCase.expectedBySequence)) {
    assert.equal(oracle.registrationView(regs[Number(sequence)].registrationId).claimAtomic, expected, `seq ${sequence}`);
  }
  assert.equal(oracle.ledgerView(eventId).liabilityAtomic, chunkCase.expectedTotal);

  // One-shot oracle comparison.
  const oneShot = new SettlementOracle();
  const oneEvent = publishStandardEvent(oneShot, { capacity: 5, deposit: chunkCase.deposit });
  const oneRegs = [0, 1, 2, 3, 4].map((sequence) => commitAs(oneShot, oneEvent, sequence, { amount: chunkCase.deposit }));
  for (const sequence of [0, 2, 3]) {
    oneShot.markAttendance({ eventId: oneEvent, registrationId: oneRegs[sequence].registrationId, attended: true, actor: ORGANIZER, now: TIMES.checkinOpen });
  }
  oneShot.finalizeAttendance({ eventId: oneEvent, actor: ORGANIZER, now: TIMES.checkinClose });
  oneShot.settle({ eventId: oneEvent, now: TIMES.checkinClose + 1 });
  for (let sequence = 0; sequence < 5; sequence += 1) {
    assert.equal(
      oneShot.registrationView(oneRegs[sequence].registrationId).claimAtomic,
      oracle.registrationView(regs[sequence].registrationId).claimAtomic,
      `one-shot vs chunked seq ${sequence}`,
    );
  }
});

test('F05: finalized-before-deadline event settles after deadline; terminal phases never revert', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle, { capacity: 2 });
  const first = commitAs(oracle, eventId, 0);
  const second = commitAs(oracle, eventId, 1);
  oracle.markAttendance({ eventId, registrationId: first.registrationId, attended: true, actor: ORGANIZER, now: TIMES.checkinOpen });
  oracle.finalizeAttendance({ eventId, actor: ORGANIZER, now: TIMES.checkinClose });
  oracle.settle({ eventId, now: DEADLINE + 1 });
  assert.equal(oracle.registrationView(first.registrationId).claimAtomic, '20');
  assert.equal(oracle.registrationView(second.registrationId).payoutState, 'ZERO');
  expectCode(() => oracle.cancelEvent({ eventId, actor: ORGANIZER, now: DEADLINE + 2 }), CODES.CANCELLATION_TOO_LATE);
  expectCode(() => oracle.finalizeAttendance({ eventId, actor: ORGANIZER, now: DEADLINE + 2 }), CODES.ATTENDANCE_FROZEN);
  expectCode(() => oracle.settle({ eventId, now: DEADLINE + 2 }), CODES.SETTLEMENT_COMPLETE);
});
