// Stateful settlement oracle: event rules, registrations, attendance, timeout
// refunds, allocation, claims and exactly-once payout callbacks.
//
// This is a single-threaded executable model, NOT the NEAR contract. It
// deliberately uses caller-supplied block time (integer epoch ms) and never
// reads the wall clock, the filesystem or the network. Concurrency is modelled
// as atomic single calls; real cross-transaction races remain contract tests
// (NOT_RUN here).
//
// Money is bigint internally and decimal string in every public view.

import {
  assertAtomic,
  assertPositiveCanonicalAtomic,
  checkedAdd,
  checkedMul,
  checkedSub,
  parseCanonicalAtomic,
  U128_MAX,
  U128_MAX_STRING,
} from './atomic.mjs';
import { CODES, assertOrFail, fail } from './errors.mjs';
import { POLICY } from './policy.mjs';
import {
  computeAllocation,
  verifyAllocation,
} from './settlement.mjs';

const EVENT_STATES = new Set(['PUBLISHED', 'ATTENDANCE_FINALIZED', 'SETTLING', 'SETTLED', 'CANCELLED', 'REFUND_ONLY']);
const TERMINAL_STATES = new Set(['SETTLED', 'CANCELLED', 'REFUND_ONLY']);
const NON_WITHDRAWN = new Set(['COMMITTED', 'ATTENDED', 'NO_SHOW']);

function assertEpochMs(value, label) {
  if (!Number.isSafeInteger(value)) {
    fail(CODES.TIME_INVALID, `${label} must be an integer epoch-millisecond timestamp`, { label, value: String(value) });
  }
  return value;
}

function assertNonEmptyString(value, label) {
  assertOrFail(typeof value === 'string' && value.trim().length > 0, CODES.RULES_INVALID, `${label} must be a non-empty string`, { label });
  return value;
}

function amountJson(value) {
  return value.toString();
}

/**
 * A zero-network local settlement oracle. Create one per test; IDs are
 * deterministic per instance so artifacts are reproducible.
 */
export class SettlementOracle {
  constructor({ contractId = 'showstake-oracle.contract' } = {}) {
    assertNonEmptyString(contractId, 'contractId');
    /** Self-call identity a private payout callback must present. */
    this.contractId = contractId;
    this.events = new Map();
    this.registrations = new Map();
    this.passes = new Map();
    this.payouts = new Map();
    this.eventPayoutIds = new Map();
    this._eventCounter = 0;
    this._registrationCounter = 0;
    this._passCounter = 0;
    this._payoutCounter = 0;
  }

  // ---------------------------------------------------------------- helpers

  _getEvent(eventId) {
    const event = this.events.get(eventId);
    if (!event) fail(CODES.EVENT_NOT_FOUND, `event ${eventId} not found`, { eventId });
    return event;
  }

  _getRegistration(registrationId) {
    const reg = this.registrations.get(registrationId);
    if (!reg) fail(CODES.REGISTRATION_NOT_FOUND, `registration ${registrationId} not found`, { registrationId });
    return reg;
  }

  _getPass(passId) {
    const pass = this.passes.get(passId);
    if (!pass) fail(CODES.PASS_NOT_FOUND, `pass ${passId} not found`, { passId });
    return pass;
  }

  /** Payout ids are unique per event, not across events. Namespace internally. */
  _payoutKey(eventId, payoutId) {
    return JSON.stringify([eventId, payoutId]);
  }

  _ledgerAdd(event, field, amount) {
    event.ledger[field] = checkedAdd(event.ledger[field], amount, `ledger.${field}`);
  }

  _ledgerSub(event, field, amount) {
    event.ledger[field] = checkedSub(event.ledger[field], amount, `ledger.${field}`);
  }

  _entitlementOf(reg) {
    // Outstanding liability only. For PAID the money is in paid; for PENDING it
    // is in pending, so neither contributes to liability again.
    if (reg.payoutState === 'PAID') return 0n;
    if (reg.payoutState === 'PENDING') return 0n;
    if (reg.entitlementSet) return reg.claimAtomic;
    return reg.principalAtomic;
  }

  _registrationInputs(event) {
    return event.registrationIds.map((registrationId) => {
      const reg = this._getRegistration(registrationId);
      const withdrawn = reg.state === 'WITHDRAWN';
      return {
        registrationId,
        sequence: reg.sequenceNo,
        state: withdrawn ? 'WITHDRAWN' : 'ACTIVE',
        attended: withdrawn ? false : reg.attended,
      };
    });
  }

  _applyFullPrincipalRefund(event, now, reason) {
    let claimTotal = 0n;
    let count = 0;
    for (const registrationId of event.registrationIds) {
      const reg = this._getRegistration(registrationId);
      if (reg.state === 'WITHDRAWN') continue; // already holds a D claim
      if (reg.payoutState === 'PENDING' || reg.payoutState === 'PAID') continue;
      reg.entitlementSet = true;
      reg.claimAtomic = event.depositAtomic;
      reg.payoutState = 'CLAIMABLE';
      reg.refundReason = reason;
      reg.refundAt = now;
      const pass = this.passes.get(reg.passId);
      if (pass) pass.financialStatus = 'REFUNDABLE';
      claimTotal = checkedAdd(claimTotal, reg.claimAtomic, 'refund claim total');
      count += 1;
    }
    return { count, claimTotal };
  }

  _completeSettlement(event, now) {
    const settlement = event.settlement;
    assertOrFail(settlement !== null, CODES.SETTLEMENT_NOT_STARTED, 'no settlement plan');
    verifyAllocation(settlement.allocation, {
      deposit: event.depositAtomic,
      registrations: this._registrationInputs(event),
    });

    let activeClaimTotal = 0n;
    for (const registrationId of event.registrationIds) {
      const reg = this._getRegistration(registrationId);
      if (reg.state === 'WITHDRAWN') continue;
      assertOrFail(reg.entitlementSet === true, CODES.SUM_VERIFICATION_FAILED, 'active registration not allocated', {
        registrationId,
      });
      activeClaimTotal = checkedAdd(activeClaimTotal, reg.claimAtomic, 'active claim total');
    }
    const expectedActive = checkedMul(settlement.allocation.n, event.depositAtomic, 'expected active allocation');
    assertOrFail(
      activeClaimTotal === expectedActive,
      CODES.SUM_VERIFICATION_FAILED,
      'active claims must equal N*D',
      { activeClaimTotal: activeClaimTotal.toString(), expectedActive: expectedActive.toString() },
    );

    settlement.completedAt = now;
    const priorState = event.state;
    event.state = 'SETTLED';
    event.settledAt = now;
    try {
      this.assertConservation(event.eventId);
    } catch (error) {
      // Fail closed: keep SETTLING so cancellation stays locked and a retry can
      // re-run completion instead of advertising a half-verified settlement.
      event.state = priorState;
      throw error;
    }
    return {
      settled: true,
      eventId: event.eventId,
      state: event.state,
      applied: settlement.cursor,
      totalEntries: settlement.plan.length,
      activeClaimTotal: amountJson(activeClaimTotal),
      allocation: {
        n: settlement.allocation.n,
        a: settlement.allocation.a,
        m: settlement.allocation.m,
        w: settlement.allocation.w,
        pool: amountJson(settlement.allocation.pool),
        q: amountJson(settlement.allocation.q),
        r: amountJson(settlement.allocation.r),
      },
    };
  }

