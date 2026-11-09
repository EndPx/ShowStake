// Projection preparation: build chain_events rows and validate enriched publish
// rules against a pinned contract view. Pure given injected data (network I/O
// happens in the store); throws => fail closed => no cursor advance.
import type { DeploymentAllowlist } from './config.js';
import type { ChainEventInsert, NormalizedBlock, PublishRules } from './types.js';
import type { ClassifiedEvent, PublishLogData } from './events.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function str(v: unknown, label: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`view field ${label} must be a non-empty string`);
  return v;
}

function u64(v: unknown, label: string): number {
  if (typeof v !== 'number' && typeof v !== 'string') throw new Error(`view field ${label} must be an integer ms`);
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`view field ${label} must be a non-negative safe integer ms`);
  return n;
}

export function mapEventState(state: string): string {
  if (state === 'Published') return 'PUBLISHED';
  if (state === 'Cancelled') return 'CANCELLED';
  if (state === 'RefundOnly') return 'REFUND_ONLY';
  if (state === 'AttendanceFinalized') return 'ATTENDANCE_FINALIZED';
  if (state === 'Settling') return 'SETTLING';
  if (state === 'Settled') return 'SETTLED';
  throw new Error(`unsupported contract event state: ${state}`);
}

/** Contract `FinancialStatus` -> registrations_projection.payout_state. */
export function mapFinancialStatus(status: string): string {
  if (status === 'Committed') return 'NOT_CLAIMABLE';
  if (status === 'Claimable') return 'CLAIMABLE';
  if (status === 'Pending') return 'PENDING';
  if (status === 'Paid') return 'PAID';
  if (status === 'Forfeited') return 'ZERO';
  throw new Error(`unsupported contract financial status: ${status}`);
}

/** Contract `AttendanceStatus` -> registrations_projection.state (final only). */
export function mapAttendanceStatus(status: string): string {
  if (status === 'Attended') return 'ATTENDED';
  if (status === 'NoShow') return 'NO_SHOW';
  if (status === 'NotMarked') return 'COMMITTED'; // not yet finalized
  throw new Error(`unsupported contract attendance status: ${status}`);
}

/** Build the chain_events row provenance for one classified event. */
export function buildChainEvent(ev: ClassifiedEvent, receiptId: string, block: NormalizedBlock): ChainEventInsert {
  return {
    receiptId,
    logIndex: ev.log.logIndex,
    blockHeight: block.height,
    blockHash: block.hash,
    blockTimeMs: block.timestampMs,
    eventName: ev.log.event,
    schemaVersion: ev.log.version,
    payload: ev.log.data,
  };
}

/** A parsed `get_event` contract view (amount/time fields normalized). */
export interface EventViewData {
  event_id: string;
  organizer: string;
  canonical_ft: string;
  rules_hash: string;
  deposit: string;
  capacity: number;
  reg_open: number;
  reg_close: number;
  cancel_cutoff: number;
  checkin_open: number;
  checkin_close: number;
  finalize_deadline: number;
  policy_version: string;
  state: string;
}

export function parseEventView(raw: unknown): EventViewData {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('get_event view is not an object');
  const v = raw as Record<string, unknown>;
  return {
    event_id: str(v['event_id'], 'event_id'),
    organizer: str(v['organizer'], 'organizer'),
    canonical_ft: str(v['canonical_ft'], 'canonical_ft'),
    rules_hash: str(v['rules_hash'], 'rules_hash'),
    deposit: str(v['deposit'], 'deposit'),
    capacity: typeof v['capacity'] === 'number' ? v['capacity'] : Number(v['capacity']),
    reg_open: u64(v['reg_open'], 'reg_open'),
    reg_close: u64(v['reg_close'], 'reg_close'),
    cancel_cutoff: u64(v['cancel_cutoff'], 'cancel_cutoff'),
    checkin_open: u64(v['checkin_open'], 'checkin_open'),
    checkin_close: u64(v['checkin_close'], 'checkin_close'),
    finalize_deadline: u64(v['finalize_deadline'], 'finalize_deadline'),
    policy_version: str(v['policy_version'], 'policy_version'),
    state: str(v['state'], 'state'),
  };
}

