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
  publishStandardEvent,
  readFixture,
} from './helpers.mjs';

const vectors = readFixture('acceptance-vectors.json');
const f02 = () => executeVector(vectors.cases.find((candidate) => candidate.id === 'F02-packet'));

function withdrewOne() {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle);
  const registration = commitAs(oracle, eventId, 0);
  oracle.withdrawRegistration({
    eventId,
    registrationId: registration.registrationId,
    actor: 'acct-0.showstake.oracle',
    now: TIMES.regOpen + 1,
  });
  return { oracle, eventId, registrationId: registration.registrationId, beneficiary: 'acct-0.showstake.oracle' };
}

test('claim reserves exactly once, becomes PENDING, and duplicate click is denied', () => {
  const { oracle, eventId, registrationId, beneficiary } = withdrewOne();
  const claim = oracle.claim({ eventId, registrationId, beneficiary, now: TIMES.regOpen + 2 });
  assert.equal(claim.amountAtomic, '10');
  assert.equal(claim.state, 'PENDING');
  assert.equal(claim.recipientAccount, beneficiary);
  assert.equal(oracle.registrationView(registrationId).payoutState, 'PENDING');
  assert.equal(oracle.passView(oracle.registrationView(registrationId).passId).financialStatus, 'PENDING');
  assert.deepEqual(
    { paid: oracle.ledgerView(eventId).paidAtomic, pending: oracle.ledgerView(eventId).pendingAtomic, liability: oracle.ledgerView(eventId).liabilityAtomic },
    { paid: '0', pending: '10', liability: '0' },
  );
  const duplicate = expectCode(
    () => oracle.claim({ eventId, registrationId, beneficiary, now: TIMES.regOpen + 3 }),
    CODES.CLAIM_ALREADY_PENDING,
  );
  assert.equal(duplicate.details.pendingPayoutId, claim.payoutId);
  assert.equal(oracle.ledgerView(eventId).pendingAtomic, '10', 'duplicate click cannot add a second pending payout');
});

test('private callback is self-only and success pays exactly once', () => {
  const { oracle, eventId, registrationId, beneficiary } = withdrewOne();
  const claim = oracle.claim({ eventId, registrationId, beneficiary, now: TIMES.regOpen + 2 });
  expectCode(
    () => oracle.onPayoutResult({ eventId, payoutId: claim.payoutId, success: true, caller: 'attacker.near', now: TIMES.regOpen + 3 }),
    CODES.UNAUTHORIZED_CALLBACK,
  );
  const paid = oracle.onPayoutResult({
    eventId,
    payoutId: claim.payoutId,
    success: true,
    caller: oracle.contractId,
    receiptId: 'receipt-1',
    now: TIMES.regOpen + 4,
  });
  assert.equal(paid.payoutState, 'SUCCEEDED');
  assert.equal(paid.registrationPayoutState, 'PAID');
  assert.equal(oracle.passView(oracle.registrationView(registrationId).passId).financialStatus, 'PAID');
  assert.equal(oracle.ledgerView(eventId).paidAtomic, '10');
  assert.equal(oracle.ledgerView(eventId).pendingAtomic, '0');
  expectCode(
    () => oracle.onPayoutResult({ eventId, payoutId: claim.payoutId, success: true, caller: oracle.contractId, now: TIMES.regOpen + 5 }),
    CODES.CALLBACK_STALE,
  );
  expectCode(
    () => oracle.claim({ eventId, registrationId, beneficiary, now: TIMES.regOpen + 6 }),
    CODES.CLAIM_ALREADY_PAID,
  );
  assert.equal(oracle.ledgerView(eventId).paidAtomic, '10');
  assert.equal(oracle.assertConservation(eventId).balanced, true);
});

