import type { SessionRow } from '../types.js';

export interface SessionVerdict {
  ok: boolean;
  code: string;
  session: SessionRow | null;
}

/**
 * Secure session lifecycle check: revoked, absolute expiry, and idle expiry are
 * each rejected independently (fail-closed). `idleExpiresAt` already encodes the
 * sliding idle deadline; the middleware slides it on authenticated activity.
 */
export function sessionIsActive(session: SessionRow | null, nowMs: number): SessionVerdict {
  if (!session) return { ok: false, code: 'NO_SESSION', session: null };
  if (session.revokedAt !== null) return { ok: false, code: 'SESSION_REVOKED', session };
  if (nowMs >= session.absoluteExpiresAt) return { ok: false, code: 'SESSION_EXPIRED', session };
  if (nowMs >= session.idleExpiresAt) return { ok: false, code: 'SESSION_IDLE_EXPIRED', session };
  return { ok: true, code: 'OK', session };
}

/** Sliding idle deadline for a fresh activity timestamp. */
export function idleDeadlineFrom(nowMs: number, idleMs: number): number {
  return nowMs + idleMs;
}