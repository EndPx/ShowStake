// Block + view providers. Default impls use public FASTNEAR NEAR Data for
// finalized blocks and a NEAR JSON-RPC endpoint (official `rpc.testnet.near.org`
// by default; `test.rpc.fastnear.com` is the D041 testnet transport) for pinned
// contract views, canonical block proof, skipped-height proof and final height.
// Both are injectable so fixture tests are deterministic and network-free.
//
// The normalizer is strict (fail-closed): a malformed or incomplete source
// payload throws BEFORE any cursor can advance, so silently-dropped receipts/logs
// can never park the cursor on top of unprocessed data. Legitimate empty shard
// outcome lists and empty `logs` arrays are accepted only as EXPLICIT empty
// arrays; an absent member, an empty `shards` array or an absent `logs` member is
// malformed, never "no data".
import type { BlockSource, CanonicalBlockHeader, CanonicalVerifier, NormalizedBlock, NormalizedReceipt, ViewSource } from './types.js';

/** The source answered 404 for a height: a candidate canonically-skipped block. */
export class BlockNotFoundError extends Error {
  constructor(readonly url: string) {
    super(`block not found (404): ${url}`);
    this.name = 'BlockNotFoundError';
  }
}

/** A non-2xx HTTP response from a source/RPC endpoint. */
export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string, readonly retryAfterSec: number | null = null) {
    super(`HTTP ${status} from ${url}`);
    this.name = 'HttpError';
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 30_000, attempts = 6): Promise<unknown> {
  let last: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      });
      if (res.status === 404) throw new BlockNotFoundError(url);
      if (!res.ok) {
        const hinted = Number(res.headers.get('retry-after'));
        throw new HttpError(res.status, url, Number.isFinite(hinted) ? hinted : null);
      }
      return (await res.json()) as unknown;
    } catch (e) {
      if (e instanceof BlockNotFoundError) throw e;
      last = e;
      const retryable = e instanceof HttpError ? RETRYABLE_STATUS.has(e.status) : true;
      if (!retryable || attempt === attempts - 1) throw e;
      const hintedMs = e instanceof HttpError && e.retryAfterSec !== null ? e.retryAfterSec * 1_000 : 0;
      // Documented provider limit is 180 requests/minute/IP; a 429 backs off
      // progressively (1s, 2s, ...) or by the Retry-After hint, whichever is longer.
      const base = e instanceof HttpError && e.status === 429 ? 1_000 : 500;
      await sleep(Math.max(hintedMs, base * 2 ** attempt));
    }
  }
  throw last instanceof Error ? last : new Error(`fetch failed: ${url}`);
}

/** A JSON-RPC error object returned by a NEAR RPC endpoint. */
export class RpcError extends Error {
  constructor(readonly method: string, readonly detail: unknown) {
    super(`RPC ${method} error: ${JSON.stringify(detail)}`);
    this.name = 'RpcError';
  }
}

/**
 * The OFFICIAL RPC reported no canonical block at a height (HTTP 422/404 or an
 * `UNKNOWN_BLOCK` error): that height is a legitimate chain-gap candidate. It is
 * NEVER treated as proof by itself — the NEXT ingested block's official canonical
 * `prev_hash`/`prev_height` linkage must still prove the gap or the ingest fails
 * closed. The block source may have served a spurious/stale block for the height,
 * which the canonical check now refuses to trust.
 */
export class CanonicalBlockMissingError extends Error {
  constructor(readonly height: number, readonly url: string) {
    super(`official RPC has no canonical block at height ${height} (${url})`);
    this.name = 'CanonicalBlockMissingError';
  }
}

function rec(object: unknown): Record<string, unknown> {
  if (typeof object !== 'object' || object === null || Array.isArray(object)) {
    throw new Error('expected JSON object');
  }
  return object as Record<string, unknown>;
}