test('failed payout restores the credit exactly once; duplicate failure cannot double-credit (F06)', () => {
  const { oracle, eventId, registrationId, beneficiary } = withdrewOne();
  const first = oracle.claim({ eventId, registrationId, beneficiary, now: TIMES.regOpen + 2, payoutId: 'p1' });
  oracle.onPayoutResult({ eventId, payoutId: first.payoutId, success: false, caller: oracle.contractId, now: TIMES.regOpen + 3 });
  assert.deepEqual(
    {
      state: oracle.registrationView(registrationId).payoutState,
      claim: oracle.registrationView(registrationId).claimAtomic,
      liability: oracle.ledgerView(eventId).liabilityAtomic,
      pending: oracle.ledgerView(eventId).pendingAtomic,
      paid: oracle.ledgerView(eventId).paidAtomic,
    },
    { state: 'CLAIMABLE', claim: '10', liability: '10', pending: '0', paid: '0' },
  );
  assert.equal(oracle.passView(oracle.registrationView(registrationId).passId).financialStatus, 'CLAIMABLE');
  expectCode(
    () => oracle.onPayoutResult({ eventId, payoutId: first.payoutId, success: false, caller: oracle.contractId, now: TIMES.regOpen + 4 }),
    CODES.CALLBACK_STALE,
  );
  assert.equal(oracle.ledgerView(eventId).liabilityAtomic, '10', 'duplicate failure callback cannot restore twice');
  const second = oracle.claim({ eventId, registrationId, beneficiary, now: TIMES.regOpen + 5, payoutId: 'p2' });
  // Late success for the failed payout is stale and must not pay the old attempt.
  expectCode(
    () => oracle.onPayoutResult({ eventId, payoutId: 'p1', success: true, caller: oracle.contractId, now: TIMES.regOpen + 6 }),
    CODES.CALLBACK_STALE,
  );
  assert.equal(oracle.registrationView(registrationId).payoutState, 'PENDING');
  oracle.onPayoutResult({ eventId, payoutId: second.payoutId, success: true, caller: oracle.contractId, now: TIMES.regOpen + 7 });
  assert.equal(oracle.ledgerView(eventId).paidAtomic, '10');
  assert.equal(oracle.ledgerView(eventId).pendingAtomic, '0');
  assert.equal(oracle.ledgerView(eventId).liabilityAtomic, '0');
  assert.equal(oracle.assertConservation(eventId).balanced, true);
});

test('claim receiver is the immutable beneficiary; relinking a login moves no rights', () => {
  const { oracle, eventId, registrationId, beneficiary } = withdrewOne();
  expectCode(
    () => oracle.claim({ eventId, registrationId, beneficiary: 'someone-else.near', now: TIMES.regOpen + 2 }),
    CODES.UNAUTHORIZED_CLAIMANT,
  );
  const linked = oracle.relinkLogin({ registrationId, provider: 'google', subject: 'subject-1' });
  assert.equal(linked.rightsChanged, false);
  assert.equal(linked.ownerAccount, beneficiary);
  assert.equal(linked.beneficiaryAccount, beneficiary);
  expectCode(
    () => oracle.reassignBeneficiary({ registrationId, to: 'someone-else.near' }),
    CODES.IMMUTABLE_BENEFICIARY,
  );
  assert.equal(oracle.reassignBeneficiary({ registrationId, to: beneficiary }).changed, false);
  const claim = oracle.claim({ eventId, registrationId, beneficiary, now: TIMES.regOpen + 3 });
  assert.equal(claim.recipientAccount, beneficiary);
});

test('cross-event claim and callback are rejected without touching either ledger', () => {
  const oracle = new SettlementOracle();
  const eventA = publishStandardEvent(oracle, { capacity: 2, eventId: 'event-a', deposit: '10' });
  const eventB = publishStandardEvent(oracle, { capacity: 2, eventId: 'event-b', deposit: '7' });
  const regA = commitAs(oracle, eventA, 0, { amount: '10' });
  const regB = commitAs(oracle, eventB, 0, { amount: '7' });
  oracle.withdrawRegistration({ eventId: eventB, registrationId: regB.registrationId, actor: 'acct-0.showstake.oracle', now: TIMES.regOpen + 1 });
  const beforeA = oracle.ledgerView(eventA);
  const beforeB = oracle.ledgerView(eventB);
  expectCode(
    () => oracle.claim({ eventId: eventA, registrationId: regB.registrationId, beneficiary: 'acct-0.showstake.oracle', now: TIMES.regOpen + 2 }),
    CODES.REGISTRATION_EVENT_MISMATCH,
  );
  assert.deepEqual(oracle.ledgerView(eventA), beforeA);
  assert.deepEqual(oracle.ledgerView(eventB), beforeB);
  const claimB = oracle.claim({ eventId: eventB, registrationId: regB.registrationId, beneficiary: 'acct-0.showstake.oracle', now: TIMES.regOpen + 3 });
  expectCode(
    () => oracle.onPayoutResult({ eventId: eventA, payoutId: claimB.payoutId, success: true, caller: oracle.contractId, now: TIMES.regOpen + 4 }),
    CODES.PAYOUT_UNKNOWN,
  );
  expectCode(
    () => oracle.onPayoutResult({ eventId: eventB, payoutId: 'does-not-exist', success: true, caller: oracle.contractId, now: TIMES.regOpen + 5 }),
    CODES.PAYOUT_UNKNOWN,
  );
  assert.equal(oracle.ledgerView(eventA).acceptedAtomic, '10');
  assert.equal(oracle.ledgerView(eventB).acceptedAtomic, '7');
  assert.equal(oracle.ledgerView(eventB).pendingAtomic, '7');
  assert.equal(oracle.ledgerView(eventA).pendingAtomic, '0');
  assert.equal(oracle.globalConservation().balanced, true);
});