  _applySettlementEntries(event, limit, now) {
    const settlement = event.settlement;
    assertOrFail(settlement !== null, CODES.SETTLEMENT_NOT_STARTED, 'no settlement plan');
    const plan = settlement.plan;
    const remaining = plan.length - settlement.cursor;
    const appliedCount = limit === null ? remaining : Math.min(limit, remaining);
    for (let i = 0; i < appliedCount; i += 1) {
      const entry = plan[settlement.cursor];
      const reg = this._getRegistration(entry.registrationId);
      assertOrFail(reg.state !== 'WITHDRAWN', CODES.SUM_VERIFICATION_FAILED, 'withdrawn registration in active plan');
      reg.entitlementSet = true;
      reg.claimAtomic = entry.payout;
      reg.payoutState = entry.payout > 0n ? 'CLAIMABLE' : 'ZERO';
      const pass = this.passes.get(reg.passId);
      if (pass) pass.financialStatus = entry.payout > 0n ? 'CLAIMABLE' : 'ZERO';
      settlement.cursor += 1;
    }
    settlement.completedAt = settlement.completedAt ?? null;
    if (settlement.cursor === plan.length) {
      return this._completeSettlement(event, now);
    }
    this.assertConservation(event.eventId);
    return {
      settled: false,
      eventId: event.eventId,
      state: event.state,
      applied: appliedCount,
      cursor: settlement.cursor,
      totalEntries: plan.length,
      remaining: plan.length - settlement.cursor,
    };
  }

  // ------------------------------------------------------------- publishing

  /**
   * Publish an event with immutable economic rules.
   * @param {{
   *   organizerAccount: string,
   *   assetContract: string,
   *   decimals: number,
   *   deposit: string,
   *   capacity: number,
   *   times: {regOpen:number,regClose:number,cancelCutoff:number,checkinOpen:number,checkinClose:number,finalizeDeadline?:number},
   *   policyVersion?: string,
   *   rulesHash?: string,
   *   title?: string,
   *   description?: string,
   * }} input
   * @returns {string} eventId
   */
  publishEvent(input) {
    assertOrFail(input && typeof input === 'object', CODES.RULES_INVALID, 'publishEvent requires an object');
    const {
      organizerAccount,
      assetContract,
      decimals,
      deposit,
      capacity,
      times,
      policyVersion = 'showstake/1.0.0',
      rulesHash = 'sha256:oracle-fixture',
      title = '',
      description = '',
    } = input;

    assertNonEmptyString(organizerAccount, 'organizerAccount');
    assertNonEmptyString(assetContract, 'assetContract');
    assertNonEmptyString(policyVersion, 'policyVersion');
    assertNonEmptyString(rulesHash, 'rulesHash');

    assertOrFail(
      Number.isInteger(decimals) && decimals >= POLICY.FT_DECIMALS_MIN && decimals <= POLICY.FT_DECIMALS_MAX,
      CODES.DECIMALS_INVALID,
      `decimals must be an integer ${POLICY.FT_DECIMALS_MIN}..${POLICY.FT_DECIMALS_MAX}`,
      { decimals },
    );
    const D = assertPositiveCanonicalAtomic(deposit, 'deposit');
    assertOrFail(
      Number.isInteger(capacity) && capacity >= POLICY.CAPACITY_MIN && capacity <= POLICY.CAPACITY_MAX,
      CODES.CAPACITY_INVALID,
      `capacity must be an integer ${POLICY.CAPACITY_MIN}..${POLICY.CAPACITY_MAX}`,
      { capacity },
    );
    assertOrFail(times && typeof times === 'object', CODES.TIME_INVALID, 'times object required');
    const regOpen = assertEpochMs(times.regOpen, 'times.regOpen');
    const regClose = assertEpochMs(times.regClose, 'times.regClose');
    const cancelCutoff = assertEpochMs(times.cancelCutoff, 'times.cancelCutoff');
    const checkinOpen = assertEpochMs(times.checkinOpen, 'times.checkinOpen');
    const checkinClose = assertEpochMs(times.checkinClose, 'times.checkinClose');
    assertOrFail(regOpen < regClose, CODES.TIME_ORDER_INVALID, 'reg_open must be < reg_close');
    assertOrFail(regClose <= cancelCutoff, CODES.TIME_ORDER_INVALID, 'reg_close must be <= cancel_cutoff');
    assertOrFail(cancelCutoff <= checkinOpen, CODES.TIME_ORDER_INVALID, 'cancel_cutoff must be <= checkin_open');
    assertOrFail(checkinOpen < checkinClose, CODES.TIME_ORDER_INVALID, 'checkin_open must be < checkin_close');
    const computedDeadline = checkinClose + POLICY.FINALIZE_TIMEOUT_MS;
    assertEpochMs(computedDeadline, 'finalizeDeadline');
    if (times.finalizeDeadline !== undefined) {
      assertOrFail(
        times.finalizeDeadline === computedDeadline,
        CODES.DEADLINE_INVALID,
        'finalize_deadline must equal checkin_close + 24h',
        { provided: times.finalizeDeadline, expected: computedDeadline },
      );
    }

    let eventId;
    if (input.eventId !== undefined) {
      eventId = input.eventId;
      assertNonEmptyString(eventId, 'eventId');
      if (this.events.has(eventId)) fail(CODES.EVENT_EXISTS, `event ${eventId} already exists`, { eventId });
    } else {
      do {
        this._eventCounter += 1;
        eventId = `event-${this._eventCounter}`;
      } while (this.events.has(eventId));
    }

    const event = {
      eventId,
      organizerAccount,
      assetContract,
      decimals,
      depositAtomic: D,
      depositAtomicString: D.toString(),
      capacity,
      times: {
        regOpen,
        regClose,
        cancelCutoff,
        checkinOpen,
        checkinClose,
        finalizeDeadline: computedDeadline,
      },
      policyVersion,
      rulesHash,
      content: { title, description, revision: 1 },
      state: 'PUBLISHED',
      registrationIds: [],
      activeCount: 0,
      commitments: new Set(),
      ledger: { accepted: 0n, paid: 0n, pending: 0n, liability: 0n },
      settlement: null,
      createdAt: times.regOpen,
      cancelledAt: null,
      refundOnlyAt: null,
      settledAt: null,
    };
    this.events.set(eventId, event);
    this.eventPayoutIds.set(eventId, new Set());
    return eventId;
  }

