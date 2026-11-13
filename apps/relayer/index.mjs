const ACTIONS = Object.freeze({
  CLOSE_REGISTRATION: 'close_registration',
  START_YIELD: 'start_yield',
  PREPARE_REDEEM: 'prepare_redeem',
  FINISH_REDEEM: 'finish_redeem',
  FINALIZE_SETTLE: 'finalize_settle'
});

// Pure proposal only. Candidate actions call escrow, never the provider directly.
export function planCandidateAction(snapshot, nowMs) {
  time(nowMs, 'nowMs');
  const contractId = 'showstake-mainnet-escrow-endpx-2026.near';
  if (snapshot?.contractId !== contractId || snapshot.codeHash !== 'CpnhymSeF785ZBVTaBZfW8ApsfMVUByNCrys8R2i8os' || snapshot.policyVersion !== 'showstake-native-usdc-rhea-review/1' || snapshot.finalized !== true || snapshot.stale !== false) throw new RelayerError('UNTRUSTED_SNAPSHOT', 'fresh finalized pinned candidate snapshot required');
  const e = snapshot.event;
  if (e == null) return null;
  const control = snapshot.control;
  if (!control || typeof control.paused !== 'boolean') throw new RelayerError('INVALID_CONFIG', 'candidate pause state required');
  const cap = BigInt(atomic(control.principal_cap, 'principal_cap'));
  const principal = BigInt(atomic(e.accepted_principal, 'accepted_principal'));
  for (const key of ['reg_close','checkin_close','finalize_deadline']) time(e[key], key);
  let method = null;
  if (e.phase === 'RegistrationOpen' && nowMs >= e.finalize_deadline) method = 'activate_timeout_refund';
  else if (e.phase === 'RegistrationOpen' && nowMs >= e.reg_close) method = 'close_registration';
  else if (e.phase === 'RegistrationClosed' && nowMs >= e.finalize_deadline) method = 'activate_timeout_refund';
  else if (e.phase === 'RegistrationClosed' && e.earn_state === 'NotStarted' && !control.paused && principal > 0n && principal <= cap) method = 'trigger_earn_supply';
  else if (['Cancelled','RefundOnly','AttendanceFinalized'].includes(e.phase) && e.earn_state === 'Supplied' && (e.phase !== 'AttendanceFinalized' || nowMs >= e.checkin_close)) method = 'trigger_earn_redeem';
  else if (e.phase === 'AttendanceFinalized' && e.earn_state === 'Redeemed') method = 'settle';
  if (!method) return null;
  const args = method === 'activate_timeout_refund' ? { event_id: required(e.event_id, 'event_id') } : {};
  return Object.freeze({ target: contractId, method, args, dryRun: true, broadcasted: false, providerStatus: 'UNVERIFIED' });
}

const ORDER = Object.values(ACTIONS);
const STATES = Object.freeze({
  REGISTRATION_OPEN: 'REGISTRATION_OPEN',
  REGISTRATION_CLOSED: 'REGISTRATION_CLOSED',
  YIELD_ACTIVE: 'YIELD_ACTIVE',
  REDEEM_PREPARED: 'REDEEM_PREPARED',
  REDEEM_PENDING: 'REDEEM_PENDING',
  REDEEMED: 'REDEEMED',
  SETTLEMENT_OPEN: 'SETTLEMENT_OPEN'
});

const ACTION_TO_METHOD = Object.freeze({
  [ACTIONS.CLOSE_REGISTRATION]: 'close_registration',
  [ACTIONS.START_YIELD]: 'start_yield',
  [ACTIONS.PREPARE_REDEEM]: 'prepare_redeem',
  [ACTIONS.FINISH_REDEEM]: 'finish_redeem',
  [ACTIONS.FINALIZE_SETTLE]: 'finalize_event'
});

export class RelayerError extends Error {
  constructor(code, message) { super(message); this.name = 'RelayerError'; this.code = code; }
}

function atomic(value, label) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new RelayerError('INVALID_ATOMIC', `${label} must be a canonical atomic integer string`);
  }
  return value;
}
function time(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RelayerError('INVALID_TIME', `${label} must be a non-negative safe integer`);
  return value;
}
function required(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new RelayerError('INVALID_CONFIG', `${label} is required`);
  return value;
}

