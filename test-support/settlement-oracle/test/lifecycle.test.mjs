import test from 'node:test';
import assert from 'node:assert/strict';

import { SettlementOracle } from '../src/engine.mjs';
import { CODES, expectCode } from '../src/errors.mjs';
import {
  DEADLINE,
  ORGANIZER,
  TIMES,
  commitAs,
  publishStandardEvent,
  readFixture,
} from './helpers.mjs';

const boundaries = readFixture('lifecycle-boundaries.json');

function oracleWithCommit(options = {}) {
  const oracle = options.oracle ?? new SettlementOracle();
  const eventId = options.eventId ?? publishStandardEvent(oracle, { capacity: 3 });
  const commit = commitAs(oracle, eventId, options.sequence ?? 0, { now: options.commitNow ?? TIMES.regOpen });
  return { oracle, eventId, registrationId: commit.registrationId };
}

test('packet phase-boundary vectors: registration, withdrawal, check-in, finalization', () => {
  for (const phaseCase of boundaries.phaseCases) {
    const { oracle, eventId, registrationId } = oracleWithCommit({ commitNow: boundaries.commitBefore });
    let outcome = 'ALLOWED';
    try {
      switch (phaseCase.op) {
        case 'commit':
          commitAs(oracle, eventId, 1, { now: phaseCase.now });
          break;
        case 'withdraw':
          oracle.withdrawRegistration({
            eventId,
            registrationId,
            actor: 'acct-0.showstake.oracle',
            now: phaseCase.now,
          });
          break;
        case 'mark':
          oracle.markAttendance({
            eventId,
            registrationId,
            attended: true,
            actor: ORGANIZER,
            now: phaseCase.now,
          });
          break;
        case 'finalize':
          oracle.finalizeAttendance({ eventId, actor: ORGANIZER, now: phaseCase.now });
          break;
        case 'refundOnly':
          oracle.activateTimeoutRefund({
            eventId,
            actor: 'anyone',
            now: phaseCase.now,
            deadlineMode: phaseCase.deadlineMode,
          });
          break;
        default:
          throw new Error(`unknown op ${phaseCase.op}`);
      }
    } catch (error) {
      outcome = error.code ?? error.name;
    }
    assert.equal(outcome, phaseCase.expect, `${phaseCase.id} (${phaseCase.op} @ ${phaseCase.now})`);
  }
});

test('denied phase calls leave the event PUBLISHED and unmodified', () => {
  const { oracle, eventId, registrationId } = oracleWithCommit({ commitNow: TIMES.regOpen });
  expectCode(
    () => oracle.finalizeAttendance({ eventId, actor: ORGANIZER, now: TIMES.checkinClose - 1 }),
    CODES.PHASE_DENIED,
  );
  assert.equal(oracle.eventView(eventId).state, 'PUBLISHED');
  assert.equal(oracle.registrationView(registrationId).state, 'COMMITTED');
  assert.equal(oracle.ledgerView(eventId).acceptedAtomic, '10');
});

test('cancel from PUBLISHED refunds full principal with no reward and blocks settlement/finalization', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle, { capacity: 3 });
  const first = commitAs(oracle, eventId, 0);
  const second = commitAs(oracle, eventId, 1);
  const third = commitAs(oracle, eventId, 2);
  oracle.markAttendance({ eventId, registrationId: first.registrationId, attended: true, actor: ORGANIZER, now: TIMES.checkinOpen });
  const result = oracle.cancelEvent({ eventId, actor: ORGANIZER, now: TIMES.checkinClose + 1 });
  assert.equal(result.state, 'CANCELLED');
  assert.equal(result.reward, '0');
  assert.equal(result.claimTotal, '30');
  for (const registration of [first, second, third]) {
    const view = oracle.registrationView(registration.registrationId);
    assert.equal(view.claimAtomic, '10');
    assert.equal(view.payoutState, 'CLAIMABLE');
  }
  assert.equal(oracle.registrationView(first.registrationId).state, 'ATTENDED');
  assert.equal(oracle.registrationView(second.registrationId).state, 'COMMITTED');
  assert.equal(oracle.assertConservation(eventId).balanced, true);
  expectCode(() => oracle.settle({ eventId, now: TIMES.checkinClose + 2 }), CODES.PHASE_DENIED);
  expectCode(() => oracle.finalizeAttendance({ eventId, actor: ORGANIZER, now: TIMES.checkinClose }), CODES.INVALID_TRANSITION);
  expectCode(() => oracle.cancelEvent({ eventId, actor: ORGANIZER, now: TIMES.checkinClose + 3 }), CODES.CANCELLATION_TOO_LATE);
  expectCode(() => oracle.activateTimeoutRefund({ eventId, now: DEADLINE }), CODES.INVALID_TRANSITION);
});