// Plausible bounds for a finalized NEAR block timestamp (UTC milliseconds).
// NEAR mainnet launched in 2020; 2017 is a safe low bound and 2100 a safe high
// bound. `timestampMs` must also be a safe integer so it never rounds silently.
const MIN_BLOCK_TIME_MS = 1_500_000_000_000;
const MAX_BLOCK_TIME_MS = 4_102_444_800_000;

/** Validate a derived block timestamp is a bounded, safe integer ms. */
export function boundedTimestampMs(tsNs: unknown): number {
  if (typeof tsNs !== 'string' || !/^[0-9]+$/.test(tsNs)) {
    throw new Error('block header.timestamp_nanosec missing or not a digit string');
  }
  let ms: bigint;
  try {
    ms = BigInt(tsNs) / 1_000_000n;
  } catch {
    throw new Error('block header.timestamp_nanosec is not a base-10 integer');
  }
  if (ms > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('block timestamp_ms exceeds safe integer range');
  const out = Number(ms);
  if (!Number.isSafeInteger(out) || out < MIN_BLOCK_TIME_MS || out > MAX_BLOCK_TIME_MS) {
    throw new Error(`block timestamp_ms ${out} outside bounded range`);
  }
  return out;
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * Strict execution-outcome status parser: exactly one key, one of the success
 * variants (`SuccessValue` base64 string / `SuccessReceiptId` base58 string) or
 * `Failure` with an object payload. Any other shape is a malformed source, not
 * "not success", and throws so ingestion fails closed. `Failure` is a legitimate
 * non-success outcome; its payload is opaque and only shape-checked.
 */
export function parseSuccessStatus(status: unknown): boolean {
  if (typeof status !== 'object' || status === null || Array.isArray(status)) {
    throw new Error('execution outcome.status must be an object');
  }
  const s = status as Record<string, unknown>;
  const keys = Object.keys(s);
  if (keys.length !== 1) throw new Error(`outcome.status must have exactly one key (got ${keys.length})`);
  const kind = keys[0]!;
  if (kind === 'SuccessValue') {
    const value = s[kind];
    if (typeof value !== 'string' || !BASE64_RE.test(value)) {
      throw new Error('SuccessValue must be a base64 string');
    }
    return true;
  }
  if (kind === 'SuccessReceiptId') {
    const value = s[kind];
    if (typeof value !== 'string' || !BASE58_RE.test(value)) {
      throw new Error('SuccessReceiptId must be a non-empty base58 string');
    }
    return true;
  }
  if (kind === 'Failure') {
    const failure = s[kind];
    if (typeof failure !== 'object' || failure === null || Array.isArray(failure)) {
      throw new Error('Failure must carry an object execution-error payload');
    }
    return false;
  }
  throw new Error(`unsupported outcome.status variant: ${kind}`);
}

/**
 * true when an execution outcome status is a success variant (not a Failure).
 * Malformed shapes are NOT success (returns false); the strict normalizer uses
 * `parseSuccessStatus` instead so a malformed source throws rather than slides
 * through as failure.
 */
export function isSuccessStatus(status: unknown): boolean {
  try {
    return parseSuccessStatus(status);
  } catch {
    return false;
  }
}

/**
 * Normalize a FASTNEAR NEAR Data `/v0/block/<height>` payload. Receipts are kept
 * in deterministic shard/position order; filtering by executor/status happens in
 * the caller so the source stays a faithful passthrough.
 *
 * Strict completeness rules (all throw => the caller fails closed and no cursor
 * can advance):
 *   * header `prev_hash`/`prev_height` must be present and well-formed (canonical
 *     chain linkage is proven from these by the ingestion store);
 *   * `shards` must be a NON-EMPTY array (a finalized block contains its shards);
 *   * the header `chunks` array must be non-empty, have unique integer
 *     `shard_id`s, and describe EXACTLY the same shard set as `shards` (a partial
 *     or duplicate shard set is an incomplete source, never "some receipts");
 *   * every shard must be an object with an integer `shard_id` and an explicit
 *     `receipt_execution_outcomes` array (an explicit empty array is legitimate);
 *   * every execution outcome must carry a non-empty `id`, an object `outcome`,
 *     a non-empty `executor_id`, an explicit `logs` string array and a
 *     well-formed `status`, and its `block_hash` must equal the parent block hash;
 *   * duplicate receipt execution-outcome ids inside one block are rejected.
 */
export function normalizeFastNearBlock(payload: unknown): NormalizedBlock {
  const top = rec(payload);
  const block = rec(top['block']);
  const header = rec(block['header']);
  const height = header['height'];
  const hash = header['hash'];
  if (typeof height !== 'number' || !Number.isSafeInteger(height) || height < 0) {
    throw new Error('block header.height is not a non-negative safe integer');
  }
  if (typeof hash !== 'string' || hash.length === 0) throw new Error('block header.hash missing');
  const prevHash = header['prev_hash'];
  if (typeof prevHash !== 'string' || prevHash.length === 0) throw new Error('block header.prev_hash missing');
  const prevHeight = header['prev_height'];
  if (typeof prevHeight !== 'number' || !Number.isSafeInteger(prevHeight) || prevHeight < 0) {
    throw new Error('block header.prev_height is not a non-negative safe integer');
  }
  const timestampMs = boundedTimestampMs(header['timestamp_nanosec']);

  if (!('shards' in top)) throw new Error('block payload has no shards member');
  const shards = top['shards'];
  if (!Array.isArray(shards)) throw new Error('block shards member is not an array');
  if (shards.length === 0) throw new Error('block shards array is empty (malformed source: a finalized block carries its shards)');

  // The header `chunks` list is the protocol's canonical shard set for this
  // block. Non-empty but partial shard data must not be claimed as complete.
  const chunks = block['chunks'];
  if (!Array.isArray(chunks)) throw new Error('block chunks member is missing or not an array');
  if (chunks.length === 0) throw new Error('block chunks array is empty (malformed source)');
  const chunkShardIds: number[] = [];
  const seenChunkShards = new Set<number>();
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = rec(chunks[ci]);
    const chunkShardId = chunk['shard_id'];
    if (typeof chunkShardId !== 'number' || !Number.isSafeInteger(chunkShardId)) {
      throw new Error(`block chunks[${ci}] shard_id missing or not an integer`);
    }
    if (seenChunkShards.has(chunkShardId)) {
      throw new Error(`block chunks contains duplicate shard_id ${chunkShardId}`);
    }
    seenChunkShards.add(chunkShardId);
    chunkShardIds.push(chunkShardId);
  }

  const receipts: NormalizedReceipt[] = [];
  const seenReceipts = new Set<string>();
  const seenShardIds = new Set<number>();
  for (let si = 0; si < shards.length; si++) {
    const shard = rec(shards[si]);
    const shardId = shard['shard_id'];
    if (typeof shardId !== 'number' || !Number.isSafeInteger(shardId)) {
      throw new Error(`shard ${si} shard_id missing or not an integer`);
    }
    if (seenShardIds.has(shardId)) throw new Error(`block shards contains duplicate shard_id ${shardId}`);
    seenShardIds.add(shardId);
    if (!seenChunkShards.has(shardId)) {
      throw new Error(`shard ${shardId} has no matching block chunk header (partial shard set)`);
    }
    if (!('receipt_execution_outcomes' in shard)) {
      throw new Error(`shard ${shardId} has no receipt_execution_outcomes member (malformed source)`);
    }
    const reos = shard['receipt_execution_outcomes'];
    if (!Array.isArray(reos)) {
      throw new Error(`shard ${shardId} receipt_execution_outcomes is not an array`);
    }
    for (let ri = 0; ri < reos.length; ri++) {
      if (typeof reos[ri] !== 'object' || reos[ri] === null || Array.isArray(reos[ri])) {
        throw new Error(`shard ${shardId} receipt_execution_outcomes[${ri}] is not an object`);
      }
      const reo = rec(reos[ri]);
      if (typeof reo['execution_outcome'] !== 'object' || reo['execution_outcome'] === null || Array.isArray(reo['execution_outcome'])) {
        throw new Error(`shard ${shardId} outcome ${ri} missing execution_outcome`);
      }
      const eo = rec(reo['execution_outcome']);
      if (eo['block_hash'] !== hash) {
        throw new Error(`shard ${shardId} outcome ${ri} execution_outcome.block_hash ${String(eo['block_hash'])} != block ${hash}`);
      }
      const receiptId = eo['id'];
      if (typeof receiptId !== 'string' || receiptId.length === 0) {
        throw new Error(`shard ${shardId} outcome ${ri} missing execution_outcome.id`);
      }
      if (seenReceipts.has(receiptId)) {
        throw new Error(`duplicate receipt execution outcome id ${receiptId} in block ${height}`);
      }
      seenReceipts.add(receiptId);
      const outcome = eo['outcome'];
      if (typeof outcome !== 'object' || outcome === null || Array.isArray(outcome)) {
        throw new Error(`shard ${shardId} outcome ${ri} missing execution_outcome.outcome`);
      }
      const o = rec(outcome);
      const executorId = o['executor_id'];
      if (typeof executorId !== 'string' || executorId.length === 0) {
        throw new Error(`shard ${shardId} outcome ${ri} missing outcome.executor_id`);
      }
      if (!('logs' in o)) {
        throw new Error(`shard ${shardId} outcome ${ri} has no outcome.logs member (malformed source)`);
      }
      const rawLogs = o['logs'];
      if (!Array.isArray(rawLogs)) {
        throw new Error(`shard ${shardId} outcome ${ri} outcome.logs is not an array`);
      }
      const logs: string[] = [];
      for (let li = 0; li < rawLogs.length; li++) {
        if (typeof rawLogs[li] !== 'string') {
          throw new Error(`shard ${shardId} outcome ${ri} outcome.logs[${li}] is not a string`);
        }
        logs.push(rawLogs[li]);
      }
      receipts.push({
        receiptId,
        executorId,
        success: parseSuccessStatus(o['status']),
        logs,
      });
    }
  }
  if (seenShardIds.size !== chunkShardIds.length) {
    throw new Error(`shard set incomplete: ${seenShardIds.size} shard outcomes for ${chunkShardIds.length} block chunk headers`);
  }
  return { height, hash, prevHash, prevHeight, timestampMs, receipts };
}

export class FastNearBlockSource implements BlockSource {
  /** Earliest time the next request may be sent (documented 180 req/min/IP). */
  private nextSlotAt = 0;
  constructor(private readonly baseUrl: string, private readonly minIntervalMs = 450) {}

  /**
   * Pace requests to at most 180/minute (documented limit) with margin. The
   * scheduler is per-source-instance and monotonic; retries are additionally
   * spaced by `fetchJson` backoff.
   */
  private async pace(): Promise<void> {
    const now = Date.now();
    const ready = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = ready + this.minIntervalMs;
    if (ready > now) await sleep(ready - now);
  }

  async fetchBlock(height: number): Promise<NormalizedBlock> {
    if (!Number.isSafeInteger(height) || height < 0) throw new Error(`invalid block height ${height}`);
    await this.pace();
    const url = `${this.baseUrl.replace(/\/$/, '')}/v0/block/${height}`;
    const payload = await fetchJson(url);
    // FASTNEAR answers a height that has no archived/known block with HTTP 200
    // and a JSON `null` body (NOT a 404). Treat it exactly like a 404: a skip
    // CANDIDATE, never block evidence — the next ingested block's official
    // canonical prev_hash/prev_height linkage proves whether the height is a
    // legitimate chain gap or a pruned block.
    if (payload === null || payload === undefined) throw new BlockNotFoundError(url);
    return normalizeFastNearBlock(payload);
  }

  async lastFinalHeight(): Promise<number> {
    await this.pace();
    const payload = rec(await fetchJson(`${this.baseUrl.replace(/\/$/, '')}/v0/last_block/final`));
    const block = rec(payload['block']);
    const header = rec(block['header']);
    const height = header['height'];
    if (typeof height !== 'number' || !Number.isSafeInteger(height)) throw new Error('last final block height missing');
    if (typeof header['hash'] !== 'string' || (header['hash'] as string).length === 0) {
      throw new Error('last final block hash missing');
    }
    return height;
  }
}

/** Minimal NEAR JSON-RPC client (read-only query + block). */
export class NearRpcClient {
  constructor(private readonly url: string) {}

  async rpc(method: string, params: unknown): Promise<unknown> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 'showstake-worker', method, params });
    const res = await fetchJson(this.url, { method: 'POST', body });
    const obj = rec(res);
    if (obj['error']) throw new RpcError(method, obj['error']);
    return obj['result'];
  }

  /** Resolve a block hash to its integer height (committed provenance evidence). */
  async resolveHeight(blockHash: string): Promise<number> {
    const result = rec(await this.rpc('block', { block_id: blockHash }));
    const header = rec(result['header']);
    const height = header['height'];
    if (typeof height !== 'number' || !Number.isSafeInteger(height)) throw new Error('block height missing');
    return height;
  }

  /**
   * Mandatory canonical check: the official RPC's CANONICAL block at `height`
   * (queried by height, not by hash) must round-trip to the expected hash. A
   * hash that only resolves when queried directly may be a non-canonical fork, so
   * the by-height query is the proof. Returns the official header's
   * prev_hash/prev_height so ingestion can prove canonical chain linkage across
   * (legitimate) skipped heights. Any mismatch throws.
   */
  async verifyBlock(height: number, hash: string): Promise<CanonicalBlockHeader> {
    if (!Number.isSafeInteger(height) || height < 0) throw new Error(`invalid block height ${height}`);
    let result: Record<string, unknown>;
    try {
      result = rec(await this.rpc('block', { block_id: height }));
    } catch (e) {
      // A height with no canonical block is a chain-gap candidate, not a fatal
      // error: the fail-closed proof is the NEXT block's prev_hash linkage.
      if (e instanceof HttpError && (e.status === 404 || e.status === 422)) {
        throw new CanonicalBlockMissingError(height, e.url);
      }
      if (e instanceof RpcError && typeof e.detail === 'string' && e.detail.includes('UNKNOWN_BLOCK')) {
        throw new CanonicalBlockMissingError(height, this.url);
      }
      throw e;
    }
    const header = rec(result['header']);
    const rpcHeight = header['height'];
    const rpcHash = header['hash'];
    const prevHash = header['prev_hash'];
    const prevHeight = header['prev_height'];
    if (typeof rpcHeight !== 'number' || !Number.isSafeInteger(rpcHeight)) throw new Error('canonical check: RPC block height missing');
    if (typeof rpcHash !== 'string' || rpcHash.length === 0) throw new Error('canonical check: RPC block hash missing');
    if (typeof prevHash !== 'string' || prevHash.length === 0) throw new Error('canonical check: RPC block prev_hash missing');
    if (typeof prevHeight !== 'number' || !Number.isSafeInteger(prevHeight) || prevHeight < 0) {
      throw new Error('canonical check: RPC block prev_height missing or invalid');
    }
    if (rpcHeight !== height) {
      throw new Error(`canonical check: canonical block at height ${height} reports height ${rpcHeight}`);
    }
    if (rpcHash !== hash) {
      throw new Error(`canonical check: canonical block at height ${height} has hash ${rpcHash}, expected ${hash}`);
    }
    return { height: rpcHeight, hash: rpcHash, prevHash, prevHeight };
  }

  /** Official final block height from RPC (used to bound and verify the scan). */
  async lastFinalHeight(): Promise<number> {
    const result = rec(await this.rpc('block', { finality: 'final' }));
    const header = rec(result['header']);
    const height = header['height'];
    if (typeof height !== 'number' || !Number.isSafeInteger(height)) throw new Error('RPC final block height missing');
    return height;
  }

  /** View a contract account's code hash at `finality`. */
  async accountCodeHash(accountId: string, finality = 'final'): Promise<string> {
    const result = await this.rpc('query', { request_type: 'view_account', finality, account_id: accountId });
    const view = rec(result);
    const codeHash = view['code_hash'];
    if (typeof codeHash !== 'string') throw new Error('account code_hash missing');
    return codeHash;
  }
}

