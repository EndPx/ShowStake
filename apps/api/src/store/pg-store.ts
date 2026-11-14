import { assertMoneyString } from '@showstake/domain';
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type { AttendanceRead, ChallengeRow, ClaimRead, ContentResourceRead, EventListData, EventResultsRead, PassRead, PublicEvent, SessionRow, WalletBindingRow } from '../types.js';
import type { Store, RheaRun } from './types.js';
import { isUuid, claimBonusAtomic } from '../lib/util.js';

/** PostgreSQL `numeric` must round-trip as a canonical money string, never a float. */
function money(v: unknown): string {
  return assertMoneyString(v, 'events_projection money column').toString();
}

function iso(d: Date): string {
  return d.toISOString();
}

interface EventRow {
  id: string;
  chain_event_id: string;
  network: string;
  contract_id: string;
  organizer_account: string;
  asset_contract: string;
  state: string;
  onchain_title: string | null;
  onchain_location: string | null;
  onchain_rules_text: string | null;
  deposit_atomic: string;
  capacity: number;
  reg_open: Date;
  reg_close: Date;
  cancel_cutoff: Date;
  checkin_open: Date;
  checkin_close: Date;
  finalize_deadline: Date;
  accepted_atomic: string;
  realized_yield_atomic: string;
  allocated_yield_atomic: string;
  paid_atomic: string;
  pending_atomic: string;
  liability_atomic: string;
  observed_at: Date;
  registered_count: number;
}

function mapEvent(r: EventRow): PublicEvent {
  return {
    id: r.id,
    chainEventId: r.chain_event_id,
    network: r.network,
    contractId: r.contract_id,
    organizerAccount: r.organizer_account,
    assetContract: r.asset_contract,
    state: r.state,
    title: r.onchain_title, location: r.onchain_location, rulesText: r.onchain_rules_text,
    depositAtomic: money(r.deposit_atomic),
    capacity: Number(r.capacity),
    times: {
      regOpen: iso(r.reg_open),
      regClose: iso(r.reg_close),
      cancelCutoff: iso(r.cancel_cutoff),
      checkinOpen: iso(r.checkin_open),
      checkinClose: iso(r.checkin_close),
      finalizeDeadline: iso(r.finalize_deadline),
    },
    totals: {
      acceptedAtomic: money(r.accepted_atomic),
      realizedYieldAtomic: money(r.realized_yield_atomic),
      allocatedYieldAtomic: money(r.allocated_yield_atomic),
      unallocatedYieldAtomic: (BigInt(money(r.realized_yield_atomic))-BigInt(money(r.allocated_yield_atomic))).toString(),
      paidAtomic: money(r.paid_atomic),
      pendingAtomic: money(r.pending_atomic),
      liabilityAtomic: money(r.liability_atomic),
    },
    registeredCount: Number(r.registered_count),
    observedAt: iso(r.observed_at),
  };
}

const EVENT_SELECT = `
  e.id, e.chain_event_id, d.network, d.contract_id, e.organizer_account, e.asset_contract, e.state,
  e.onchain_title, e.onchain_location, e.onchain_rules_text,
  e.deposit_atomic::text AS deposit_atomic, e.capacity,
  e.reg_open, e.reg_close, e.cancel_cutoff, e.checkin_open, e.checkin_close, e.finalize_deadline,
  e.accepted_atomic::text AS accepted_atomic, e.paid_atomic::text AS paid_atomic,
  e.realized_yield_atomic::text AS realized_yield_atomic,
  e.allocated_yield_atomic::text AS allocated_yield_atomic,
  e.pending_atomic::text AS pending_atomic, e.liability_atomic::text AS liability_atomic,
  e.observed_at,
  (SELECT count(*)::int FROM registrations_projection r
    WHERE r.event_id = e.id AND r.state <> 'WITHDRAWN') AS registered_count
  FROM events_projection e
  JOIN deployments d ON d.id = e.deployment_id`;

export class PgStore implements Store {
  constructor(private readonly pool: Pool) {}