  /** Change title/description only (versioned). Financial rule changes are rejected. */
  amendContent({ eventId, title, description }) {
    const event = this._getEvent(eventId);
    if (TERMINAL_STATES.has(event.state)) fail(CODES.INVALID_TRANSITION, 'content is frozen in a terminal state', { eventId, state: event.state });
    const nextTitle = title === undefined ? event.content.title : title;
    const nextDescription = description === undefined ? event.content.description : description;
    assertOrFail(typeof nextTitle === 'string', CODES.RULES_INVALID, 'title must be a string');
    assertOrFail(typeof nextDescription === 'string', CODES.RULES_INVALID, 'description must be a string');
    event.content.title = nextTitle;
    event.content.description = nextDescription;
    event.content.revision += 1;
    return { ...event.content };
  }

  /** Attempt to change any economically immutable publish rule. */
  amendRules({ eventId, patch }) {
    const event = this._getEvent(eventId);
    assertOrFail(patch && typeof patch === 'object', CODES.RULES_INVALID, 'patch object required');
    const changes = [];
    if (patch.deposit !== undefined && assertPositiveCanonicalAtomic(patch.deposit, 'patch.deposit') !== event.depositAtomic) {
      changes.push('deposit');
    }
    if (patch.capacity !== undefined && patch.capacity !== event.capacity) changes.push('capacity');
    if (patch.organizerAccount !== undefined && patch.organizerAccount !== event.organizerAccount) changes.push('organizerAccount');
    if (patch.assetContract !== undefined && patch.assetContract !== event.assetContract) changes.push('assetContract');
    if (patch.decimals !== undefined && patch.decimals !== event.decimals) changes.push('decimals');
    if (patch.policyVersion !== undefined && patch.policyVersion !== event.policyVersion) changes.push('policyVersion');
    if (patch.rulesHash !== undefined && patch.rulesHash !== event.rulesHash) changes.push('rulesHash');
    if (patch.times !== undefined) {
      for (const key of Object.keys(event.times)) {
        if (patch.times[key] !== undefined && patch.times[key] !== event.times[key]) changes.push(`times.${key}`);
      }
    }
    if (changes.length > 0) {
      fail(CODES.IMMUTABLE_RULES, 'financial rules/times/organizer/capacity are immutable after publish', {
        eventId,
        changed: changes,
      });
    }
    return this.eventView(eventId);
  }

  // ---------------------------------------------------------------- deposits

  /**
   * Model a participant-signed ft_transfer_call that should create a seat.
   * All rejections return the unused amount in full (disposal metadata) and
   * change no event/registration state.
   */
  commitDeposit({
    eventId,
    participantAccount,
    beneficiaryAccount,
    commitmentId,
    amount,
    tokenContract,
    now,
    storagePrepaid = true,
    passId,
  }) {
    const event = this._getEvent(eventId);
    assertNonEmptyString(participantAccount, 'participantAccount');
    assertNonEmptyString(commitmentId, 'commitmentId');
    assertEpochMs(now, 'now');

    const parsedAmount = parseCanonicalAtomic(amount);
    const refundDetails = (reason) => ({
      reason,
      disposal: 'RETURN_FULL',
      refundAtomic: parsedAmount === null ? null : parsedAmount.toString(),
      refundTo: participantAccount,
      seatGranted: false,
      passIssued: false,
    });
    const reject = (code, message) => {
      fail(code, message, refundDetails(code));
    };

    if (event.state !== 'PUBLISHED') reject(CODES.PHASE_DENIED, `event is ${event.state}`);
    if (!(now >= event.times.regOpen && now < event.times.regClose)) {
      reject(CODES.PHASE_DENIED, 'registration is not open at this block time');
    }
    if (tokenContract !== event.assetContract) {
      reject(CODES.WRONG_TOKEN, 'token contract is not the event canonical FT');
    }
    if (parsedAmount === null) {
      assertOrFail(amount !== undefined && amount !== null, CODES.AMOUNT_INVALID, 'amount is required', refundDetails('AMOUNT_INVALID'));
      reject(CODES.AMOUNT_INVALID, 'amount must be a canonical u128 base-10 string');
    }
    if (parsedAmount === 0n) reject(CODES.AMOUNT_ZERO, 'deposit must be > 0');
    if (parsedAmount !== event.depositAtomic) {
      reject(CODES.WRONG_AMOUNT, `amount must equal the fixed deposit ${event.depositAtomicString}`);
    }
    const beneficiary = beneficiaryAccount ?? participantAccount;
    assertNonEmptyString(beneficiary, 'beneficiaryAccount');
    if (beneficiary !== participantAccount) {
      reject(CODES.IDENTITY_MISMATCH, 'beneficiary must equal the verified participant account');
    }
    if (storagePrepaid !== true) {
      reject(CODES.STORAGE_NOT_PREPAID, 'FT/NFT storage and gas must be preflighted before the seat commitment');
    }
    const commitmentKey = `${participantAccount}\u0000${commitmentId}`;
    if (event.commitments.has(commitmentKey)) {
      reject(CODES.DUPLICATE_COMMITMENT, 'commitment_id was already used by this payer');
    }
    for (const registrationId of event.registrationIds) {
      const existing = this._getRegistration(registrationId);
      if (existing.participantAccount === participantAccount && existing.state !== 'WITHDRAWN') {
        reject(CODES.DUPLICATE_ACTIVE_REGISTRATION, 'account already has an active registration for this event');
      }
    }
    if (event.activeCount >= event.capacity) reject(CODES.EVENT_FULL, 'event is at capacity');
    if (event.ledger.accepted + parsedAmount > U128_MAX) {
      reject(CODES.ATOMIC_OVERFLOW, 'accepted principal would overflow u128');
    }
    const nextAccepted = event.ledger.accepted + parsedAmount;

    // -------- all validations passed: one atomic mutation block --------
    this._registrationCounter += 1;
    this._passCounter += 1;
    const registrationId = `reg-${this._registrationCounter}`;
    const registrationSequence = event.registrationIds.length;
    const issuedPassId = passId ?? `pass-${this._passCounter}`;
    assertOrFail(typeof issuedPassId === 'string' && issuedPassId.length > 0, CODES.RULES_INVALID, 'passId must be non-empty');
    if (this.passes.has(issuedPassId)) fail(CODES.RULES_INVALID, 'passId already exists', { passId: issuedPassId });

    const registration = {
      registrationId,
      eventId,
      sequenceNo: registrationSequence,
      participantAccount,
      beneficiaryAccount: participantAccount,
      commitmentId,
      principalAtomic: parsedAmount,
      state: 'COMMITTED',
      attended: false,
      entitlementSet: false,
      claimAtomic: 0n,
      payoutState: 'NOT_CLAIMABLE',
      pendingAtomic: 0n,
      paidAtomic: 0n,
      passId: issuedPassId,
      committedAt: now,
      refundReason: null,
      refundAt: null,
    };
    const pass = {
      passId: issuedPassId,
      eventId,
      registrationId,
      ownerAccount: participantAccount,
      issuedAt: now,
      status: 'ACTIVE',
      attendanceStatus: 'NOT_ATTENDED',
      financialStatus: 'COMMITTED',
      policyVersion: event.policyVersion,
      checkinValid: true,
      metadata: { noPii: true, provesRegistrationNotPresence: true },
    };

    this.registrations.set(registrationId, registration);
    this.passes.set(issuedPassId, pass);
    event.registrationIds.push(registrationId);
    event.activeCount += 1;
    event.commitments.add(commitmentKey);
    this._ledgerAdd(event, 'accepted', parsedAmount);
    this._ledgerAdd(event, 'liability', parsedAmount);
    this.assertConservation(eventId);

    return {
      registrationId,
      passId: issuedPassId,
      eventId,
      sequenceNo: registrationSequence,
      ownerAccount: participantAccount,
      beneficiaryAccount: participantAccount,
      amountAtomic: amountJson(parsedAmount),
      registrationStatus: registration.state,
      passStatus: pass.status,
      sameReceipt: true,
    };
  }

