import test from 'node:test';
import assert from 'node:assert/strict';

import { SettlementOracle } from '../src/engine.mjs';
import { CODES, expectCode } from '../src/errors.mjs';
import { U128_MAX } from '../src/atomic.mjs';
import {
  ORGANIZER,
  TIMES,
  TOKEN,
  commitAs,
  materializeAmount,
  publishStandardEvent,
  readFixture,
} from './helpers.mjs';

const amountFixture = readFixture('amount-edge-cases.json');

test('exact canonical FT deposit creates registration and pass atomically in one result (C01)', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle, { capacity: 1, deposit: '5000000' });
  const result = oracle.commitDeposit({
    eventId,
    participantAccount: 'alice.near',
    beneficiaryAccount: 'alice.near',
    commitmentId: 'funding-attempt-1',
    amount: '5000000',
    tokenContract: TOKEN,
    now: TIMES.regOpen,
  });
  assert.equal(result.sameReceipt, true);
  assert.equal(result.amountAtomic, '5000000');
  assert.equal(result.ownerAccount, 'alice.near');
  assert.equal(result.beneficiaryAccount, 'alice.near');
  const registration = oracle.registrationView(result.registrationId);
  const pass = oracle.passView(result.passId);
  assert.equal(registration.principalAtomic, '5000000');
  assert.equal(registration.participantAccount, pass.ownerAccount);
  assert.equal(registration.beneficiaryAccount, pass.ownerAccount);
  assert.equal(pass.registrationId, result.registrationId);
  assert.equal(oracle.ledgerView(eventId).acceptedAtomic, '5000000');
  assert.equal(oracle.ledgerView(eventId).liabilityAtomic, '5000000');
});

test('beneficiary must equal the verified participant account at commit (C04/C07)', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle);
  const error = expectCode(
    () => oracle.commitDeposit({
      eventId,
      participantAccount: 'alice.near',
      beneficiaryAccount: 'mallory.near',
      commitmentId: 'c-1',
      amount: '10',
      tokenContract: TOKEN,
      now: TIMES.regOpen,
    }),
    CODES.IDENTITY_MISMATCH,
  );
  assert.equal(error.details.refundAtomic, '10');
  assert.equal(error.details.seatGranted, false);
  assert.equal(oracle.eventView(eventId).counts.registrations, 0);
  assert.equal(oracle.ledgerView(eventId).acceptedAtomic, '0');
});

test('wrong token, wrong amount, zero and malformed amounts are returned without a seat (C02/D05)', () => {
  const cases = [
    [{ tokenContract: 'fake.ft.near' }, CODES.WRONG_TOKEN],
    [{ amount: '9' }, CODES.WRONG_AMOUNT],
    [{ amount: '11' }, CODES.WRONG_AMOUNT],
    [{ amount: '0' }, CODES.AMOUNT_ZERO],
  ];
  for (const [overrides, code] of cases) {
    const oracle = new SettlementOracle();
    const eventId = publishStandardEvent(oracle);
    const error = expectCode(
      () => oracle.commitDeposit({
        eventId,
        participantAccount: 'alice.near',
        commitmentId: 'c-1',
        amount: '10',
        tokenContract: TOKEN,
        now: TIMES.regOpen,
        ...overrides,
      }),
      code,
    );
    assert.equal(error.details.disposal, 'RETURN_FULL');
    assert.equal(error.details.seatGranted, false);
    assert.equal(oracle.eventView(eventId).counts.registrations, 0);
    assert.equal(oracle.eventView(eventId).counts.activeCapacityUsed, 0);
    assert.equal(oracle.ledgerView(eventId).acceptedAtomic, '0');
  }
});

test('every malformed fixture amount is rejected by commitDeposit with no state change', () => {
  for (const entry of amountFixture.invalid) {
    const oracle = new SettlementOracle();
    const eventId = publishStandardEvent(oracle);
    const amount = materializeAmount(entry);
    let outcome;
    try {
      oracle.commitDeposit({
        eventId,
        participantAccount: 'alice.near',
        commitmentId: 'c-1',
        amount,
        tokenContract: TOKEN,
        now: TIMES.regOpen,
      });
      outcome = 'ACCEPTED';
    } catch (error) {
      outcome = error.code;
    }
    assert.equal(outcome, CODES.AMOUNT_INVALID, `fixture ${JSON.stringify(amount)} (${entry.reason})`);
    assert.equal(oracle.eventView(eventId).counts.registrations, 0);
    assert.equal(oracle.ledgerView(eventId).acceptedAtomic, '0');
  }
});

