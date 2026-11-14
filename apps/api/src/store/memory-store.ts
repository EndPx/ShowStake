import type { AttendanceRead, ChallengeRow, ClaimRead, ContentResourceRead, EventListData, EventResultsRead, PassRead, PublicEvent, SessionRow, WalletBindingRow } from '../types.js';
import type { Store, RheaRun } from './types.js';
import { claimBonusAtomic } from '../lib/util.js';

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
  private readonly passes: PassRead[] = [];
  private readonly claims: ClaimRead[] = [];
  private readonly attendance = new Map<string, AttendanceRead[]>();
  private readonly content = new Map<string, ContentResourceRead[]>();
  private seq = 0;
  private readonly qr = new Map<string,{registrationId:string;nonceHash:string;owner:string;expiresAt:number;consumed:boolean}>();
  private readonly rheaRuns = new Map<string,RheaRun>();
  private readonly rheaLocks = new Map<string,Promise<void>>();

  async getRheaRun(id:string):Promise<RheaRun|null>{return structuredClone(this.rheaRuns.get(id) ?? null);}
  async updateRheaRun(seed:RheaRun,change:(run:RheaRun)=>RheaRun):Promise<RheaRun>{
    const prev=this.rheaLocks.get(seed.approvalId) ?? Promise.resolve();let release!:()=>void;const next=new Promise<void>(r=>{release=r;});this.rheaLocks.set(seed.approvalId,next);await prev;
    try {const run=structuredClone(this.rheaRuns.get(seed.approvalId) ?? seed);if(run.treasury!==seed.treasury || run.planHash!==seed.planHash)throw new Error('approval identity mismatch');const result=change(run);this.rheaRuns.set(seed.approvalId,structuredClone(result));return structuredClone(result);}finally{release();if(this.rheaLocks.get(seed.approvalId)===next)this.rheaLocks.delete(seed.approvalId);}
  }

  seedEvent(e: PublicEvent): void {
    const realized=e.totals.realizedYieldAtomic ?? '0',allocated=e.totals.allocatedYieldAtomic ?? '0';
    this.events.push({ ...e, title:e.title ?? null, location:e.location ?? null, rulesText:e.rulesText ?? null, totals: { ...e.totals, realizedYieldAtomic:realized,allocatedYieldAtomic:allocated,unallocatedYieldAtomic:(BigInt(realized)-BigInt(allocated)).toString() } });
  }
  seedPass(p: Omit<PassRead, 'finalized'> | PassRead): void { this.passes.push({ ...p, finalized: true }); }
  seedClaim(c: Omit<ClaimRead, 'finalized'> | ClaimRead): void { this.claims.push({ ...c, finalized: true }); }
  seedAttendance(eventId: string, rows: Array<Omit<AttendanceRead, 'finalized'> | AttendanceRead>): void { this.attendance.set(eventId, rows.map((r) => ({ ...r, finalized: true }))); }
  seedContent(eventId: string, rows: ContentResourceRead[]): void { this.content.set(eventId, rows); }

  /** Test-only: force a challenge to be treated as expired (past expiresAt). */
  expireChallenge(id: string): void {
    const c = this.challenges.get(id);
    if (c) c.expiresAtMs = 0;
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async listEvents(opts: { limit: number; cursor: { regOpen: string; id: string } | null; network?:string }): Promise<EventListData> {
    const sorted = this.events.filter(e=>!opts.network || e.network===opts.network).sort((a, b) => {
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
  async getEventByChainEventId(id: string, network?:string, contractId?:string): Promise<PublicEvent | null> {
    const matches=this.events.filter(e=>e.chainEventId===id && (!network || e.network===network) && (!contractId || e.contractId===contractId));return matches.length===1?matches[0]!:null;
  }
  async getEventResults(id: string): Promise<EventResultsRead | null> {
    const direct=this.events.find((e) => e.id === id);const matches=direct?[direct]:this.events.filter((e)=>e.chainEventId===id);
    if (matches.length!==1) return null;const event=matches[0]!;
    const rows = this.claims.filter((c) => c.eventId === event.id);
    const attendees = this.attendance.get(event.id) ?? [];
    const withdrawn = this.passes.filter((p) => p.eventId === event.id && p.registrationStatus === 'WITHDRAWN').length;
    const noShows = attendees.filter((a) => !a.attendanceStatus && a.registrationStatus === 'NO_SHOW').length;
    const active = Math.max(0, (event.registeredCount ?? rows.length) - withdrawn);
    return {
      eventId: event.id, chainEventId: event.chainEventId, state: event.state,
      counts: { registrations: rows.length || event.registeredCount || 0, activeRegistrations: active, withdrawn, attendees: attendees.filter((a) => a.attendanceStatus).length, noShows },
      totals: event.totals,
      finalized: ['ATTENDANCE_FINALIZED', 'SETTLING', 'SETTLED', 'CANCELLED', 'REFUND_ONLY'].includes(event.state),
      refund: { available: event.state === 'CANCELLED' || event.state === 'REFUND_ONLY', reason: event.state === 'CANCELLED' ? 'CANCELLED' : event.state === 'REFUND_ONLY' ? 'TIMEOUT' : null, principalAtomic: event.state === 'CANCELLED' || event.state === 'REFUND_ONLY' ? event.depositAtomic : null },
      settlement: { available: event.state === 'SETTLED', claimsEnabled: event.state === 'SETTLED', complete: event.state === 'SETTLED' },
      yield: { status: 'UNAVAILABLE', reason: 'ABI_NOT_FROZEN' }, observedAt: event.observedAt,
    };
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
  async getBindingById(id: string): Promise<WalletBindingRow | null> {
    return [...this.bindings.values()].find((b) => b.id === id) ?? null;
  }
  async listPasses(accountId: string, network: string): Promise<PassRead[]> {
    return this.passes.flatMap(p=>{const e=this.events.find(e=>e.id===p.eventId&&e.network===network);return p.ownerAccount===accountId&&e?[{...p,network:e.network,contractId:e.contractId,chainEventId:e.chainEventId,chainRegistrationId:p.chainRegistrationId??null,chainPassId:p.chainPassId??null}]:[];});
  }
  async listClaims(accountId: string, network: string): Promise<ClaimRead[]> {
    return this.claims.flatMap(c=>{const e=this.events.find(e=>e.id===c.eventId&&e.network===network);return c.beneficiaryAccount===accountId&&e?[{...c,network:e.network,contractId:e.contractId,chainEventId:e.chainEventId,chainRegistrationId:c.chainRegistrationId??null,chainPassId:c.chainPassId??null,bonusAtomic:claimBonusAtomic(c.principalAtomic,c.claimAtomic)}]:[];});
  }
  async getAttendance(eventId: string, organizerAccount: string, network: string): Promise<AttendanceRead[] | null> {
    const event = this.events.find((e) => e.id === eventId);
    return event && event.network === network && event.organizerAccount === organizerAccount ? (this.attendance.get(eventId) ?? []).map(r=>({...r,network:event.network,contractId:event.contractId,chainEventId:event.chainEventId,chainRegistrationId:r.chainRegistrationId??null,chainPassId:r.chainPassId??null})) : null;
  }
  async getContentAccess(eventId: string, accountId: string, network: string): Promise<ContentResourceRead[] | null> {
    const event = this.events.find((e) => e.id === eventId);
    if (!event || event.network !== network || event.state !== 'SETTLED') return null;
    const pass = this.passes.find((p) => p.eventId === eventId && p.ownerAccount === accountId && p.attendanceStatus && p.registrationStatus !== 'WITHDRAWN');
    return pass ? (this.content.get(eventId) ?? []) : null;
  }
  async publishResource(a:{id:string;eventId:string;objectKey:string;title:string;mimeType:string;bytesSize:number}):Promise<string> {
    if (!this.events.some(e=>e.id===a.eventId)) throw new Error('event unavailable');
    const publishedAt=new Date().toISOString();
    const rows=this.content.get(a.eventId) ?? [];
    rows.push({objectKey:a.objectKey,title:a.title,mimeType:a.mimeType,publishedAt,observedAt:publishedAt});
    this.content.set(a.eventId,rows); return publishedAt;
  }
  async findPass(eventId:string,passId:string,owner:string):Promise<{registrationId:string;chainPassId:string}|null> {
    const p=this.passes.find(x=>x.eventId===eventId && x.id===passId && x.ownerAccount===owner); return p?{registrationId:p.id,chainPassId:p.id}:null;
  }
  async createQr(a:{id:string;registrationId:string;nonceHash:string;owner:string;issuedAt:number;expiresAt:number}):Promise<void> {this.qr.set(a.id,{...a,consumed:false});}
  async consumeQr(a:{id:string;eventId:string;nonceHash:string;owner:string;organizer:string;requestId:string}):Promise<boolean> {
    const q=this.qr.get(a.id); const p=q && this.passes.find(x=>x.id===q.registrationId && x.eventId===a.eventId); if(!q || !p || q.consumed || q.expiresAt<=Date.now() || q.owner!==a.owner || q.nonceHash!==a.nonceHash) return false; q.consumed=true; return true;
  }

}
