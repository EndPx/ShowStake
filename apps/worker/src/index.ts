// Orchestration: resolve/verify the deployment, then ingest finalized blocks
// sequentially (bounded), advancing the durable cursor exactly once per block.
//
// The scan is bounded by the OFFICIAL RPC final height (never the block source's
// claim), every fetched block is canonically verified inside `store.ingestBlock`,
// and a 404 height is only a SKIP CANDIDATE: the cursor advances across it only
// when the next ingested block's official canonical prev_hash/prev_height links
// directly to the cursor (proving no canonical block exists at the missing
// heights). A pruned-but-existing height breaks that linkage and fails closed. A
// malformed/missing source payload throws and the cursor stays behind it.
import type { BlockSource, CanonicalVerifier, ViewSource } from './types.js';
import { BlockNotFoundError, FastNearBlockSource, NearRpcClient, NearRpcViewSource, RpcCanonicalVerifier } from './source.js';
import { WorkerStore, type LiveChain } from './store.js';

export interface ScanLog {
  (msg: string): void;
}

export interface ScanResult {
  startHeight: number;
  /** last height ingested (or startHeight-1 when nothing was ingested). */
  endHeight: number;
  blocksIngested: number;
  /** heights proven skipped by canonical prev-hash linkage at a later ingest. */
  heightsSkipped: number[];
  /** trailing heights the source 404'd that no later block proved skipped. */
  heightsUnprovenMissing: number[];
  /** official RPC final height used as the upper bound. */
  officialFinalHeight: number;
  reason: string;
}

export function makeLiveChain(rpcUrl: string): LiveChain {
  const rpc = new NearRpcClient(rpcUrl);
  const viewSource: ViewSource = new NearRpcViewSource(rpc);
  return { viewSource, accountCodeHash: (accountId, finality) => rpc.accountCodeHash(accountId, finality) };
}

/** Official-RPC canonical/finality verifier for the production ingest/scan path. */
export function makeCanonicalVerifier(rpcUrl: string): CanonicalVerifier {
  return new RpcCanonicalVerifier(new NearRpcClient(rpcUrl));
}

export function makeBlockSource(neardataUrl: string): BlockSource {
  return new FastNearBlockSource(neardataUrl);
}

/** Read the worker's DB connection config from socket env or DATABASE_URL. */
export function workerConnectConfig(databaseUrl: string | null): Record<string, unknown> {
  const socket = process.env.SHOWSTAKE_PG_SOCKET ?? null;
  if (socket) {
    return {
      user: process.env.SHOWSTAKE_PG_USER || 'showstake',
      host: socket,
      port: Number(process.env.SHOWSTAKE_PG_PORT || 55439),
      database: process.env.SHOWSTAKE_PG_DB1 || 'postgres',
      application_name: 'showstake-worker',
    };
  }
  if (!databaseUrl) throw new Error('DATABASE_URL (or SHOWSTAKE_PG_SOCKET) is required');
  return { connectionString: databaseUrl, application_name: 'showstake-worker' };
}

/**
 * Ingest from `nextHeight` up to the official final height (or an optional
 * inclusive `untilHeight`), advancing at most `maxBlocks` heights (skips count
 * toward the bound so a run is always finite). Any block that fails throws (fail
 * closed) and the cursor stays behind it.
 */
export async function runBoundedScan(opts: {
  store: WorkerStore;
  blockSource: BlockSource;
  verifier: CanonicalVerifier;
  deploymentId: string;
  nextHeight: number;
  maxBlocks: number;
  untilHeight?: number;
  log?: ScanLog;
}): Promise<ScanResult> {
  const { store, blockSource, verifier, deploymentId, nextHeight, maxBlocks, untilHeight, log } = opts;
  if (!Number.isSafeInteger(nextHeight) || nextHeight < 0) throw new Error(`invalid nextHeight ${nextHeight}`);
  if (!Number.isSafeInteger(maxBlocks) || maxBlocks <= 0) throw new Error(`invalid maxBlocks ${maxBlocks}`);
  if (untilHeight !== undefined && (!Number.isSafeInteger(untilHeight) || untilHeight < 0)) {
    throw new Error(`invalid untilHeight ${untilHeight}`);
  }

  const officialFinalHeight = await verifier.lastFinalHeight();
  const endLimit = untilHeight === undefined ? officialFinalHeight : Math.min(untilHeight, officialFinalHeight);
  let height = nextHeight;
  let count = 0;
  let lastIngested = nextHeight - 1;
  const heightsSkipped: number[] = [];
  const pendingMissing: number[] = [];

  while (count < maxBlocks && height <= endLimit) {
    let block;
    try {
      block = await blockSource.fetchBlock(height);
    } catch (e) {
      if (e instanceof BlockNotFoundError) {
        // A 404 is only a skip CANDIDATE (it may be a pruned existing block).
        // It becomes a proven skip only when a later ingested block's official
        // canonical prev_hash/prev_height links directly to the cursor.
        pendingMissing.push(height);
        log?.(`source has no block at ${height} (skip candidate; canonical linkage checked at the next ingest)`);
        height++;
        count++;
        continue;
      }
      throw e;
    }
    if (block.height !== height) throw new Error(`source returned block ${block.height}, expected ${height}`);
    const summary = await store.ingestBlock(deploymentId, block);
    // ingestBlock's linkage proof covers every still-pending missing height below
    // this block (it required prev_hash/prev_height == cursor at the gap).
    for (let i = pendingMissing.length - 1; i >= 0; i--) {
      if (pendingMissing[i]! < block.height) heightsSkipped.push(pendingMissing.splice(i, 1)[0]!);
    }
    log?.(`ingested ${block.height} (hash ${block.hash}): ${summary.publishedEvents} publish, ${summary.committedRegistrations} commit, ${summary.provenanceEvents} provenance`);
    lastIngested = block.height;
    height++;
    count++;
  }
  return {
    startHeight: nextHeight,
    endHeight: lastIngested,
    blocksIngested: count - pendingMissing.length - heightsSkipped.length,
    heightsSkipped,
    heightsUnprovenMissing: pendingMissing,
    officialFinalHeight,
    reason: count >= maxBlocks ? 'max_blocks_reached' : 'reached_end_height',
  };
}
