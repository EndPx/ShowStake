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
  vectorRegistrations,
} from './helpers.mjs';
import { computeAllocation } from '../src/settlement.mjs';

const vectors = readFixture('acceptance-vectors.json');
const vector = (id) => vectors.cases.find((candidate) => candidate.id === id);

test('zero-attendee settlement refunds every remaining registrant D and withdrawn credit separately', () => {
  const caseVector = vector('zero-attendees-with-withdrawal');
  const { oracle, eventId, registrationBySequence } = executeVector(caseVector);
  assert.equal(oracle.eventView(eventId).state, 'SETTLED');
  for (const [sequence, registrationId] of registrationBySequence) {
    const view = oracle.registrationView(registrationId);
    assert.equal(view.claimAtomic, caseVector.deposit, `sequence ${sequence}`);
    assert.equal(view.payoutState, 'CLAIMABLE');
  }
  assert.equal(oracle.assertConservation(eventId).balanced, true);
  assert.equal(oracle.ledgerView(eventId).acceptedAtomic, caseVector.expected.total);
});

test('zero-attendee path with one registration pays exactly D and conserves', () => {
  const caseVector = vector('single-zero-attendee');
  const { oracle, eventId, registrationBySequence } = executeVector(caseVector);
  const registrationId = registrationBySequence.get(0);
  const view = oracle.registrationView(registrationId);
  assert.equal(view.claimAtomic, '1');
  assert.equal(view.payoutState, 'CLAIMABLE');
  const claim = oracle.claim({ eventId, registrationId, beneficiary: view.beneficiaryAccount, now: TIMES.checkinClose + 2 });
  assert.equal(claim.amountAtomic, '1');
  oracle.onPayoutResult({ eventId, payoutId: claim.payoutId, success: true, caller: oracle.contractId, now: TIMES.checkinClose + 3 });
  const ledger = oracle.ledgerView(eventId);
  assert.equal(ledger.paidAtomic, '1');
  assert.equal(ledger.liabilityAtomic, '0');
  assert.equal(ledger.acceptedAtomic, '1');
});

test('cancellation refunds full principal exactly once and withdrawn credit stays payable', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle, { capacity: 4 });
  const activeA = commitAs(oracle, eventId, 0);
  const withdrawn = commitAs(oracle, eventId, 1);
  const activeB = commitAs(oracle, eventId, 2);
  oracle.withdrawRegistration({
    eventId,
    registrationId: withdrawn.registrationId,
    actor: 'acct-1.showstake.oracle',
    now: TIMES.regOpen + 1,
  });
  const cancelled = oracle.cancelEvent({ eventId, actor: ORGANIZER, now: TIMES.regOpen + 2 });
  assert.equal(cancelled.claimTotal, '30');
  assert.equal(cancelled.rewardedRegistrations, undefined);
  for (const registration of [activeA, withdrawn, activeB]) {
    assert.equal(oracle.registrationView(registration.registrationId).claimAtomic, '10');
  }
  // Withdrawn claim is payable; failed payout restores it and not the seat.
  const claim = oracle.claim({
    eventId,
    registrationId: withdrawn.registrationId,
    beneficiary: 'acct-1.showstake.oracle',
    now: TIMES.regOpen + 3,
  });
  oracle.onPayoutResult({ eventId, payoutId: claim.payoutId, success: false, caller: oracle.contractId, now: TIMES.regOpen + 4 });
  assert.equal(oracle.registrationView(withdrawn.registrationId).state, 'WITHDRAWN');
  assert.equal(oracle.registrationView(withdrawn.registrationId).payoutState, 'CLAIMABLE');
  assert.equal(oracle.ledgerView(eventId).liabilityAtomic, '30');
  assert.equal(oracle.assertConservation(eventId).balanced, true);
});

