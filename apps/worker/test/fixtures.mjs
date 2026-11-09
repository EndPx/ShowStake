// Deterministic, labelled worker test fixtures. No network, no real assets.
//
// Local fixtures are adversarial (malformed/duplicate/failed/wrong-deployment
// receipts); the committed testnet publish/deposit receipt metadata below is
// real on-chain evidence sourced from docs/evidence/testnet-product-smoke.json
// and docs/evidence/testnet-showstake-deployment-result.json, used ONLY by the
// clearly-separate read-only testnet proof (verify-worker-testnet.mjs).

export const COMMITTED_DEPLOYMENT = {
  environment: 'testnet',
  network: 'testnet',
  contractId: 'showstake-endpx.testnet',
  ftContractId: 'showstake-ft-endpx.testnet',
  ftDecimals: 6,
  codeHash: 'HyqAt2yJGvV3CHKNYLA9oqzt1aWrmagwSbtogdXhA8wo',
  wasmSha256: 'fc49fb85cc6e718086ddf81e9a936362a8c36ef9384a8444eadafa6ec0cdcd8e',
  organizer: 'showstake-participant-endpx.testnet',
  policyVersion: 'showstake-v2/1',
  // Contract deployment block (`after.block_height` in
  // docs/evidence/testnet-showstake-deployment-result.json). The exact-start gate
  // requires a fresh worker cursor to begin here, never at the later publish block.
  startHeight: 276624074,
};

/** Accepted v6 settlement deployment (showstake-v2-d036-settle/1, f462ddcb…). */
export const SETTLE_DEPLOYMENT = {
  environment: 'testnet',
  network: 'testnet',
  contractId: 'showstake-settle-endpx.testnet',
  ftContractId: 'showstake-ft-endpx.testnet',
  ftDecimals: 6,
  codeHash: 'HSyv94gFgwMFyfrfQBhjBc7Aidgh4eaaL6LeH3cs1zpp',
  wasmSha256: 'f462ddcbb8b47ff03f4bea71c054cefe0d0a576b1346a0f9a55688c43307fd59',
  organizer: 'showstake-participant-endpx.testnet',
  policyVersion: 'showstake-v2-d036-settle/1',
  startHeight: 276712710,
};

/** Committed d036-settle-five publish receipt (EventPublished) block metadata. */
export const V6_SETTLE_PUBLISH = {
  receiptId: 'oEYHu1QaYb2U3BeFnesHVGd3Rm3YiV2CjdpN4PkUMS9',
  blockHash: '88FA3ywBBi7uNZCsfimeLeYVBYm51RgAVaKKUiwoC7CX',
  blockHeight: 276713411,
};

/** Committed d036-settle-five final payout receipt (PayoutSucceeded reg-1). */
export const V6_SETTLE_FINAL_BLOCK = {
  receiptId: 'zW1K2zpGNcgotPw3jwETxDJbB9bbvwAwVMYegNo2QsB',
  blockHash: '3Mpa7htVsJB9nUBKq4nzv6BhBmgTbGC5TJJd3e11Ecaj',
  blockHeight: 276714097,
};

/** Real committed `publish` (EventPublished) receipt metadata. */
export const PUBLISH_RECEIPT = {
  receiptId: 'GrpHcvrpi5ZBph2DcRumXSKHwpFB2UCRqgXjDd4yPYY6',
  blockHash: '3Bj52tt5ctKTNUdkyh4peH4tk26rQrjexoiWaoiHjqSa',
  blockHeight: 276624284,
  blockTimeMs: 1794050592970,
  log: 'EVENT_JSON:{"standard":"showstake","version":"1.0.0","event":"EventPublished","data":{"event_id":"testnet-first-event","organizer":"showstake-participant-endpx.testnet","deposit":"1000000","capacity":10,"finalize_deadline":1794162171780,"policy_version":"showstake-v2/1","storage_cost_yocto":"3490000000000000000000"}}',
};

