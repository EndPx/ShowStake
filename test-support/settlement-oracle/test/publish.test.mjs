import test from 'node:test';
import assert from 'node:assert/strict';

import { SettlementOracle } from '../src/engine.mjs';
import { CODES, expectCode } from '../src/errors.mjs';
import { DEADLINE, ORGANIZER, TIMES, TOKEN, publishStandardEvent } from './helpers.mjs';

test('publish accepts capacity boundaries 1 and 200', () => {
  for (const capacity of [1, 200]) {
    const oracle = new SettlementOracle();
    const eventId = publishStandardEvent(oracle, { capacity });
    assert.equal(oracle.eventView(eventId).capacity, capacity);
  }
});

test('publish rejects capacity 0, 201, fractions and non-numbers', () => {
  for (const capacity of [0, 201, 1.5, '200', null, NaN]) {
    const oracle = new SettlementOracle();
    expectCode(() => publishStandardEvent(oracle, { capacity }), CODES.CAPACITY_INVALID);
  }
});

test('publish rejects non-positive, malformed and out-of-range deposits', () => {
  const cases = [
    ['0', CODES.AMOUNT_ZERO],
    ['-1', CODES.AMOUNT_INVALID],
    ['01', CODES.AMOUNT_INVALID],
    ['1.0', CODES.AMOUNT_INVALID],
    ['340282366920938463463374607431768211456', CODES.AMOUNT_INVALID],
    [10, CODES.AMOUNT_INVALID],
  ];
  for (const [deposit, code] of cases) {
    const oracle = new SettlementOracle();
    expectCode(() => publishStandardEvent(oracle, { deposit }), code);
  }
});

test('publish enforces FT decimals 0..38', () => {
  for (const decimals of [0, 38]) {
    const oracle = new SettlementOracle();
    oracle.publishEvent({
      organizerAccount: ORGANIZER,
      assetContract: TOKEN,
      decimals,
      deposit: '10',
      capacity: 1,
      times: { ...TIMES },
    });
  }
  for (const decimals of [-1, 39, 6.5, '6']) {
    const oracle = new SettlementOracle();
    expectCode(
      () => oracle.publishEvent({
        organizerAccount: ORGANIZER,
        assetContract: TOKEN,
        decimals,
        deposit: '10',
        capacity: 1,
        times: { ...TIMES },
      }),
      CODES.DECIMALS_INVALID,
    );
  }
});

test('publish enforces the exact time ordering and 24h finalize deadline', () => {
  const cases = [
    { regOpen: TIMES.regClose, regClose: TIMES.regClose, cancelCutoff: TIMES.cancelCutoff, checkinOpen: TIMES.checkinOpen, checkinClose: TIMES.checkinClose },
    { regOpen: TIMES.regOpen, regClose: TIMES.regOpen, cancelCutoff: TIMES.cancelCutoff, checkinOpen: TIMES.checkinOpen, checkinClose: TIMES.checkinClose },
    { regOpen: TIMES.regOpen, regClose: TIMES.regClose, cancelCutoff: TIMES.regClose - 1, checkinOpen: TIMES.checkinOpen, checkinClose: TIMES.checkinClose },
    { regOpen: TIMES.regOpen, regClose: TIMES.regClose, cancelCutoff: TIMES.cancelCutoff, checkinOpen: TIMES.cancelCutoff - 1, checkinClose: TIMES.checkinClose },
    { regOpen: TIMES.regOpen, regClose: TIMES.regClose, cancelCutoff: TIMES.cancelCutoff, checkinOpen: TIMES.checkinClose, checkinClose: TIMES.checkinClose },
  ];
  for (const times of cases) {
    const oracle = new SettlementOracle();
    expectCode(
      () => oracle.publishEvent({
        organizerAccount: ORGANIZER,
        assetContract: TOKEN,
        decimals: 6,
        deposit: '10',
        capacity: 1,
        times,
      }),
      CODES.TIME_ORDER_INVALID,
    );
  }

  const oracle = new SettlementOracle();
  const eventId = oracle.publishEvent({
    organizerAccount: ORGANIZER,
    assetContract: TOKEN,
    decimals: 6,
    deposit: '10',
    capacity: 1,
    times: { ...TIMES, finalizeDeadline: TIMES.checkinClose + 24 * 60 * 60 * 1000 },
  });
  assert.equal(oracle.eventView(eventId).times.finalizeDeadline, DEADLINE);

  const wrong = new SettlementOracle();
  expectCode(
    () => wrong.publishEvent({
      organizerAccount: ORGANIZER,
      assetContract: TOKEN,
      decimals: 6,
      deposit: '10',
      capacity: 1,
      times: { ...TIMES, finalizeDeadline: DEADLINE + 1 },
    }),
    CODES.DEADLINE_INVALID,
  );
});

test('publish rejects non-integer timestamps and non-positive/zero capacities', () => {
  const oracle = new SettlementOracle();
  for (const bad of [1.5, NaN, Infinity, '1000000', null]) {
    expectCode(
      () => oracle.publishEvent({
        organizerAccount: ORGANIZER,
        assetContract: TOKEN,
        decimals: 6,
        deposit: '10',
        capacity: 1,
        times: { ...TIMES, regOpen: bad },
      }),
      CODES.TIME_INVALID,
    );
  }
});

test('financial rules, times, organizer and capacity are immutable after publish', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle, { capacity: 5, deposit: '10' });
  for (const patch of [
    { deposit: '11' },
    { capacity: 6 },
    { organizerAccount: 'other.near' },
    { assetContract: 'other.ft.near' },
    { decimals: 7 },
    { times: { regOpen: TIMES.regOpen + 1 } },
    { policyVersion: 'v2' },
    { rulesHash: 'other' },
  ]) {
    const error = expectCode(() => oracle.amendRules({ eventId, patch }), CODES.IMMUTABLE_RULES);
    assert.ok(error.details.changed.length > 0);
  }
  // A no-op patch is not a change.
  assert.equal(oracle.amendRules({ eventId, patch: { deposit: '10', capacity: 5 } }).depositAtomic, '10');
});

test('title/description edits are versioned and do not change money', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle);
  const before = oracle.eventView(eventId);
  const content = oracle.amendContent({ eventId, title: 'New title', description: 'New description' });
  assert.equal(content.revision, 2);
  const after = oracle.eventView(eventId);
  assert.deepEqual(after.totals, before.totals);
  assert.equal(after.content.title, 'New title');
  assert.equal(after.depositAtomic, before.depositAtomic);
});

test('event views serialize every money field as a decimal string', () => {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle);
  oracle.commitDeposit({
    eventId,
    participantAccount: 'alice.near',
    commitmentId: 'c-1',
    amount: '10',
    tokenContract: TOKEN,
    now: TIMES.regOpen,
  });
  const view = oracle.eventView(eventId);
  for (const key of ['acceptedAtomic', 'paidAtomic', 'pendingAtomic', 'liabilityAtomic']) {
    assert.equal(typeof view.totals[key], 'string', key);
    assert.match(view.totals[key], /^(0|[1-9][0-9]*)$/);
  }
  assert.equal(typeof view.depositAtomic, 'string');
  assert.equal(view.totals.acceptedAtomic, '10');
  assert.equal(view.totals.liabilityAtomic, '10');
});

test('duplicate event id is refused', () => {
  const oracle = new SettlementOracle();
  publishStandardEvent(oracle, { eventId: 'fixed-event' });
  expectCode(() => publishStandardEvent(oracle, { eventId: 'fixed-event' }), CODES.EVENT_EXISTS);
});