  private rheaRow(r:{approval_id:string;treasury_account:string;plan_hash:string;native_reserved_atomic:string;usdc_reserved_atomic:string;journal:Record<string,unknown>}):RheaRun{return {approvalId:r.approval_id,treasury:r.treasury_account,planHash:r.plan_hash,nativeReservedAtomic:money(r.native_reserved_atomic),usdcReservedAtomic:money(r.usdc_reserved_atomic),journal:r.journal};}
  async getRheaRun(id:string):Promise<RheaRun|null>{const q=await this.pool.query(`SELECT approval_id,treasury_account,plan_hash,native_reserved_atomic::text,usdc_reserved_atomic::text,journal FROM rhea_microtest_runs WHERE approval_id=$1`,[id]);return q.rows[0]?this.rheaRow(q.rows[0]):null;}
  async updateRheaRun(seed:RheaRun,change:(run:RheaRun)=>RheaRun):Promise<RheaRun>{const c=await this.pool.connect();try{await c.query('BEGIN');await c.query(`INSERT INTO rhea_microtest_runs(approval_id,treasury_account,network,plan_hash,native_reserved_atomic,usdc_reserved_atomic,journal) VALUES($1,$2,'mainnet',$3,0,0,'{}') ON CONFLICT(approval_id) DO NOTHING`,[seed.approvalId,seed.treasury,seed.planHash]);const q=await c.query(`SELECT approval_id,treasury_account,plan_hash,native_reserved_atomic::text,usdc_reserved_atomic::text,journal FROM rhea_microtest_runs WHERE approval_id=$1 FOR UPDATE`,[seed.approvalId]);const run=this.rheaRow(q.rows[0]);if(run.treasury!==seed.treasury||run.planHash!==seed.planHash)throw new Error('approval identity mismatch');const out=change(run);await c.query(`UPDATE rhea_microtest_runs SET native_reserved_atomic=$2,usdc_reserved_atomic=$3,journal=$4::jsonb,updated_at=clock_timestamp() WHERE approval_id=$1`,[seed.approvalId,out.nativeReservedAtomic,out.usdcReservedAtomic,JSON.stringify(out.journal)]);await c.query('COMMIT');return out;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async listEvents(opts: { limit: number; cursor: { regOpen: string; id: string } | null; network?:string }): Promise<EventListData> {
    const params: unknown[] = [];
    let where = ` WHERE e.state = 'PUBLISHED'`;
    if (opts.cursor) {
      params.push(Date.parse(opts.cursor.regOpen), opts.cursor.id);
      where += ` AND (e.reg_open, e.id) > (to_timestamp($${params.length-1}::double precision / 1000.0), $${params.length})`;
    }
    if(opts.network){params.push(opts.network);where+=` AND d.network = $${params.length}`;}
    params.push(opts.limit + 1);
    const sql = `SELECT ${EVENT_SELECT}${where} ORDER BY e.reg_open ASC, e.id ASC LIMIT $${params.length}`;
    const res = await this.pool.query<EventRow>(sql, params);
    const rows = res.rows;
    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    const items = page.map(mapEvent);
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({ regOpen: last.reg_open.toISOString(), id: last.id }), 'utf8').toString('base64url') : null;
    return { items, nextCursor };
  }

  async getEvent(id: string): Promise<PublicEvent | null> {
    const res = await this.pool.query<EventRow>(`SELECT ${EVENT_SELECT} WHERE e.id = $1`, [id]);
    return res.rows[0] ? mapEvent(res.rows[0]) : null;
  }
  async getEventByChainEventId(id: string, network?:string, contractId?:string): Promise<PublicEvent | null> {
    const params:unknown[]=[id];let filter='';if(network){params.push(network);filter+=` AND d.network=$${params.length}`;}if(contractId){params.push(contractId);filter+=` AND d.contract_id=$${params.length}`;}
    const res = await this.pool.query<EventRow>(`SELECT ${EVENT_SELECT} WHERE e.chain_event_id = $1${filter} LIMIT 2`,params);
    return res.rows.length===1 ? mapEvent(res.rows[0]!) : null;
  }
  async getEventResults(id: string): Promise<EventResultsRead | null> {
    const ev = await this.pool.query<EventRow>(`SELECT ${EVENT_SELECT} WHERE ${isUuid(id) ? "e.id" : "e.chain_event_id"} = $1 LIMIT 2`, [id]);
    if (ev.rows.length !== 1) return null;
    const event = ev.rows[0];
    if (!event) return null;
    const counts = await this.pool.query<{ registrations: string; active: string; withdrawn: string; attendees: string; no_shows: string }>(
      `SELECT count(*)::text registrations, count(*) FILTER (WHERE state <> 'WITHDRAWN')::text active,
       count(*) FILTER (WHERE state = 'WITHDRAWN')::text withdrawn,
       count(*) FILTER (WHERE state = 'ATTENDED')::text attendees,
       count(*) FILTER (WHERE state = 'NO_SHOW')::text no_shows
       FROM registrations_projection WHERE event_id = $1`, [event.id]);
    const c = counts.rows[0]!;
    const refund = event.state === 'CANCELLED' || event.state === 'REFUND_ONLY';
    const finalized = ['ATTENDANCE_FINALIZED', 'SETTLING', 'SETTLED', 'CANCELLED', 'REFUND_ONLY'].includes(event.state);
    return {
      eventId: event.id, chainEventId: event.chain_event_id, state: event.state,
      counts: { registrations: Number(c.registrations), activeRegistrations: Number(c.active), withdrawn: Number(c.withdrawn), attendees: Number(c.attendees), noShows: Number(c.no_shows) },
      totals: { acceptedAtomic: money(event.accepted_atomic), realizedYieldAtomic: money(event.realized_yield_atomic), allocatedYieldAtomic: money(event.allocated_yield_atomic), unallocatedYieldAtomic: (BigInt(money(event.realized_yield_atomic))-BigInt(money(event.allocated_yield_atomic))).toString(), paidAtomic: money(event.paid_atomic), pendingAtomic: money(event.pending_atomic), liabilityAtomic: money(event.liability_atomic) },
      finalized, refund: { available: refund, reason: event.state === 'CANCELLED' ? 'CANCELLED' : event.state === 'REFUND_ONLY' ? 'TIMEOUT' : null, principalAtomic: refund ? money(event.deposit_atomic) : null },
      settlement: { available: event.state === 'SETTLED', claimsEnabled: event.state === 'SETTLED', complete: event.state === 'SETTLED' },
      yield: { status: 'UNAVAILABLE', reason: 'ABI_NOT_FROZEN' }, observedAt: iso(event.observed_at),
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
    await this.pool.query(
      `INSERT INTO auth_challenges
         (id, nonce_hash, purpose, domain, network, account_id, linking_user_id, issued_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8::double precision / 1000.0), to_timestamp($9::double precision / 1000.0))`,
      [c.id, c.nonceHash, c.purpose, c.domain, c.network, c.accountId, c.linkingUserId, c.issuedAtMs, c.expiresAtMs],
    );
  }

  async getChallenge(id: string): Promise<ChallengeRow | null> {
    const res = await this.pool.query<{
      id: string;
      nonce_hash: string;
      purpose: string;
      domain: string;
      network: string;
      account_id: string;
      linking_user_id: string | null;
      issued_at: Date;
      expires_at: Date;
      consumed_at: Date | null;
    }>(
      `SELECT id, nonce_hash, purpose, domain, network, account_id, linking_user_id, issued_at, expires_at, consumed_at
       FROM auth_challenges WHERE id = $1`,
      [id],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: r.id,
      nonceHash: r.nonce_hash,
      purpose: r.purpose,
      domain: r.domain,
      network: r.network,
      accountId: r.account_id,
      linkingUserId: r.linking_user_id,
      issuedAtMs: r.issued_at.getTime(),
      expiresAtMs: r.expires_at.getTime(),
      consumedAt: r.consumed_at ? r.consumed_at.getTime() : null,
    };
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
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Acquire the row lock before evaluating expiry. An UPDATE predicate can
      // be evaluated before waiting on an unchanged SELECT FOR UPDATE lock.
      await client.query('SELECT id FROM auth_challenges WHERE id = $1 FOR UPDATE', [args.challengeId]);
      // 1. Atomic single-use nonce consumption, anchored to DATABASE time at the
      //    moment the row lock is actually acquired (`clock_timestamp()` is the
      //    real wall clock, evaluated after any lock wait — unlike `now()` which
      //    is fixed at transaction start). A challenge that expires while the
      //    caller/competitor is blocked on this lock is therefore denied, not
      //    consumed. No caller-supplied timestamp is trusted for the expiry gate.
      const consumed = await client.query(
        `UPDATE auth_challenges SET consumed_at = clock_timestamp()
         WHERE id = $1 AND consumed_at IS NULL AND expires_at > clock_timestamp()
         RETURNING id`,
        [args.challengeId],
      );
      if (consumed.rowCount === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      // 2. Anchor the session timestamps on ACTUAL current DB time (post-lock),
      //    not a pre-RPC/pre-await timestamp from the caller.
      const anchor = await client.query<{ now_ms: string }>(
        `SELECT (extract(epoch from clock_timestamp()) * 1000)::bigint AS now_ms`,
      );
      const nowMsRow = anchor.rows[0];
      if (!nowMsRow || !Number.isFinite(Number(nowMsRow.now_ms))) {
        throw new Error('could not read the database clock for session anchoring');
      }
      const dbNowMs = Number(nowMsRow.now_ms);
      const idleExpiresAt = dbNowMs + args.idleMs;
      const absoluteExpiresAt = dbNowMs + args.absoluteMs;

      // 3. Resolve (or create) the immutable NEAR wallet binding for this account.
      const { userId, bindingId } = await this.ensureBindingTx(client, {
        namespace: args.namespace,
        network: args.network,
        accountId: args.accountId,
        walletKind: args.walletKind,
        nowMs: dbNowMs,
      });
      // 4. Open the session (random token hash stored; raw token never persisted).
      await client.query(
        `INSERT INTO sessions (id, token_hash, user_id, wallet_binding_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
         VALUES ($1, $2, $3, $4, to_timestamp($5::double precision / 1000.0), to_timestamp($5::double precision / 1000.0),
                 to_timestamp($6::double precision / 1000.0), to_timestamp($7::double precision / 1000.0))`,
        [args.sessionId, args.tokenHash, userId, bindingId, dbNowMs, idleExpiresAt, absoluteExpiresAt],
      );
      await client.query('COMMIT');
      return { userId, bindingId, sessionId: args.sessionId, nowMs: dbNowMs };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      client.release();
    }
  }

  private async ensureBindingTx(
    client: PoolClient,
    args: { namespace: string; network: string; accountId: string; walletKind: string; nowMs: number },
  ): Promise<{ userId: string; bindingId: string }> {
    let row = await client.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM wallet_bindings
       WHERE namespace = $1 AND network = $2 AND account_id = $3 FOR UPDATE`,
      [args.namespace, args.network, args.accountId],
    );
    if (row.rows[0]) return { userId: row.rows[0].user_id, bindingId: row.rows[0].id };

    const userId = randomUUID();
    const bindingId = randomUUID();
    await client.query(
      `INSERT INTO app_users (id, created_at) VALUES ($1, to_timestamp($2::double precision / 1000.0))`,
      [userId, args.nowMs],
    );
    const inserted = await client.query<{ id: string; user_id: string }>(
      `INSERT INTO wallet_bindings (id, user_id, namespace, network, account_id, wallet_kind, verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7::double precision / 1000.0))
       ON CONFLICT (namespace, network, account_id) DO NOTHING
       RETURNING id, user_id`,
      [bindingId, userId, args.namespace, args.network, args.accountId, args.walletKind, args.nowMs],
    );
    if (inserted.rows[0]) return { userId: inserted.rows[0].user_id, bindingId: inserted.rows[0].id };
    // Lost a race to a concurrent binding insert; read the winner's committed row.
    row = await client.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM wallet_bindings
       WHERE namespace = $1 AND network = $2 AND account_id = $3 FOR UPDATE`,
      [args.namespace, args.network, args.accountId],
    );
    const r = row.rows[0];
    if (!r) throw new Error('wallet binding disappeared during creation');
    return { userId: r.user_id, bindingId: r.id };
  }

