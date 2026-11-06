// Pure settlement allocation — no state, no clock, no network.
//
// Policy (docs/planning/showstake-v2/01-PRODUCT.md, "Settlement and refund"):
//   N = remaining non-withdrawn registrations, A attendees, M = N - A, D common principal.
//   A > 0: pool = M*D; q = floor(pool/A); r = pool mod A.
//          Attendees in immutable registration-sequence order: first r get D+q+1,
//          the rest D+q. No-shows get 0.
//   A = 0: all remaining registrants refund D.
//   Withdrawn participants separately retain D credit (outside the pool).
//   Platform fee 0 / organizer fee 0, so the whole pool is redistributed.
//
// Exact bigint arithmetic only; every intermediate is u128-checked.

import { assertAtomic, assertPositiveCanonicalAtomic, checkedAdd, checkedMul, U128_MAX } from './atomic.mjs';
import { CODES, assertOrFail, fail } from './errors.mjs';

const ACTIVE_STATES = new Set(['ACTIVE']);
const WITHDRAWN_STATES = new Set(['WITHDRAWN']);

/**
 * @typedef {{
 *   registrationId: string,
 *   sequence: number,
 *   state: 'ACTIVE'|'WITHDRAWN',
 *   attended: boolean,
 * }} AllocationRegistration
 */

/**
 * Validate and sort registration inputs by immutable sequence.
 * @param {AllocationRegistration[]} registrations
 */
export function normalizeRegistrations(registrations) {
  assertOrFail(Array.isArray(registrations), CODES.RULES_INVALID, 'registrations must be an array');
  const seenIds = new Set();
  const seenSeq = new Set();
  const out = registrations.map((reg, index) => {
    assertOrFail(reg && typeof reg === 'object', CODES.RULES_INVALID, `registration[${index}] must be an object`);
    const { registrationId, sequence, state, attended } = reg;
    assertOrFail(
      typeof registrationId === 'string' && registrationId.length > 0,
      CODES.RULES_INVALID,
      `registration[${index}].registrationId must be a non-empty string`,
    );
    assertOrFail(
      Number.isSafeInteger(sequence) && sequence >= 0,
      CODES.RULES_INVALID,
      `registration[${index}].sequence must be a non-negative safe integer`,
      { registrationId, sequence },
    );
    assertOrFail(
      ACTIVE_STATES.has(state) || WITHDRAWN_STATES.has(state),
      CODES.RULES_INVALID,
      `registration[${index}].state must be ACTIVE or WITHDRAWN`,
      { registrationId, state },
    );
    assertOrFail(typeof attended === 'boolean', CODES.RULES_INVALID, `registration[${index}].attended must be boolean`);
    assertOrFail(
      state === 'ACTIVE' || attended === false,
      CODES.RULES_INVALID,
      'a WITHDRAWN registration cannot be an attendee',
      { registrationId },
    );
    assertOrFail(!seenIds.has(registrationId), CODES.RULES_INVALID, 'duplicate registrationId', { registrationId });
    assertOrFail(!seenSeq.has(sequence), CODES.RULES_INVALID, 'duplicate registration sequence', { sequence });
    seenIds.add(registrationId);
    seenSeq.add(sequence);
    return { registrationId, sequence, state, attended };
  });
  out.sort((a, b) => a.sequence - b.sequence);
  return out;
}

/**
 * Compute the exact allocation.
 *
 * @param {{deposit: string|bigint, registrations: AllocationRegistration[]}} input
 * @returns {{
 *   deposit: bigint,
 *   n: number, a: number, m: number, w: number,
 *   pool: bigint, q: bigint, r: bigint,
 *   entries: {registrationId:string, sequence:number, kind:'ATTENDEE'|'NO_SHOW'|'WITHDRAWN'|'ZERO_ATTENDEE_REFUND', payout:bigint}[],
 *   totals: {active: bigint, withdrawn: bigint, total: bigint, expectedTotal: bigint},
 * }}
 */
