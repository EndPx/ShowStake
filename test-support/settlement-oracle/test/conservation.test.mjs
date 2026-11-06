import test from 'node:test';
import assert from 'node:assert/strict';

import { SettlementOracle } from '../src/engine.mjs';
import { U128_MAX } from '../src/atomic.mjs';
import { CODES, expectCode } from '../src/errors.mjs';
import {
  DEADLINE,
  ORGANIZER,
  TIMES,
  commitAs,
  lcg,
  publishStandardEvent,
  randomInt,
  shuffled,
} from './helpers.mjs';

function requireConservation(oracle, eventIds) {
  for (const eventId of eventIds) oracle.assertConservation(eventId);
  return oracle.globalConservation();
}

test('per-event invariant holds after every randomized operation (F07)', () => {
  for (let seed = 1; seed <= 12; seed += 1) {
    const next = lcg(seed * 7919);
    const oracle = new SettlementOracle();
    const events = [
      { eventId: publishStandardEvent(oracle, { capacity: 12, deposit: '10', eventId: `rand-${seed}-a` }), deposit: '10', regs: [] },
      { eventId: publishStandardEvent(oracle, { capacity: 12, deposit: '7', eventId: `rand-${seed}-b` }), deposit: '7', regs: [] },
    ];

    for (const event of events) {
      const count = 1 + randomInt(next, 10);
      for (let index = 0; index < count; index += 1) {
        const result = commitAs(oracle, event.eventId, index, {
          amount: event.deposit,
          account: `${event.eventId}-acct-${index}`,
          commitmentId: `c-${index}`,
        });
        event.regs.push({ registrationId: result.registrationId, account: `${event.eventId}-acct-${index}` });
        requireConservation(oracle, [event.eventId]);
      }
      // Random voluntary withdrawals before cutoff.
      for (const reg of shuffled(next, event.regs)) {
        if (next() < 0.35) {
          oracle.withdrawRegistration({ eventId: event.eventId, registrationId: reg.registrationId, actor: reg.account, now: TIMES.regOpen + 1 });
          requireConservation(oracle, [event.eventId]);
        }
      }
      // Random attendance attestations.
      for (const reg of event.regs) {
        const view = oracle.registrationView(reg.registrationId);
        if (view.state !== 'WITHDRAWN' && next() < 0.6) {
          oracle.markAttendance({ eventId: event.eventId, registrationId: reg.registrationId, attended: true, actor: ORGANIZER, now: TIMES.checkinOpen });
          requireConservation(oracle, [event.eventId]);
        }
      }
    }

    for (const [index, event] of events.entries()) {
      const outcome = (seed + index) % 3;
      if (outcome === 0) {
        oracle.finalizeAttendance({ eventId: event.eventId, actor: ORGANIZER, now: TIMES.checkinClose });
        requireConservation(oracle, [event.eventId]);
        let settled = oracle.settle({ eventId: event.eventId, actor: 'anyone', now: TIMES.checkinClose + 1, chunkSize: 1 + randomInt(next, 3) });
        requireConservation(oracle, [event.eventId]);
        while (!settled.settled) {
          settled = oracle.settleChunk({
            eventId: event.eventId,
            offset: settled.cursor,
            limit: 1 + randomInt(next, 3),
            now: TIMES.checkinClose + 2,
          });
          requireConservation(oracle, [event.eventId]);
        }
      } else if (outcome === 1) {
        if (seed % 2 === 0) {
          oracle.finalizeAttendance({ eventId: event.eventId, actor: ORGANIZER, now: TIMES.checkinClose });
        }
        oracle.cancelEvent({ eventId: event.eventId, actor: ORGANIZER, now: TIMES.checkinClose + 1 });
        requireConservation(oracle, [event.eventId]);
      } else {
        oracle.activateTimeoutRefund({ eventId: event.eventId, actor: 'anyone', now: DEADLINE });
        requireConservation(oracle, [event.eventId]);
      }
    }

    // Interleaved claims across both events, random order, random failures.
    const allRegs = events.flatMap((event) => event.regs.map((reg) => ({ ...reg, eventId: event.eventId })));
    for (const reg of shuffled(next, allRegs)) {
      let view = oracle.registrationView(reg.registrationId);
      if (view.payoutState !== 'CLAIMABLE') continue;
      const claim = oracle.claim({
        eventId: reg.eventId,
        registrationId: reg.registrationId,
        beneficiary: reg.account,
        now: TIMES.checkinClose + 10,
      });
      requireConservation(oracle, events.map((event) => event.eventId));
      // A duplicate click while pending is denied.
      expectCode(
        () => oracle.claim({
          eventId: reg.eventId,
          registrationId: reg.registrationId,
          beneficiary: reg.account,
          now: TIMES.checkinClose + 11,
        }),
        CODES.CLAIM_ALREADY_PENDING,
      );
      const success = next() < 0.5;
      oracle.onPayoutResult({
        eventId: reg.eventId,
        payoutId: claim.payoutId,
        success,
        caller: oracle.contractId,
        receiptId: `receipt-${seed}-${claim.payoutId}`,
        now: TIMES.checkinClose + 12,
      });
      requireConservation(oracle, events.map((event) => event.eventId));
      if (!success) {
        // Failed payout restores exactly one claim; retry to completion.
        view = oracle.registrationView(reg.registrationId);
        assert.equal(view.payoutState, 'CLAIMABLE');
        const retry = oracle.claim({
          eventId: reg.eventId,
          registrationId: reg.registrationId,
          beneficiary: reg.account,
          now: TIMES.checkinClose + 13,
        });
        oracle.onPayoutResult({
          eventId: reg.eventId,
          payoutId: retry.payoutId,
          success: true,
          caller: oracle.contractId,
          now: TIMES.checkinClose + 14,
        });
        requireConservation(oracle, events.map((event) => event.eventId));
      }
    }

    for (const event of events) {
      const ledger = oracle.ledgerView(event.eventId);
      assert.equal(ledger.pendingAtomic, '0', `seed ${seed}: pending must drain`);
      assert.equal(ledger.liabilityAtomic, '0', `seed ${seed}: all entitlements paid`);
      assert.equal(ledger.paidAtomic, ledger.acceptedAtomic, `seed ${seed}: paid must equal accepted`);
      assert.equal(oracle.eventView(event.eventId).counts.registrations >= 1, true);
    }
    const global = oracle.globalConservation();
    assert.equal(global.balanced, true);
  }
});