/**
 * Cross-check the enriched view against the EventPublished log and the
 * deployment allowlist; returns the full immutable publish rules. Throw on any
 * discrepancy (log field, token identity, organizer identity, time ordering, or
 * finalize_deadline != checkin_close + 24h).
 */
export function enrichPublish(pub: PublishLogData, view: EventViewData, d: DeploymentAllowlist): PublishRules {
  if (view.event_id !== pub.eventId) throw new Error(`event_id mismatch: log ${pub.eventId} vs view ${view.event_id}`);
  if (view.organizer !== pub.organizer || view.organizer !== d.organizer) {
    throw new Error(`organizer mismatch: log/view ${view.organizer} != allowlist ${d.organizer}`);
  }
  if (view.canonical_ft !== d.ftContractId) {
    throw new Error(`canonical_ft mismatch: view ${view.canonical_ft} != allowlist ${d.ftContractId}`);
  }
  if (view.deposit !== pub.deposit) throw new Error(`deposit mismatch: log ${pub.deposit} vs view ${view.deposit}`);
  if (view.capacity !== pub.capacity) throw new Error(`capacity mismatch: log ${pub.capacity} vs view ${view.capacity}`);
  if (view.policy_version !== pub.policyVersion || view.policy_version !== d.policyVersion) {
    throw new Error(`policy_version mismatch: ${view.policy_version}`);
  }
  if (view.reg_open >= view.reg_close) throw new Error('time ordering violated: reg_open >= reg_close');
  if (view.reg_close > view.cancel_cutoff) throw new Error('time ordering violated: reg_close > cancel_cutoff');
  if (view.cancel_cutoff > view.checkin_open) throw new Error('time ordering violated: cancel_cutoff > checkin_open');
  if (view.checkin_open >= view.checkin_close) throw new Error('time ordering violated: checkin_open >= checkin_close');
  if (view.capacity < 1 || view.capacity > 200) throw new Error(`capacity out of range: ${view.capacity}`);
  const expectedDeadline = view.checkin_close + DAY_MS;
  if (view.finalize_deadline !== expectedDeadline) throw new Error('finalize_deadline != checkin_close + 24h');
  if (view.finalize_deadline !== pub.finalizeDeadlineMs) {
    throw new Error(`finalize_deadline mismatch: log ${pub.finalizeDeadlineMs} vs view ${view.finalize_deadline}`);
  }
  if (mapEventState(view.state) !== 'PUBLISHED') {
    throw new Error(`EventPublished must be in Published state, got ${view.state}`);
  }
  return {
    eventId: view.event_id,
    organizer: view.organizer,
    canonicalFt: view.canonical_ft,
    deposit: view.deposit,
    capacity: view.capacity,
    regOpenMs: view.reg_open,
    regCloseMs: view.reg_close,
    cancelCutoffMs: view.cancel_cutoff,
    checkinOpenMs: view.checkin_open,
    checkinCloseMs: view.checkin_close,
    finalizeDeadlineMs: view.finalize_deadline,
    policyVersion: view.policy_version,
    rulesHash: view.rules_hash,
  };
}

// --- v6 settlement view parsers (pinned `get_*` contract views) -------------

function u128str(v: unknown, label: string): string {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v)) {
    throw new Error(`view field ${label} must be a canonical u128 string`);
  }
  if (BigInt(v) > (1n << 128n) - 1n) throw new Error(`view field ${label} exceeds u128`);
  return v;
}

function intField(v: unknown, label: string, min = 0): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min) {
    throw new Error(`view field ${label} must be an integer >= ${min}`);
  }
  return n;
}

/** `get_event_totals` view: verified accepted/paid/pending/liability totals. */
export interface EventTotalsViewData {
  event_id: string;
  state: string;
  accepted_principal: string;
  paid: string;
  pending: string;
  liability: string;
}