export function computeAllocation({ deposit, registrations }) {
  const D = assertPositiveCanonicalAtomic(deposit, 'deposit');
  const regs = normalizeRegistrations(registrations);

  const active = regs.filter((reg) => reg.state === 'ACTIVE');
  const withdrawn = regs.filter((reg) => reg.state === 'WITHDRAWN');
  const N = active.length;
  const A = active.filter((reg) => reg.attended).length;
  const M = N - A;
  const W = withdrawn.length;

  const pool = A > 0 ? checkedMul(M, D, 'pool') : 0n;
  const q = A > 0 ? pool / BigInt(A) : 0n;
  const r = A > 0 ? pool % BigInt(A) : 0n;

  assertOrFail(r < BigInt(A) || A === 0, CODES.RULES_INVALID, 'remainder must be smaller than attendee count');

  let attendeeIndex = 0;
  const entries = regs.map((reg) => {
    if (reg.state === 'WITHDRAWN') {
      return { registrationId: reg.registrationId, sequence: reg.sequence, kind: /** @type {const} */ ('WITHDRAWN'), payout: D };
    }
    if (reg.attended) {
      const bonus = attendeeIndex < Number(r) ? 1n : 0n;
      attendeeIndex += 1;
      const payout = checkedAdd(checkedAdd(D, q, 'attendee payout'), bonus, 'attendee payout+bonus');
      return { registrationId: reg.registrationId, sequence: reg.sequence, kind: /** @type {const} */ ('ATTENDEE'), payout };
    }
    return {
      registrationId: reg.registrationId,
      sequence: reg.sequence,
      kind: /** @type {const} */ (A === 0 ? 'ZERO_ATTENDEE_REFUND' : 'NO_SHOW'),
      payout: A === 0 ? D : 0n,
    };
  });

  assertOrFail(attendeeIndex === A, CODES.RULES_INVALID, 'attendee ordering count mismatch');

  let activeTotal = 0n;
  let withdrawnTotal = 0n;
  for (const entry of entries) {
    if (entry.kind === 'WITHDRAWN') withdrawnTotal = checkedAdd(withdrawnTotal, entry.payout, 'withdrawn total');
    else activeTotal = checkedAdd(activeTotal, entry.payout, 'active total');
  }

  const expectedTotal = checkedMul(N + W, D, 'expected total');
  const total = checkedAdd(activeTotal, withdrawnTotal, 'allocation total');
  assertOrFail(
    total === expectedTotal,
    CODES.SUM_VERIFICATION_FAILED,
    'allocation total must equal (N+W)*D',
    { total: total.toString(), expectedTotal: expectedTotal.toString(), n: N, w: W, deposit: D.toString() },
  );

  // Independent closed-form checks (do not reuse the per-entry accumulation).
  const expectedActive = checkedMul(N, D, 'expected active total');
  assertOrFail(
    activeTotal === expectedActive,
    CODES.SUM_VERIFICATION_FAILED,
    'active allocation must return exactly N*D',
    { activeTotal: activeTotal.toString(), expectedActive: expectedActive.toString() },
  );

  return {
    deposit: D,
    n: N,
    a: A,
    m: M,
    w: W,
    pool,
    q,
    r,
    entries,
    totals: { active: activeTotal, withdrawn: withdrawnTotal, total, expectedTotal },
  };
}

/**
 * Verify that a stored/derived allocation still sums exactly to the expected
 * obligation. Used by the stateful engine before marking settlement complete
 * and directly by corruption tests.
 *
 * @param {ReturnType<typeof computeAllocation>} allocation
 * @param {{registrations: AllocationRegistration[], deposit: string|bigint}} expected
 * @returns {true}
 */
export function verifyAllocation(allocation, expected) {
  const regs = normalizeRegistrations(expected.registrations);
  const D = assertPositiveCanonicalAtomic(expected.deposit, 'deposit');
  const ids = new Set(allocation.entries.map((entry) => entry.registrationId));
  assertOrFail(ids.size === allocation.entries.length, CODES.SUM_VERIFICATION_FAILED, 'duplicate allocation entries');
  assertOrFail(ids.size === regs.length, CODES.SUM_VERIFICATION_FAILED, 'allocation entry count mismatch');

  let total = 0n;
  for (const reg of regs) {
    const entry = allocation.entries.find((candidate) => candidate.registrationId === reg.registrationId);
    assertOrFail(entry !== undefined, CODES.SUM_VERIFICATION_FAILED, 'missing allocation entry', {
      registrationId: reg.registrationId,
    });
    assertOrFail(entry.payout <= U128_MAX, CODES.ATOMIC_OVERFLOW, 'allocation entry exceeds u128');
    total = checkedAdd(total, assertAtomic(entry.payout, 'allocation payout'), 'verification total');
  }
  const expectedTotal = checkedMul(regs.length, D, 'verification expected total');
  assertOrFail(
    total === expectedTotal,
    CODES.SUM_VERIFICATION_FAILED,
    'allocation sum verification failed',
    { total: total.toString(), expectedTotal: expectedTotal.toString() },
  );
  return true;
}

/** Map of registrationId -> decimal payout string, for compact fixtures. */
export function allocationAmounts(allocation) {
  const out = {};
  for (const entry of allocation.entries) out[entry.registrationId] = entry.payout.toString();
  return out;
}

/** Number of attendees that received the +1 remainder unit. */
export function remainderRecipientCount(allocation) {
  return allocation.entries.filter((entry) => entry.kind === 'ATTENDEE' && entry.payout === allocation.deposit + allocation.q + 1n).length;
}

/** Assertion helper used by tests/engine; throws on an unsorted plan. */
export function assertSequenceOrdered(allocation) {
  for (let i = 1; i < allocation.entries.length; i += 1) {
    if (allocation.entries[i - 1].sequence >= allocation.entries[i].sequence) {
      fail(CODES.SUM_VERIFICATION_FAILED, 'allocation entries are not in immutable sequence order', { index: i });
    }
  }
  return true;
}