test('no event may consume another event\'s liabilities (CIT-ISOLATION)', () => {
  const oracle = new SettlementOracle();
  const eventA = publishStandardEvent(oracle, { capacity: 2, deposit: '10', eventId: 'iso-a' });
  const eventB = publishStandardEvent(oracle, { capacity: 2, deposit: '7', eventId: 'iso-b' });
  const regA = commitAs(oracle, eventA, 0, { amount: '10', account: 'a.near', commitmentId: 'a-1' });
  const regB = commitAs(oracle, eventB, 0, { amount: '7', account: 'b.near', commitmentId: 'b-1' });
  oracle.withdrawRegistration({ eventId: eventA, registrationId: regA.registrationId, actor: 'a.near', now: TIMES.regOpen + 1 });
  oracle.withdrawRegistration({ eventId: eventB, registrationId: regB.registrationId, actor: 'b.near', now: TIMES.regOpen + 1 });
  const beforeA = oracle.ledgerView(eventA);
  const beforeB = oracle.ledgerView(eventB);
  assert.equal(beforeA.acceptedAtomic, '10');
  assert.equal(beforeB.acceptedAtomic, '7');

  const claimA = oracle.claim({ eventId: eventA, registrationId: regA.registrationId, beneficiary: 'a.near', now: TIMES.regOpen + 2 });
  // Paying A must leave B's counters untouched.
  oracle.onPayoutResult({ eventId: eventA, payoutId: claimA.payoutId, success: true, caller: oracle.contractId, now: TIMES.regOpen + 3 });
  assert.deepEqual(oracle.ledgerView(eventB), beforeB);
  assert.equal(oracle.ledgerView(eventA).paidAtomic, '10');
  assert.equal(oracle.ledgerView(eventA).pendingAtomic, '0');

  // Cross-event claim is denied, and settling B does not borrow A's money.
  expectCode(
    () => oracle.claim({ eventId: eventA, registrationId: regB.registrationId, beneficiary: 'b.near', now: TIMES.regOpen + 4 }),
    CODES.REGISTRATION_EVENT_MISMATCH,
  );
  assert.deepEqual(oracle.ledgerView(eventB), beforeB);
  oracle.finalizeAttendance({ eventId: eventB, actor: ORGANIZER, now: TIMES.checkinClose });
  oracle.settle({ eventId: eventB, now: TIMES.checkinClose + 1 });
  assert.equal(oracle.ledgerView(eventA).paidAtomic, '10');
  assert.equal(oracle.ledgerView(eventA).acceptedAtomic, '10');
  assert.equal(oracle.ledgerView(eventB).acceptedAtomic, '7');
  assert.equal(oracle.ledgerView(eventB).liabilityAtomic, '7');
  const global = oracle.globalConservation();
  assert.equal(global.totals.acceptedAtomic, '17');
  assert.equal(global.totals.paidAtomic, '10');
  assert.equal(global.totals.liabilityAtomic, '7');
  assert.equal(global.balanced, true);
});