export function verifyRheaProvider(config) {
  if (!config || config.verified !== true) throw new RelayerError('PROVIDER_UNVERIFIED', 'Rhea provider verification is required');
  for (const key of ['network', 'usdcAccount', 'lendingAccount', 'codeHash', 'abiRevision', 'receiptAsset']) required(config[key], `provider.${key}`);
  if (!config.methods || typeof config.methods.supply !== 'string' || typeof config.methods.redeem !== 'string') {
    throw new RelayerError('PROVIDER_UNVERIFIED', 'verified provider methods are required; no ABI is assumed');
  }
  return Object.freeze({ ...config, methods: Object.freeze({ ...config.methods }) });
}

export function idempotencyKey(eventId, action, attempt) {
  return `${eventId}/${action}/${attempt}`;
}

function actionAllowed(state, action) {
  return {
    [ACTIONS.CLOSE_REGISTRATION]: state === STATES.REGISTRATION_OPEN,
    [ACTIONS.START_YIELD]: state === STATES.REGISTRATION_CLOSED,
    [ACTIONS.PREPARE_REDEEM]: state === STATES.YIELD_ACTIVE,
    [ACTIONS.FINISH_REDEEM]: state === STATES.REDEEM_PREPARED || state === STATES.REDEEM_PENDING,
    [ACTIONS.FINALIZE_SETTLE]: state === STATES.REDEEMED
  }[action] === true;
}

export class RelayerPlanner {
  constructor({ provider, dryRun = true, maxAttempts = 3, baseBackoffMs = 1_000, maxBackoffMs = 60_000, broadcaster = null } = {}) {
    this.provider = verifyRheaProvider(provider);
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new RelayerError('INVALID_CONFIG', 'maxAttempts must be positive');
    this.maxAttempts = maxAttempts;
    this.baseBackoffMs = baseBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.dryRun = dryRun;
    this.broadcaster = broadcaster;
    this.events = new Map();
    this.pending = new Map();
    this.completed = new Set();
  }

  registerEvent(input) {
    const eventId = required(input?.eventId, 'eventId');
    if (this.events.has(eventId)) throw new RelayerError('EVENT_EXISTS', eventId);
    const contractId = required(input?.contractId, 'contractId');
    const registrationCloseMs = time(input.registrationCloseMs, 'registrationCloseMs');
    const startTimeMs = time(input.startTimeMs, 'startTimeMs');
    const endTimeMs = time(input.endTimeMs, 'endTimeMs');
    if (!(registrationCloseMs <= startTimeMs && startTimeMs < endTimeMs)) throw new RelayerError('INVALID_TIMES', 'registrationClose <= start < end is required');
    const principalAtomic = atomic(input.principalAtomic, 'principalAtomic');
    if (BigInt(principalAtomic) === 0n) throw new RelayerError('INVALID_ATOMIC', 'principalAtomic must be positive');
    this.events.set(eventId, { eventId, contractId, registrationCloseMs, startTimeMs, endTimeMs, principalAtomic, redeemedAtomic: null, state: STATES.REGISTRATION_OPEN, attempt: 0, attempts: {}, retryAtMs: 0 });
    return this.snapshot(eventId);
  }

  snapshot(eventId) { const event = this.events.get(eventId); if (!event) throw new RelayerError('EVENT_MISSING', eventId); return Object.freeze({ ...event }); }