  async getSessionByTokenHash(tokenHash: string, _nowMs: number): Promise<SessionRow | null> {
    const res = await this.pool.query<{
      id: string;
      token_hash: string;
      user_id: string | null;
      wallet_binding_id: string | null;
      created_at: Date;
      last_seen_at: Date;
      idle_expires_at: Date;
      absolute_expires_at: Date;
      revoked_at: Date | null;
    }>(
      `SELECT id, token_hash, user_id, wallet_binding_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at
       FROM sessions WHERE token_hash = $1`,
      [tokenHash],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: r.id,
      tokenHash: r.token_hash,
      userId: r.user_id ?? '',
      walletBindingId: r.wallet_binding_id,
      createdAt: r.created_at.getTime(),
      lastSeenAt: r.last_seen_at.getTime(),
      idleExpiresAt: r.idle_expires_at.getTime(),
      absoluteExpiresAt: r.absolute_expires_at.getTime(),
      revokedAt: r.revoked_at ? r.revoked_at.getTime() : null,
    };
  }

  async revokeSession(tokenHash: string, nowMs: number): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE sessions SET revoked_at = to_timestamp($2::double precision / 1000.0)
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash, nowMs],
    );
    return res.rowCount === 1;
  }

  async touchSession(tokenHash: string, nowMs: number, idleExpiresAt: number): Promise<void> {
    await this.pool.query(
      `UPDATE sessions SET last_seen_at = to_timestamp($2::double precision / 1000.0),
                           idle_expires_at = to_timestamp($3::double precision / 1000.0)
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash, nowMs, idleExpiresAt],
    );
  }

  async getBinding(namespace: string, network: string, accountId: string): Promise<WalletBindingRow | null> {
    const res = await this.pool.query<{
      id: string;
      user_id: string;
      namespace: string;
      network: string;
      account_id: string;
      wallet_kind: string;
    }>(
      `SELECT id, user_id, namespace, network, account_id, wallet_kind
       FROM wallet_bindings WHERE namespace = $1 AND network = $2 AND account_id = $3`,
      [namespace, network, accountId],
    );
    const r = res.rows[0];
    if (!r) return null;
    return { id: r.id, userId: r.user_id, namespace: r.namespace, network: r.network, accountId: r.account_id, walletKind: r.wallet_kind };
  }

  async getBindingById(id: string): Promise<WalletBindingRow | null> {
    const res = await this.pool.query<{ id:string; user_id:string; namespace:string; network:string; account_id:string; wallet_kind:string }>(`SELECT id,user_id,namespace,network,account_id,wallet_kind FROM wallet_bindings WHERE id=$1 AND disabled_at IS NULL`, [id]);
    const r=res.rows[0]; return r ? {id:r.id,userId:r.user_id,namespace:r.namespace,network:r.network,accountId:r.account_id,walletKind:r.wallet_kind} : null;
  }

  async listPasses(accountId: string, network: string): Promise<PassRead[]> {
    const res=await this.pool.query<{id:string;event_id:string;network:string;contract_id:string;chain_event_id:string;chain_registration_id:string;pass_id:string;owner_account:string;registration_status:string;attended:boolean;payout_state:string;observed_at:Date}>(`SELECT p.id,r.event_id,d.network,d.contract_id,e.chain_event_id,r.chain_registration_id,p.pass_id,p.owner_account,r.state AS registration_status,r.attended,r.payout_state,GREATEST(p.observed_at,r.observed_at,e.observed_at) AS observed_at FROM passes_projection p JOIN registrations_projection r ON r.id=p.registration_id JOIN events_projection e ON e.id=r.event_id JOIN deployments d ON d.id=e.deployment_id AND d.id=p.deployment_id WHERE p.owner_account=$1 AND d.network=$2 ORDER BY p.issued_at DESC,p.id`,[accountId,network]);
    return res.rows.map(r=>({id:r.id,eventId:r.event_id,network:r.network,contractId:r.contract_id,chainEventId:r.chain_event_id,chainRegistrationId:r.chain_registration_id,chainPassId:r.pass_id,ownerAccount:r.owner_account,registrationStatus:r.registration_status,attendanceStatus:r.attended,financialStatus:r.payout_state,observedAt:iso(r.observed_at),finalized:true}));
  }

  async listClaims(accountId: string, network: string): Promise<ClaimRead[]> {
    const res=await this.pool.query<{id:string;event_id:string;network:string;contract_id:string;chain_event_id:string;chain_registration_id:string;pass_id:string|null;beneficiary_account:string;principal_atomic:string;claim_atomic:string;payout_state:string;observed_at:Date}>(`SELECT r.id,r.event_id,d.network,d.contract_id,e.chain_event_id,r.chain_registration_id,p.pass_id,r.beneficiary_account,r.principal_atomic::text,r.claim_atomic::text,r.payout_state,r.observed_at FROM registrations_projection r JOIN events_projection e ON e.id=r.event_id JOIN deployments d ON d.id=e.deployment_id LEFT JOIN passes_projection p ON p.registration_id=r.id AND p.deployment_id=d.id WHERE r.beneficiary_account=$1 AND d.network=$2 ORDER BY r.observed_at DESC,r.id`,[accountId,network]);
    return res.rows.map(r=>{const principal=money(r.principal_atomic), claim=money(r.claim_atomic); return {id:r.id,eventId:r.event_id,network:r.network,contractId:r.contract_id,chainEventId:r.chain_event_id,chainRegistrationId:r.chain_registration_id,chainPassId:r.pass_id,beneficiaryAccount:r.beneficiary_account,principalAtomic:principal,bonusAtomic:claimBonusAtomic(principal,claim),claimAtomic:claim,payoutState:r.payout_state,observedAt:iso(r.observed_at),finalized:true};});
  }

  async getAttendance(eventId: string, organizerAccount: string, network: string): Promise<AttendanceRead[] | null> {
    const ev=await this.pool.query<{organizer_account:string}>(`SELECT e.organizer_account FROM events_projection e JOIN deployments d ON d.id=e.deployment_id WHERE e.id=$1 AND d.network=$2`,[eventId,network]);
    if(!ev.rows[0] || ev.rows[0].organizer_account!==organizerAccount) return null;
    const res=await this.pool.query<{id:string;network:string;contract_id:string;chain_event_id:string;chain_registration_id:string;pass_id:string|null;participant_account:string;attended:boolean;state:string;payout_state:string;observed_at:Date}>(`SELECT r.id,d.network,d.contract_id,e.chain_event_id,r.chain_registration_id,p.pass_id,r.participant_account,r.attended,r.state,r.payout_state,r.observed_at FROM registrations_projection r JOIN events_projection e ON e.id=r.event_id JOIN deployments d ON d.id=e.deployment_id LEFT JOIN passes_projection p ON p.registration_id=r.id AND p.deployment_id=d.id WHERE r.event_id=$1 AND d.network=$2 AND e.organizer_account=$3 ORDER BY r.sequence_no,r.id`,[eventId,network,organizerAccount]);
    return res.rows.map(r=>({registrationId:r.id,network:r.network,contractId:r.contract_id,chainEventId:r.chain_event_id,chainRegistrationId:r.chain_registration_id,chainPassId:r.pass_id,participantAccount:r.participant_account,attendanceStatus:r.attended,registrationStatus:r.state,payoutState:r.payout_state,observedAt:iso(r.observed_at),finalized:true}));
  }

  async getContentAccess(eventId: string, accountId: string, network: string): Promise<ContentResourceRead[] | null> {
    const res=await this.pool.query<{object_key:string;title:string;mime_type:string;published_at:Date|null;observed_at:Date}>(`SELECT pr.object_key,pr.title,pr.mime_type,pr.published_at,GREATEST(e.observed_at,r.observed_at) AS observed_at FROM protected_resources pr JOIN events_projection e ON e.id=pr.event_id JOIN deployments d ON d.id=e.deployment_id JOIN registrations_projection r ON r.event_id=e.id WHERE e.id=$1 AND d.network=$2 AND e.state='SETTLED' AND r.participant_account=$3 AND r.beneficiary_account=$3 AND r.attended=true AND r.state='ATTENDED' AND pr.deleted_at IS NULL AND pr.published_at IS NOT NULL`,[eventId,network,accountId]);
    if(res.rows.length===0) return null;
    return res.rows.map(r=>({objectKey:r.object_key,title:r.title,mimeType:r.mime_type,publishedAt:r.published_at?iso(r.published_at):null,observedAt:iso(r.observed_at)}));
  }
  async publishResource(a:{id:string;eventId:string;objectKey:string;title:string;mimeType:string;bytesSize:number}):Promise<string> {
    const result=await this.pool.query<{published_at:Date}>(`INSERT INTO protected_resources(id,event_id,object_key,title,mime_type,bytes_size,published_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()) RETURNING published_at`,[a.id,a.eventId,a.objectKey,a.title,a.mimeType,a.bytesSize]);
    return iso(result.rows[0]!.published_at);
  }
  async findPass(eventId:string, passId:string, owner:string): Promise<{registrationId:string;chainPassId:string}|null> {
    const q=await this.pool.query<{registration_id:string;pass_id:string}>(`SELECT p.registration_id,p.pass_id FROM passes_projection p JOIN registrations_projection r ON r.id=p.registration_id WHERE r.event_id=$1 AND p.id=$2 AND p.owner_account=$3`,[eventId,passId,owner]);
    const r=q.rows[0]; return r ? {registrationId:r.registration_id,chainPassId:r.pass_id} : null;
  }
  async createQr(a:{id:string;registrationId:string;nonceHash:string;owner:string;issuedAt:number;expiresAt:number}):Promise<void> {
    await this.pool.query(`INSERT INTO qr_challenges(id,registration_id,nonce_hash,owner_account,key_id,issued_at,expires_at) VALUES($1,$2,$3,$4,'v1',to_timestamp($5::double precision/1000),to_timestamp($6::double precision/1000))`,[a.id,a.registrationId,a.nonceHash,a.owner,a.issuedAt,a.expiresAt]);
  }
  async consumeQr(a:{id:string;eventId:string;nonceHash:string;owner:string;organizer:string;requestId:string}):Promise<boolean> {
    const client=await this.pool.connect();
    try { await client.query('BEGIN');
      const q=await client.query<{registration_id:string}>(`UPDATE qr_challenges q SET consumed_at=clock_timestamp() FROM registrations_projection r WHERE q.id=$1 AND q.registration_id=r.id AND r.event_id=$2 AND q.nonce_hash=$3 AND q.owner_account=$4 AND q.consumed_at IS NULL AND q.expires_at>clock_timestamp() RETURNING q.registration_id`,[a.id,a.eventId,a.nonceHash,a.owner]);
      if(!q.rows[0]) { await client.query('ROLLBACK'); return false; }
      await client.query(`INSERT INTO checkin_requests(id,registration_id,qr_challenge_id,organizer_account,state) VALUES($1,$2,$3,$4,'PROPOSED')`,[a.requestId,q.rows[0].registration_id,a.id,a.organizer]);
      await client.query('COMMIT'); return true;
    } catch(e) { await client.query('ROLLBACK'); throw e; } finally {client.release();}
  }

}