  /** Any plain ft_transfer to escrow fabricates no entitlement. */
  plainTransferToEscrow({ eventId, payerAccount, amount, tokenContract }) {
    const event = this._getEvent(eventId);
    assertNonEmptyString(payerAccount, 'payerAccount');
    const parsed = assertAtomic(amount, 'amount');
    const tokenMismatch = tokenContract !== undefined && tokenContract !== event.assetContract;
    fail(
      CODES.UNSUPPORTED_TRANSFER,
      'plain ft_transfer cannot create a seat or principal; only ft_transfer_call with exact rules is accepted',
      {
        eventId,
        payerAccount,
        amountAtomic: parsed.toString(),
        tokenMismatch,
        disposal: 'QUARANTINE_EXPLAIN',
        treatedAsPrincipal: false,
        seatGranted: false,
        passIssued: false,
      },
    );
  }

  // ------------------------------------------------------------- attendance

  markAttendance({ eventId, registrationId, attended, actor, now }) {
    const event = this._getEvent(eventId);
    assertEpochMs(now, 'now');
    if (actor !== event.organizerAccount) {
      fail(CODES.UNAUTHORIZED_ORGANIZER, 'only the organizer account may attest attendance', { eventId, actor });
    }
    if (event.state === 'ATTENDANCE_FINALIZED' || event.state === 'SETTLING' || event.state === 'SETTLED') {
      fail(CODES.ATTENDANCE_FROZEN, 'attendance is frozen after finalization', { eventId, state: event.state });
    }
    if (event.state !== 'PUBLISHED') {
      fail(CODES.PHASE_DENIED, `event is ${event.state}`, { eventId, state: event.state });
    }
    if (!(now >= event.times.checkinOpen && now < event.times.checkinClose)) {
      fail(CODES.PHASE_DENIED, 'check-in is not open at this block time', { now, times: event.times });
    }
    const reg = this._getRegistration(registrationId);
    if (reg.eventId !== eventId) fail(CODES.REGISTRATION_EVENT_MISMATCH, 'registration belongs to another event', { eventId, registrationId });
    if (reg.state === 'WITHDRAWN') fail(CODES.REGISTRATION_WITHDRAWN, 'withdrawn registration cannot be marked', { registrationId });
    assertOrFail(typeof attended === 'boolean', CODES.RULES_INVALID, 'attended must be boolean');
    reg.attended = attended;
    reg.state = attended ? 'ATTENDED' : 'COMMITTED';
    const pass = this.passes.get(reg.passId);
    if (pass) pass.attendanceStatus = attended ? 'ATTENDED' : 'NOT_ATTENDED';
    return { registrationId, attended, state: reg.state };
  }

  finalizeAttendance({ eventId, actor, now }) {
    const event = this._getEvent(eventId);
    assertEpochMs(now, 'now');
    if (actor !== event.organizerAccount) {
      fail(CODES.UNAUTHORIZED_ORGANIZER, 'only the organizer account may finalize attendance', { eventId, actor });
    }
    if (event.state === 'ATTENDANCE_FINALIZED' || event.state === 'SETTLING' || event.state === 'SETTLED') {
      fail(CODES.ATTENDANCE_FROZEN, 'attendance already finalized', { eventId, state: event.state });
    }
    if (event.state !== 'PUBLISHED') fail(CODES.INVALID_TRANSITION, `cannot finalize from ${event.state}`, { eventId, state: event.state });
    if (now >= event.times.finalizeDeadline) {
      fail(CODES.LATE_FINALIZATION, 'finalization deadline reached; only refund-only remains', {
        now,
        finalizeDeadline: event.times.finalizeDeadline,
      });
    }
    if (now < event.times.checkinClose) {
      fail(CODES.PHASE_DENIED, 'finalization opens at checkin_close', { now, checkinClose: event.times.checkinClose });
    }

    let attended = 0;
    let noShow = 0;
    for (const registrationId of event.registrationIds) {
      const reg = this._getRegistration(registrationId);
      if (reg.state === 'WITHDRAWN') continue;
      const pass = this.passes.get(reg.passId);
      if (reg.attended) {
        reg.state = 'ATTENDED';
        attended += 1;
        if (pass) pass.attendanceStatus = 'ATTENDED';
      } else {
        reg.state = 'NO_SHOW';
        noShow += 1;
        if (pass) pass.attendanceStatus = 'NO_SHOW';
      }
    }
    event.state = 'ATTENDANCE_FINALIZED';
    event.finalizedAt = now;
    this.assertConservation(eventId);
    return { eventId, state: event.state, attended, noShow, active: attended + noShow };
  }