/**
 * Official-RPC canonical/final-height verifier used by the PRODUCTION ingestion
 * and scan paths (not a test-only helper). The final-height answer is cached for
 * a few seconds (it is monotonic) so a bounded scan does not re-query it for
 * every block; `verifyBlock` always hits the RPC. No `proveSkipped` exists:
 * an RPC `UNKNOWN_BLOCK`/source 404 can mean a pruned historical block, so it is
 * NEVER accepted as skip evidence by itself; ingestion proves skips only from the
 * official canonical predecessor linkage (prev_hash/prev_height) of the next
 * ingested block.
 */
export class RpcCanonicalVerifier implements CanonicalVerifier {
  private cachedFinal: { height: number; at: number } | null = null;
  constructor(private readonly rpc: NearRpcClient, private readonly finalTtlMs = 5_000) {}

  async lastFinalHeight(): Promise<number> {
    const now = Date.now();
    if (this.cachedFinal !== null && now - this.cachedFinal.at < this.finalTtlMs) return this.cachedFinal.height;
    const height = await this.rpc.lastFinalHeight();
    this.cachedFinal = { height, at: now };
    return height;
  }

  verifyBlock(height: number, hash: string): Promise<CanonicalBlockHeader> {
    return this.rpc.verifyBlock(height, hash);
  }
}