test('duplicate commitment replay grants no second seat and returns the amount in full', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle);
  commitAs(oracle, eventId, 0, { commitmentId: 'same-commitment' });
  const replay = expectCode(
    () => oracle.commitDeposit({
      eventId,
      participantAccount: 'acct-0.showstake.oracle',
      commitmentId: 'same-commitment',
      amount: '10',
      tokenContract: TOKEN,
      now: TIMES.regOpen,
    }),
    CODES.DUPLICATE_COMMITMENT,
  );
  assert.equal(replay.details.refundAtomic, '10');
  assert.equal(oracle.eventView(eventId).counts.registrations, 1);
  assert.equal(oracle.ledgerView(eventId).acceptedAtomic, '10');
});

test('duplicate active registration is denied; withdrawn account may rejoin with a new commitment', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle);
  const first = commitAs(oracle, eventId, 0);
  expectCode(() => commitAs(oracle, eventId, 1, { account: 'acct-0.showstake.oracle', commitmentId: 'new-c' }), CODES.DUPLICATE_ACTIVE_REGISTRATION);
  oracle.withdrawRegistration({
    eventId,
    registrationId: first.registrationId,
    actor: 'acct-0.showstake.oracle',
    now: TIMES.regOpen + 1,
  });
  const rejoined = commitAs(oracle, eventId, 2, { account: 'acct-0.showstake.oracle', commitmentId: 'new-c' });
  assert.equal(oracle.registrationView(rejoined.registrationId).state, 'COMMITTED');
  assert.equal(oracle.eventView(eventId).counts.activeCapacityUsed, 1);
});

test('capacity 1 and 200 boundaries are exact (C03)', () => {
  const single = new SettlementOracle();
  const singleEvent = publishStandardEvent(single, { capacity: 1 });
  commitAs(single, singleEvent, 0);
  const full = expectCode(() => commitAs(single, singleEvent, 1), CODES.EVENT_FULL);
  assert.equal(full.details.refundAtomic, '10');
  assert.equal(single.eventView(singleEvent).counts.registrations, 1);

  const many = new SettlementOracle();
  const manyEvent = publishStandardEvent(many, { capacity: 200 });
  for (let sequence = 0; sequence < 200; sequence += 1) commitAs(many, manyEvent, sequence);
  assert.equal(many.eventView(manyEvent).counts.activeCapacityUsed, 200);
  expectCode(() => commitAs(many, manyEvent, 200), CODES.EVENT_FULL);
  assert.equal(many.eventView(manyEvent).counts.registrations, 200);
});

test('storage preflight failure and plain ft_transfer fabricate no entitlement (C07)', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle);
  const storage = expectCode(
    () => commitAs(oracle, eventId, 0, { storagePrepaid: false }),
    CODES.STORAGE_NOT_PREPAID,
  );
  assert.equal(storage.details.refundAtomic, '10');
  const plain = expectCode(
    () => oracle.plainTransferToEscrow({ eventId, payerAccount: 'alice.near', amount: '10', tokenContract: TOKEN }),
    CODES.UNSUPPORTED_TRANSFER,
  );
  assert.equal(plain.details.treatedAsPrincipal, false);
  assert.equal(oracle.eventView(eventId).counts.registrations, 0);
  assert.equal(oracle.ledgerView(eventId).acceptedAtomic, '0');
});

test('registration phase closed and cancelled/full events reject with full return', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle);
  const closed = expectCode(
    () => commitAs(oracle, eventId, 0, { now: TIMES.regClose }),
    CODES.PHASE_DENIED,
  );
  assert.equal(closed.details.refundAtomic, '10');
  const cancelled = new SettlementOracle();
  const cancelledEvent = publishStandardEvent(cancelled);
  commitAs(cancelled, cancelledEvent, 0);
  cancelled.cancelEvent({ eventId: cancelledEvent, actor: ORGANIZER, now: TIMES.regOpen + 10 });
  expectCode(() => commitAs(cancelled, cancelledEvent, 1), CODES.PHASE_DENIED);
});

test('pass is account-bound: ordinary transfer, approval and admin reassignment are rejected (C04)', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle);
  const registration = commitAs(oracle, eventId, 0);
  expectCode(() => oracle.transferPass({ passId: registration.passId, from: 'acct-0.showstake.oracle', to: 'mallory.near' }), CODES.TRANSFER_FORBIDDEN);
  expectCode(() => oracle.approvePass({ passId: registration.passId, approvedAccount: 'mallory.near' }), CODES.APPROVAL_FORBIDDEN);
  expectCode(() => oracle.adminReassignPass({ passId: registration.passId, to: 'mallory.near' }), CODES.ADMIN_REASSIGN_FORBIDDEN);
  expectCode(() => oracle.reassignBeneficiary({ registrationId: registration.registrationId, to: 'mallory.near' }), CODES.IMMUTABLE_BENEFICIARY);
  const pass = oracle.passView(registration.passId);
  assert.equal(pass.ownerAccount, 'acct-0.showstake.oracle');
  assert.equal(oracle.registrationView(registration.registrationId).beneficiaryAccount, 'acct-0.showstake.oracle');
});