  #nextAction(event, nowMs) {
    if (event.state === STATES.REGISTRATION_OPEN && nowMs >= event.registrationCloseMs) return ACTIONS.CLOSE_REGISTRATION;
    if (event.state === STATES.REGISTRATION_CLOSED && nowMs >= event.startTimeMs) return ACTIONS.START_YIELD;
    if (event.state === STATES.YIELD_ACTIVE && nowMs >= event.endTimeMs) return ACTIONS.PREPARE_REDEEM;
    if (event.state === STATES.REDEEM_PREPARED) return ACTIONS.FINISH_REDEEM;
    if (event.state === STATES.REDEEMED) return ACTIONS.FINALIZE_SETTLE;
    return null;
  }

  #payload(event, action, attempt, key) {
    const provider = this.provider;
    const isProvider = action === ACTIONS.START_YIELD || action === ACTIONS.FINISH_REDEEM;
    const target = isProvider ? provider.lendingAccount : event.contractId;
    const method = isProvider ? (action === ACTIONS.START_YIELD ? provider.methods.supply : provider.methods.redeem) : ACTION_TO_METHOD[action];
    const args = action === ACTIONS.START_YIELD
      ? { event_id: event.eventId, amount: event.principalAtomic, idempotency_key: key }
      : action === ACTIONS.PREPARE_REDEEM
        ? { event_id: event.eventId, idempotency_key: key }
        : action === ACTIONS.FINISH_REDEEM
          ? { event_id: event.eventId, receipt_asset: provider.receiptAsset, idempotency_key: key }
          : { event_id: event.eventId, idempotency_key: key };
    return { target, method, args, amountAtomic: action === ACTIONS.START_YIELD ? event.principalAtomic : '0', provider: isProvider ? provider.providerName ?? 'Rhea' : undefined, attempt };
  }

  plan(eventId, nowMs) {
    time(nowMs, 'nowMs');
    const event = this.events.get(eventId); if (!event) throw new RelayerError('EVENT_MISSING', eventId);
    if (event.retryAtMs > nowMs) return null;
    const action = this.#nextAction(event, nowMs); if (!action) return null;
    const pendingKey = `${eventId}:${action}`;
    if (this.pending.has(pendingKey) || this.completed.has(pendingKey)) return null;
    const attempt = (event.attempts[action] ?? 0) + 1;
    if (attempt > this.maxAttempts) return null;
    event.attempts[action] = attempt;
    event.attempt = attempt;
    const key = idempotencyKey(eventId, action, attempt);
    const proposal = Object.freeze({ eventId, action, attempt, idempotencyKey: key, dryRun: this.dryRun, call: this.#payload(event, action, attempt, key) });
    this.pending.set(pendingKey, proposal);
    if (action === ACTIONS.FINISH_REDEEM) event.state = STATES.REDEEM_PENDING;
    return proposal;
  }

  async execute(proposal) {
    if (!proposal || !this.pending.has(`${proposal.eventId}:${proposal.action}`)) throw new RelayerError('UNKNOWN_PROPOSAL', 'proposal is not pending');
    if (this.dryRun) return Object.freeze({ ...proposal, broadcasted: false });
    if (typeof this.broadcaster !== 'function') throw new RelayerError('BROADCASTER_REQUIRED', 'non-dry execution requires an injected broadcaster');
    const receipt = await this.broadcaster(proposal.call, proposal);
    return Object.freeze({ ...proposal, broadcasted: true, receipt });
  }

  applyReceipt(receipt) {
    const { eventId, action, attempt, idempotencyKey: key, status } = receipt ?? {};
    const event = this.events.get(eventId); if (!event) throw new RelayerError('STALE_RECEIPT', 'unknown event');
    const pendingKey = `${eventId}:${action}`;
    const proposal = this.pending.get(pendingKey);
    if (!proposal || proposal.attempt !== attempt || proposal.idempotencyKey !== key) throw new RelayerError('STALE_RECEIPT', 'receipt does not match the current attempt');
    if (status !== 'success' && status !== 'failed') throw new RelayerError('INVALID_RECEIPT', 'status must be success or failed');
    if (status === 'failed') {
      this.pending.delete(pendingKey);
      const observedAtMs = Number.isSafeInteger(receipt.observedAtMs) ? receipt.observedAtMs : Date.now();
      event.retryAtMs = observedAtMs + Math.min(this.maxBackoffMs, this.baseBackoffMs * (2 ** (attempt - 1)));
      if (action === ACTIONS.FINISH_REDEEM) event.state = STATES.REDEEM_PREPARED;
      return Object.freeze({ retryable: attempt < this.maxAttempts, retryAtMs: event.retryAtMs });
    }
    if (action === ACTIONS.START_YIELD && atomic(receipt.amountAtomic, 'receipt.amountAtomic') !== event.principalAtomic) {
      throw new RelayerError('AMOUNT_MISMATCH', 'supply receipt amount must equal event principal');
    }
    if (action === ACTIONS.FINISH_REDEEM) {
      const redeemed = atomic(receipt.amountAtomic, 'receipt.amountAtomic');
      if (BigInt(redeemed) < BigInt(event.principalAtomic)) throw new RelayerError('AMOUNT_MISMATCH', 'redeem receipt must return at least principal');
      event.redeemedAtomic = redeemed;
    }
    this.pending.delete(pendingKey);
    event.retryAtMs = 0;
    this.completed.add(pendingKey);
    const transitions = {
      [ACTIONS.CLOSE_REGISTRATION]: STATES.REGISTRATION_CLOSED,
      [ACTIONS.START_YIELD]: STATES.YIELD_ACTIVE,
      [ACTIONS.PREPARE_REDEEM]: STATES.REDEEM_PREPARED,
      [ACTIONS.FINISH_REDEEM]: STATES.REDEEMED,
      [ACTIONS.FINALIZE_SETTLE]: STATES.SETTLEMENT_OPEN
    };
    event.state = transitions[action];
    return Object.freeze({ retryable: false, state: event.state });
  }
}

export { ACTIONS, STATES };