  checkinEligibility({ passId, now }) {
    assertEpochMs(now, 'now');
    const pass = this._getPass(passId);
    const reg = this._getRegistration(pass.registrationId);
    const event = this._getEvent(pass.eventId);
    if (!pass.checkinValid || reg.state === 'WITHDRAWN') return { eligible: false, reason: 'PASS_WITHDRAWN' };
    if (event.state !== 'PUBLISHED') return { eligible: false, reason: 'EVENT_NOT_PUBLISHED' };
    if (now < event.times.checkinOpen) return { eligible: false, reason: 'CHECKIN_NOT_OPEN' };
    if (now >= event.times.checkinClose) return { eligible: false, reason: 'CHECKIN_CLOSED' };
    return { eligible: true, reason: 'OK', ownerAccount: pass.ownerAccount };
  }

  // ------------------------------------------------------------- withdrawal

  withdrawRegistration({ eventId, registrationId, actor, now }) {
    const event = this._getEvent(eventId);
    assertEpochMs(now, 'now');
    const reg = this._getRegistration(registrationId);
    if (reg.eventId !== eventId) fail(CODES.REGISTRATION_EVENT_MISMATCH, 'registration belongs to another event', { eventId, registrationId });
    if (actor !== reg.participantAccount) {
      fail(CODES.UNAUTHORIZED_PARTICIPANT, 'only the immutable participant/owner may withdraw', { registrationId, actor });
    }
    if (reg.state === 'WITHDRAWN') fail(CODES.REGISTRATION_WITHDRAWN, 'registration already withdrawn', { registrationId });
    if (event.state !== 'PUBLISHED') fail(CODES.PHASE_DENIED, `withdrawal is not available in ${event.state}`, { eventId, state: event.state });
    if (!(now < event.times.cancelCutoff)) {
      fail(CODES.WITHDRAWAL_WINDOW_CLOSED, 'voluntary withdrawal must occur before cancel_cutoff', {
        now,
        cancelCutoff: event.times.cancelCutoff,
      });
    }

    reg.state = 'WITHDRAWN';
    reg.attended = false;
    reg.entitlementSet = true;
    reg.claimAtomic = event.depositAtomic;
    reg.payoutState = 'CLAIMABLE';
    reg.withdrawnAt = now;
    event.activeCount -= 1;
    const pass = this.passes.get(reg.passId);
    if (pass) {
      pass.status = 'WITHDRAWN';
      pass.checkinValid = false;
      pass.attendanceStatus = 'WITHDRAWN';
      pass.financialStatus = 'CLAIMABLE';
    }
    this.assertConservation(eventId);
    return {
      registrationId,
      state: reg.state,
      claimAtomic: amountJson(reg.claimAtomic),
      payoutState: reg.payoutState,
      seatFreed: true,
      passInvalidForCheckin: true,
      activeCount: event.activeCount,
    };
  }

  // ------------------------------------------------- cancellation / timeout

  cancelEvent({ eventId, actor, now }) {
    const event = this._getEvent(eventId);
    assertEpochMs(now, 'now');
    if (actor !== event.organizerAccount) {
      fail(CODES.UNAUTHORIZED_ORGANIZER, 'only the organizer may cancel', { eventId, actor });
    }
    if (event.state === 'SETTLING') fail(CODES.CANCELLATION_LOCKED, 'cancellation is locked once SETTLING begins', { eventId });
    if (event.state === 'SETTLED' || event.state === 'CANCELLED' || event.state === 'REFUND_ONLY') {
      fail(CODES.CANCELLATION_TOO_LATE, `cannot cancel from ${event.state}`, { eventId, state: event.state });
    }
    assertOrFail(
      event.state === 'PUBLISHED' || event.state === 'ATTENDANCE_FINALIZED',
      CODES.INVALID_TRANSITION,
      `cannot cancel from ${event.state}`,
    );
    const refund = this._applyFullPrincipalRefund(event, now, 'CANCELLED');
    event.state = 'CANCELLED';
    event.cancelledAt = now;
    this.assertConservation(eventId);
    return {
      eventId,
      state: event.state,
      refundedRegistrations: refund.count,
      newClaimTotal: amountJson(refund.claimTotal),
      claimTotal: amountJson(event.ledger.liability),
      reward: '0',
    };
  }

  activateTimeoutRefund({ eventId, actor = 'anyone', now, deadlineMode }) {
    const event = this._getEvent(eventId);
    assertEpochMs(now, 'now');
    assertNonEmptyString(actor, 'actor');
    if (event.state === 'REFUND_ONLY') fail(CODES.INVALID_TRANSITION, 'refund-only already active', { eventId });
    if (event.state === 'ATTENDANCE_FINALIZED' || event.state === 'SETTLING' || event.state === 'SETTLED') {
      fail(CODES.REFUND_ONLY_DENIED, 'finalized event must settle, not switch to refund-only', {
        eventId,
        state: event.state,
      });
    }
    if (event.state !== 'PUBLISHED') fail(CODES.INVALID_TRANSITION, `cannot activate from ${event.state}`, { eventId, state: event.state });

    const mode = deadlineMode ?? POLICY.REFUND_ONLY_DEADLINE_MODE;
    assertOrFail(mode === 'AT_OR_AFTER' || mode === 'AFTER', CODES.RULES_INVALID, 'deadlineMode must be AT_OR_AFTER or AFTER');
    const reached = mode === 'AT_OR_AFTER' ? now >= event.times.finalizeDeadline : now > event.times.finalizeDeadline;
    // Boundary interpretation is recorded as OG-01: the packet says "after deadline"
    // while finalization is already denied at now == deadline.
    if (!reached) {
      fail(CODES.PHASE_DENIED, 'refund-only activates at/after the finalization deadline', {
        now,
        finalizeDeadline: event.times.finalizeDeadline,
        mode,
      });
    }
    const refund = this._applyFullPrincipalRefund(event, now, 'REFUND_ONLY');
    event.state = 'REFUND_ONLY';
    event.refundOnlyAt = now;
    this.assertConservation(eventId);
    return {
      eventId,
      state: event.state,
      activatedBy: actor,
      permissionless: true,
      deadlineMode: mode,
      refundedRegistrations: refund.count,
      newClaimTotal: amountJson(refund.claimTotal),
      claimTotal: amountJson(event.ledger.liability),
    };
  }

  // -------------------------------------------------------------- settlement

