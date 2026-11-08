// The persist-then-sign sequencing of a deposit attempt, as a pure closure with
// injected wallet + persistence (no React, no DOM, and only type-only imports so
// the Node verification script can import it directly). It asserts the exact
// critical-path guarantees:
//   * a durable PREPARED write (persist + read-back) MUST succeed BEFORE the
//     wallet is asked to sign; on failure the wallet is never called (count 0).
//   * a wallet ok with a missing hash, and a wallet error, are both UNKNOWN —
//     the persisted attempt stays blocked and is never auto-reset into a fresh
//     commitment (there is no safe reset: a null hash is "broadcast status
//     unknown", not "unsent").
//
// This module is intentionally side-effect-free about its inputs; the caller
// owns React state and the real `signAndSendTransaction` / `persistAttempt`.

import type { AttemptRecord, PersistResult } from "./attempt";

export interface WalletSignResult {
  ok: boolean;
  txHash: string | null;
  status: string | null;
  detail?: string;
}

export type CommitStepResult =
  /** PREPARED could not be durably persisted — the wallet was NOT asked. */
  | { kind: "persist_failed"; reason: string }
  /** The wallet returned an error; outcome UNKNOWN, the PREPARED attempt stays blocked. */
  | { kind: "wallet_rejected"; reason: string; prepared: AttemptRecord }
  /** The wallet returned ok; `record.txHash` may still be null (also UNKNOWN). */
  | { kind: "submitted"; record: AttemptRecord; persisted: boolean };

export function submittedRecord(prepared: AttemptRecord, txHash: string | null, _status: string | null): AttemptRecord {
  return { ...prepared, status: "SUBMITTED", txHash, at: new Date().toISOString() };
}

/**
 * Persist PREPARED (durably) before asking the wallet, then record the outcome.
 * `sign` is only invoked after a durable PREPARED write succeeds.
 */
export async function runCommitSteps(opts: {
  prepared: AttemptRecord;
  sign: () => Promise<WalletSignResult>;
  persistPrepared: (r: AttemptRecord) => PersistResult;
  persistSubmitted: (r: AttemptRecord) => PersistResult;
}): Promise<CommitStepResult> {
  const prepared = opts.persistPrepared(opts.prepared);
  if (!prepared.ok) return { kind: "persist_failed", reason: prepared.reason };

  const result = await opts.sign();
  if (!result.ok) {
    return { kind: "wallet_rejected", reason: result.detail ?? "wallet rejected the transaction", prepared: opts.prepared };
  }

  const submitted = submittedRecord(opts.prepared, result.txHash, result.status);
  const persisted = opts.persistSubmitted(submitted);
  return { kind: "submitted", record: submitted, persisted: persisted.ok };
}

/**
 * Any non-null attempt blocks a new send — including a hash-less (UNKNOWN) one.
 * There is no reset path that clears it; only read-only reconciliation
 * (confirmed / rejected / failed / manual-hash) may close it.
 */
export function attemptBlocksNewSend(attempt: AttemptRecord | null): boolean {
  return attempt !== null;
}