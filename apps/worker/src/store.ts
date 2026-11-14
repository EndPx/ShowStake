// Projection store: a least-privilege worker DB pool plus the transactional
// ingestion core.
//
// Cursor invariant (frozen): each ingest is ONE PostgreSQL transaction guarded by
// a per-(deployment, consumer) transaction-scoped advisory lock taken BEFORE the
// cursor is read, so the cursor can only advance monotonically, contiguously, and
// to an official-RPC-canonical hash:
//   * first cursor creation is serialized by the same lock and must land exactly
//     on the DB deployment start_block (no omitted history);
//   * a gap (height > cursor+1) throws UNLESS every intermediate height is
//     canonically proven skipped by the official RPC (never a blind skip);
//   * a fork (same height, different hash) throws;
//   * an older canonical block is an idempotent replay only when every event it
//     carries was already ingested with the same provenance; it never regresses
//     and never injects new chain events at an already-passed height;
//   * the cursor upsert is conditional on the EXACT expected previous
//     height+hash, so a lost lock/serialization bug fails closed instead of
//     overwriting a newer cursor.
// Any canonical/finality/validation/enrichment/DB error rolls the whole block
// back, so the cursor can never advance past required unprocessed data.
// Malformed cursor state is a hard failure (fail-closed), never silently treated
// as "start over at null".
//
// The ingestion id is bound to the DB deployment row and the allowlist INSIDE the
// transaction (FOR SHARE), so a stale/foreign id can never project under this
// consumer. Canonical hash + official-finality proof happen in the production
// ingest path itself, not only in tests.
import { randomUUID } from 'node:crypto';
import { isMulti, isCandidate, isMainnetCandidate, isLinkedCandidate, LINKED_POLICY, parseCandidateEvent, parseCandidateRegistration, validateCandidatePasses, validateCandidateConfig, validateCandidateCoverage, validateLinkedCoverage } from './candidate.js';
import { parseMultiLogs, readMultiSnapshot } from './multievent.js';
import { Pool, type Client, type PoolConfig } from 'pg';
import { WORKER_DB_ROLE, type DeploymentAllowlist } from './config.js';
import { assertAllowlistIdentity } from './identity.js';
import { classifyEvent, parseShowStakeLogs } from './events.js';
import type { AttendanceData, FinalizeData, PayoutData, SettleChunkData, SettleEndData, SettleStartData } from './events.js';
import { buildChainEvent, enrichPublish, mapEventState, parseEventView, parsePayoutView, parseSettlementView, parseTotalsView } from './project.js';
import type { EventTotalsViewData, PayoutViewData, SettlementViewData } from './project.js';
import type { CanonicalBlockHeader, CanonicalVerifier, ChainEventInsert, DeploymentRow, NormalizedBlock, PublishRules, ViewSource } from './types.js';

export interface LiveChain {
  viewSource: ViewSource;
  accountCodeHash(accountId: string, finality?: string): Promise<string>;
}

export interface IngestSummary {
  blockHeight: number;
  blockHash: string;
  matchedReceipts: number;
  publishedEvents: number;
  committedRegistrations: number;
  settlementEvents: number;
  payoutEvents: number;
  provenanceEvents: number;
  /** the durable cursor height after this ingest (unchanged on replay). */
  cursorHeight: number;
}

/** Event-derived transitions are reconciled against ONE pinned totals view per block. */
type BlockFinancialReconcile = Map<string, EventTotalsViewData>;

/** A parsed, validated `worker_cursors.cursor_value` row. */
export interface CursorState {
  block_height: number;
  block_hash: string;
}

/** Strictly parse a `worker_cursors.cursor_value` jsonb. Malformed state throws. */
export function parseCursorValue(cursorValue: unknown): CursorState {
  if (typeof cursorValue !== 'object' || cursorValue === null || Array.isArray(cursorValue)) {
    throw new Error('worker_cursors.cursor_value is not an object');
  }
  const v = cursorValue as Record<string, unknown>;
  const height = v['block_height'];
  const hash = v['block_hash'];
  if (typeof height !== 'number' || !Number.isSafeInteger(height) || height < 0) {
    throw new Error('worker_cursors.cursor_value.block_height is not a non-negative safe integer');
  }
  if (typeof hash !== 'string' || hash.length === 0 || hash.length > 128 || /\s/.test(hash)) {
    throw new Error('worker_cursors.cursor_value.block_hash is not a single non-empty token');
  }
  return { block_height: height, block_hash: hash };
}

/** Validate a deployments row against the explicit allowlist; returns start_block. */
function assertDeploymentRow(row: DeploymentRow, d: DeploymentAllowlist): number {
  if (row.environment !== d.environment) throw new Error(`deployment environment mismatch: ${row.environment}`);
  if (row.network !== d.network) throw new Error(`deployment network mismatch: ${row.network}`);
  if (row.contract_id !== d.contractId) throw new Error('deployment contract_id mismatch');
  if (row.ft_contract_id !== d.ftContractId) throw new Error('deployment ft_contract_id mismatch');
  if (Number(row.ft_decimals) !== d.ftDecimals) throw new Error('deployment ft_decimals mismatch');
  if (row.code_hash !== d.codeHash) throw new Error('deployment code_hash mismatch');
  const startBlock = Number(row.start_block);
  if (!Number.isSafeInteger(startBlock) || startBlock < 0) throw new Error('deployment start_block invalid');
  return startBlock;
}

/** Build a worker pool whose every connection runs `SET ROLE showstake_worker`. */
export function createWorkerPool(config: PoolConfig): Pool {
  return new Pool({
    ...config,
    onConnect: async (client) => {
      await client.query(`SET ROLE ${JSON.stringify(WORKER_DB_ROLE)}`);
      // The service LOGIN must be a dedicated, unprivileged NOINHERIT role:
      // no operator attributes, no escalation membership, no direct/inherited
      // writes to projection tables (so `RESET ROLE` cannot restore authority).
      const identity = await client.query<{ unsafe: boolean }>(`
        SELECT (
          r.rolsuper
          OR r.rolcreatedb
          OR r.rolcreaterole
          OR r.rolreplication
          OR r.rolbypassrls
          OR r.rolinherit
          OR EXISTS (
            SELECT 1 FROM pg_auth_members am
              JOIN pg_roles member ON member.oid = am.member
             WHERE member.rolname = session_user AND am.inherit_option
          )
          OR pg_has_role(session_user, 'showstake_api', 'MEMBER')
          OR pg_has_role(session_user, 'showstake_migration', 'MEMBER')
          OR EXISTS (
            SELECT 1 FROM pg_auth_members am
              JOIN pg_roles member ON member.oid = am.member
              JOIN pg_roles granted ON granted.oid = am.roleid
             WHERE member.rolname = session_user
               AND (granted.rolsuper OR granted.rolcreatedb OR granted.rolcreaterole
                    OR granted.rolreplication OR granted.rolbypassrls)
          )
          OR has_table_privilege(session_user, 'app_users', 'INSERT,UPDATE,DELETE')
          OR has_table_privilege(session_user, 'sessions', 'INSERT,UPDATE,DELETE')
          OR has_table_privilege(session_user, 'deployments', 'INSERT,UPDATE,DELETE')
          OR has_table_privilege(session_user, 'chain_events', 'INSERT,UPDATE,DELETE')
          OR has_table_privilege(session_user, 'events_projection', 'INSERT,UPDATE,DELETE')
          OR has_table_privilege(session_user, 'registrations_projection', 'INSERT,UPDATE,DELETE')
          OR has_table_privilege(session_user, 'passes_projection', 'INSERT,UPDATE,DELETE')
          OR has_table_privilege(session_user, 'payouts_projection', 'INSERT,UPDATE,DELETE')
          OR has_table_privilege(session_user, 'worker_cursors', 'INSERT,UPDATE,DELETE')
        ) AS unsafe
        FROM pg_roles r WHERE r.rolname = session_user`);
      if (!identity.rows[0] || identity.rows[0].unsafe) {
        throw new Error('worker requires a dedicated unprivileged NOINHERIT LOGIN; operator/superuser credentials are forbidden');
      }
    },
  });
}