  settle({ eventId, actor = 'anyone', now, chunkSize }) {
    const event = this._getEvent(eventId);
    assertEpochMs(now, 'now');
    assertNonEmptyString(actor, 'actor');
    let limit = null;
    if (chunkSize !== undefined && chunkSize !== null) {
      assertOrFail(Number.isInteger(chunkSize) && chunkSize > 0, CODES.RULES_INVALID, 'chunkSize must be a positive integer');
      limit = chunkSize;
    }

    if (event.state === 'SETTLED') fail(CODES.SETTLEMENT_COMPLETE, 'event already settled', { eventId });
    if (event.state === 'PUBLISHED') fail(CODES.PHASE_DENIED, 'attendance must be finalized before settlement', { eventId });
    if (event.state === 'CANCELLED' || event.state === 'REFUND_ONLY') {
      fail(CODES.PHASE_DENIED, `cannot settle from ${event.state}`, { eventId, state: event.state });
    }
    assertOrFail(event.state === 'ATTENDANCE_FINALIZED' || event.state === 'SETTLING', CODES.INVALID_TRANSITION, `cannot settle from ${event.state}`);

    if (event.state === 'ATTENDANCE_FINALIZED') {
      const allocation = computeAllocation({
        deposit: event.depositAtomic,
        registrations: this._registrationInputs(event),
      });
      const plan = allocation.entries.filter((entry) => entry.kind !== 'WITHDRAWN');
      event.settlement = {
        allocation,
        plan,
        cursor: 0,
        startedAt: now,
        startedBy: actor,
        completedAt: null,
      };
      event.state = 'SETTLING';
    }

    const settlement = event.settlement;
    const result = this._applySettlementEntries(event, limit, now);
    return {
      ...result,
      startedBy: settlement.startedBy,
      actor,
      permissionless: true,
      now,
    };
  }

  /** Contract-style frozen-cursor chunk. Replaying an already-applied offset is a no-op. */
  settleChunk({ eventId, offset, limit, actor = 'anyone', now }) {
    const event = this._getEvent(eventId);
    assertEpochMs(now, 'now');
    if (event.state === 'SETTLED') fail(CODES.SETTLEMENT_COMPLETE, 'event already settled', { eventId });
    if (event.state !== 'SETTLING' || event.settlement === null) {
      fail(CODES.SETTLEMENT_NOT_STARTED, 'settlement has not started', { eventId, state: event.state });
    }
    assertOrFail(Number.isInteger(offset) && offset >= 0, CODES.RULES_INVALID, 'offset must be a non-negative integer');
    assertOrFail(Number.isInteger(limit) && limit > 0, CODES.RULES_INVALID, 'limit must be a positive integer');
    assertNonEmptyString(actor, 'actor');
    const settlement = event.settlement;
    if (offset < settlement.cursor) {
      return {
        settled: false,
        alreadyApplied: true,
        cursor: settlement.cursor,
        totalEntries: settlement.plan.length,
        remaining: settlement.plan.length - settlement.cursor,
        replayOf: offset,
      };
    }
    if (offset > settlement.cursor) {
      fail(CODES.CURSOR_GAP, 'cursor gap: chunks must be applied in order', {
        offset,
        cursor: settlement.cursor,
      });
    }
    const result = this._applySettlementEntries(event, limit, now);
    return { ...result, actor, now, alreadyApplied: false };
  }

  // ------------------------------------------------------------------ claims

  claim({ eventId, registrationId, beneficiary, payoutId, now }) {
    const event = this._getEvent(eventId);
    assertEpochMs(now, 'now');
    const reg = this._getRegistration(registrationId);
    if (reg.eventId !== eventId) {
      fail(CODES.REGISTRATION_EVENT_MISMATCH, 'registration does not belong to this event', { eventId, registrationId });
    }
    assertNonEmptyString(beneficiary, 'beneficiary');
    if (beneficiary !== reg.beneficiaryAccount) {
      fail(CODES.UNAUTHORIZED_CLAIMANT, 'claim receiver must be the immutable beneficiary', {
        registrationId,
        beneficiary,
        immutableBeneficiary: reg.beneficiaryAccount,
      });
    }
    if (event.state === 'SETTLING') {
      fail(CODES.CLAIMS_DISABLED, 'claims are disabled until allocation completes', { eventId });
    }
    if (reg.payoutState === 'PENDING') {
      fail(CODES.CLAIM_ALREADY_PENDING, 'one pending payout per registration', {
        registrationId,
        pendingPayoutId: reg.pendingPayoutId,
      });
    }
    if (reg.payoutState === 'PAID') fail(CODES.CLAIM_ALREADY_PAID, 'claim already paid', { registrationId });
    if (reg.payoutState === 'ZERO') fail(CODES.NOTHING_TO_CLAIM, 'no-show allocation is zero', { registrationId });
    if (reg.payoutState === 'NOT_CLAIMABLE') {
      fail(CODES.NOT_CLAIMABLE, 'registration has no claimable allocation yet', { registrationId, eventState: event.state });
    }
    assertOrFail(reg.payoutState === 'CLAIMABLE', CODES.NOT_CLAIMABLE, 'registration is not claimable', { payoutState: reg.payoutState });
    if (reg.claimAtomic === 0n) fail(CODES.NOTHING_TO_CLAIM, 'claim amount is zero', { registrationId });

    const resolvedPayoutId = payoutId ?? `payout-${this._payoutCounter + 1}`;
    assertNonEmptyString(resolvedPayoutId, 'payoutId');
    const eventIds = this.eventPayoutIds.get(eventId);
    if (eventIds.has(resolvedPayoutId)) {
      fail(CODES.DUPLICATE_PAYOUT_ID, 'payout_id already used in this event', { eventId, payoutId: resolvedPayoutId });
    }

    const amount = reg.claimAtomic;
    this._payoutCounter += 1;
    this._ledgerSub(event, 'liability', amount);
    this._ledgerAdd(event, 'pending', amount);
    reg.pendingAtomic = amount;
    reg.payoutState = 'PENDING';
    reg.pendingPayoutId = resolvedPayoutId;
    const pass = this.passes.get(reg.passId);
    if (pass) pass.financialStatus = 'PENDING';
    const payout = {
      payoutId: resolvedPayoutId,
      eventId,
      registrationId,
      recipientAccount: reg.beneficiaryAccount,
      amountAtomic: amount,
      state: 'PENDING',
      reservedAt: now,
      resolvedAt: null,
      receiptId: null,
    };
    this.payouts.set(this._payoutKey(eventId, resolvedPayoutId), payout);
    eventIds.add(resolvedPayoutId);
    this.assertConservation(eventId);
    return {
      payoutId: resolvedPayoutId,
      eventId,
      registrationId,
      recipientAccount: payout.recipientAccount,
      amountAtomic: amountJson(amount),
      state: payout.state,
    };
  }

