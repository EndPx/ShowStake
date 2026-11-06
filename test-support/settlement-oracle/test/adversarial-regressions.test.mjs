import test from 'node:test';
import assert from 'node:assert/strict';

import { SettlementOracle } from '../src/engine.mjs';
import { CODES, expectCode } from '../src/errors.mjs';
import {
  ORGANIZER,
  TIMES,
  TOKEN,
  commitAs,
  publishStandardEvent,
} from './helpers.mjs';

function snapshot(oracle, eventId, registrationIds = [], passIds = []) {
  const event = oracle.eventView(eventId);
  const settlement = oracle.events.get(eventId).settlement;
  return JSON.stringify({
    event,
    ledger: oracle.ledgerView(eventId),
    allocation: oracle.allocationView(eventId),
    registrations: registrationIds.map((id) => oracle.registrationView(id)),
    passes: passIds.map((id) => oracle.passView(id)),
    settlement: settlement === null ? null : {
      cursor: settlement.cursor,
      planLength: settlement.plan.length,
      startedBy: settlement.startedBy,
      completedAt: settlement.completedAt,
    },
  });
}

function finalizedTwo(oracle) {
  const eventId = publishStandardEvent(oracle, { capacity: 2 });
  const first = commitAs(oracle, eventId, 0);
  const second = commitAs(oracle, eventId, 1);
  oracle.finalizeAttendance({ eventId, actor: ORGANIZER, now: TIMES.checkinClose });
  return { eventId, ids: [first.registrationId, second.registrationId], passIds: [first.passId, second.passId] };
}

test('cross-event payout id collision keeps both pending payouts addressable (CROSS_EVENT_PAYOUT_ID_COLLISION)', () => {
  const oracle = new SettlementOracle();
  const eventA = publishStandardEvent(oracle, { capacity: 1, deposit: '10', eventId: 'collision-a' });
  const eventB = publishStandardEvent(oracle, { capacity: 1, deposit: '7', eventId: 'collision-b' });
  const regA = commitAs(oracle, eventA, 0, { amount: '10', account: 'a.near', commitmentId: 'a-1' });
  const regB = commitAs(oracle, eventB, 0, { amount: '7', account: 'b.near', commitmentId: 'b-1' });
  oracle.withdrawRegistration({ eventId: eventA, registrationId: regA.registrationId, actor: 'a.near', now: TIMES.regOpen + 1 });
  oracle.withdrawRegistration({ eventId: eventB, registrationId: regB.registrationId, actor: 'b.near', now: TIMES.regOpen + 1 });

  const claimA = oracle.claim({ eventId: eventA, registrationId: regA.registrationId, beneficiary: 'a.near', payoutId: 'same-id', now: TIMES.regOpen + 2 });
  const claimB = oracle.claim({ eventId: eventB, registrationId: regB.registrationId, beneficiary: 'b.near', payoutId: 'same-id', now: TIMES.regOpen + 2 });
  assert.equal(claimA.payoutId, 'same-id');
  assert.equal(claimB.payoutId, 'same-id');

  expectCode(() => oracle.payoutView('same-id'), CODES.DUPLICATE_PAYOUT_ID);
  const storedA = oracle.payoutView('same-id', eventA);
  const storedB = oracle.payoutView('same-id', eventB);
  assert.equal(storedA.eventId, eventA);
  assert.equal(storedA.amountAtomic, '10');
  assert.equal(storedA.recipientAccount, 'a.near');
  assert.equal(storedB.eventId, eventB);
  assert.equal(storedB.amountAtomic, '7');
  assert.equal(storedB.recipientAccount, 'b.near');

  // Both callbacks must resolve their own event's pending payout.
  const resultA = oracle.onPayoutResult({ eventId: eventA, payoutId: 'same-id', success: true, caller: oracle.contractId, now: TIMES.regOpen + 3 });
  const resultB = oracle.onPayoutResult({ eventId: eventB, payoutId: 'same-id', success: true, caller: oracle.contractId, now: TIMES.regOpen + 3 });
  assert.equal(resultA.registrationId, regA.registrationId);
  assert.equal(resultB.registrationId, regB.registrationId);
  assert.equal(oracle.ledgerView(eventA).paidAtomic, '10');
  assert.equal(oracle.ledgerView(eventB).paidAtomic, '7');
  assert.equal(oracle.ledgerView(eventA).pendingAtomic, '0');
  assert.equal(oracle.ledgerView(eventB).pendingAtomic, '0');
  assert.equal(oracle.globalConservation().balanced, true);
});

test('settle with chunkSize 0 is rejected before any event mutation (REJECTED_SETTLEMENT_MUTATES_STATE)', () => {
  const oracle = new SettlementOracle();
  const { eventId, ids, passIds } = finalizedTwo(oracle);
  const before = snapshot(oracle, eventId, ids, passIds);
  for (const chunkSize of [0, -1, 1.5, '1', NaN]) {
    expectCode(() => oracle.settle({ eventId, now: TIMES.checkinClose + 1, chunkSize }), CODES.RULES_INVALID);
    assert.equal(snapshot(oracle, eventId, ids, passIds), before, `chunkSize ${String(chunkSize)} mutated state`);
  }
  // Cancellation must still be possible because SETTLING was never entered.
  const cancelled = oracle.cancelEvent({ eventId, actor: ORGANIZER, now: TIMES.checkinClose + 2 });
  assert.equal(cancelled.state, 'CANCELLED');
  assert.equal(cancelled.claimTotal, '20');
});

