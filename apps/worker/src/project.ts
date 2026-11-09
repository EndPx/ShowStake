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
  throw new Error(`unsupported contract event state: ${state}`);
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