test('duplicate payout_id across distinct registrations is denied', () => {
  const { oracle, eventId, registrationBySequence } = f02();
  const first = oracle.claim({
    eventId,
    registrationId: registrationBySequence.get(0),
    beneficiary: 'acct-0.showstake.oracle',
    payoutId: 'shared-payout-id',
    now: TIMES.checkinClose + 2,
  });
  assert.equal(first.payoutId, 'shared-payout-id');
  expectCode(
    () => oracle.claim({
      eventId,
      registrationId: registrationBySequence.get(2),
      beneficiary: 'acct-2.showstake.oracle',
      payoutId: 'shared-payout-id',
      now: TIMES.checkinClose + 3,
    }),
    CODES.DUPLICATE_PAYOUT_ID,
  );
  assert.equal(oracle.ledgerView(eventId).pendingAtomic, '17');
});

test('active registrations are NOT_CLAIMABLE before settlement; no-show claim is ZERO (F02)', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle, { capacity: 5 });
  const registrations = [0, 1, 2, 3, 4].map((sequence) => commitAs(oracle, eventId, sequence));
  expectCode(
    () => oracle.claim({ eventId, registrationId: registrations[0].registrationId, beneficiary: 'acct-0.showstake.oracle', now: TIMES.regOpen + 1 }),
    CODES.NOT_CLAIMABLE,
  );
  for (const sequence of [0, 2, 3]) {
    oracle.markAttendance({ eventId, registrationId: registrations[sequence].registrationId, attended: true, actor: ORGANIZER, now: TIMES.checkinOpen });
  }
  oracle.finalizeAttendance({ eventId, actor: ORGANIZER, now: TIMES.checkinClose });
  oracle.settle({ eventId, now: TIMES.checkinClose + 1 });
  assert.equal(oracle.registrationView(registrations[0].registrationId).claimAtomic, '17');
  assert.equal(oracle.registrationView(registrations[1].registrationId).payoutState, 'ZERO');
  assert.equal(oracle.registrationView(registrations[1].registrationId).claimAtomic, '0');
  expectCode(
    () => oracle.claim({ eventId, registrationId: registrations[1].registrationId, beneficiary: 'acct-1.showstake.oracle', now: TIMES.checkinClose + 2 }),
    CODES.NOTHING_TO_CLAIM,
  );
});

test('claim order does not change per-registration F02 amounts', () => {
  const { oracle, eventId, registrationBySequence } = f02();
  const order = [3, 2, 0];
  const expected = new Map([[3, '16'], [2, '17'], [0, '17']]);
  for (const sequence of order) {
    const claim = oracle.claim({
      eventId,
      registrationId: registrationBySequence.get(sequence),
      beneficiary: `acct-${sequence}.showstake.oracle`,
      now: TIMES.checkinClose + 2,
    });
    assert.equal(claim.amountAtomic, expected.get(sequence), `sequence ${sequence}`);
    oracle.onPayoutResult({ eventId, payoutId: claim.payoutId, success: true, caller: oracle.contractId, now: TIMES.checkinClose + 3 });
  }
  assert.equal(oracle.ledgerView(eventId).paidAtomic, '50');
  assert.equal(oracle.ledgerView(eventId).pendingAtomic, '0');
  assert.equal(oracle.ledgerView(eventId).liabilityAtomic, '0');
});