/**
 * Proves the runtime pool operates as the restricted worker role (fail closed),
 * and that `RESET ROLE` cannot restore any write authority. Restores the worker
 * role before the connection is reused.
 */
export async function assertWorkerLeastPrivilege(pool: Pool): Promise<void> {
  const readOnlyTables = [
    'deployments',
    'factory_deployment_allowlist',
    'app_users',
    'sessions',
    'chain_events',
    'events_projection',
    'registrations_projection',
    'passes_projection',
    'payouts_projection',
    'worker_cursors',
  ] as const;
  const client = await pool.connect();
  try {
    const cur = await client.query<{ current_user: string; session_user: string }>('SELECT current_user, session_user');
    if (cur.rows[0]?.current_user !== WORKER_DB_ROLE) {
      throw new Error(`worker least-privilege check failed: current_user ${cur.rows[0]?.current_user}`);
    }
    for (const table of readOnlyTables) {
      let denied = false;
      try {
        await client.query(`DELETE FROM ${table} WHERE false`);
      } catch (e) {
        denied = (e as { code?: string }).code === '42501';
      }
      if (!denied) throw new Error(`worker role can mutate ${table} (must be read-only)`);
    }

    // RESET ROLE must land on the unprivileged NOINHERIT service login and must
    // NOT restore any projection/cursor write authority (accepted-API pattern).
    try {
      await client.query('RESET ROLE');
      const reset = await client.query<{ current_user: string; session_user: string }>('SELECT current_user, session_user');
      const who = `${reset.rows[0]?.current_user}/${reset.rows[0]?.session_user}`;
      if (reset.rows[0]?.current_user !== reset.rows[0]?.session_user) {
        throw new Error(`worker least-privilege check failed: RESET ROLE did not return to the session login (${who})`);
      }
      for (const probe of [
        `UPDATE public.events_projection SET deposit_atomic = deposit_atomic WHERE false`,
        `DELETE FROM public.worker_cursors WHERE false`,
      ]) {
        let denied = false;
        let detail = 'no error (write allowed)';
        try {
          await client.query(probe);
        } catch (e) {
          const err = e as { code?: string; message?: string };
          denied = err.code === '42501';
          detail = `${err.code}: ${err.message}`;
        }
        if (!denied) throw new Error(`worker service LOGIN can write after RESET ROLE (${who}; ${detail}): ${probe}`);
      }
    } finally {
      await client.query(`SET ROLE ${JSON.stringify(WORKER_DB_ROLE)}`);
    }
  } finally {
    client.release();
  }
}

export class WorkerStore {
  constructor(
    private readonly pool: Pool,
    private readonly allowlist: DeploymentAllowlist,
    private readonly consumer: string,
    private readonly live: LiveChain,
    private readonly canonical: CanonicalVerifier,
  ) {
    assertAllowlistIdentity(allowlist);
    if (!consumer) throw new Error('worker consumer id is required');
  }

  private lockKey(deploymentId: string): string {
    return `${deploymentId}:${this.consumer}`;
  }

  /** Resolve and verify the allowlisted deployment against the DB row. */
  async resolveDeployment(): Promise<{ id: string; startBlock: number }> {
    const res = await this.pool.query<DeploymentRow>(
      `SELECT id, environment, network, contract_id, ft_contract_id, ft_decimals, start_block::text, code_hash
         FROM deployments WHERE network = $1 AND contract_id = $2`,
      [this.allowlist.network, this.allowlist.contractId],
    );
    const row = res.rows[0];
    if (!row) throw new Error(`no deployment row for ${this.allowlist.network}/${this.allowlist.contractId}`);
    const startBlock = assertDeploymentRow(row, this.allowlist);
    if (this.allowlist.startHeight < startBlock) {
      throw new Error(`start height ${this.allowlist.startHeight} precedes deployment start_block ${startBlock}`);
    }
    return { id: row.id, startBlock };
  }

  /**
   * Resolve the first height to ingest. Fresh-start requires the configured
   * start height to EXACTLY equal the deployment start_block (never skip
   * required history); an existing durable cursor resumes from cursor+1. Throws
   * on malformed cursor state (fail-closed, never "restart at null").
   */
  async resolveStartHeight(deploymentId: string, startBlock: number): Promise<number> {
    const cursor = await this.readCursor(deploymentId);
    if (cursor !== null) {
      if (cursor.block_height < startBlock) {
        throw new Error(
          `resume gate: durable cursor ${cursor.block_height} precedes deployment start_block ${startBlock}`,
        );
      }
      return cursor.block_height + 1;
    }
    if (this.allowlist.startHeight !== startBlock) {
      throw new Error(
        `exact-start gate: configured start height ${this.allowlist.startHeight} != deployment start_block ${startBlock} and no resume cursor; refusing to omit required history`,
      );
    }
    return startBlock;
  }

  /** Live chain/token identity: code hash + get_config + actual FT metadata. */
  async verifyLiveIdentity(): Promise<void> {
    const codeHash = await this.live.accountCodeHash(this.allowlist.contractId);
    if (codeHash !== this.allowlist.codeHash) {
      throw new Error(`live code hash ${codeHash} != allowlist ${this.allowlist.codeHash}`);
    }
    const view = await this.live.viewSource.callView('get_config', { accountId: this.allowlist.contractId, args: {} }, 'final');
    const cfg = view.result as Record<string, unknown>;
    if (!isMulti(this.allowlist) && cfg['organizer'] !== this.allowlist.organizer) throw new Error(`live organizer ${String(cfg['organizer'])} mismatch`);
    if (cfg['canonical_ft'] !== this.allowlist.ftContractId) throw new Error('live canonical_ft mismatch');
    if (cfg['network'] !== this.allowlist.network) throw new Error(`live network ${String(cfg['network'])} mismatch`);
    if (cfg['policy_version'] !== this.allowlist.policyVersion) throw new Error('live policy_version mismatch');
    if (this.allowlist.adapter==='shared-yield-v2' && (cfg['schema_version']!==2 || cfg['provider_account']!==this.allowlist.candidateProviderAccount || cfg['provider_kind']!==(this.allowlist.network==='mainnet'?'RHEA_MAINNET':'MOCK_TESTNET'))) throw new Error('live shared yield provider mismatch');

    // Token identity is the FT's own on-chain metadata, not just the config/DB echo.
    const ftView = await this.live.viewSource.callView('ft_metadata', { accountId: this.allowlist.ftContractId, args: {} }, 'final');
    const meta = ftView.result as Record<string, unknown>;
    const decimals = meta['decimals'];
    if (typeof decimals !== 'number' && typeof decimals !== 'string') {
      throw new Error('ft_metadata.decimals missing');
    }
    const decimalsNum = typeof decimals === 'string' ? Number(decimals) : decimals;
    if (!Number.isSafeInteger(decimalsNum) || decimalsNum !== this.allowlist.ftDecimals) {
      throw new Error(`ft_metadata.decimals ${decimalsNum} != allowlist ${this.allowlist.ftDecimals}`);
    }
    const symbol = meta['symbol'];
    if (typeof symbol !== 'string' || symbol.length === 0) throw new Error('ft_metadata.symbol missing');
  }

  /** Read the durable cursor (strict). `null` means "no cursor row yet". */
  async readCursor(deploymentId: string): Promise<CursorState | null> {
    const res = await this.pool.query<{ cursor_value: unknown }>(
      `SELECT cursor_value FROM worker_cursors WHERE deployment_id = $1 AND consumer = $2`,
      [deploymentId, this.consumer],
    );
    const row = res.rows[0];
    if (!row) return null;
    // A row that exists but holds JSON null / junk is malformed state, not "no cursor".
    return parseCursorValue(row.cursor_value);
  }