test('cancel from ATTENDANCE_FINALIZED refunds everyone full principal regardless of attendance', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle, { capacity: 3 });
  const registrations = [0, 1, 2].map((sequence) => commitAs(oracle, eventId, sequence));
  oracle.markAttendance({ eventId, registrationId: registrations[0].registrationId, attended: true, actor: ORGANIZER, now: TIMES.checkinOpen });
  oracle.finalizeAttendance({ eventId, actor: ORGANIZER, now: TIMES.checkinClose });
  const result = oracle.cancelEvent({ eventId, actor: ORGANIZER, now: TIMES.checkinClose + 10 });
  assert.equal(result.claimTotal, '30');
  assert.equal(oracle.registrationView(registrations[0].registrationId).claimAtomic, '10');
  assert.equal(oracle.registrationView(registrations[1].registrationId).claimAtomic, '10');
  assert.equal(oracle.registrationView(registrations[2].registrationId).claimAtomic, '10');
});

test('late finalization at the deadline is denied; refund-only then blocks finalize/settle/cancel', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle);
  commitAs(oracle, eventId, 0);
  expectCode(() => oracle.finalizeAttendance({ eventId, actor: ORGANIZER, now: DEADLINE }), CODES.LATE_FINALIZATION);
  assert.equal(oracle.eventView(eventId).state, 'PUBLISHED');
  const activated = oracle.activateTimeoutRefund({ eventId, actor: 'random-passersby', now: DEADLINE });
  assert.equal(activated.state, 'REFUND_ONLY');
  assert.equal(activated.permissionless, true);
  assert.equal(activated.claimTotal, '10');
  expectCode(() => oracle.settle({ eventId, now: DEADLINE + 1 }), CODES.PHASE_DENIED);
  expectCode(() => oracle.finalizeAttendance({ eventId, actor: ORGANIZER, now: DEADLINE + 1 }), CODES.INVALID_TRANSITION);
  expectCode(() => oracle.cancelEvent({ eventId, actor: ORGANIZER, now: DEADLINE + 1 }), CODES.CANCELLATION_TOO_LATE);
  expectCode(() => oracle.activateTimeoutRefund({ eventId, now: DEADLINE + 2 }), CODES.INVALID_TRANSITION);
});

test('already finalized before deadline can settle after deadline (F05)', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle, { capacity: 2 });
  const first = commitAs(oracle, eventId, 0);
  const second = commitAs(oracle, eventId, 1);
  oracle.markAttendance({ eventId, registrationId: first.registrationId, attended: true, actor: ORGANIZER, now: TIMES.checkinOpen });
  oracle.finalizeAttendance({ eventId, actor: ORGANIZER, now: TIMES.checkinClose });
  const settled = oracle.settle({ eventId, actor: 'anyone', now: DEADLINE + 5_000 });
  assert.equal(settled.settled, true);
  assert.equal(settled.state, 'SETTLED');
  assert.equal(oracle.registrationView(first.registrationId).claimAtomic, '20');
  assert.equal(oracle.registrationView(second.registrationId).payoutState, 'ZERO');
  assert.equal(oracle.assertConservation(eventId).balanced, true);
  expectCode(() => oracle.settle({ eventId, now: DEADLINE + 6_000 }), CODES.SETTLEMENT_COMPLETE);
});