/** Real committed `deposit` (RegistrationCommitted) receipt metadata. */
export const DEPOSIT_RECEIPT = {
  receiptId: 'EzrnbJnaB8vc2AnQGHDHpUQ5RxZSk5riALpBcVEbDttS',
  blockHash: '6JKLsNKV9X3tSwntQyN4PLf8mQerMAczxPQXSVWupd3i',
  blockHeight: 276624391,
  log: 'EVENT_JSON:{"standard":"showstake","version":"1.0.0","event":"RegistrationCommitted","data":{"event_id":"testnet-first-event","registration_id":"reg-0","pass_id":"pass-0","participant":"showstake-participant-endpx.testnet","beneficiary":"showstake-participant-endpx.testnet","commitment_id":"testnet-commit-001","amount":"1000000","event_sequence":0,"storage_cost_yocto":"6970000000000000000000"}}',
};

/** Real `get_event` view result (pinned to the publish block) for enrichment. */
export const PUBLISH_VIEW = {
  event_id: 'testnet-first-event',
  organizer: 'showstake-participant-endpx.testnet',
  canonical_ft: 'showstake-ft-endpx.testnet',
  rules_hash: 'testnet-first-event-v2',
  deposit: '1000000',
  capacity: 10,
  reg_open: 1794050511780,
  reg_close: 1794072171780,
  cancel_cutoff: 1794072171780,
  checkin_open: 1794072171780,
  checkin_close: 1794075771780,
  finalize_deadline: 1794162171780,
  policy_version: 'showstake-v2/1',
  state: 'Published',
};

const DEP = COMMITTED_DEPLOYMENT;

/** Build a deterministic normalized receipt (caller supplies a labelled id). */
export function receipt({ id, executorId = DEP.contractId, status = { SuccessValue: '' }, logs = [] }) {
  return { receiptId: id, executorId, success: Boolean(status) && !('Failure' in status), logs };
}

export function log(event, data) {
  return `EVENT_JSON:${JSON.stringify({ standard: 'showstake', version: '1.0.0', event, data })}`;
}

/**
 * A normalized block carrying the given receipts. Canonical linkage fields are
 * explicit (the DB suite registers the matching official header with the fake
 * verifier); defaults model a contiguous predecessor at height-1.
 */
export function block({ height, hash, timestampMs, receipts, prevHash = `PREV-${height - 1}`, prevHeight = height - 1 }) {
  return { height, hash, prevHash, prevHeight, timestampMs, receipts };
}

/** A commit-only block for `evt-local-1` (5000000 atomic each), used by the DB suite. */
export function commitBlock({ height, hash, registrationId, passId, eventSequence, participant = 'dave.testnet', prevHash = `PREV-${height - 1}`, prevHeight = height - 1 }) {
  const commitLog = log('RegistrationCommitted', {
    event_id: 'evt-local-1',
    registration_id: registrationId,
    pass_id: passId,
    participant,
    beneficiary: participant,
    commitment_id: `commit-${registrationId}`,
    amount: '5000000',
    event_sequence: eventSequence,
    storage_cost_yocto: '0',
  });
  return block({
    height,
    hash,
    prevHash,
    prevHeight,
    timestampMs: 1794000000000 + height * 1000,
    receipts: [receipt({ id: `receipt-${registrationId}`, logs: [commitLog] })],
  });
}

/**
 * Local fixture blocks (deterministic, labelled) for the DB suite. Heights begin
 * at 100 so the DB deployment's start_block equals the fixture start (the local
 * fixture is deliberately not real chain history).
 */
