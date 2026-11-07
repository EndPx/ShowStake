import type { ChallengeRow, EventListData, PublicEvent, SessionRow, WalletBindingRow } from '../types.js';
import type { Store } from './types.js';

/**
 * In-memory test double with the SAME single-use/expiry semantics as PgStore.
 * Local-only: it never represents a wallet proof and is used exclusively for
 * fail-closed challenge/verify/session unit checks (labelled PASS_LOCAL).
 */
export class MemoryStore implements Store {
  private readonly challenges = new Map<string, ChallengeRow>();
  private readonly sessions = new Map<string, SessionRow>();
  private readonly bindings = new Map<string, WalletBindingRow>();
  private readonly users = new Map<string, string>(); // bindingId -> userId
  private readonly events: PublicEvent[] = [];
  private seq = 0;

  seedEvent(e: PublicEvent): void {
    this.events.push(e);
  }

  /** Test-only: force a challenge to be treated as expired (past expiresAt). */
  expireChallenge(id: string): void {
    const c = this.challenges.get(id);
    if (c) c.expiresAtMs = 0;
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async listEvents(opts: { limit: number; cursor: { regOpen: string; id: string } | null }): Promise<EventListData> {
    const sorted = [...this.events].sort((a, b) => {
      const d = Date.parse(a.times.regOpen) - Date.parse(b.times.regOpen);
      if (d !== 0) return d;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const start = opts.cursor
      ? sorted.findIndex((e) => Date.parse(e.times.regOpen) > Date.parse(opts.cursor!.regOpen) || (Date.parse(e.times.regOpen) === Date.parse(opts.cursor!.regOpen) && e.id > opts.cursor!.id))
      : 0;
    const from = start < 0 ? sorted.length : start;
    const page = sorted.slice(from, from + opts.limit);
    const nextCursor = from + opts.limit < sorted.length
      ? Buffer.from(JSON.stringify({ regOpen: page[page.length - 1]!.times.regOpen, id: page[page.length - 1]!.id }), 'utf8').toString('base64url')
      : null;
    return { items: page, nextCursor };
  }

  async getEvent(id: string): Promise<PublicEvent | null> {
    return this.events.find((e) => e.id === id) ?? null;
  }

  async createChallenge(c: {
    id: string;
    nonceHash: string;
    purpose: string;
    domain: string;
    network: string;
    accountId: string;
    linkingUserId: string | null;
    issuedAtMs: number;
    expiresAtMs: number;
  }): Promise<void> {
    this.challenges.set(c.id, { ...c, consumedAt: null });
  }

  async getChallenge(id: string): Promise<ChallengeRow | null> {
    return this.challenges.get(id) ?? null;
  }

  async consumeAndOpenSession(args: {
    challengeId: string;
    namespace: string;
    network: string;
    accountId: string;
    walletKind: string;
    sessionId: string;
    tokenHash: string;
    idleMs: number;
    absoluteMs: number;
  }): Promise<{ userId: string; bindingId: string; sessionId: string; nowMs: number } | null> {
    const c = this.challenges.get(args.challengeId);
    if (!c) return null;
    if (c.consumedAt !== null) return null; // replay/concurrent reuse
    // Anchor on ACTUAL current time (parity with PgStore's clock_timestamp), so
    // a caller cannot pass a stale pre-await timestamp to bypass expiry.
    const nowMs = Date.now();
    if (nowMs >= c.expiresAtMs) return null; // expiry fail-closed
    c.consumedAt = nowMs;

    const key = `${args.namespace}|${args.network}|${args.accountId}`;
    let binding = this.bindings.get(key);
    let userId: string;
    if (!binding) {
      userId = `user-${this.seq++}`;
      const bindingId = `binding-${this.seq++}`;
      binding = { id: bindingId, userId, namespace: args.namespace, network: args.network, accountId: args.accountId, walletKind: args.walletKind };
      this.bindings.set(key, binding);
      this.users.set(bindingId, userId);
    } else {
      userId = binding.userId;
    }

    const idleExpiresAt = nowMs + args.idleMs;
    const absoluteExpiresAt = nowMs + args.absoluteMs;
    this.sessions.set(args.tokenHash, {
      id: args.sessionId,
      tokenHash: args.tokenHash,
      userId,
      walletBindingId: binding.id,
      createdAt: nowMs,
      lastSeenAt: nowMs,
      idleExpiresAt,
      absoluteExpiresAt,
      revokedAt: null,
    });
    return { userId, bindingId: binding.id, sessionId: args.sessionId, nowMs };
  }

  async getSessionByTokenHash(tokenHash: string, _nowMs: number): Promise<SessionRow | null> {
    return this.sessions.get(tokenHash) ?? null;
  }

  async revokeSession(tokenHash: string, nowMs: number): Promise<boolean> {
    const s = this.sessions.get(tokenHash);
    if (!s || s.revokedAt !== null) return false;
    s.revokedAt = nowMs;
    return true;
  }

  async touchSession(tokenHash: string, nowMs: number, idleExpiresAt: number): Promise<void> {
    const s = this.sessions.get(tokenHash);
    if (s) {
      s.lastSeenAt = nowMs;
      s.idleExpiresAt = idleExpiresAt;
    }
  }

  async getBinding(namespace: string, network: string, accountId: string): Promise<WalletBindingRow | null> {
    return this.bindings.get(`${namespace}|${network}|${accountId}`) ?? null;
  }
}