  /** Read the durable cursor height (strict; throws on malformed state). */
  async readCursorHeight(deploymentId: string): Promise<number | null> {
    const cursor = await this.readCursor(deploymentId);
    return cursor === null ? null : cursor.block_height;
  }

  /**
   * Ingest one finalized block for one deployment: canonical/finality proof,
   * filter successful receipts for the allowlisted contract, parse/classify
   * showstake events, enrich publication rules from the pinned view, then persist
   * everything atomically with a monotonic cursor.
   */
  async ingestBlock(deploymentId: string, block: NormalizedBlock, refreshCandidate = false): Promise<IngestSummary> {
    if (block.height < this.allowlist.startHeight) {
      throw new Error(`block ${block.height} precedes configured start height ${this.allowlist.startHeight}`);
    }

    // Mandatory canonical + finality proof for EVERY ingest (production path).
    const canonicalHeader = await this.canonical.verifyBlock(block.height, block.hash);
    const finalHeight = await this.canonical.lastFinalHeight();
    if (block.height > finalHeight) {
      throw new Error(`block ${block.height} is not final (official final height ${finalHeight})`);
    }
    // The source's own predecessor fields must agree with the official canonical
    // header (a source may not claim a different chain shape under a real hash).
    if (block.prevHash !== canonicalHeader.prevHash || block.prevHeight !== canonicalHeader.prevHeight) {
      throw new Error(
        `source/official header mismatch at ${block.height}: source prev ${block.prevHeight}/${block.prevHash} != official ${canonicalHeader.prevHeight}/${canonicalHeader.prevHash}`,
      );
    }

    if (['showstake-native-usdc-event/1','showstake-native-usdc-rhea-review/1',LINKED_POLICY,'showstake-native-usdc-factory-rhea/3'].includes(this.allowlist.policyVersion) && !isCandidate(this.allowlist)) throw new Error('candidate code hash is not reviewed');
    const multi = isMulti(this.allowlist);
    const candidate = isCandidate(this.allowlist) || multi;
    const kept = block.receipts.filter((r) => r.executorId === this.allowlist.contractId && r.success);
    const units: { classified: ReturnType<typeof classifyEvent>; chainEvent: ChainEventInsert }[] = [];
    for (const receipt of kept) {
      for (const ev of (multi ? parseMultiLogs(receipt.logs) : parseShowStakeLogs(receipt.logs))) {
        const classified: ReturnType<typeof classifyEvent> = multi ? { kind: 'PROVENANCE', log: ev } : classifyEvent(ev);
        units.push({ classified, chainEvent: buildChainEvent(classified, receipt.receiptId, block) });
      }
    }

    let singleSnapshot: { event: NonNullable<ReturnType<typeof parseCandidateEvent>>; registrations: ReturnType<typeof parseCandidateRegistration>[] } | null = null;
    let multiSnapshots: Awaited<ReturnType<typeof readMultiSnapshot>> = [];
    if (multi && (kept.length || refreshCandidate)) {
      const read = async (method:string,args:unknown,accountId=this.allowlist.contractId):Promise<unknown> => { const result=await this.live.viewSource.callView(method,{accountId,args},block.hash); this.assertPinned(result.blockHeight,result.blockHash,block,method); return result.result; };
      multiSnapshots=await readMultiSnapshot(this.allowlist,read);
      for (const unit of units) {
        const p=unit.chainEvent.payload, snap=multiSnapshots.find(x=>x.event.rules.eventId===p.event_id);
        if(!snap) throw new Error('receipt event missing from pinned snapshot');
        if(unit.chainEvent.eventName==='EventCreated' && p.organizer!==snap.event.rules.organizer) throw new Error('receipt organizer mismatch');
        if(typeof p.registration_id==='string') {
          const r=snap.registrations.find(x=>x.registrationId===p.registration_id);
          if(!r || (p.pass_id!==undefined && p.pass_id!==r.passId) || (p.participant!==undefined && p.participant!==r.participant) || (p.beneficiary!==undefined && p.beneficiary!==r.beneficiary) || (p.commitment_id!==undefined && p.commitment_id!==r.commitmentId) || (p.event_sequence!==undefined && p.event_sequence!==r.eventSequence) || (p.amount!==undefined && p.amount!==(unit.chainEvent.eventName==='RegistrationCommitted'?r.amount:r.claimAmount))) throw new Error('receipt registration identity mismatch');
        }
      }
    }
    if (candidate && !multi && (kept.length || refreshCandidate)) {
      const read = async (method: string, args: unknown, accountId = this.allowlist.contractId): Promise<unknown> => {
        const result = await this.live.viewSource.callView(method, { accountId, args }, block.hash);
        this.assertPinned(result.blockHeight, result.blockHash, block, method);
        return result.result;
      };
      const [rawConfig,rawEvent]=await Promise.all([read('get_config',{}),read('get_event',{})]);
      const provider = validateCandidateConfig(rawConfig, this.allowlist);
      const event = parseCandidateEvent(rawEvent, this.allowlist);
      if (event) {
        const registrations: ReturnType<typeof parseCandidateRegistration>[] = [];
        for (let from = 0; from < event.count; from += 50) {
          const raw = await read('list_event_registrations', { event_id: event.rules.eventId, from, limit: 50 });
          if (!Array.isArray(raw) || raw.length !== Math.min(50, event.count - from)) throw new Error('candidate registration page incomplete');
          const page=raw.map((item,index)=>parseCandidateRegistration(item,event,registrations.length+index));
          // The read closure checks the exact block hash for every parallel result.
          await validateCandidatePasses(page,passId=>read('get_pass',{pass_id:passId}),this.allowlist);
          registrations.push(...page);
        }
        if (new Set(registrations.map(r => r.registrationId)).size !== event.count || new Set(registrations.map(r => r.passId)).size !== event.count || new Set(registrations.map(r => r.participant)).size !== event.count || new Set(registrations.map(r => r.commitmentId)).size !== event.count) throw new Error('candidate duplicate registration identity');
        if (event.phase === 'Settled' && registrations.reduce((sum, r) => sum + BigInt(r.claimAmount), 0n) !== BigInt(event.accepted) + BigInt(event.allocatedYield)) throw new Error('candidate settlement conservation failed');
        const [balance,mockPosition]=await Promise.all([read('ft_balance_of',{account_id:this.allowlist.contractId},this.allowlist.ftContractId),!isLinkedCandidate(this.allowlist)&&!isMainnetCandidate(this.allowlist)?read('get_position',{account_id:this.allowlist.contractId},provider):Promise.resolve(null)]);
        if (isLinkedCandidate(this.allowlist)) {
          const needsPosition=['Supplied','RedeemPending'].includes(event.earnState);
          const [position,asset]=needsPosition?await Promise.all([read('get_account',{account_id:this.allowlist.contractId},provider),read('get_asset',{token_id:this.allowlist.ftContractId},provider)]):[null,null];
          validateLinkedCoverage(event,registrations,balance,position,asset,this.allowlist.contractId,this.allowlist.ftContractId);
        } else if (isMainnetCandidate(this.allowlist)) {
          // Rhea position and detached withdrawal receipts are not yet accepted as financial proof.
          // Only assert wallet coverage in states in which the contract says funds are local.
          if (event.earnState === 'NotStarted' || event.earnState === 'Redeemed') validateCandidateCoverage(event, registrations, balance, '0');
        } else {
          const position = mockPosition;
          validateCandidateCoverage(event, registrations, balance, position);
        }
        singleSnapshot = { event, registrations };
      }
    }

    // Enrich before opening the transaction (network reads; fail closed). Every
    // enriched view must be pinned to exactly the block being ingested. Financial
    // transitions are driven by their OWN event data, then reconciled against ONE
    // pinned `get_event_totals` per block: a mid-block pinned view already shows
    // the END-of-block state (a payout started and its callback can land in the
    // same block, so a start event's `get_payout` may already read `Succeeded`),
    // so per-event state/totals assertions are never exact.
    const publishRules = new Map<number, PublishRules>();
    const settlementViews = new Map<number, SettlementViewData>();
    const payoutViews = new Map<number, PayoutViewData>();
    for (let i = 0; i < units.length; i++) {
      const c = units[i]!.classified;
      if (candidate) continue;
      if (c.kind === 'PUBLISH') {
        const viewResult = await this.live.viewSource.callView(
          'get_event',
          { accountId: this.allowlist.contractId, args: { event_id: c.publish.eventId } },
          block.hash,
        );
        this.assertPinned(viewResult.blockHeight, viewResult.blockHash, block, 'get_event');
        publishRules.set(i, enrichPublish(c.publish, parseEventView(viewResult.result), this.allowlist));
      } else if (c.kind === 'SETTLE_END') {
        const raw = await this.live.viewSource.callView(
          'get_settlement',
          { accountId: this.allowlist.contractId, args: { event_id: c.settleEnd.eventId } },
          block.hash,
        );
        this.assertPinned(raw.blockHeight, raw.blockHash, block, 'get_settlement');
        settlementViews.set(i, parseSettlementView(raw.result));
      } else if (c.kind === 'PAYOUT_START' || c.kind === 'PAYOUT_SUCCESS' || c.kind === 'PAYOUT_FAIL') {
        const raw = await this.live.viewSource.callView(
          'get_payout',
          { accountId: this.allowlist.contractId, args: { payout_id: c.payout.payoutId } },
          block.hash,
        );
        this.assertPinned(raw.blockHeight, raw.blockHash, block, 'get_payout');
        payoutViews.set(i, parsePayoutView(raw.result));
      }
    }

    // ONE pinned totals view per block reconciles every financial event's final
    // state (contract totals are the sole financial authority, never DB-created).
    const financialEventIds = new Set<string>();
    for (const unit of units) {
      const kind = unit.classified.kind;
      if (kind === 'SETTLE_END' || kind === 'PAYOUT_START' || kind === 'PAYOUT_SUCCESS' || kind === 'PAYOUT_FAIL') {
        financialEventIds.add(this.classifiedEventId(unit.classified));
      }
    }
    let blockFinancial: BlockFinancialReconcile | null = null;
    if (financialEventIds.size > 0) {
      blockFinancial = new Map();
      for (const eventId of financialEventIds) {
      const totalsRaw = await this.live.viewSource.callView(
        'get_event_totals',
        { accountId: this.allowlist.contractId, args: { event_id: eventId } },
        block.hash,
      );
      this.assertPinned(totalsRaw.blockHeight, totalsRaw.blockHash, block, 'get_event_totals');
        const totals = parseTotalsView(totalsRaw.result);
        if (totals.event_id !== eventId) throw new Error(`event totals view event_id mismatch: requested ${eventId}, got ${totals.event_id}`);
        blockFinancial.set(eventId, totals);
      }
    }

    const client = await this.pool.connect();
    let published = 0;
    let committed = 0;
    let settlement = 0;
    let payouts = 0;
    let provenance = 0;
    try {
      await client.query('BEGIN');
      // Transaction-scoped per-(deployment, consumer) lock: serializes ingestion
      // and first-cursor creation; auto-released on commit/rollback/crash.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [this.lockKey(deploymentId)]);

      // Bind the ingestion id to the DB deployment + allowlist INSIDE the tx.
      const startBlock = await this.bindDeploymentInTx(client, deploymentId);
      const current = await this.readCursorInTx(client, deploymentId);
      const next = this.advanceCursor(block, current, startBlock, canonicalHeader);

      // An older block may only replay already-ingested provenance (never inject
      // a previously-unseen event at an already-passed height).
      if (current !== null && block.height < current.block_height) {
        await this.assertOldReplayKnown(client, deploymentId, units, block);
      }

      for (let i = 0; i < units.length; i++) {
        const { classified, chainEvent } = units[i]!;
        const inserted = await this.insertChainEvent(client, deploymentId, chainEvent);
        if (!inserted) continue; // already ingested (idempotent replay)
        if (candidate) { provenance++; continue; }
        switch (classified.kind) {
          case 'PUBLISH':
            await this.insertEventProjection(client, deploymentId, publishRules.get(i)!, chainEvent.blockTimeMs);
            published++;
            break;
          case 'COMMIT':
            await this.applyCommit(client, deploymentId, classified.commit, chainEvent.blockTimeMs);
            committed++;
            break;
          case 'ATTENDANCE':
            await this.applyAttendance(client, deploymentId, classified.attendance);
            settlement++;
            break;
          case 'FINALIZE':
            await this.applyFinalize(client, deploymentId, classified.finalize);
            settlement++;
            break;
          case 'SETTLE_START':
            await this.applySettleStart(client, deploymentId, classified.settleStart);
            settlement++;
            break;
          case 'SETTLE_CHUNK':
            await this.applySettleChunk(client, deploymentId, classified.settleChunk);
            settlement++;
            break;
          case 'SETTLE_END':
            await this.applySettleEnd(client, deploymentId, classified.settleEnd, settlementViews.get(i)!, blockFinancial?.get(classified.settleEnd.eventId) ?? null);
            settlement++;
            break;
          case 'PAYOUT_START':
            await this.applyPayoutStart(client, deploymentId, classified.payout, payoutViews.get(i)!, chainEvent.receiptId, chainEvent.blockTimeMs);
            payouts++;
            break;
          case 'PAYOUT_SUCCESS':
            await this.applyPayoutSuccess(client, deploymentId, classified.payout, payoutViews.get(i)!);
            payouts++;
            break;
          case 'PAYOUT_FAIL':
            await this.applyPayoutFail(client, deploymentId, classified.payout, payoutViews.get(i)!);
            payouts++;
            break;
          default:
            provenance++;
        }
      }

      for (const snapshot of (current === null || block.height > current.block_height ? (multi ? multiSnapshots : singleSnapshot ? [singleSnapshot] : []) : [])) {
        await this.insertEventProjection(client, deploymentId, snapshot.event.rules, block.timestampMs);
        for (const registration of snapshot.registrations) await this.applyCommit(client, deploymentId, registration, block.timestampMs);
        const row = await client.query<{ accepted_atomic: string; deposit_atomic: string; capacity: number; organizer_account: string; asset_contract: string; policy_version: string }>(`SELECT accepted_atomic::text, deposit_atomic::text, capacity, organizer_account, asset_contract, policy_version FROM events_projection WHERE deployment_id = $1 AND chain_event_id = $2`, [deploymentId, snapshot.event.rules.eventId]);
        const ev = row.rows[0], rules = snapshot.event.rules;
        if (!ev || ev.accepted_atomic !== snapshot.event.accepted || ev.deposit_atomic !== rules.deposit || ev.capacity !== rules.capacity || ev.organizer_account !== rules.organizer || ev.asset_contract !== rules.canonicalFt || ev.policy_version !== rules.policyVersion) throw new Error('candidate projected event mismatch');
        const rows = await client.query<{ chain_registration_id: string; sequence_no: string; participant_account: string; beneficiary_account: string; commitment_id: string; principal_atomic: string; pass_id: string; owner_account: string }>(`SELECT r.chain_registration_id, r.sequence_no::text, r.participant_account, r.beneficiary_account, r.commitment_id, r.principal_atomic::text, p.pass_id, p.owner_account FROM registrations_projection r JOIN events_projection e ON e.id = r.event_id JOIN passes_projection p ON p.registration_id = r.id WHERE e.deployment_id = $1 AND e.chain_event_id = $2 ORDER BY r.sequence_no`, [deploymentId, rules.eventId]);
        if (rows.rows.length !== snapshot.registrations.length || rows.rows.some((r, i) => { const v = snapshot!.registrations[i]!; return r.chain_registration_id !== v.registrationId || r.sequence_no !== String(v.eventSequence) || r.participant_account !== v.participant || r.beneficiary_account !== v.beneficiary || r.commitment_id !== v.commitmentId || r.principal_atomic !== v.amount || r.pass_id !== v.passId || r.owner_account !== v.participant; })) throw new Error('candidate projected registrations mismatch');
        const final = snapshot.event.phase === 'AttendanceFinalized' || snapshot.event.phase === 'Settled';
        const refund = snapshot.event.phase === 'Cancelled' || snapshot.event.phase === 'RefundOnly';
        let paid = 0n, pending = 0n;
        for (const r of snapshot.registrations) {
          const settled = snapshot.event.phase === 'Settled';
          const refundReady = (!multi || snapshot.event.shared) && refund && ['NotStarted','Redeemed'].includes(snapshot.event.earnState) && BigInt(snapshot.event.accepted)>0n;
          let refundAmount=r.amount;
          if(refundReady && snapshot.event.shared) {
            const n=BigInt(snapshot.event.count), y=BigInt(snapshot.event.realizedYield);
            if(n===0n)throw new Error('shared refund without registrations');
            refundAmount=['Pending','Paid','Claimable'].includes(r.claim) ? r.claimAmount : (BigInt(r.amount)+y/n+(BigInt(r.eventSequence)<y%n?1n:0n)).toString();
          }
          const payout = !settled && !refundReady ? 'NOT_CLAIMABLE' : settled && r.claimAmount === '0' ? 'ZERO' : r.claim === 'Paid' ? 'PAID' : r.claim === 'Pending' ? 'PENDING' : 'CLAIMABLE';
          if (r.claim === 'Paid') paid += BigInt(r.claimAmount);
          if (r.claim === 'Pending') pending += BigInt(r.claimAmount);
          await client.query(`UPDATE registrations_projection SET state = $3, attended = $4, claim_atomic = $5::numeric, payout_state = $6, observed_at = to_timestamp($8::double precision / 1000) WHERE event_id = (SELECT id FROM events_projection WHERE deployment_id = $1 AND chain_event_id = $2) AND chain_registration_id = $7`, [deploymentId, rules.eventId, refund ? 'REFUNDABLE' : final ? (r.attendance === 'Attended' ? 'ATTENDED' : 'NO_SHOW') : 'COMMITTED', r.attendance === 'Attended', settled ? r.claimAmount : refundReady ? refundAmount : '0', payout, r.registrationId, block.timestampMs]);
        }
        const liability = BigInt(snapshot.event.accepted) + BigInt(snapshot.event.allocatedYield) - paid - pending;
        if (liability < 0n) throw new Error('candidate negative liability');
        await client.query(`UPDATE events_projection SET state = $3, paid_atomic = $4::numeric, pending_atomic = $5::numeric, liability_atomic = $6::numeric, observed_at = to_timestamp($7::double precision / 1000), realized_yield_atomic = $8::numeric, onchain_title = $9, onchain_location = $10, onchain_rules_text = $11, allocated_yield_atomic=$12::numeric WHERE deployment_id = $1 AND chain_event_id = $2`, [deploymentId, rules.eventId, snapshot.event.phase === 'Settled' ? 'SETTLED' : snapshot.event.phase === 'Cancelled' ? 'CANCELLED' : snapshot.event.phase === 'RefundOnly' ? 'REFUND_ONLY' : final ? 'ATTENDANCE_FINALIZED' : 'PUBLISHED', paid.toString(), pending.toString(), liability.toString(), block.timestampMs, snapshot.event.realizedYield, snapshot.event.title, snapshot.event.location, snapshot.event.rulesText,snapshot.event.allocatedYield]);
      }

      // Reconcile the block's financial state exactly once (contract totals are
      // the authority; per-event transitions above are the derived ledger moves).
      if (blockFinancial) {
        for (const [eventId, totals] of blockFinancial) {
          await this.applyVerifiedTotals(client, deploymentId, eventId, totals);
        }
      }

      if (next !== null) {
        await this.writeCursor(client, deploymentId, next, current);
      }
      await client.query('COMMIT');
      return {
        blockHeight: block.height,
        blockHash: block.hash,
        matchedReceipts: kept.length,
        publishedEvents: published,
        committedRegistrations: committed,
        settlementEvents: settlement,
        payoutEvents: payouts,
        provenanceEvents: provenance,
        cursorHeight: next?.block_height ?? current?.block_height ?? block.height,
      };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Re-read the deployment row INSIDE the transaction and verify it against the
   * allowlist. The worker role only has SELECT on deployments (no row-lock
   * privilege), and the row is operator-seeded/immutable at runtime, so a plain
   * in-transaction SELECT is the authoritative binding.
   */
  private async bindDeploymentInTx(client: Client, deploymentId: string): Promise<number> {
    const res = await client.query<DeploymentRow>(
      `SELECT id, environment, network, contract_id, ft_contract_id, ft_decimals, start_block::text, code_hash
         FROM deployments WHERE id = $1`,
      [deploymentId],
    );
    const row = res.rows[0];
    if (!row) throw new Error(`ingestion deployment ${deploymentId} not found in deployments`);
    return assertDeploymentRow(row, this.allowlist);
  }

  /** Read the cursor inside the (already advisory-locked) transaction (strict). */
  private async readCursorInTx(client: Client, deploymentId: string): Promise<CursorState | null> {
    const res = await client.query<{ cursor_value: unknown }>(
      `SELECT cursor_value FROM worker_cursors WHERE deployment_id = $1 AND consumer = $2`,
      [deploymentId, this.consumer],
    );
    const row = res.rows[0];
    if (!row) return null;
    return parseCursorValue(row.cursor_value);
  }

  /**
   * Monotonic, canonically-linked advancement. Returns the cursor to write
   * (`null` = idempotent replay, cursor unchanged). Throws on fork, an
   * unproven height gap, first-write off the deployment start, or malformed
   * existing cursor.
   *
   * A source 404 / RPC UNKNOWN_BLOCK is NOT skip evidence (it may be a pruned
   * historical block). Forward progress across a height gap is allowed only when
   * the official canonical header of the target block proves chain linkage:
   * prev_hash == cursor hash AND prev_height == cursor height. If any canonical
   * block existed between the cursor and the target, the target's predecessor
   * would be that block, not the cursor block.
   */
  private advanceCursor(
    block: NormalizedBlock,
    current: CursorState | null,
    startBlock: number,
    canonicalHeader: CanonicalBlockHeader,
  ): CursorState | null {
    if (block.height < startBlock) {
      throw new Error(`block ${block.height} precedes deployment start_block ${startBlock}`);
    }
    if (current === null) {
      if (block.height !== startBlock) {
        throw new Error(
          `first cursor must be created exactly at deployment start_block ${startBlock}; got block ${block.height} (missing initial block must fail closed)`,
        );
      }
      return { block_height: block.height, block_hash: block.hash };
    }
    if (current.block_height < startBlock) {
      throw new Error(`cursor ${current.block_height} precedes deployment start_block ${startBlock}`);
    }
    if (block.height < current.block_height) {
      return null; // older canonical replay (validated by assertOldReplayKnown)
    }
    if (block.height === current.block_height) {
      if (block.hash !== current.block_hash) {
        throw new Error(`fork: block ${block.height} hash ${block.hash} != cursor hash ${current.block_hash}`);
      }
      return null; // exact replay
    }
    if (canonicalHeader.prevHash !== current.block_hash || canonicalHeader.prevHeight !== current.block_height) {
      throw new Error(
        `chain linkage: canonical block ${block.height} has prev ${canonicalHeader.prevHeight}/${canonicalHeader.prevHash}, expected cursor ${current.block_height}/${current.block_hash}; a source 404 or RPC UNKNOWN_BLOCK alone is not a skip proof`,
      );
    }
    return { block_height: block.height, block_hash: block.hash };
  }

  /**
   * Conditional cursor write: creation may only insert (the advisory lock makes a
   * conflict a bug), and an update must match the EXACT expected previous
   * height+hash. Either mismatch throws and rolls the block back.
   */
  private async writeCursor(
    client: Client,
    deploymentId: string,
    next: CursorState,
    expected: CursorState | null,
  ): Promise<void> {
    if (expected === null) {
      const res = await client.query(
        `INSERT INTO worker_cursors (deployment_id, consumer, cursor_value, updated_at)
         VALUES ($1, $2, $3::jsonb, now())
         ON CONFLICT (deployment_id, consumer) DO NOTHING
         RETURNING deployment_id`,
        [deploymentId, this.consumer, JSON.stringify(next)],
      );
      if ((res.rowCount ?? 0) !== 1) {
        throw new Error('cursor creation raced: a cursor row exists despite the advisory lock');
      }
      return;
    }
    const res = await client.query(
      `UPDATE worker_cursors
          SET cursor_value = $3::jsonb, updated_at = now()
        WHERE deployment_id = $1 AND consumer = $2 AND cursor_value = $4::jsonb
        RETURNING deployment_id`,
      [deploymentId, this.consumer, JSON.stringify(next), JSON.stringify(expected)],
    );
    if ((res.rowCount ?? 0) !== 1) {
      throw new Error(
        `cursor update failed expected-previous-state check (expected ${expected.block_height}/${expected.block_hash})`,
      );
    }
  }

  /** An old replay must consist only of chain events already ingested verbatim. */
  private async assertOldReplayKnown(
    client: Client,
    deploymentId: string,
    units: { chainEvent: ChainEventInsert }[],
    block: NormalizedBlock,
  ): Promise<void> {
    for (const { chainEvent } of units) {
      const res = await client.query<{ block_hash: string; event_name: string }>(
        `SELECT block_hash, event_name FROM chain_events
          WHERE deployment_id = $1 AND receipt_id = $2 AND log_index = $3`,
        [deploymentId, chainEvent.receiptId, chainEvent.logIndex],
      );
      const row = res.rows[0];
      if (!row) {
        throw new Error(
          `old replay at ${block.height} introduces an unknown chain event (${chainEvent.receiptId}/${chainEvent.logIndex}); refusing to regress/inject`,
        );
      }
      if (row.block_hash !== chainEvent.blockHash || row.event_name !== chainEvent.eventName) {
        throw new Error(
          `old replay provenance mismatch at ${block.height} for ${chainEvent.receiptId}/${chainEvent.logIndex}`,
        );
      }
    }
  }

  /**
   * Insert a chain event, or verify an existing row is byte-for-byte equivalent
   * provenance on replay. `ON CONFLICT DO NOTHING` is never a silent drop: a
   * same-key row with a different block height/hash/time, event name, schema
   * version or payload throws (a source may not alter a log under an already
   * ingested receipt_id/log_index).
   */
  private async insertChainEvent(client: Client, deploymentId: string, ce: ChainEventInsert): Promise<boolean> {
    const res = await client.query(
      `INSERT INTO chain_events (id, deployment_id, receipt_id, log_index, block_height, block_hash, block_time, event_name, schema_version, payload, ingested_at)
       VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7::double precision / 1000.0), $8, $9, $10::jsonb, now())
       ON CONFLICT (deployment_id, receipt_id, log_index) DO NOTHING
       RETURNING id`,
      [randomUUID(), deploymentId, ce.receiptId, ce.logIndex, ce.blockHeight, ce.blockHash, ce.blockTimeMs, ce.eventName, ce.schemaVersion, JSON.stringify(ce.payload)],
    );
    if ((res.rowCount ?? 0) === 1) return true;

    const existing = await client.query<{
      block_height: string;
      block_hash: string;
      event_name: string;
      schema_version: string;
      same_time: boolean;
      same_payload: boolean;
    }>(
      `SELECT block_height::text AS block_height, block_hash, event_name, schema_version,
              (block_time = to_timestamp($4::double precision / 1000.0)) AS same_time,
              (payload = $5::jsonb) AS same_payload
         FROM chain_events
        WHERE deployment_id = $1 AND receipt_id = $2 AND log_index = $3`,
      [deploymentId, ce.receiptId, ce.logIndex, ce.blockTimeMs, JSON.stringify(ce.payload)],
    );
    const row = existing.rows[0];
    if (!row) throw new Error(`chain_event conflict for ${ce.receiptId}/${ce.logIndex} without an existing row`);
    if (
      Number(row.block_height) !== ce.blockHeight ||
      row.block_hash !== ce.blockHash ||
      row.event_name !== ce.eventName ||
      row.schema_version !== ce.schemaVersion ||
      row.same_time !== true ||
      row.same_payload !== true
    ) {
      throw new Error(
        `replay provenance mismatch for ${ce.receiptId}/${ce.logIndex}: existing ${row.block_height}/${row.block_hash}/${row.event_name}/${row.schema_version} (time=${row.same_time}, payload=${row.same_payload}) != incoming ${ce.blockHeight}/${ce.blockHash}/${ce.eventName}/${ce.schemaVersion}`,
      );
    }
    return false;
  }

  private async insertEventProjection(client: Client, deploymentId: string, rules: PublishRules, blockTimeMs: number): Promise<void> {
    await client.query(
      `INSERT INTO events_projection
         (id, deployment_id, chain_event_id, organizer_account, asset_contract, deposit_atomic, capacity,
          reg_open, reg_close, cancel_cutoff, checkin_open, checkin_close, finalize_deadline,
          state, policy_version, rules_hash, accepted_atomic, paid_atomic, pending_atomic, liability_atomic, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
          to_timestamp($8::double precision / 1000.0), to_timestamp($9::double precision / 1000.0),
          to_timestamp($10::double precision / 1000.0), to_timestamp($11::double precision / 1000.0),
          to_timestamp($12::double precision / 1000.0), to_timestamp($13::double precision / 1000.0),
          'PUBLISHED', $14, $15, '0', '0', '0', '0', to_timestamp($16::double precision / 1000.0))
       ON CONFLICT (deployment_id, chain_event_id) DO NOTHING`,
      [
        randomUUID(), deploymentId, rules.eventId, rules.organizer, rules.canonicalFt, rules.deposit, rules.capacity,
        rules.regOpenMs, rules.regCloseMs, rules.cancelCutoffMs, rules.checkinOpenMs, rules.checkinCloseMs,
        rules.finalizeDeadlineMs, rules.policyVersion, rules.rulesHash, blockTimeMs,
      ],
    );
  }

  private async applyCommit(client: Client, deploymentId: string, c: { eventId: string; registrationId: string; passId: string; participant: string; beneficiary: string; commitmentId: string; amount: string; eventSequence: number }, blockTimeMs: number): Promise<void> {
    if (c.participant !== c.beneficiary) throw new Error('participant != beneficiary (schema requires equality)');
    const event = await client.query<{ id: string; deposit_atomic: string }>(
      `SELECT id, deposit_atomic::text FROM events_projection WHERE deployment_id = $1 AND chain_event_id = $2 FOR UPDATE`,
      [deploymentId, c.eventId],
    );
    const ev = event.rows[0];
    if (!ev) throw new Error(`event ${c.eventId} not projected yet (out-of-order commit denied)`);
    if (BigInt(c.amount) !== BigInt(ev.deposit_atomic)) {
      throw new Error(`commit amount ${c.amount} != event deposit ${ev.deposit_atomic}`);
    }
    const regId = randomUUID();
    const inserted = await client.query(
      `INSERT INTO registrations_projection
         (id, event_id, chain_registration_id, sequence_no, participant_account, beneficiary_account, commitment_id,
          principal_atomic, state, attended, claim_atomic, payout_state, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'COMMITTED', false, '0', 'NOT_CLAIMABLE', to_timestamp($9::double precision / 1000.0))
       ON CONFLICT (event_id, chain_registration_id) DO NOTHING
       RETURNING id`,
      [regId, ev.id, c.registrationId, c.eventSequence, c.participant, c.beneficiary, c.commitmentId, c.amount, blockTimeMs],
    );
    if ((inserted.rowCount ?? 0) !== 1) return; // duplicate registration: already applied
    await client.query(
      `INSERT INTO passes_projection (id, registration_id, deployment_id, pass_id, owner_account, issued_at, observed_at, metadata, event_id)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6::double precision / 1000.0), to_timestamp($6::double precision / 1000.0), '{}'::jsonb, $7)`,
      [randomUUID(), regId, deploymentId, c.passId, c.participant, blockTimeMs, ev.id],
    );
    await client.query(
      `UPDATE events_projection
          SET accepted_atomic = accepted_atomic + ($1::numeric), liability_atomic = liability_atomic + ($1::numeric)
        WHERE id = $2`,
      [c.amount, ev.id],
    );
  }

  /** A pinned view must have executed exactly at the ingested block. */
  private assertPinned(viewBlockHeight: number, viewBlockHash: string, block: NormalizedBlock, method: string): void {
    if (viewBlockHeight !== block.height) {
      throw new Error(`${method} pinned to block ${viewBlockHeight}, ingesting ${block.height}`);
    }
    if (viewBlockHash !== block.hash) {
      throw new Error(`${method} pinned to hash ${viewBlockHash}, expected ${block.hash}`);
    }
  }

  /** Read the projected event row (FOR UPDATE) for a lifecycle event; fail closed. */
  private async lockEvent(client: Client, deploymentId: string, eventId: string, expected: readonly string[]): Promise<{ id: string; state: string }> {
    const res = await client.query<{ id: string; state: string }>(
      `SELECT id, state FROM events_projection WHERE deployment_id = $1 AND chain_event_id = $2 FOR UPDATE`,
      [deploymentId, eventId],
    );
    const row = res.rows[0];
    if (!row) throw new Error(`lifecycle event for ${eventId} before its publish projection (out-of-order denied)`);
    if (!expected.includes(row.state)) {
      throw new Error(`lifecycle event for ${eventId} from state ${row.state} (expected ${expected.join('|')})`);
    }
    return row;
  }

  /** Verified payout event identity against the pinned `get_payout` view (identity +
   * amount only — NOT the payout state, which by end-of-block may already be the
   * terminal Succeeded/Failed when a start + callback land in the same block). */
  private assertPayoutIdentity(p: PayoutData, view: PayoutViewData): void {
    if (view.payout_id !== p.payoutId) throw new Error(`payout_id mismatch: event ${p.payoutId} vs view ${view.payout_id}`);
    if (view.registration_id !== p.registrationId) throw new Error(`payout registration mismatch: ${p.registrationId} vs ${view.registration_id}`);
    if (view.event_id !== p.eventId) throw new Error(`payout event mismatch: ${p.eventId} vs ${view.event_id}`);
    if (view.beneficiary !== p.beneficiary) throw new Error(`payout beneficiary mismatch: ${p.beneficiary} vs ${view.beneficiary}`);
    if (view.amount !== p.amount) throw new Error(`payout amount mismatch: event ${p.amount} vs view ${view.amount}`);
  }

  /** Resolve the projected event + registration for a payout (fail closed). */
  private async lookupRegistration(client: Client, deploymentId: string, eventId: string, registrationId: string): Promise<{ eventId: string; regId: string }> {
    const ev = await client.query<{ id: string }>(
      `SELECT id FROM events_projection WHERE deployment_id = $1 AND chain_event_id = $2`,
      [deploymentId, eventId],
    );
    if (!ev.rows[0]) throw new Error(`payout for unknown event ${eventId}`);
    const reg = await client.query<{ id: string }>(
      `SELECT id FROM registrations_projection WHERE event_id = $1 AND chain_registration_id = $2`,
      [ev.rows[0].id, registrationId],
    );
    if (!reg.rows[0]) throw new Error(`payout for unknown registration ${registrationId}`);
    return { eventId: ev.rows[0].id, regId: reg.rows[0].id };
  }

  /** Reconcile the event's financial totals exactly once per block from the pinned
   * `get_event_totals` view (contract authority: accepted/paid/pending/liability). */
  private async applyVerifiedTotals(client: Client, deploymentId: string, eventId: string, totals: EventTotalsViewData): Promise<void> {
    if (totals.event_id !== eventId) throw new Error(`event totals view event_id mismatch: requested ${eventId}, got ${totals.event_id}`);
    await client.query(
      `UPDATE events_projection
          SET accepted_atomic = $3::numeric, paid_atomic = $4::numeric, pending_atomic = $5::numeric, liability_atomic = $6::numeric
        WHERE deployment_id = $1 AND chain_event_id = $2`,
      [deploymentId, eventId, totals.accepted_principal, totals.paid, totals.pending, totals.liability],
    );
  }

  private classifiedEventId(c: ReturnType<typeof classifyEvent>): string {
    switch (c.kind) {
      case 'SETTLE_END': return c.settleEnd.eventId;
      case 'PAYOUT_START':
      case 'PAYOUT_SUCCESS':
      case 'PAYOUT_FAIL': return c.payout.eventId;
      default: throw new Error(`financial reconcile on non-financial event kind ${c.kind}`);
    }
  }

  /** Provisional attendance mark (never final): updates the `attended` flag only. */
  private async applyAttendance(client: Client, deploymentId: string, a: AttendanceData): Promise<void> {
    const ev = await this.lockEvent(client, deploymentId, a.eventId, ['PUBLISHED']);
    const upd = await client.query(
      `UPDATE registrations_projection SET attended = $3 WHERE event_id = $1 AND chain_registration_id = $2 RETURNING id`,
      [ev.id, a.registrationId, a.attended],
    );
    if ((upd.rowCount ?? 0) !== 1) {
      throw new Error(`attendance for unknown registration ${a.registrationId} in event ${a.eventId}`);
    }
  }

  /** Freeze attendance: derive final ATTENDED/NO_SHOW from the provisional flag. */
  private async applyFinalize(client: Client, deploymentId: string, f: FinalizeData): Promise<void> {
    const ev = await this.lockEvent(client, deploymentId, f.eventId, ['PUBLISHED']);
    if (f.attendeeCount + f.noShowCount !== f.totalRegistrations) {
      throw new Error(`finalize counts inconsistent: ${f.attendeeCount}+${f.noShowCount} != ${f.totalRegistrations}`);
    }
    const regs = await client.query<{ attended: boolean }>(
      `SELECT attended FROM registrations_projection WHERE event_id = $1 ORDER BY sequence_no ASC`,
      [ev.id],
    );
    if (regs.rows.length !== f.totalRegistrations) {
      throw new Error(`finalize over ${regs.rows.length} registrations, expected ${f.totalRegistrations}`);
    }
    const attendedCount = regs.rows.filter((r) => r.attended).length;
    if (attendedCount !== f.attendeeCount || regs.rows.length - attendedCount !== f.noShowCount) {
      throw new Error(`finalize attendance mismatch: projection ${attendedCount} attended vs event ${f.attendeeCount}`);
    }
    await client.query(
      `UPDATE registrations_projection SET state = CASE WHEN attended THEN 'ATTENDED' ELSE 'NO_SHOW' END WHERE event_id = $1`,
      [ev.id],
    );
    await client.query(`UPDATE events_projection SET state = 'ATTENDANCE_FINALIZED' WHERE id = $1`, [ev.id]);
  }

  /** Settlement begins: freeze allocation pending chunked completion. */
  private async applySettleStart(client: Client, deploymentId: string, s: SettleStartData): Promise<void> {
    const ev = await this.lockEvent(client, deploymentId, s.eventId, ['ATTENDANCE_FINALIZED']);
    await client.query(`UPDATE events_projection SET state = 'SETTLING' WHERE id = $1`, [ev.id]);
  }

  /** A partial settlement chunk never exposes claimability. */
  private async applySettleChunk(client: Client, deploymentId: string, s: SettleChunkData): Promise<void> {
    const ev = await this.lockEvent(client, deploymentId, s.eventId, ['ATTENDANCE_FINALIZED', 'SETTLING', 'SETTLED']);
    if (ev.state === 'ATTENDANCE_FINALIZED') {
      await client.query(`UPDATE events_projection SET state = 'SETTLING' WHERE id = $1`, [ev.id]);
    }
    // Partial allocation (complete=false) and idempotent re-settles (already_settled)
    // never change claimability: only EventSettled finalizes entitlement.
  }

  /**
   * Settlement completion: freeze the deterministic allocation (verified against
   * the pinned `get_settlement` view and the block's pinned `get_event_totals`)
   * and mark the event Settled. Claim entitlements come from the contract's own
   * allocation rule; financial totals are reconciled ONCE per block afterwards
   * from the pinned totals view — never DB-invented rights.
   */
  private async applySettleEnd(client: Client, deploymentId: string, e: SettleEndData, settlement: SettlementViewData, blockTotals: EventTotalsViewData | null): Promise<void> {
    const existing = await client.query<{ id: string; state: string; deposit_atomic: string; accepted_atomic: string }>(
      `SELECT id, state, deposit_atomic::text, accepted_atomic::text FROM events_projection WHERE deployment_id = $1 AND chain_event_id = $2 FOR UPDATE`,
      [deploymentId, e.eventId],
    );
    const row = existing.rows[0];
    if (!row) throw new Error(`settle for event ${e.eventId} before its publish projection`);
    if (row.state !== 'SETTLING') throw new Error(`event settled from state ${row.state} (expected SETTLING)`);
    if (settlement.event_id !== e.eventId) throw new Error('settlement view event_id mismatch');
    if (!settlement.complete) throw new Error('settlement view not complete');
    if (!settlement.attendance_frozen) throw new Error('settlement view attendance is not frozen');
    if (settlement.attendee_count !== e.attendeeCount || settlement.no_show_count !== e.noShowCount || settlement.registrations !== e.totalRegistrations) {
      throw new Error(`settlement counts mismatch: view ${settlement.attendee_count}/${settlement.no_show_count}/${settlement.registrations} vs event ${e.attendeeCount}/${e.noShowCount}/${e.totalRegistrations}`);
    }
    if (!settlement.claims_enabled) throw new Error('settlement view claims are not enabled');
    if (settlement.allocated_total !== e.allocatedTotal) {
      throw new Error(`allocated_total mismatch: view ${settlement.allocated_total} vs event ${e.allocatedTotal}`);
    }
    if (mapEventState(settlement.state) !== 'SETTLED') throw new Error('settlement view state is not Settled');
    // Contract totals are authoritative; the DB accepted principal must match.
    if (blockTotals !== null && blockTotals.accepted_principal !== row.accepted_atomic) {
      throw new Error(`accepted principal mismatch: contract ${blockTotals.accepted_principal} vs DB ${row.accepted_atomic}`);
    }
    const regs = await client.query<{ id: string; attended: boolean }>(
      `SELECT id, attended FROM registrations_projection WHERE event_id = $1 ORDER BY sequence_no ASC`,
      [row.id],
    );
    if (regs.rows.length !== e.totalRegistrations) {
      throw new Error(`settle over ${regs.rows.length} registrations, expected ${e.totalRegistrations}`);
    }
    const deposit = BigInt(row.deposit_atomic);
    const baseShare = BigInt(settlement.base_share);
    const remainder = BigInt(settlement.remainder);
    const attendees = BigInt(e.attendeeCount);
    let attendeeIndex = 0n;
    let allocatedSum = 0n;
    for (const r of regs.rows) {
      let claim: bigint;
      let payoutState: string;
      if (r.attended) {
        const bonus = attendeeIndex < remainder ? 1n : 0n;
        claim = deposit + baseShare + bonus;
        attendeeIndex += 1n;
        payoutState = 'CLAIMABLE';
      } else if (attendees === 0n) {
        claim = deposit; // zero-attendee: every registration refunds its own D
        payoutState = 'CLAIMABLE';
      } else {
        claim = 0n; // no-show forfeits its allocation (Forfeited -> ZERO)
        payoutState = 'ZERO';
      }
      allocatedSum += claim;
      await client.query(
        `UPDATE registrations_projection SET claim_atomic = $2::numeric, payout_state = $3 WHERE id = $1`,
        [r.id, claim.toString(), payoutState],
      );
    }
    if (allocatedSum.toString() !== e.allocatedTotal || allocatedSum.toString() !== settlement.allocated_total) {
      throw new Error(`settlement conservation failed: allocated ${allocatedSum} vs event ${e.allocatedTotal} vs view ${settlement.allocated_total}`);
    }
    await client.query(`UPDATE events_projection SET state = 'SETTLED' WHERE id = $1`, [row.id]);
  }

  private async applyPayoutStart(client: Client, deploymentId: string, p: PayoutData, payoutView: PayoutViewData, receiptId: string, blockTimeMs: number): Promise<void> {
    this.assertPayoutIdentity(p, payoutView);
    const { regId } = await this.lookupRegistration(client, deploymentId, p.eventId, p.registrationId);
    await client.query(
      `INSERT INTO payouts_projection (id, registration_id, payout_id, recipient_account, amount_atomic, state, receipt_id, observed_at)
       VALUES ($1, $2, $3, $4, $5::numeric, 'PENDING', $6, to_timestamp($7::double precision / 1000.0))
       ON CONFLICT (registration_id, payout_id) DO NOTHING`,
      [randomUUID(), regId, p.payoutId, p.beneficiary, p.amount, receiptId, blockTimeMs],
    );
    await client.query(`UPDATE registrations_projection SET payout_state = 'PENDING' WHERE id = $1`, [regId]);
  }

  private async applyPayoutSuccess(client: Client, deploymentId: string, p: PayoutData, payoutView: PayoutViewData): Promise<void> {
    this.assertPayoutIdentity(p, payoutView);
    const { regId } = await this.lookupRegistration(client, deploymentId, p.eventId, p.registrationId);
    const updated = await client.query(
      `UPDATE payouts_projection SET state = 'SUCCEEDED' WHERE registration_id = $1 AND payout_id = $2 AND state = 'PENDING' RETURNING id`,
      [regId, p.payoutId],
    );
    if ((updated.rowCount ?? 0) !== 1) throw new Error(`payout success without a pending payout ${p.payoutId}`);
    await client.query(`UPDATE registrations_projection SET payout_state = 'PAID' WHERE id = $1`, [regId]);
  }

  private async applyPayoutFail(client: Client, deploymentId: string, p: PayoutData, payoutView: PayoutViewData): Promise<void> {
    this.assertPayoutIdentity(p, payoutView);
    const { regId } = await this.lookupRegistration(client, deploymentId, p.eventId, p.registrationId);
    const updated = await client.query(
      `UPDATE payouts_projection SET state = 'FAILED' WHERE registration_id = $1 AND payout_id = $2 AND state = 'PENDING' RETURNING id`,
      [regId, p.payoutId],
    );
    if ((updated.rowCount ?? 0) !== 1) throw new Error(`payout failure without a pending payout ${p.payoutId}`);
    // A failed private callback restores claimability without changing registration
    // state; the liability is re-claimable, never double-counted.
    await client.query(`UPDATE registrations_projection SET payout_state = 'CLAIMABLE' WHERE id = $1`, [regId]);
  }
}