test('timeout refund-only is permissionless, full principal, and exact at the deadline boundary', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle, { capacity: 2 });
  commitAs(oracle, eventId, 0);
  commitAs(oracle, eventId, 1);
  const activated = oracle.activateTimeoutRefund({ eventId, actor: 'anyone-at-all', now: DEADLINE });
  assert.equal(activated.state, 'REFUND_ONLY');
  assert.equal(activated.permissionless, true);
  assert.equal(activated.claimTotal, '20');
  assert.equal(oracle.ledgerView(eventId).liabilityAtomic, '20');
  for (const registrationId of ['reg-1', 'reg-2']) {
    assert.equal(oracle.registrationView(registrationId).claimAtomic, '10');
    assert.equal(oracle.registrationView(registrationId).payoutState, 'CLAIMABLE');
  }
});

test('finalization timeout denies late finalize and preserves refund-only fallback', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle);
  const registration = commitAs(oracle, eventId, 0);
  expectCode(() => oracle.finalizeAttendance({ eventId, actor: ORGANIZER, now: DEADLINE }), CODES.LATE_FINALIZATION);
  const activated = oracle.activateTimeoutRefund({ eventId, now: DEADLINE });
  assert.equal(activated.claimTotal, '10');
  assert.equal(oracle.registrationView(registration.registrationId).claimAtomic, '10');
  assert.equal(oracle.registrationView(registration.registrationId).state, 'COMMITTED');
});

test('withdrawal frees the seat once, invalidates the old pass, and grants a D claim (C05)', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle, { capacity: 1 });
  const first = commitAs(oracle, eventId, 0);
  expectCode(() => commitAs(oracle, eventId, 1), CODES.EVENT_FULL);
  const withdrawal = oracle.withdrawRegistration({
    eventId,
    registrationId: first.registrationId,
    actor: 'acct-0.showstake.oracle',
    now: TIMES.regOpen + 1,
  });
  assert.equal(withdrawal.seatFreed, true);
  assert.equal(withdrawal.claimAtomic, '10');
  assert.equal(withdrawal.passInvalidForCheckin, true);
  assert.equal(oracle.passView(first.passId).checkinValid, false);
  assert.deepEqual(
    oracle.checkinEligibility({ passId: first.passId, now: TIMES.checkinOpen }),
    { eligible: false, reason: 'PASS_WITHDRAWN' },
  );
  // Seat can now be used by a different account.
  const replacement = commitAs(oracle, eventId, 1);
  assert.equal(oracle.eventView(eventId).counts.activeCapacityUsed, 1);
  // A second withdrawal of the old registration cannot free a seat again.
  expectCode(
    () => oracle.withdrawRegistration({
      eventId,
      registrationId: first.registrationId,
      actor: 'acct-0.showstake.oracle',
      now: TIMES.regOpen + 2,
    }),
    CODES.REGISTRATION_WITHDRAWN,
  );
  assert.equal(oracle.eventView(eventId).counts.activeCapacityUsed, 1);
  assert.equal(oracle.registrationView(first.registrationId).claimAtomic, '10');
  assert.equal(oracle.registrationView(replacement.registrationId).claimAtomic, '0');
  assert.equal(oracle.assertConservation(eventId).balanced, true);
});