test('invalid amendContent leaves title and revision untouched', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle, { capacity: 1 });
  const before = JSON.stringify(oracle.eventView(eventId));
  expectCode(() => oracle.amendContent({ eventId, title: 'changed', description: 42 }), CODES.RULES_INVALID);
  assert.equal(JSON.stringify(oracle.eventView(eventId)), before);
});

test('invalid settleChunk inputs do not move the frozen cursor or claims', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle, { capacity: 3 });
  const regs = [0, 1, 2].map((sequence) => commitAs(oracle, eventId, sequence));
  oracle.markAttendance({ eventId, registrationId: regs[0].registrationId, attended: true, actor: ORGANIZER, now: TIMES.checkinOpen });
  oracle.finalizeAttendance({ eventId, actor: ORGANIZER, now: TIMES.checkinClose });
  const first = oracle.settle({ eventId, now: TIMES.checkinClose + 1, chunkSize: 1 });
  assert.equal(first.settled, false);
  const before = snapshot(oracle, eventId, regs.map((reg) => reg.registrationId), regs.map((reg) => reg.passId));
  expectCode(() => oracle.settleChunk({ eventId, offset: 2, limit: 1, now: TIMES.checkinClose + 2 }), CODES.CURSOR_GAP);
  expectCode(() => oracle.settleChunk({ eventId, offset: first.cursor, limit: 0, now: TIMES.checkinClose + 2 }), CODES.RULES_INVALID);
  expectCode(() => oracle.settleChunk({ eventId, offset: -1, limit: 1, now: TIMES.checkinClose + 2 }), CODES.RULES_INVALID);
  assert.equal(snapshot(oracle, eventId, regs.map((reg) => reg.registrationId), regs.map((reg) => reg.passId)), before);
});

test('other rejected transitions leave event, registration and pass rows unchanged', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle, { capacity: 2 });
  const first = commitAs(oracle, eventId, 0);
  const second = commitAs(oracle, eventId, 1);
  const ids = [first.registrationId, second.registrationId];
  const passIds = [first.passId, second.passId];
  const base = snapshot(oracle, eventId, ids, passIds);

  expectCode(() => commitAs(oracle, eventId, 2, { tokenContract: 'wrong.ft' }), CODES.WRONG_TOKEN);
  assert.equal(snapshot(oracle, eventId, ids, passIds), base);
  expectCode(() => commitAs(oracle, eventId, 2, { amount: '9' }), CODES.WRONG_AMOUNT);
  assert.equal(snapshot(oracle, eventId, ids, passIds), base);
  expectCode(() => commitAs(oracle, eventId, 2, { storagePrepaid: false }), CODES.STORAGE_NOT_PREPAID);
  assert.equal(snapshot(oracle, eventId, ids, passIds), base);
  expectCode(
    () => oracle.markAttendance({ eventId, registrationId: first.registrationId, attended: 'yes', actor: ORGANIZER, now: TIMES.checkinOpen }),
    CODES.RULES_INVALID,
  );
  assert.equal(snapshot(oracle, eventId, ids, passIds), base);
  expectCode(
    () => oracle.finalizeAttendance({ eventId, actor: ORGANIZER, now: TIMES.checkinClose - 1 }),
    CODES.PHASE_DENIED,
  );
  assert.equal(snapshot(oracle, eventId, ids, passIds), base);
  expectCode(
    () => oracle.withdrawRegistration({ eventId, registrationId: first.registrationId, actor: 'mallory.near', now: TIMES.regOpen + 1 }),
    CODES.UNAUTHORIZED_PARTICIPANT,
  );
  assert.equal(snapshot(oracle, eventId, ids, passIds), base);
  expectCode(
    () => oracle.cancelEvent({ eventId, actor: 'mallory.near', now: TIMES.regOpen + 1 }),
    CODES.UNAUTHORIZED_ORGANIZER,
  );
  assert.equal(snapshot(oracle, eventId, ids, passIds), base);
  expectCode(
    () => oracle.activateTimeoutRefund({ eventId, now: TIMES.checkinClose + 1, deadlineMode: 'NOT_A_MODE' }),
    CODES.RULES_INVALID,
  );
  assert.equal(snapshot(oracle, eventId, ids, passIds), base);
  expectCode(
    () => oracle.claim({ eventId, registrationId: first.registrationId, beneficiary: 'mallory.near', now: TIMES.regOpen + 1 }),
    CODES.UNAUTHORIZED_CLAIMANT,
  );
  assert.equal(snapshot(oracle, eventId, ids, passIds), base);
  expectCode(() => oracle.settle({ eventId, now: TIMES.checkinClose + 1 }), CODES.PHASE_DENIED);
  assert.equal(snapshot(oracle, eventId, ids, passIds), base);
});

test('invalid publish does not create an event', () => {
  const oracle = new SettlementOracle();
  const before = oracle.events.size;
  expectCode(
    () => oracle.publishEvent({
      organizerAccount: ORGANIZER,
      assetContract: TOKEN,
      decimals: 6,
      deposit: '0',
      capacity: 1,
      times: { ...TIMES },
    }),
    CODES.AMOUNT_ZERO,
  );
  expectCode(
    () => oracle.publishEvent({
      organizerAccount: ORGANIZER,
      assetContract: TOKEN,
      decimals: 6,
      deposit: '10',
      capacity: 0,
      times: { ...TIMES },
    }),
    CODES.CAPACITY_INVALID,
  );
  assert.equal(oracle.events.size, before);
});