  /** Private FT transfer callback. Only the contract itself may call. */
  onPayoutResult({ eventId, payoutId, success, caller, receiptId = null, now }) {
    assertEpochMs(now, 'now');
    if (caller !== this.contractId) {
      fail(CODES.UNAUTHORIZED_CALLBACK, 'only the contract self-call may resolve a payout', { caller, expected: this.contractId });
    }
    const payout = this.payouts.get(this._payoutKey(eventId, payoutId));
    if (!payout || payout.eventId !== eventId) {
      fail(CODES.PAYOUT_UNKNOWN, 'payout not found for this event', { eventId, payoutId });
    }
    if (payout.state !== 'PENDING') {
      fail(CODES.CALLBACK_STALE, 'callback target is no longer pending; exactly-once resolution', {
        payoutId,
        state: payout.state,
      });
    }
    assertOrFail(typeof success === 'boolean', CODES.RULES_INVALID, 'success must be boolean');
    const event = this._getEvent(eventId);
    const reg = this._getRegistration(payout.registrationId);
    const amount = payout.amountAtomic;
    if (success) {
      this._ledgerSub(event, 'pending', amount);
      this._ledgerAdd(event, 'paid', amount);
      reg.pendingAtomic = 0n;
      reg.paidAtomic = checkedAdd(reg.paidAtomic, amount, 'paid');
      reg.payoutState = 'PAID';
      reg.pendingPayoutId = null;
      payout.state = 'SUCCEEDED';
      payout.receiptId = receiptId;
      const pass = this.passes.get(reg.passId);
      if (pass) pass.financialStatus = 'PAID';
    } else {
      this._ledgerSub(event, 'pending', amount);
      this._ledgerAdd(event, 'liability', amount);
      reg.pendingAtomic = 0n;
      reg.payoutState = 'CLAIMABLE';
      reg.pendingPayoutId = null;
      payout.state = 'FAILED';
      payout.receiptId = receiptId;
      const failedPass = this.passes.get(reg.passId);
      if (failedPass) failedPass.financialStatus = 'CLAIMABLE';
      // A failed payout never restores a withdrawn registration (CIT-WITHDRAW).
    }
    payout.resolvedAt = now;
    this.assertConservation(eventId);
    return {
      payoutId,
      eventId,
      registrationId: reg.registrationId,
      payoutState: payout.state,
      registrationState: reg.state,
      registrationPayoutState: reg.payoutState,
      amountAtomic: amountJson(amount),
      recipientAccount: payout.recipientAccount,
    };
  }

  // ------------------------------------------------------- pass immutability

  transferPass({ passId, from, to }) {
    const pass = this._getPass(passId);
    fail(CODES.TRANSFER_FORBIDDEN, 'ordinary transfer is permanently rejected; pass is account-bound', {
      passId,
      ownerAccount: pass.ownerAccount,
      from,
      to,
    });
  }

  approvePass({ passId, approvedAccount }) {
    const pass = this._getPass(passId);
    fail(CODES.APPROVAL_FORBIDDEN, 'approval paths are permanently rejected', {
      passId,
      ownerAccount: pass.ownerAccount,
      approvedAccount,
    });
  }

  adminReassignPass({ passId, to }) {
    const pass = this._getPass(passId);
    fail(CODES.ADMIN_REASSIGN_FORBIDDEN, 'admin reassignment is not part of v2', { passId, ownerAccount: pass.ownerAccount, to });
  }

  reassignBeneficiary({ registrationId, to }) {
    const reg = this._getRegistration(registrationId);
    if (to === reg.beneficiaryAccount) {
      return { registrationId, beneficiaryAccount: reg.beneficiaryAccount, changed: false };
    }
    fail(CODES.IMMUTABLE_BENEFICIARY, 'beneficiary is immutable for the registration lifetime', {
      registrationId,
      current: reg.beneficiaryAccount,
      proposed: to,
    });
  }

  /** App login relinking never moves onchain rights. */
  relinkLogin({ registrationId, provider, subject }) {
    const reg = this._getRegistration(registrationId);
    assertNonEmptyString(provider, 'provider');
    assertNonEmptyString(subject, 'subject');
    const pass = this._getPass(reg.passId);
    return {
      registrationId,
      appLink: { provider, subject },
      ownerAccount: pass.ownerAccount,
      beneficiaryAccount: reg.beneficiaryAccount,
      rightsChanged: false,
    };
  }

  // ------------------------------------------------------------------- views

  eventView(eventId) {
    const event = this._getEvent(eventId);
    let active = 0;
    let withdrawn = 0;
    let attended = 0;
    for (const registrationId of event.registrationIds) {
      const reg = this._getRegistration(registrationId);
      if (reg.state === 'WITHDRAWN') withdrawn += 1;
      else {
        active += 1;
        if (reg.attended) attended += 1;
      }
    }
    return {
      eventId,
      organizerAccount: event.organizerAccount,
      assetContract: event.assetContract,
      decimals: event.decimals,
      depositAtomic: event.depositAtomicString,
      capacity: event.capacity,
      times: { ...event.times },
      policyVersion: event.policyVersion,
      rulesHash: event.rulesHash,
      content: { ...event.content },
      state: event.state,
      counts: { registrations: event.registrationIds.length, active, withdrawn, attended, activeCapacityUsed: event.activeCount },
      totals: {
        acceptedAtomic: amountJson(event.ledger.accepted),
        paidAtomic: amountJson(event.ledger.paid),
        pendingAtomic: amountJson(event.ledger.pending),
        liabilityAtomic: amountJson(event.ledger.liability),
      },
    };
  }

  registrationView(registrationId) {
    const reg = this._getRegistration(registrationId);
    return {
      registrationId,
      eventId: reg.eventId,
      sequenceNo: reg.sequenceNo,
      participantAccount: reg.participantAccount,
      beneficiaryAccount: reg.beneficiaryAccount,
      commitmentId: reg.commitmentId,
      principalAtomic: amountJson(reg.principalAtomic),
      state: reg.state,
      attended: reg.attended,
      claimAtomic: amountJson(reg.claimAtomic),
      entitlementSet: reg.entitlementSet,
      payoutState: reg.payoutState,
      pendingAtomic: amountJson(reg.pendingAtomic),
      paidAtomic: amountJson(reg.paidAtomic),
      passId: reg.passId,
      pendingPayoutId: reg.pendingPayoutId ?? null,
    };
  }

  passView(passId) {
    const pass = this._getPass(passId);
    return {
      passId,
      eventId: pass.eventId,
      registrationId: pass.registrationId,
      ownerAccount: pass.ownerAccount,
      issuedAt: pass.issuedAt,
      status: pass.status,
      attendanceStatus: pass.attendanceStatus,
      financialStatus: pass.financialStatus,
      policyVersion: pass.policyVersion,
      checkinValid: pass.checkinValid,
      metadata: { ...pass.metadata },
    };
  }