export function localFixtureBlocks() {
  const pubLog = log('EventPublished', {
    event_id: 'evt-local-1',
    organizer: DEP.organizer,
    deposit: '5000000',
    capacity: 50,
    finalize_deadline: 1794162171780,
    policy_version: DEP.policyVersion,
    storage_cost_yocto: '0',
  });
  const localView = {
    event_id: 'evt-local-1',
    organizer: DEP.organizer,
    canonical_ft: DEP.ftContractId,
    rules_hash: 'rules-local-1',
    deposit: '5000000',
    capacity: 50,
    reg_open: 1794050511780,
    reg_close: 1794072171780,
    cancel_cutoff: 1794072171780,
    checkin_open: 1794072171780,
    checkin_close: 1794075771780,
    finalize_deadline: 1794162171780,
    policy_version: DEP.policyVersion,
    state: 'Published',
  };
  const commitLog = log('RegistrationCommitted', {
    event_id: 'evt-local-1',
    registration_id: 'reg-local-0',
    pass_id: 'pass-local-0',
    participant: 'bob.testnet',
    beneficiary: 'bob.testnet',
    commitment_id: 'commit-local-1',
    amount: '5000000',
    event_sequence: 0,
    storage_cost_yocto: '0',
  });
  const blocks = {
    publish: block({
      height: 100, hash: 'H100', timestampMs: 1794000000000,
      receipts: [receipt({ id: 'local-receipt-publish', logs: [pubLog] })],
    }),
    deposit: block({
      height: 101, hash: 'H101', prevHash: 'H100', prevHeight: 100, timestampMs: 1794000001000,
      receipts: [receipt({ id: 'local-receipt-deposit', logs: [commitLog] })],
    }),
    // wrong executor (different contract) — must be ignored entirely.
    wrongExecutor: block({
      height: 103, hash: 'H103', prevHash: 'H101', prevHeight: 101, timestampMs: 1794000003000,
      receipts: [receipt({ id: 'local-receipt-wrong', executorId: 'someone-else.testnet', logs: [log('RegistrationCommitted', { event_id: 'evt-local-1', registration_id: 'reg-WRONG', pass_id: 'pass-WRONG', participant: 'bob.testnet', beneficiary: 'bob.testnet', commitment_id: 'commit-WRONG', amount: '5000000', event_sequence: 2, storage_cost_yocto: '0' })] })],
    }),
    // failed receipt carrying a forged RegistrationCommitted log (must be refused).
    failed: block({
      height: 104, hash: 'H104', prevHash: 'H103', prevHeight: 103, timestampMs: 1794000004000,
      receipts: [receipt({ id: 'local-receipt-failed', status: { Failure: { ActionError: { index: 0 } } }, logs: [log('RegistrationCommitted', { event_id: 'evt-local-1', registration_id: 'reg-BAD', pass_id: 'pass-BAD', participant: 'bob.testnet', beneficiary: 'bob.testnet', commitment_id: 'commit-BAD', amount: '5000000', event_sequence: 1, storage_cost_yocto: '0' })] })],
    }),
    // malformed amount (leading zero) on an otherwise-successful receipt — must fail closed.
    malformed: block({
      height: 105, hash: 'H105M', prevHash: 'H104', prevHeight: 104, timestampMs: 1794000005000,
      receipts: [receipt({ id: 'local-receipt-malformed', logs: [log('RegistrationCommitted', { event_id: 'evt-local-1', registration_id: 'reg-BAD2', pass_id: 'pass-BAD2', participant: 'bob.testnet', beneficiary: 'bob.testnet', commitment_id: 'commit-BAD2', amount: '05000000', event_sequence: 3, storage_cost_yocto: '0' })] })],
    }),
    // unsupported showstake event — must fail closed.
    unsupported: block({
      height: 105, hash: 'H105U', prevHash: 'H104', prevHeight: 104, timestampMs: 1794000005000,
      receipts: [receipt({ id: 'local-receipt-unsupported', logs: [log('SomeFutureEvent', { x: 1 })] })],
    }),
    // In-transaction failure AFTER the chain_event insert: commit for an event
    // that was never published. Proves the whole transaction (provenance + cursor)
    // rolls back; the cursor stays behind.
    crash: block({
      height: 105, hash: 'H105C', prevHash: 'H104', prevHeight: 104, timestampMs: 1794000005000,
      receipts: [receipt({ id: 'local-receipt-crash', logs: [log('RegistrationCommitted', { event_id: 'evt-never-published', registration_id: 'reg-crash', pass_id: 'pass-crash', participant: 'bob.testnet', beneficiary: 'bob.testnet', commitment_id: 'commit-crash', amount: '5000000', event_sequence: 0, storage_cost_yocto: '0' })] })],
    }),
    // A valid provenance-only block at 105 (after the failed attempts) advances the cursor.
    provenance: block({
      height: 105, hash: 'H105P', prevHash: 'H104', prevHeight: 104, timestampMs: 1794000005000,
      receipts: [receipt({ id: 'local-receipt-storage', logs: [log('StorageDeposited', { account_id: 'bob.testnet', amount: '1250000000000000000000' })] })],
    }),
    // publish view used by the fake live chain
    localView,
  };
  return { blocks, localView };
}