test('only the participant/owner may withdraw', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle);
  const registration = commitAs(oracle, eventId, 0);
  expectCode(
    () => oracle.withdrawRegistration({ eventId, registrationId: registration.registrationId, actor: 'mallory.near', now: TIMES.regOpen + 1 }),
    CODES.UNAUTHORIZED_PARTICIPANT,
  );
});

test('u128 max deposit is accepted once; a second deposit overflows the aggregate and is returned (OG-02)', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle, { deposit: U128_MAX.toString(), capacity: 2 });
  const first = commitAs(oracle, eventId, 0, { amount: U128_MAX.toString() });
  assert.equal(oracle.ledgerView(eventId).acceptedAtomic, U128_MAX.toString());
  const overflow = expectCode(
    () => commitAs(oracle, eventId, 1, { amount: U128_MAX.toString() }),
    CODES.ATOMIC_OVERFLOW,
  );
  assert.equal(overflow.details.refundAtomic, U128_MAX.toString());
  assert.equal(overflow.details.seatGranted, false);
  assert.equal(oracle.eventView(eventId).counts.registrations, 1);
  assert.equal(oracle.eventView(eventId).counts.activeCapacityUsed, 1);
  assert.equal(oracle.ledgerView(eventId).acceptedAtomic, U128_MAX.toString());
  assert.equal(oracle.registrationView(first.registrationId).principalAtomic, U128_MAX.toString());
});

test('partial settlement near u128 max does not overflow the intermediate entitlement sum', () => {
  // accepted = 2*D <= u128 max, but mid-chunk the allocated attendee share plus
  // the not-yet-zeroed no-show principal exceeds u128. Only the final ledger is u128.
  const deposit = (U128_MAX / 2n).toString();
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle, { deposit, capacity: 2 });
  const attendee = commitAs(oracle, eventId, 0, { amount: deposit });
  const noShow = commitAs(oracle, eventId, 1, { amount: deposit });
  oracle.markAttendance({ eventId, registrationId: attendee.registrationId, attended: true, actor: ORGANIZER, now: TIMES.checkinOpen });
  oracle.finalizeAttendance({ eventId, actor: ORGANIZER, now: TIMES.checkinClose });
  const first = oracle.settle({ eventId, now: TIMES.checkinClose + 1, chunkSize: 1 });
  assert.equal(first.settled, false);
  assert.equal(first.state, 'SETTLING');
  assert.equal(oracle.ledgerView(eventId).acceptedAtomic, (U128_MAX - 1n).toString());
  const finished = oracle.settleChunk({ eventId, offset: 1, limit: 1, now: TIMES.checkinClose + 2 });
  assert.equal(finished.settled, true);
  assert.equal(oracle.registrationView(attendee.registrationId).claimAtomic, (U128_MAX - 1n).toString());
  assert.equal(oracle.registrationView(noShow.registrationId).payoutState, 'ZERO');
  assert.equal(oracle.assertConservation(eventId).balanced, true);
});

test('max capacity at the u128 aggregate ceiling settles and pays exactly', () => {
  const deposit = (U128_MAX / 200n).toString(); // floor, 200*D <= u128 max
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle, { deposit, capacity: 200 });
  for (let sequence = 0; sequence < 200; sequence += 1) commitAs(oracle, eventId, sequence, { amount: deposit });
  const accepted = (BigInt(deposit) * 200n).toString();
  assert.equal(oracle.ledgerView(eventId).acceptedAtomic, accepted);
  oracle.finalizeAttendance({ eventId, actor: ORGANIZER, now: TIMES.checkinClose });
  const settled = oracle.settle({ eventId, now: TIMES.checkinClose + 1 });
  assert.equal(settled.settled, true);
  assert.equal(settled.allocation.n, 200);
  assert.equal(settled.allocation.a, 0);
  // A=0: every one of 200 registrations has a D claim; accepted stays exact.
  for (let sequence = 0; sequence < 200; sequence += 1) {
    const registrationId = `reg-${sequence + 1}`;
    assert.equal(oracle.registrationView(registrationId).claimAtomic, deposit);
    const claim = oracle.claim({
      eventId,
      registrationId,
      beneficiary: `acct-${sequence}.showstake.oracle`,
      now: TIMES.checkinClose + 2,
    });
    assert.equal(claim.amountAtomic, deposit);
    oracle.onPayoutResult({ eventId, payoutId: claim.payoutId, success: true, caller: oracle.contractId, now: TIMES.checkinClose + 3 });
  }
  assert.equal(oracle.ledgerView(eventId).paidAtomic, accepted);
  assert.equal(oracle.ledgerView(eventId).pendingAtomic, '0');
  assert.equal(oracle.ledgerView(eventId).liabilityAtomic, '0');
  assert.equal(oracle.assertConservation(eventId).balanced, true);
});
