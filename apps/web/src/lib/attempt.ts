// Deposit-attempt persistence + completion boundary (pure, no React, no DOM).
//
// A deposit attempt is persisted BEFORE the wallet is asked to sign, so a
// redirect/timeout/close can never lose it. The storage key binds the FULL
// submission identity (`network`, `contract`, `event`, `account`) — not just
// `account+event` — so one account changing contracts/events can never collide
// with, or clear, another's attempt. Reconciliation (read-only) must confirm
// the exact `commitmentId` before the attempt may be cleared; an unknown
// outcome keeps the attempt blocked from a fresh send.
//
// `AttemptBoundary` is the synchronous re-entry guard + monotonic generation
// that mirrors the accepted onboarding harness (`invalidateSignedState` bumps
// `verificationGeneration`, and an in-flight completion checks it after every
// await). `inflight` blocks a second click before React state updates;
// `generation` invalidates A→B→A stale async completions.

export const ATTEMPT_SCHEMA_VERSION = 1 as const;

export type AttemptStatus = "PREPARED" | "SUBMITTED";

export interface AttemptRecord {
  version: typeof ATTEMPT_SCHEMA_VERSION;
  status: AttemptStatus;
  network: string;
  contractId: string;
  ftContractId: string;
  eventId: string;
  accountId: string;
  /** Canonical base-10 deposit the commit must transfer (exact). */
  amount: string;
  commitmentId: string;
  txHash: string | null;
  at: string; // ISO timestamp of the last persistent update
}

export interface AttemptKey {
  network: string;
  contractId: string;
  eventId: string;
  accountId: string;
}

/** storage key = network + contract + event + account (never account+event alone). */
export function attemptStorageKey(key: AttemptKey): string {
  return `showstake:pending:v${ATTEMPT_SCHEMA_VERSION}:${key.network}:${key.contractId}:${key.eventId}:${key.accountId}`;
}

export interface AttemptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type PersistResult =
  | { ok: true; record: AttemptRecord }
  | { ok: false; reason: string };

export function attemptKeyFromRecord(record: AttemptRecord): AttemptKey {
  return { network: record.network, contractId: record.contractId, eventId: record.eventId, accountId: record.accountId };
}

function parse(value: string): AttemptRecord | null {
  try {
    const raw = JSON.parse(value) as unknown;
    if (typeof raw !== "object" || raw === null) return null;
    const o = raw as Record<string, unknown>;
    if (o["version"] !== ATTEMPT_SCHEMA_VERSION) return null;
    if (typeof o["accountId"] !== "string" || typeof o["network"] !== "string" || typeof o["contractId"] !== "string") return null;
    if (typeof o["ftContractId"] !== "string" || typeof o["eventId"] !== "string" || typeof o["amount"] !== "string") return null;
    if (typeof o["commitmentId"] !== "string") return null;
    if (o["status"] !== "PREPARED" && o["status"] !== "SUBMITTED") return null;
    return o as unknown as AttemptRecord;
  } catch {
    return null;
  }
}

/** Read the attempt for an identity; a record under a different identity is ignored (fails closed to null). */
export function readAttempt(storage: AttemptStorage | null, key: AttemptKey): AttemptRecord | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(attemptStorageKey(key));
    if (!raw) return null;
    const record = parse(raw);
    if (!record) return null;
    return attemptBelongsTo(record, key) ? record : null;
  } catch {
    return null;
  }
}

/**
 * Durable, verified write: `setItem` MUST succeed AND the stored bytes MUST read
 * back identically before the caller may proceed (it never silently swallows a
 * quota/exception). Only `{ok:true}` is proof the attempt survived a redirect.
 */
export function persistAttempt(storage: AttemptStorage | null, record: AttemptRecord): PersistResult {
  if (!storage) return { ok: false, reason: "persistent storage is unavailable (private mode / blocked localStorage)" };
  const key = attemptStorageKey(attemptKeyFromRecord(record));
  const json = JSON.stringify(record);
  try {
    storage.setItem(key, json);
  } catch (e) {
    return { ok: false, reason: `persist failed: ${String((e as Error)?.message ?? e)}` };
  }
  try {
    const stored = storage.getItem(key);
    if (stored !== json) {
      return { ok: false, reason: "persist read-back did not match the written attempt" };
    }
  } catch {
    return { ok: false, reason: "persist read-back failed" };
  }
  return { ok: true, record };
}

export function clearAttempt(storage: AttemptStorage | null, key: AttemptKey): void {
  if (!storage) return;
  try {
    storage.removeItem(attemptStorageKey(key));
  } catch {
    // noop
  }
}

export function attemptBelongsTo(record: AttemptRecord, key: AttemptKey): boolean {
  return (
    record.accountId === key.accountId &&
    record.network === key.network &&
    record.contractId === key.contractId &&
    record.eventId === key.eventId
  );
}

// ---------------------------------------------------------------------------

export interface AttemptBoundary {
  /** Monotonic identity generation; bumped on any account/disconnect boundary. */
  generation: number;
  /** Synchronous re-entry guard (double-click protection before React state). */
  inflight: boolean;
}

export function createAttemptBoundary(): AttemptBoundary {
  return { generation: 0, inflight: false };
}

/** Bump the boundary when the identity changes (disconnect/switch). */
export function bumpAttemptBoundary(boundary: AttemptBoundary): void {
  boundary.generation += 1;
  boundary.inflight = false;
}

/** Synchronous attempt to enter a critical (money-moving) operation. */
export function enterAttempt(boundary: AttemptBoundary): boolean {
  if (boundary.inflight) return false;
  boundary.inflight = true;
  return true;
}

export function exitAttempt(boundary: AttemptBoundary): void {
  boundary.inflight = false;
}

export function currentGeneration(boundary: AttemptBoundary): number {
  return boundary.generation;
}

export function isStaleGeneration(boundary: AttemptBoundary, generation: number): boolean {
  return boundary.generation !== generation;
}