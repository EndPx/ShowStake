import { assertMoneyString } from '@showstake/domain';
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type { ChallengeRow, EventListData, PublicEvent, SessionRow, WalletBindingRow } from '../types.js';
import type { Store } from './types.js';

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
  deposit_atomic: string;
  capacity: number;
  reg_open: Date;
  reg_close: Date;
  cancel_cutoff: Date;
  checkin_open: Date;
  checkin_close: Date;
  finalize_deadline: Date;
  accepted_atomic: string;
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
  e.deposit_atomic::text AS deposit_atomic, e.capacity,
  e.reg_open, e.reg_close, e.cancel_cutoff, e.checkin_open, e.checkin_close, e.finalize_deadline,
  e.accepted_atomic::text AS accepted_atomic, e.paid_atomic::text AS paid_atomic,
  e.pending_atomic::text AS pending_atomic, e.liability_atomic::text AS liability_atomic,
  e.observed_at,
  (SELECT count(*)::int FROM registrations_projection r
    WHERE r.event_id = e.id AND r.state <> 'WITHDRAWN') AS registered_count
  FROM events_projection e
  JOIN deployments d ON d.id = e.deployment_id`;

export class PgStore implements Store {
  constructor(private readonly pool: Pool) {}

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async listEvents(opts: { limit: number; cursor: { regOpen: string; id: string } | null }): Promise<EventListData> {
    const params: unknown[] = [];
    let where = ` WHERE e.state = 'PUBLISHED'`;
    if (opts.cursor) {
      params.push(Date.parse(opts.cursor.regOpen), opts.cursor.id);
      where += ` AND (e.reg_open, e.id) > (to_timestamp($1::double precision / 1000.0), $2)`;
    }
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
}
