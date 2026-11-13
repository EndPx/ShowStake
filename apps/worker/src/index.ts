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
import { BlockNotFoundError, CanonicalBlockMissingError, FastNearBlockSource, NearRpcClient, NearRpcViewSource, RpcCanonicalVerifier } from './source.js';
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

/** Sequential watch loop; each cycle resolves its durable cursor again. */
export async function runWorkerCycles(cycle:()=>Promise<boolean>,watch:boolean,stopped:()=>boolean,wait:()=>Promise<void>,log:(message:string)=>void):Promise<void>{
  do {let progressed=false;try{progressed=await cycle();}catch(e){if(!watch)throw e;log(e instanceof Error?e.message:String(e));}if(watch&&!progressed&&!stopped())await wait();}while(watch&&!stopped());
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
  prefetchNext?: boolean;
  sourceAvailabilityBound?: boolean;
  log?: ScanLog;
}): Promise<ScanResult> {
  const { store, blockSource, verifier, deploymentId, nextHeight, maxBlocks, untilHeight, log } = opts;
  if (!Number.isSafeInteger(nextHeight) || nextHeight < 0) throw new Error(`invalid nextHeight ${nextHeight}`);
  if (!Number.isSafeInteger(maxBlocks) || maxBlocks <= 0) throw new Error(`invalid maxBlocks ${maxBlocks}`);
  if (untilHeight !== undefined && (!Number.isSafeInteger(untilHeight) || untilHeight < 0)) {
    throw new Error(`invalid untilHeight ${untilHeight}`);
  }

  const officialFinalHeight = await verifier.lastFinalHeight();
  let endLimit = untilHeight === undefined ? officialFinalHeight : Math.min(untilHeight, officialFinalHeight);
  if(opts.sourceAvailabilityBound && blockSource.lastFinalHeight){const available=await blockSource.lastFinalHeight();if(!Number.isSafeInteger(available)||available<0)throw new Error('invalid source availability height');endLimit=Math.min(endLimit,available);}
  let height = nextHeight;
  let count = 0;
  let lastIngested = nextHeight - 1;
  const heightsSkipped: number[] = [];
  const pendingMissing: number[] = [];
  type FetchResult = {ok:true;block:Awaited<ReturnType<BlockSource['fetchBlock']>>}|{ok:false;error:unknown};
  const fetchSafe=(h:number):Promise<FetchResult>=>Promise.resolve().then(()=>blockSource.fetchBlock(h)).then(block=>({ok:true,block} as const),error=>({ok:false,error} as const));
  let prefetched:{height:number;result:Promise<FetchResult>}|null=null;
  const readFetch=(h:number,ready:{height:number;result:Promise<FetchResult>}|null):Promise<FetchResult>=>ready?.height===h?ready.result:fetchSafe(h);

  while (count < maxBlocks && height <= endLimit) {
    let block;
    try {
      const result:FetchResult = await readFetch(height,prefetched);
      prefetched=null;
      if (!result.ok) throw result.error;
      block=result.block;
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
    if(opts.prefetchNext && count+1<maxBlocks && height+1<=endLimit) prefetched={height:height+1,result:fetchSafe(height+1)};
    let summary;
    try {
      summary = await store.ingestBlock(deploymentId, block, height === endLimit || count + 1 >= maxBlocks);
    } catch (e) {
      if (e instanceof CanonicalBlockMissingError) {
        // The OFFICIAL RPC has no canonical block at this height (a chain gap);
        // the source may have served a spurious/stale block, which the canonical
        // check refuses to trust. Skip candidate: proven only by the NEXT block's
        // official canonical prev_hash/prev_height linkage, never by itself.
        pendingMissing.push(height);
        log?.(`official RPC has no canonical block at ${height} (skip candidate; canonical linkage checked at the next ingest)`);
        height++;
        count++;
        continue;
      }
      throw e;
    }
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
