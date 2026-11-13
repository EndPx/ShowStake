import type { AttendanceRead, ChallengeRow, ClaimRead, ContentResourceRead, EventListData, EventResultsRead, PassRead, PublicEvent, SessionRow, WalletBindingRow } from '../types.js';
export type RheaRun = {approvalId:string;treasury:string;planHash:string;nativeReservedAtomic:string;usdcReservedAtomic:string;journal:Record<string,unknown>};

/**
 * Persistence boundary for the API. The PgStore talks to PostgreSQL (API role
 * reads projections, writes app-owned tables); the MemoryStore is a local test
 * double with the same single-use/expiry semantics (never a wallet proof).
 */
export interface Store {
  ping(): Promise<boolean>;
  getRheaRun(approvalId:string):Promise<RheaRun|null>;
  updateRheaRun(seed:RheaRun, change:(run:RheaRun)=>RheaRun):Promise<RheaRun>;
  findPass(eventId: string, passId: string, owner: string): Promise<{registrationId:string; chainPassId:string} | null>;
  createQr(args: {id:string; registrationId:string; nonceHash:string; owner:string; issuedAt:number; expiresAt:number}): Promise<void>;
  consumeQr(args: {id:string; eventId:string; nonceHash:string; owner:string; organizer:string; requestId:string}): Promise<boolean>;

  listEvents(opts: { limit: number; cursor: { regOpen: string; id: string } | null; network?:string }): Promise<EventListData>;
  getEvent(id: string): Promise<PublicEvent | null>;
  getEventByChainEventId(id: string, network?:string, contractId?:string): Promise<PublicEvent | null>;
  getEventResults(id: string): Promise<EventResultsRead | null>;

  createChallenge(c: {
    id: string;
    nonceHash: string;
    purpose: string;
    domain: string;
    network: string;
    accountId: string;
    linkingUserId: string | null;
    issuedAtMs: number;
    expiresAtMs: number;
  }): Promise<void>;
  getChallenge(id: string): Promise<ChallengeRow | null>;

  /**
   * Atomically consume an unconsumed/valid challenge and open a session. The
   * store uses the ACTUAL current time (not a caller-supplied timestamp) as the
   * anchor for the expiry comparison and the session timestamps, so a challenge
   * that expires while the caller is blocked on the row lock is still denied.
   * Returns null when already consumed or expired; returns the anchor `nowMs`.
   */
  consumeAndOpenSession(args: {
    challengeId: string;
    namespace: string;
    network: string;
    accountId: string;
    walletKind: string;
    sessionId: string;
    tokenHash: string;
    /** session idle lifetime in ms (anchor + idleMs = idleExpiresAt). */
    idleMs: number;
    /** session absolute lifetime in ms. */
    absoluteMs: number;
  }): Promise<{ userId: string; bindingId: string; sessionId: string; nowMs: number } | null>;

  getSessionByTokenHash(tokenHash: string, nowMs: number): Promise<SessionRow | null>;
  revokeSession(tokenHash: string, nowMs: number): Promise<boolean>;
  touchSession(tokenHash: string, nowMs: number, idleExpiresAt: number): Promise<void>;
  getBinding(namespace: string, network: string, accountId: string): Promise<WalletBindingRow | null>;
  getBindingById(id: string): Promise<WalletBindingRow | null>;
  listPasses(accountId: string, network: string): Promise<PassRead[]>;
  listClaims(accountId: string, network: string): Promise<ClaimRead[]>;
  getAttendance(eventId: string, organizerAccount: string, network: string): Promise<AttendanceRead[] | null>;
  getContentAccess(eventId: string, accountId: string, network: string): Promise<ContentResourceRead[] | null>;
  publishResource(args: {id:string; eventId:string; objectKey:string; title:string; mimeType:string; bytesSize:number}): Promise<string>;
}
