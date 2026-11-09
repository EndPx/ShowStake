// Parse and validate ShowStake `EVENT_JSON` logs. This module is pure (no I/O)
// so adversarial parsing is deterministic and unit-testable. Any malformed,
// wrong-version, wrong-standard or unsupported event throws — the ingestion
// transaction fails closed and the cursor cannot advance past it.
import { validateAccountIdShape } from '@showstake/domain';
import type { CommitData, ShowStakeEvent } from './types.js';

export const SHOWSTAKE_STANDARD = 'showstake';
export const SHOWSTAKE_VERSION = '1.0.0';

/**
 * Events emitted by the deployed minimum (fc49fb85 / `showstake-v2/1`) contract
 * plus the settled v6 lifecycle (f462ddcb / `showstake-v2-d036-settle/1`).
 * Unknown financial/attendance/settlement event names throw (fail-closed): they
 * are never silently downgraded to provenance-only, because advancing a stale
 * projection over an unparsed financial event would fabricate DB rights.
 */
export const KNOWN_EVENTS = new Set([
  // projected
  'EventPublished',
  'RegistrationCommitted',
  // v6 attendance + settlement lifecycle (projected)
  'AttendanceMarked',
  'EventFinalized',
  'SettlementStarted',
  'SettlementChunk',
  'EventSettled',
  // v6 private payout callback lifecycle (projected)
  'PayoutStarted',
  'PayoutSucceeded',
  'PayoutFailed',
  // provenance-only (captured in chain_events, never projected)
  'StorageDeposited',
  'EventCancelled',
  'RefundModeActivated',
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Extract and structurally validate showstake EVENT_JSON logs. */
export function parseShowStakeLogs(logs: string[]): ShowStakeEvent[] {
  const out: ShowStakeEvent[] = [];
  for (let i = 0; i < logs.length; i++) {
    const raw = logs[i]!;
    if (!raw.startsWith('EVENT_JSON:')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.slice('EVENT_JSON:'.length));
    } catch {
      throw new Error(`malformed EVENT_JSON log at index ${i}`);
    }
    if (!isObject(parsed)) throw new Error(`EVENT_JSON log at index ${i} is not an object`);
    const standard = parsed['standard'];
    if (standard !== SHOWSTAKE_STANDARD) continue; // ignore other standards (e.g. nep141)
    const version = parsed['version'];
    if (version !== SHOWSTAKE_VERSION) {
      throw new Error(`unsupported showstake version at log ${i}: ${String(version)}`);
    }
    const event = parsed['event'];
    if (typeof event !== 'string' || !KNOWN_EVENTS.has(event)) {
      throw new Error(`unsupported showstake event at log ${i}: ${String(event)}`);
    }
    const data = parsed['data'];
    if (!isObject(data)) throw new Error(`showstake event ${event} at log ${i} has non-object data`);
    out.push({ logIndex: i, standard: SHOWSTAKE_STANDARD, version: SHOWSTAKE_VERSION, event, data, raw });
  }
  return out;
}

function reqString(data: Record<string, unknown>, key: string): string {
  const v = data[key];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`field ${key} must be a non-empty string`);
  return v;
}

function reqAccount(data: Record<string, unknown>, key: string): string {
  const v = reqString(data, key);
  if (validateAccountIdShape(v) !== true) throw new Error(`field ${key} is not a valid NEAR account id: ${v}`);
  return v;
}

function reqU128(data: Record<string, unknown>, key: string, { positive = false } = {}): string {
  const v = reqString(data, key);
  if (!/^(0|[1-9][0-9]*)$/.test(v)) throw new Error(`field ${key} is not a canonical u128 string: ${v}`);
  if (BigInt(v) > (1n << 128n) - 1n) throw new Error(`field ${key} exceeds u128: ${v}`);
  if (positive && BigInt(v) === 0n) throw new Error(`field ${key} must be > 0`);
  return v;
}

function reqInt(data: Record<string, unknown>, key: string, opts: { min: number; max: number }): number {
  const v = data[key];
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    if (typeof v === 'string' && /^[0-9]+$/.test(v)) {
      const n = Number(v);
      if (Number.isSafeInteger(n) && n >= opts.min && n <= opts.max) return n;
    }
    throw new Error(`field ${key} must be an integer in ${opts.min}..${opts.max}`);
  }
  if (!Number.isSafeInteger(v) || v < opts.min || v > opts.max) {
    throw new Error(`field ${key} must be an integer in ${opts.min}..${opts.max}`);
  }
  return v;
}

