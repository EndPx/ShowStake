// Parse and validate ShowStake `EVENT_JSON` logs. This module is pure (no I/O)
// so adversarial parsing is deterministic and unit-testable. Any malformed,
// wrong-version, wrong-standard or unsupported event throws — the ingestion
// transaction fails closed and the cursor cannot advance past it.
import { validateAccountIdShape } from '@showstake/domain';
import type { CommitData, ShowStakeEvent } from './types.js';

export const SHOWSTAKE_STANDARD = 'showstake';
export const SHOWSTAKE_VERSION = '1.0.0';

/** Events emitted by the deployed minimum (fc49fb85) contract source. */
export const KNOWN_EVENTS = new Set([
  // projected
  'EventPublished',
  'RegistrationCommitted',
  // provenance-only (captured in chain_events, never projected in this slice)
  'StorageDeposited',
  'EventCancelled',
  'RefundModeActivated',
  'PayoutStarted',
  'PayoutSucceeded',
  'PayoutFailed',
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

/** A classified event: PUBLISH/COMMIT project; everything else is provenance. */
export type ClassifiedEvent =
  | { kind: 'PUBLISH'; log: ShowStakeEvent; publish: PublishLogData }
  | { kind: 'COMMIT'; log: ShowStakeEvent; commit: CommitData }
  | { kind: 'PROVENANCE'; log: ShowStakeEvent };

export function classifyEvent(ev: ShowStakeEvent): ClassifiedEvent {
  if (ev.event === 'EventPublished') return { kind: 'PUBLISH', log: ev, publish: parsePublishLog(ev.data) };
  if (ev.event === 'RegistrationCommitted') return { kind: 'COMMIT', log: ev, commit: parseCommitLog(ev.data) };
  return { kind: 'PROVENANCE', log: ev };
}