test('rejoin creates a new registration/pass and keeps the old claim separate (C06)', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle, { capacity: 2 });
  const old = commitAs(oracle, eventId, 0);
  oracle.withdrawRegistration({
    eventId,
    registrationId: old.registrationId,
    actor: 'acct-0.showstake.oracle',
    now: TIMES.regOpen + 1,
  });
  const rejoined = commitAs(oracle, eventId, 9, {
    account: 'acct-0.showstake.oracle',
    commitmentId: 'commit-rejoin',
    now: TIMES.regOpen + 2,
  });
  assert.notEqual(rejoined.registrationId, old.registrationId);
  assert.notEqual(rejoined.passId, old.passId);
  assert.equal(oracle.registrationView(old.registrationId).state, 'WITHDRAWN');
  assert.equal(oracle.registrationView(old.registrationId).claimAtomic, '10');
  assert.equal(oracle.registrationView(rejoined.registrationId).state, 'COMMITTED');
  assert.equal(oracle.passView(old.passId).checkinValid, false);
  assert.equal(oracle.checkinEligibility({ passId: rejoined.passId, now: TIMES.checkinOpen }).eligible, true);
  // No duplicate active registration.
  expectCode(
    () => commitAs(oracle, eventId, 10, { account: 'acct-0.showstake.oracle', commitmentId: 'commit-dup' }),
    CODES.DUPLICATE_ACTIVE_REGISTRATION,
  );
  // Old and new claims are independently payable to the same immutable beneficiary.
  const oldClaim = oracle.claim({
    eventId,
    registrationId: old.registrationId,
    beneficiary: 'acct-0.showstake.oracle',
    now: TIMES.regOpen + 3,
  });
  assert.equal(oldClaim.amountAtomic, '10');
  oracle.onPayoutResult({ eventId, payoutId: oldClaim.payoutId, success: true, caller: oracle.contractId, now: TIMES.regOpen + 4 });
  oracle.markAttendance({ eventId, registrationId: rejoined.registrationId, attended: true, actor: ORGANIZER, now: TIMES.checkinOpen });
  oracle.finalizeAttendance({ eventId, actor: ORGANIZER, now: TIMES.checkinClose });
  oracle.settle({ eventId, now: TIMES.checkinClose + 1 });
  assert.equal(oracle.registrationView(rejoined.registrationId).claimAtomic, '10');
  assert.equal(oracle.ledgerView(eventId).acceptedAtomic, '20');
  assert.equal(oracle.ledgerView(eventId).paidAtomic, '10');
  assert.equal(oracle.ledgerView(eventId).liabilityAtomic, '10');
  assert.equal(oracle.assertConservation(eventId).balanced, true);
});

test('failed payout never restores a withdrawn registration', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle);
  const registration = commitAs(oracle, eventId, 0);
  oracle.withdrawRegistration({
    eventId,
    registrationId: registration.registrationId,
    actor: 'acct-0.showstake.oracle',
    now: TIMES.regOpen + 1,
  });
  const claim = oracle.claim({
    eventId,
    registrationId: registration.registrationId,
    beneficiary: 'acct-0.showstake.oracle',
    now: TIMES.regOpen + 2,
  });
  oracle.onPayoutResult({ eventId, payoutId: claim.payoutId, success: false, caller: oracle.contractId, now: TIMES.regOpen + 3 });
  const view = oracle.registrationView(registration.registrationId);
  assert.equal(view.state, 'WITHDRAWN');
  assert.equal(view.payoutState, 'CLAIMABLE');
  assert.equal(view.claimAtomic, '10');
  assert.equal(oracle.eventView(eventId).counts.activeCapacityUsed, 0);
});

test('zero attendees after withdrawal-only event settles with only withdrawn credit', () => {
  const caseVector = vector('all-withdrawn');
  const { oracle, eventId } = executeVector(caseVector);
  assert.equal(oracle.eventView(eventId).state, 'SETTLED');
  assert.equal(oracle.ledgerView(eventId).acceptedAtomic, '33');
  for (const registrationId of ['reg-1', 'reg-2', 'reg-3']) {
    assert.equal(oracle.registrationView(registrationId).claimAtomic, '11');
    assert.equal(oracle.registrationView(registrationId).payoutState, 'CLAIMABLE');
  }
});

test('A=0 allocation is exactly the same as computeAllocation with no attendees (OG-07 amounts explicit)', () => {
  const caseVector = vector('zero-attendees-with-withdrawal');
  const allocation = computeAllocation({ deposit: caseVector.deposit, registrations: vectorRegistrations(caseVector) });
  assert.equal(allocation.totals.active.toString(), '21');
  assert.equal(allocation.totals.withdrawn.toString(), '7');
  assert.equal(allocation.totals.total.toString(), '28');
});