function reqBool(data: Record<string, unknown>, key: string): boolean {
  const v = data[key];
  if (typeof v !== 'boolean') throw new Error(`field ${key} must be a boolean`);
  return v;
}

/** Data extracted from an `EventPublished` log (enrichment adds the rest). */
export interface PublishLogData {
  eventId: string;
  organizer: string;
  deposit: string;
  capacity: number;
  finalizeDeadlineMs: number;
  policyVersion: string;
}

export function parsePublishLog(data: Record<string, unknown>): PublishLogData {
  return {
    eventId: reqString(data, 'event_id'),
    organizer: reqAccount(data, 'organizer'),
    deposit: reqU128(data, 'deposit', { positive: true }),
    capacity: reqInt(data, 'capacity', { min: 1, max: 200 }),
    finalizeDeadlineMs: reqInt(data, 'finalize_deadline', { min: 0, max: Number.MAX_SAFE_INTEGER }),
    policyVersion: reqString(data, 'policy_version'),
  };
}

export function parseCommitLog(data: Record<string, unknown>): CommitData {
  return {
    eventId: reqString(data, 'event_id'),
    registrationId: reqString(data, 'registration_id'),
    passId: reqString(data, 'pass_id'),
    participant: reqAccount(data, 'participant'),
    beneficiary: reqAccount(data, 'beneficiary'),
    commitmentId: reqString(data, 'commitment_id'),
    amount: reqU128(data, 'amount', { positive: true }),
    eventSequence: reqInt(data, 'event_sequence', { min: 0, max: Number.MAX_SAFE_INTEGER }),
  };
}

/** Optional flag carried by `SettlementChunk` after an idempotent re-settle. */
export interface AttendanceData {
  eventId: string;
  registrationId: string;
  attended: boolean;
  changed: boolean;
}

export interface FinalizeData {
  eventId: string;
  attendeeCount: number;
  noShowCount: number;
  totalRegistrations: number;
  finalizedAtMs: number;
}

export interface SettleStartData {
  eventId: string;
  pool: string;
  baseShare: string;
  remainder: string;
  attendeeCount: number;
  actor: string;
}

export interface SettleChunkData {
  eventId: string;
  cursor: number;
  totalRegistrations: number;
  allocatedTotal: string;
  complete: boolean;
  /** only present on an idempotent re-settle after the event is already Settled. */
  alreadySettled: boolean;
}

export interface SettleEndData {
  eventId: string;
  allocatedTotal: string;
  attendeeCount: number;
  noShowCount: number;
  totalRegistrations: number;
}

export interface PayoutData {
  payoutId: string;
  registrationId: string;
  eventId: string;
  beneficiary: string;
  amount: string;
}

export function parseAttendanceLog(data: Record<string, unknown>): AttendanceData {
  return {
    eventId: reqString(data, 'event_id'),
    registrationId: reqString(data, 'registration_id'),
    attended: reqBool(data, 'attended'),
    changed: reqBool(data, 'changed'),
  };
}

export function parseFinalizeLog(data: Record<string, unknown>): FinalizeData {
  return {
    eventId: reqString(data, 'event_id'),
    attendeeCount: reqInt(data, 'attendee_count', { min: 0, max: 200 }),
    noShowCount: reqInt(data, 'no_show_count', { min: 0, max: 200 }),
    totalRegistrations: reqInt(data, 'total_registrations', { min: 1, max: 200 }),
    finalizedAtMs: reqInt(data, 'finalized_at', { min: 0, max: Number.MAX_SAFE_INTEGER }),
  };
}

export function parseSettleStartLog(data: Record<string, unknown>): SettleStartData {
  return {
    eventId: reqString(data, 'event_id'),
    pool: reqU128(data, 'pool'),
    baseShare: reqU128(data, 'base_share'),
    remainder: reqU128(data, 'remainder'),
    attendeeCount: reqInt(data, 'attendee_count', { min: 0, max: 200 }),
    actor: reqAccount(data, 'actor'),
  };
}

