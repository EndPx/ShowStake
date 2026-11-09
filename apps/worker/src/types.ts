// Shared worker types. Money amounts stay canonical base-10 u128 strings at the
// JSON/chain boundary; internally we parse them to bigint via @showstake/domain.

/** A normalized finalized NEAR block abstracted from the block source. */
export interface NormalizedBlock {
  /** integer block height. */
  height: number;
  /** base58 block hash (NEAR header hash). */
  hash: string;
  /** base58 hash of the canonical predecessor block (header.prev_hash). */
  prevHash: string;
  /** integer height of the canonical predecessor block (header.prev_height). */
  prevHeight: number;
  /** integer UTC milliseconds (derived from header.timestamp_nanosec). */
  timestampMs: number;
  /** receipts in deterministic shard/position order (already only execution outcomes). */
  receipts: NormalizedReceipt[];
}

export interface NormalizedReceipt {
  /** receipt id (base58). */
  receiptId: string;
  /** account that executed this receipt. */
  executorId: string;
  /** true when outcome.status is a success variant (not a Failure). */
  success: boolean;
  /** execution logs (strings) for this receipt. */
  logs: string[];
}

/** A parsed ShowStake `EVENT_JSON` log. */
export interface ShowStakeEvent {
  /** index of this log within the receipt's `outcome.logs` (0-based). */
  logIndex: number;
  /** NEP-297 standard. Must be exactly "showstake". */
  standard: string;
  /** NEP-297 version. Must be exactly "1.0.0". */
  version: string;
  /** ShowStake event name (e.g., "EventPublished"). */
  event: string;
  /** Validated JSON object payload. */
  data: Record<string, unknown>;
  /** the raw EVENT_JSON log string (provenance). */
  raw: string;
}

/** Column values for one `chain_events` row (before uuid/id assignment). */
export interface ChainEventInsert {
  receiptId: string;
  logIndex: number;
  blockHeight: number;
  blockHash: string;
  blockTimeMs: number;
  eventName: string;
  schemaVersion: string;
  payload: Record<string, unknown>;
}

/**
 * A validated, typed ShowStake event ready for projection. Provenance-only
 * events (StorageDeposited, settlement/cancel/payout) are captured in
 * chain_events but never mutate financial projections in this slice.
 */
export type ValidatedEvent =
  | { kind: 'PUBLISH'; chainEvent: ChainEventInsert; eventId: string; rules: PublishRules }
  | { kind: 'COMMIT'; chainEvent: ChainEventInsert; commit: CommitData }
  | { kind: 'PROVENANCE'; chainEvent: ChainEventInsert };

export interface PublishRules {
  eventId: string;
  organizer: string;
  canonicalFt: string;
  deposit: string;
  capacity: number;
  regOpenMs: number;
  regCloseMs: number;
  cancelCutoffMs: number;
  checkinOpenMs: number;
  checkinCloseMs: number;
  finalizeDeadlineMs: number;
  policyVersion: string;
  rulesHash: string;
}

export interface CommitData {
  eventId: string;
  registrationId: string;
  passId: string;
  participant: string;
  beneficiary: string;
  commitmentId: string;
  amount: string;
  eventSequence: number;
}

/** A `deployments` row shape the worker reads (as showstake_worker). */
export interface DeploymentRow {
  id: string;
  environment: string;
  network: string;
  contract_id: string;
  ft_contract_id: string;
  ft_decimals: number;
  start_block: string; // numeric -> string from pg
  code_hash: string;
}

/** A contract view result (`get_config` / `get_event`), amount fields as strings. */
export interface ViewResult<T = unknown> {
  result: T;
  blockHeight: number;
  blockHash: string;
}

/** A block-source provider (injectable for deterministic fixture tests). */
export interface BlockSource {
  /** fetch a finalized block by height, normalized (throws when unavailable). */
  fetchBlock(height: number): Promise<NormalizedBlock>;
  /** resolve the latest finalized block height (for the scan loop). */
  lastFinalHeight(): Promise<number>;
}

/** Official canonical block header fields used for chain linkage. */
export interface CanonicalBlockHeader {
  height: number;
  hash: string;
  /** header.prev_hash of the official canonical block at `height`. */
  prevHash: string;
  /** header.prev_height of the official canonical block at `height`. */
  prevHeight: number;
}

/**
 * Official-chain canonical/finality verifier. The production scan path must
 * prove every fetched block against the official RPC before ingesting it, and
 * must bound the scan by the official final height. `verifyBlock` returns the
 * official header's prev_hash/prev_height so ingestion can prove canonical chain
 * linkage across skipped heights (a source 404 or RPC UNKNOWN_BLOCK alone is NOT
 * sufficient evidence that a height is a legitimate chain gap).
 */
export interface CanonicalVerifier {
  /** official final block height (RPC `block` @ final). */
  lastFinalHeight(): Promise<number>;
  /**
   * assert the official CANONICAL block at `height` has exactly `hash` (throws
   * otherwise) and return its canonical predecessor linkage.
   */
  verifyBlock(height: number, hash: string): Promise<CanonicalBlockHeader>;
}

/** A contract-view provider (injectable). `blockRef` is a block hash or "final". */
export interface ViewSource {
  callView(method: string, args: unknown, blockRef: string): Promise<{ result: unknown; blockHeight: number; blockHash: string }>;
}