test('settlement requires finalization; finalization requires the organizer', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle);
  commitAs(oracle, eventId, 0);
  expectCode(() => oracle.settle({ eventId, now: TIMES.checkinClose }), CODES.PHASE_DENIED);
  expectCode(
    () => oracle.finalizeAttendance({ eventId, actor: 'not-the-organizer.near', now: TIMES.checkinClose }),
    CODES.UNAUTHORIZED_ORGANIZER,
  );
  expectCode(
    () => oracle.markAttendance({
      eventId,
      registrationId: 'reg-1',
      attended: true,
      actor: 'not-the-organizer.near',
      now: TIMES.checkinOpen,
    }),
    CODES.UNAUTHORIZED_ORGANIZER,
  );
});

test('attendance can be corrected inside the window, then freezes at finalization', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle);
  const registration = commitAs(oracle, eventId, 0);
  oracle.markAttendance({ eventId, registrationId: registration.registrationId, attended: true, actor: ORGANIZER, now: TIMES.checkinOpen });
  oracle.markAttendance({ eventId, registrationId: registration.registrationId, attended: false, actor: ORGANIZER, now: TIMES.checkinOpen + 1 });
  assert.equal(oracle.registrationView(registration.registrationId).state, 'COMMITTED');
  oracle.finalizeAttendance({ eventId, actor: ORGANIZER, now: TIMES.checkinClose });
  assert.equal(oracle.registrationView(registration.registrationId).state, 'NO_SHOW');
  expectCode(
    () => oracle.markAttendance({
      eventId,
      registrationId: registration.registrationId,
      attended: true,
      actor: ORGANIZER,
      now: TIMES.checkinClose + 1,
    }),
    CODES.ATTENDANCE_FROZEN,
  );
  expectCode(
    () => oracle.finalizeAttendance({ eventId, actor: ORGANIZER, now: TIMES.checkinClose + 2 }),
    CODES.ATTENDANCE_FROZEN,
  );
});

test('withdrawn registration cannot be marked attendance', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle);
  const registration = commitAs(oracle, eventId, 0);
  oracle.withdrawRegistration({
    eventId,
    registrationId: registration.registrationId,
    actor: 'acct-0.showstake.oracle',
    now: TIMES.regOpen + 1,
  });
  expectCode(
    () => oracle.markAttendance({
      eventId,
      registrationId: registration.registrationId,
      attended: true,
      actor: ORGANIZER,
      now: TIMES.checkinOpen,
    }),
    CODES.REGISTRATION_WITHDRAWN,
  );
});

test('refund-only deadline boundary honours the documented default and alternative mode (OG-01)', () => {
  const atDeadline = new SettlementOracle();
  const eventA = publishStandardEvent(atDeadline);
  commitAs(atDeadline, eventA, 0);
  const activated = atDeadline.activateTimeoutRefund({ eventId: eventA, now: DEADLINE });
  assert.equal(activated.deadlineMode, 'AT_OR_AFTER');
  assert.equal(activated.state, 'REFUND_ONLY');

  const afterOnly = new SettlementOracle();
  const eventB = publishStandardEvent(afterOnly);
  commitAs(afterOnly, eventB, 0);
  expectCode(
    () => afterOnly.activateTimeoutRefund({ eventId: eventB, now: DEADLINE, deadlineMode: 'AFTER' }),
    CODES.PHASE_DENIED,
  );
  const later = afterOnly.activateTimeoutRefund({ eventId: eventB, now: DEADLINE + 1, deadlineMode: 'AFTER' });
  assert.equal(later.state, 'REFUND_ONLY');
});