export function parseSettleChunkLog(data: Record<string, unknown>): SettleChunkData {
  return {
    eventId: reqString(data, 'event_id'),
    cursor: reqInt(data, 'cursor', { min: 0, max: Number.MAX_SAFE_INTEGER }),
    totalRegistrations: reqInt(data, 'total_registrations', { min: 1, max: 200 }),
    allocatedTotal: reqU128(data, 'allocated_total'),
    complete: reqBool(data, 'complete'),
    alreadySettled: data['already_settled'] === undefined ? false : reqBool(data, 'already_settled'),
  };
}

export function parseSettleEndLog(data: Record<string, unknown>): SettleEndData {
  return {
    eventId: reqString(data, 'event_id'),
    allocatedTotal: reqU128(data, 'allocated_total'),
    attendeeCount: reqInt(data, 'attendee_count', { min: 0, max: 200 }),
    noShowCount: reqInt(data, 'no_show_count', { min: 0, max: 200 }),
    totalRegistrations: reqInt(data, 'total_registrations', { min: 1, max: 200 }),
  };
}

export function parsePayoutLog(data: Record<string, unknown>): PayoutData {
  return {
    payoutId: reqString(data, 'payout_id'),
    registrationId: reqString(data, 'registration_id'),
    eventId: reqString(data, 'event_id'),
    beneficiary: reqAccount(data, 'beneficiary'),
    amount: reqU128(data, 'amount', { positive: true }),
  };
}

/**
 * A classified event. PUBLISH/COMMIT plus the v6 attendance/settlement/payout
 * lifecycle project; the remaining events are provenance-only (never projected).
 */
export type ClassifiedEvent =
  | { kind: 'PUBLISH'; log: ShowStakeEvent; publish: PublishLogData }
  | { kind: 'COMMIT'; log: ShowStakeEvent; commit: CommitData }
  | { kind: 'ATTENDANCE'; log: ShowStakeEvent; attendance: AttendanceData }
  | { kind: 'FINALIZE'; log: ShowStakeEvent; finalize: FinalizeData }
  | { kind: 'SETTLE_START'; log: ShowStakeEvent; settleStart: SettleStartData }
  | { kind: 'SETTLE_CHUNK'; log: ShowStakeEvent; settleChunk: SettleChunkData }
  | { kind: 'SETTLE_END'; log: ShowStakeEvent; settleEnd: SettleEndData }
  | { kind: 'PAYOUT_START'; log: ShowStakeEvent; payout: PayoutData }
  | { kind: 'PAYOUT_SUCCESS'; log: ShowStakeEvent; payout: PayoutData }
  | { kind: 'PAYOUT_FAIL'; log: ShowStakeEvent; payout: PayoutData }
  | { kind: 'PROVENANCE'; log: ShowStakeEvent };

export function classifyEvent(ev: ShowStakeEvent): ClassifiedEvent {
  switch (ev.event) {
    case 'EventPublished': return { kind: 'PUBLISH', log: ev, publish: parsePublishLog(ev.data) };
    case 'RegistrationCommitted': return { kind: 'COMMIT', log: ev, commit: parseCommitLog(ev.data) };
    case 'AttendanceMarked': return { kind: 'ATTENDANCE', log: ev, attendance: parseAttendanceLog(ev.data) };
    case 'EventFinalized': return { kind: 'FINALIZE', log: ev, finalize: parseFinalizeLog(ev.data) };
    case 'SettlementStarted': return { kind: 'SETTLE_START', log: ev, settleStart: parseSettleStartLog(ev.data) };
    case 'SettlementChunk': return { kind: 'SETTLE_CHUNK', log: ev, settleChunk: parseSettleChunkLog(ev.data) };
    case 'EventSettled': return { kind: 'SETTLE_END', log: ev, settleEnd: parseSettleEndLog(ev.data) };
    case 'PayoutStarted': return { kind: 'PAYOUT_START', log: ev, payout: parsePayoutLog(ev.data) };
    case 'PayoutSucceeded': return { kind: 'PAYOUT_SUCCESS', log: ev, payout: parsePayoutLog(ev.data) };
    case 'PayoutFailed': return { kind: 'PAYOUT_FAIL', log: ev, payout: parsePayoutLog(ev.data) };
    default: return { kind: 'PROVENANCE', log: ev };
  }
}