test('chunked settlement disables claims, locks cancellation, is idempotent and resumes (F08)', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle, { capacity: 5 });
  const registrations = [0, 1, 2, 3, 4].map((sequence) => commitAs(oracle, eventId, sequence));
  for (const sequence of [0, 2, 3]) {
    oracle.markAttendance({ eventId, registrationId: registrations[sequence].registrationId, attended: true, actor: ORGANIZER, now: TIMES.checkinOpen });
  }
  oracle.finalizeAttendance({ eventId, actor: ORGANIZER, now: TIMES.checkinClose });

  const firstChunk = oracle.settle({ eventId, now: TIMES.checkinClose + 1, chunkSize: 2 });
  assert.equal(firstChunk.settled, false);
  assert.equal(firstChunk.state, 'SETTLING');
  assert.equal(firstChunk.cursor, 2);
  expectCode(
    () => oracle.claim({ eventId, registrationId: registrations[0].registrationId, beneficiary: 'acct-0.showstake.oracle', now: TIMES.checkinClose + 2 }),
    CODES.CLAIMS_DISABLED,
  );
  expectCode(
    () => oracle.cancelEvent({ eventId, actor: ORGANIZER, now: TIMES.checkinClose + 2 }),
    CODES.CANCELLATION_LOCKED,
  );
  // Replaying an already applied chunk is a no-op.
  const replay = oracle.settleChunk({ eventId, offset: 0, limit: 2, now: TIMES.checkinClose + 3 });
  assert.equal(replay.alreadyApplied, true);
  assert.equal(replay.cursor, 2);
  // A gap is refused.
  expectCode(
    () => oracle.settleChunk({ eventId, offset: 3, limit: 1, now: TIMES.checkinClose + 4 }),
    CODES.CURSOR_GAP,
  );
  const secondChunk = oracle.settleChunk({ eventId, offset: 2, limit: 2, now: TIMES.checkinClose + 5 });
  assert.equal(secondChunk.settled, false);
  assert.equal(secondChunk.cursor, 4);
  expectCode(
    () => oracle.claim({ eventId, registrationId: registrations[2].registrationId, beneficiary: 'acct-2.showstake.oracle', now: TIMES.checkinClose + 6 }),
    CODES.CLAIMS_DISABLED,
  );
  const finished = oracle.settleChunk({ eventId, offset: 4, limit: 1, now: TIMES.checkinClose + 7 });
  assert.equal(finished.settled, true);
  assert.equal(finished.state, 'SETTLED');
  assert.equal(finished.activeClaimTotal, '50');
  // Chunked result equals the one-shot allocation.
  assert.equal(oracle.registrationView(registrations[0].registrationId).claimAtomic, '17');
  assert.equal(oracle.registrationView(registrations[2].registrationId).claimAtomic, '17');
  assert.equal(oracle.registrationView(registrations[3].registrationId).claimAtomic, '16');
  assert.equal(oracle.registrationView(registrations[1].registrationId).payoutState, 'ZERO');
  assert.equal(oracle.registrationView(registrations[4].registrationId).payoutState, 'ZERO');
  assert.equal(oracle.assertConservation(eventId).balanced, true);
  const claim = oracle.claim({ eventId, registrationId: registrations[0].registrationId, beneficiary: 'acct-0.showstake.oracle', now: TIMES.checkinClose + 8 });
  assert.equal(claim.amountAtomic, '17');
});

test('claims never expire and remain payable long after the deadline (CIT-NO-EXPIRY)', () => {
  const { oracle, eventId, registrationId, beneficiary } = withdrewOne();
  const claim = oracle.claim({ eventId, registrationId, beneficiary, now: DEADLINE + 10 * 365 * 24 * 60 * 60 * 1000 });
  assert.equal(claim.amountAtomic, '10');
});

test('claim amount views are decimal strings', () => {
  const { oracle, eventId, registrationId, beneficiary } = withdrewOne();
  const claim = oracle.claim({ eventId, registrationId, beneficiary, now: TIMES.regOpen + 2 });
  assert.equal(typeof claim.amountAtomic, 'string');
  assert.equal(typeof oracle.payoutView(claim.payoutId).amountAtomic, 'string');
  assert.equal(typeof oracle.registrationView(registrationId).claimAtomic, 'string');
});