test('accepted principal equals paid + pending + liability through the full phase sequence', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle, { capacity: 3, deposit: '10' });
  const a = commitAs(oracle, eventId, 0);
  const b = commitAs(oracle, eventId, 1);
  const c = commitAs(oracle, eventId, 2);
  // Committed: all principal is outstanding liability.
  assert.deepEqual(
    { accepted: oracle.ledgerView(eventId).acceptedAtomic, paid: oracle.ledgerView(eventId).paidAtomic, pending: oracle.ledgerView(eventId).pendingAtomic, liability: oracle.ledgerView(eventId).liabilityAtomic },
    { accepted: '30', paid: '0', pending: '0', liability: '30' },
  );
  // One withdrawal keeps the same liability composition (D claim).
  oracle.withdrawRegistration({ eventId, registrationId: a.registrationId, actor: 'acct-0.showstake.oracle', now: TIMES.regOpen + 1 });
  assert.equal(oracle.ledgerView(eventId).liabilityAtomic, '30');
  // Attendance adjudication moves no money.
  oracle.markAttendance({ eventId, registrationId: b.registrationId, attended: true, actor: ORGANIZER, now: TIMES.checkinOpen });
  oracle.finalizeAttendance({ eventId, actor: ORGANIZER, now: TIMES.checkinClose });
  assert.equal(oracle.ledgerView(eventId).liabilityAtomic, '30');
  // Settlement redistributes the no-show principal but conserves the total.
  oracle.settle({ eventId, now: TIMES.checkinClose + 1 });
  assert.equal(oracle.ledgerView(eventId).liabilityAtomic, '30');
  assert.equal(oracle.registrationView(b.registrationId).claimAtomic, '20');
  assert.equal(oracle.registrationView(c.registrationId).payoutState, 'ZERO');
  // Reserve and pay one claim; each step conserves.
  const claim = oracle.claim({ eventId, registrationId: a.registrationId, beneficiary: 'acct-0.showstake.oracle', now: TIMES.checkinClose + 2 });
  assert.deepEqual(
    { paid: oracle.ledgerView(eventId).paidAtomic, pending: oracle.ledgerView(eventId).pendingAtomic, liability: oracle.ledgerView(eventId).liabilityAtomic },
    { paid: '0', pending: '10', liability: '20' },
  );
  oracle.onPayoutResult({ eventId, payoutId: claim.payoutId, success: true, caller: oracle.contractId, now: TIMES.checkinClose + 3 });
  assert.deepEqual(
    { paid: oracle.ledgerView(eventId).paidAtomic, pending: oracle.ledgerView(eventId).pendingAtomic, liability: oracle.ledgerView(eventId).liabilityAtomic },
    { paid: '10', pending: '0', liability: '20' },
  );
  assert.equal(oracle.assertConservation(eventId).balanced, true);
});

test('aggregate conservation across events may exceed u128 without confusing per-event ceilings', () => {
  const deposit = U128_MAX.toString();
  const oracle = new SettlementOracle();
  const eventA = publishStandardEvent(oracle, { deposit, capacity: 1, eventId: 'max-a' });
  const eventB = publishStandardEvent(oracle, { deposit, capacity: 1, eventId: 'max-b' });
  const regA = commitAs(oracle, eventA, 0, { amount: deposit, account: 'max-a.near', commitmentId: 'max-a-1' });
  const regB = commitAs(oracle, eventB, 0, { amount: deposit, account: 'max-b.near', commitmentId: 'max-b-1' });
  for (const [eventId, registrationId, account] of [
    [eventA, regA.registrationId, 'max-a.near'],
    [eventB, regB.registrationId, 'max-b.near'],
  ]) {
    oracle.finalizeAttendance({ eventId, actor: ORGANIZER, now: TIMES.checkinClose });
    oracle.settle({ eventId, now: TIMES.checkinClose + 1 });
    const claim = oracle.claim({ eventId, registrationId, beneficiary: account, now: TIMES.checkinClose + 2 });
    assert.equal(claim.amountAtomic, deposit);
    oracle.onPayoutResult({ eventId, payoutId: claim.payoutId, success: true, caller: oracle.contractId, now: TIMES.checkinClose + 3 });
  }
  const global = oracle.globalConservation();
  assert.equal(global.totals.acceptedAtomic, (U128_MAX * 2n).toString());
  assert.equal(global.totals.paidAtomic, (U128_MAX * 2n).toString());
  assert.equal(global.balanced, true);
  assert.equal(oracle.ledgerView(eventA).acceptedAtomic, deposit);
  assert.equal(oracle.ledgerView(eventB).acceptedAtomic, deposit);
});