  /**
   * View a payout. Prefer `payoutView(payoutId, eventId)` because payout ids
   * are event-scoped. Without eventId, an id reused across events is ambiguous.
   */
  payoutView(payoutId, eventId) {
    let payout;
    if (eventId !== undefined) {
      payout = this.payouts.get(this._payoutKey(eventId, payoutId));
    } else {
      const matches = [...this.payouts.values()].filter((candidate) => candidate.payoutId === payoutId);
      if (matches.length > 1) {
        fail(CODES.DUPLICATE_PAYOUT_ID, `payout ${payoutId} is ambiguous across events; pass eventId`, {
          payoutId,
          eventIds: matches.map((candidate) => candidate.eventId),
        });
      }
      payout = matches[0];
    }
    if (!payout) fail(CODES.PAYOUT_UNKNOWN, `payout ${payoutId} not found`, { payoutId, eventId: eventId ?? null });
    return {
      payoutId,
      eventId: payout.eventId,
      registrationId: payout.registrationId,
      recipientAccount: payout.recipientAccount,
      amountAtomic: amountJson(payout.amountAtomic),
      state: payout.state,
      receiptId: payout.receiptId,
    };
  }

  ledgerView(eventId) {
    const event = this._getEvent(eventId);
    return {
      eventId,
      acceptedAtomic: amountJson(event.ledger.accepted),
      paidAtomic: amountJson(event.ledger.paid),
      pendingAtomic: amountJson(event.ledger.pending),
      liabilityAtomic: amountJson(event.ledger.liability),
      state: event.state,
    };
  }

  allocationView(eventId) {
    const event = this._getEvent(eventId);
    const rows = event.registrationIds.map((registrationId) => {
      const reg = this._getRegistration(registrationId);
      return {
        registrationId,
        sequenceNo: reg.sequenceNo,
        state: reg.state,
        attended: reg.attended,
        claimAtomic: amountJson(reg.claimAtomic),
        payoutState: reg.payoutState,
      };
    });
    return { eventId, state: event.state, rows };
  }

  // ----------------------------------------------------------- conservation

  /** Recompute the per-event invariant from registration rows and counters. */
  assertConservation(eventId) {
    const event = this._getEvent(eventId);
    let accepted = 0n;
    let paid = 0n;
    let pending = 0n;
    let liability = 0n;
    for (const registrationId of event.registrationIds) {
      const reg = this._getRegistration(registrationId);
      accepted = checkedAdd(accepted, reg.principalAtomic, 'accepted recompute');
      if (reg.payoutState === 'PAID') paid = checkedAdd(paid, reg.paidAtomic, 'paid recompute');
      if (reg.payoutState === 'PENDING') pending = checkedAdd(pending, reg.pendingAtomic, 'pending recompute');
      const entitlement = this._entitlementOf(reg);
      // Plain bigint: during SETTLING this intermediate sum can legitimately
      // exceed u128 (an attendee share is booked before no-show principal is
      // zeroed), but it is never a ledger value.
      liability += entitlement;
    }
    assertOrFail(accepted === event.ledger.accepted, CODES.CONSERVATION_BROKEN, 'accepted principal mismatch', {
      eventId,
      recomputed: accepted.toString(),
      counter: event.ledger.accepted.toString(),
    });
    assertOrFail(paid === event.ledger.paid, CODES.CONSERVATION_BROKEN, 'paid mismatch', {
      eventId,
      recomputed: paid.toString(),
      counter: event.ledger.paid.toString(),
    });
    assertOrFail(pending === event.ledger.pending, CODES.CONSERVATION_BROKEN, 'pending mismatch', {
      eventId,
      recomputed: pending.toString(),
      counter: event.ledger.pending.toString(),
    });
    // Mid-settlement the per-registration entitlements temporarily exceed the
    // accepted total: an attendee's share is booked before the corresponding
    // no-show principal is zeroed. The exact sum is verified at completion in
    // _completeSettlement; the ledger identity below must hold throughout.
    if (event.state !== 'SETTLING') {
      assertOrFail(liability === event.ledger.liability, CODES.CONSERVATION_BROKEN, 'liability mismatch', {
        eventId,
        recomputed: liability.toString(),
        counter: event.ledger.liability.toString(),
      });
    }
    const rhs = event.ledger.paid + event.ledger.pending + event.ledger.liability;
    assertOrFail(accepted === rhs, CODES.CONSERVATION_BROKEN, 'accepted != paid + pending + liability', {
      eventId,
      accepted: accepted.toString(),
      paid: event.ledger.paid.toString(),
      pending: event.ledger.pending.toString(),
      liability: event.ledger.liability.toString(),
    });
    return {
      eventId,
      acceptedAtomic: amountJson(event.ledger.accepted),
      paidAtomic: amountJson(event.ledger.paid),
      pendingAtomic: amountJson(event.ledger.pending),
      liabilityAtomic: amountJson(event.ledger.liability),
      balanced: true,
    };
  }

  /** Aggregate conservation plus per-event isolation checks. */
  globalConservation() {
    let accepted = 0n;
    let paid = 0n;
    let pending = 0n;
    let liability = 0n;
    const perEvent = [];
    for (const eventId of this.events.keys()) {
      const view = this.assertConservation(eventId);
      perEvent.push(view);
      accepted += BigInt(view.acceptedAtomic);
      paid += BigInt(view.paidAtomic);
      pending += BigInt(view.pendingAtomic);
      liability += BigInt(view.liabilityAtomic);
    }
    const rhs = paid + pending + liability;
    assertOrFail(accepted === rhs, CODES.CONSERVATION_BROKEN, 'global conservation broken', {
      accepted: accepted.toString(),
      paid: paid.toString(),
      pending: pending.toString(),
      liability: liability.toString(),
    });
    // A payout may only debit the event whose registration it belongs to.
    for (const payout of this.payouts.values()) {
      const reg = this._getRegistration(payout.registrationId);
      assertOrFail(payout.eventId === reg.eventId, CODES.CONSERVATION_BROKEN, 'payout crosses event boundary', {
        payoutId: payout.payoutId,
      });
      assertOrFail(payout.recipientAccount === reg.beneficiaryAccount, CODES.CONSERVATION_BROKEN, 'payout recipient is not beneficiary', {
        payoutId: payout.payoutId,
      });
    }
    return {
      totals: {
        acceptedAtomic: amountJson(accepted),
        paidAtomic: amountJson(paid),
        pendingAtomic: amountJson(pending),
        liabilityAtomic: amountJson(liability),
      },
      perEvent,
      balanced: true,
    };
  }
}

export { EVENT_STATES, NON_WITHDRAWN, TERMINAL_STATES };