/** Contract view calls via NEAR RPC `query` (read-only). */
export class NearRpcViewSource implements ViewSource {
  constructor(private readonly rpc: NearRpcClient) {}

  async callView(method: string, args: unknown, blockRef: string): Promise<{ result: unknown; blockHeight: number; blockHash: string }> {
    const params: Record<string, unknown> = {
      request_type: 'call_function',
      account_id: (args as { accountId?: string })?.accountId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify((args as { args: unknown }).args), 'utf8').toString('base64'),
    };
    if (blockRef === 'final') {
      params['finality'] = 'final';
    } else {
      params['block_id'] = blockRef;
    }
    const result = rec(await this.rpc.rpc('query', params));
    if (result['error']) throw new Error(`view ${method} error: ${JSON.stringify(result['error'])}`);
    const blockHeight = result['block_height'];
    const blockHash = result['block_hash'];
    if (typeof blockHeight !== 'number' || !Number.isSafeInteger(blockHeight)) {
      throw new Error(`view ${method} response missing block_height`);
    }
    if (typeof blockHash !== 'string' || blockHash.length === 0) {
      throw new Error(`view ${method} response missing block_hash`);
    }
    // A pinned view must actually have executed at the requested block hash.
    if (blockRef !== 'final' && blockHash !== blockRef) {
      throw new Error(`view ${method} executed at block hash ${blockHash}, expected pinned block ${blockRef}`);
    }
    const encoded = result['result'];
    if (!Array.isArray(encoded) || encoded.length === 0) {
      throw new Error(`view ${method} returned no result bytes`);
    }
    const json = Buffer.from(encoded as number[]).toString('utf8');
    const parsed: unknown = JSON.parse(json);
    return { result: parsed, blockHeight, blockHash };
  }
}

/**
 * Convenience: call a view with an explicit account/method/args object, returning
 * the decoded JSON plus the block it was pinned to.
 */
export async function viewAccount(vs: ViewSource, accountId: string, method: string, args: unknown, blockRef = 'final') {
  return vs.callView(method, { accountId, args }, blockRef);
}