export function parseTotalsView(raw: unknown): EventTotalsViewData {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('get_event_totals view is not an object');
  const v = raw as Record<string, unknown>;
  return {
    event_id: str(v['event_id'], 'event_id'),
    state: str(v['state'], 'state'),
    accepted_principal: u128str(v['accepted_principal'], 'accepted_principal'),
    paid: u128str(v['paid'], 'paid'),
    pending: u128str(v['pending'], 'pending'),
    liability: u128str(v['liability'], 'liability'),
  };
}

/** `get_settlement` view: frozen allocation terms + completion. */
export interface SettlementViewData {
  event_id: string;
  state: string;
  attendance_frozen: boolean;
  attendee_count: number;
  no_show_count: number;
  registrations: number;
  pool: string;
  base_share: string;
  remainder: string;
  allocated_total: string;
  complete: boolean;
  claims_enabled: boolean;
}

export function parseSettlementView(raw: unknown): SettlementViewData {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('get_settlement view is not an object');
  const v = raw as Record<string, unknown>;
  const b = (k: string) => {
    const x = v[k];
    if (typeof x !== 'boolean') throw new Error(`view field ${k} must be a boolean`);
    return x;
  };
  return {
    event_id: str(v['event_id'], 'event_id'),
    state: str(v['state'], 'state'),
    attendance_frozen: b('attendance_frozen'),
    attendee_count: intField(v['attendee_count'], 'attendee_count'),
    no_show_count: intField(v['no_show_count'], 'no_show_count'),
    registrations: intField(v['registrations'], 'registrations'),
    pool: u128str(v['pool'], 'pool'),
    base_share: u128str(v['base_share'], 'base_share'),
    remainder: u128str(v['remainder'], 'remainder'),
    allocated_total: u128str(v['allocated_total'], 'allocated_total'),
    complete: b('complete'),
    claims_enabled: b('claims_enabled'),
  };
}

/** `get_claim` view: verified per-registration allocation + payout state. */
export interface ClaimViewData {
  registration_id: string;
  event_id: string;
  amount: string;
  payout_state: string;
  paid_amount: string;
}

export function parseClaimView(raw: unknown): ClaimViewData {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('get_claim view is not an object');
  const v = raw as Record<string, unknown>;
  return {
    registration_id: str(v['registration_id'], 'registration_id'),
    event_id: str(v['event_id'], 'event_id'),
    amount: u128str(v['amount'], 'amount'),
    payout_state: str(v['payout_state'], 'payout_state'),
    paid_amount: u128str(v['paid_amount'], 'paid_amount'),
  };
}

/** `get_registration` view: verified (frozen) attendance status. */
export interface RegistrationViewData {
  registration_id: string;
  event_id: string;
  attendance_status: string;
  financial_status: string;
}

export function parseRegistrationView(raw: unknown): RegistrationViewData {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('get_registration view is not an object');
  const v = raw as Record<string, unknown>;
  return {
    registration_id: str(v['registration_id'], 'registration_id'),
    event_id: str(v['event_id'], 'event_id'),
    attendance_status: str(v['attendance_status'], 'attendance_status'),
    financial_status: str(v['financial_status'], 'financial_status'),
  };
}

/** `get_payout` view: verified payout outcome + amount. */
export interface PayoutViewData {
  payout_id: string;
  registration_id: string;
  event_id: string;
  beneficiary: string;
  amount: string;
  state: string; // Pending | Succeeded | Failed
}

export function parsePayoutView(raw: unknown): PayoutViewData {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('get_payout view is not an object');
  const v = raw as Record<string, unknown>;
  return {
    payout_id: str(v['payout_id'], 'payout_id'),
    registration_id: str(v['registration_id'], 'registration_id'),
    event_id: str(v['event_id'], 'event_id'),
    beneficiary: str(v['beneficiary'], 'beneficiary'),
    amount: u128str(v['amount'], 'amount'),
    state: str(v['state'], 'state'),
  };
}