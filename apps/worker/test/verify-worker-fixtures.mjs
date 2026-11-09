// apps/worker adversarial parsing + pure-logic verification (NO database, NO
// network). Imports the compiled worker dist (run `pnpm --filter @showstake/worker
// build` first). Deterministic labelled fixtures only.
import { parseShowStakeLogs, classifyEvent } from '../dist/events.js';
import { normalizeFastNearBlock, isSuccessStatus, parseSuccessStatus, BlockNotFoundError } from '../dist/source.js';
import { enrichPublish, parseEventView, mapFinancialStatus, parseTotalsView, parseSettlementView, parsePayoutView } from '../dist/project.js';
import { base58Decode, verifyCodeIdentity, toHex } from '../dist/identity.js';
import { parseCursorValue } from '../dist/store.js';
import { runBoundedScan } from '../dist/index.js';
import { COMMITTED_DEPLOYMENT, PUBLISH_RECEIPT, PUBLISH_VIEW, log } from './fixtures.mjs';

const results = [];
function check(id, ok, expected, observed) {
  results.push({ id, ok: Boolean(ok), expected, observed, classifier: 'PASS_LOCAL' });
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${id}  (observed: ${observed})`);
}

function expectThrow(id, fn, contains) {
  try {
    fn();
    check(id, false, `throws (${contains})`, 'did not throw');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(id, msg.includes(contains), `throws (${contains})`, msg);
  }
}

async function expectReject(id, fn, contains) {
  try {
    await fn();
    check(id, false, `rejects (${contains})`, 'did not reject');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(id, msg.includes(contains), `rejects (${contains})`, msg);
  }
}

const DEP = COMMITTED_DEPLOYMENT;
const pubLog = log('EventPublished', {
  event_id: 'e1', organizer: DEP.organizer, deposit: '1000000', capacity: 10,
  finalize_deadline: 1794162171780, policy_version: DEP.policyVersion, storage_cost_yocto: '0',
});
const commitLog = log('RegistrationCommitted', {
  event_id: 'e1', registration_id: 'r0', pass_id: 'p0', participant: 'a.testnet',
  beneficiary: 'a.testnet', commitment_id: 'c1', amount: '1000000', event_sequence: 0,
  storage_cost_yocto: '0',
});

const HASH = '3Bj52tt5ctKTNUdkyh4peH4tk26rQrjexoiWaoiHjqSa';
const outcome = (over = {}) => ({
  execution_outcome: {
    block_hash: HASH,
    id: over.id ?? 'r1',
    outcome: {
      executor_id: over.executorId ?? 'c.testnet',
      status: over.status ?? { SuccessValue: '' },
      logs: 'logs' in over ? over.logs : [pubLog],
    },
  },
});
const validPayload = () => ({
  block: {
    header: {
      height: 100,
      hash: HASH,
      prev_hash: '11111111111111111111111111111111',
      prev_height: 99,
      timestamp_nanosec: '1794000000000000000',
    },
    chunks: [{ shard_id: 0 }, { shard_id: 1 }],
  },
  shards: [
    { shard_id: 0, receipt_execution_outcomes: [] },
    { shard_id: 1, receipt_execution_outcomes: [outcome()] },
  ],
});

// 1. parseShowStakeLogs
{
  const parsed = parseShowStakeLogs([pubLog, commitLog]);
  check('PARSE_PUBLISH', parsed.length === 2 && parsed[0].event === 'EventPublished', 'two showstake events', parsed.length);
  check('PARSE_STANDARD', parsed[0].standard === 'showstake' && parsed[0].version === '1.0.0', 'standard/version', `${parsed[0].standard}/${parsed[0].version}`);
  check('PARSE_LOG_INDEX', parsed[1].logIndex === 1, 'log index preserved', parsed[1].logIndex);
  const ignored = parseShowStakeLogs(['EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[]}', pubLog]);
  check('PARSE_IGNORE_OTHER_STANDARD', ignored.length === 1 && ignored[0].event === 'EventPublished', 'nep141 ignored', ignored.length);
  expectThrow('PARSE_MALFORMED', () => parseShowStakeLogs(['EVENT_JSON:not-json']), 'malformed');
  expectThrow('PARSE_WRONG_VERSION', () => parseShowStakeLogs([log('EventPublished', { event_id: 'x', organizer: DEP.organizer, deposit: '1', capacity: 1, finalize_deadline: 1, policy_version: 'p' }).replace('"version":"1.0.0"', '"version":"9.9.9"')]), 'unsupported showstake version');
  expectThrow('PARSE_UNKNOWN_EVENT', () => parseShowStakeLogs([log('Nope', {})]), 'unsupported showstake event');
}

// 2. classifyEvent (adversarial)
{
  const c = classifyEvent(parseShowStakeLogs([commitLog])[0]);
  check('CLASSIFY_COMMIT', c.kind === 'COMMIT' && c.commit.amount === '1000000', 'commit classified', c.kind);
  check('CLASSIFY_COMMIT_SEQ', c.kind === 'COMMIT' && c.commit.eventSequence === 0, 'event_sequence 0', c.kind === 'COMMIT' ? c.commit.eventSequence : null);

  const badAmount = log('RegistrationCommitted', { event_id: 'e1', registration_id: 'r', pass_id: 'p', participant: 'a.testnet', beneficiary: 'a.testnet', commitment_id: 'c', amount: '099', event_sequence: 0, storage_cost_yocto: '0' });
  expectThrow('ADVERSARIAL_AMOUNT_LEADING_ZERO', () => classifyEvent(parseShowStakeLogs([badAmount])[0]), 'canonical u128');
  const negAmount = log('RegistrationCommitted', { event_id: 'e1', registration_id: 'r', pass_id: 'p', participant: 'a.testnet', beneficiary: 'a.testnet', commitment_id: 'c', amount: '-5', event_sequence: 0, storage_cost_yocto: '0' });
  expectThrow('ADVERSARIAL_AMOUNT_NEGATIVE', () => classifyEvent(parseShowStakeLogs([negAmount])[0]), 'canonical u128');
  const hugeAmount = log('RegistrationCommitted', { event_id: 'e1', registration_id: 'r', pass_id: 'p', participant: 'a.testnet', beneficiary: 'a.testnet', commitment_id: 'c', amount: '340282366920938463463374607431768211456', event_sequence: 0, storage_cost_yocto: '0' });
  expectThrow('ADVERSARIAL_AMOUNT_U128_OVERFLOW', () => classifyEvent(parseShowStakeLogs([hugeAmount])[0]), 'u128');
  const badAcct = log('RegistrationCommitted', { event_id: 'e1', registration_id: 'r', pass_id: 'p', participant: 'Bad Acct!', beneficiary: 'Bad Acct!', commitment_id: 'c', amount: '1000000', event_sequence: 0, storage_cost_yocto: '0' });
  expectThrow('ADVERSARIAL_ACCOUNT_INVALID', () => classifyEvent(parseShowStakeLogs([badAcct])[0]), 'valid NEAR account');
  const badCap = log('EventPublished', { event_id: 'e1', organizer: DEP.organizer, deposit: '1', capacity: 0, finalize_deadline: 1, policy_version: 'p', storage_cost_yocto: '0' });
  expectThrow('ADVERSARIAL_CAPACITY_ZERO', () => classifyEvent(parseShowStakeLogs([badCap])[0]), 'capacity');
  const badDepos = log('EventPublished', { event_id: 'e1', organizer: DEP.organizer, deposit: '0', capacity: 10, finalize_deadline: 1, policy_version: 'p', storage_cost_yocto: '0' });
  expectThrow('ADVERSARIAL_DEPOSIT_ZERO', () => classifyEvent(parseShowStakeLogs([badDepos])[0]), '> 0');
}

// 3. status shape (strict)
{
  check('STATUS_SUCCESS', isSuccessStatus({ SuccessValue: '' }), 'SuccessValue success', true);
  check('STATUS_FAILURE', !isSuccessStatus({ Failure: { ActionError: {} } }), 'Failure not success', false);
  check('STATUS_NONOBJECT', !isSuccessStatus('ok'), 'non-object not success', false);
  check('STATUS_STRICT_SUCCESS_VALUE', parseSuccessStatus({ SuccessValue: 'AQID' }), 'base64 SuccessValue accepted', true);
  check('STATUS_STRICT_RECEIPT_ID', parseSuccessStatus({ SuccessReceiptId: '3AAKPfQtp7Wzw91ck8XJipEgU9aF9hT7PHQehuxBbFBk' }), 'base58 SuccessReceiptId accepted', true);
  expectThrow('STATUS_TWO_KEYS_REJECTED', () => parseSuccessStatus({ SuccessValue: '', Failure: { ActionError: {} } }), 'exactly one key');
  expectThrow('STATUS_UNKNOWN_VARIANT_REJECTED', () => parseSuccessStatus({ SomethingElse: '' }), 'unsupported outcome.status variant');
  expectThrow('STATUS_BAD_BASE64_REJECTED', () => parseSuccessStatus({ SuccessValue: '***' }), 'base64');
  expectThrow('STATUS_BAD_RECEIPT_ID_REJECTED', () => parseSuccessStatus({ SuccessReceiptId: '' }), 'base58');
  expectThrow('STATUS_FAILURE_SHAPE_REJECTED', () => parseSuccessStatus({ Failure: 'trap' }), 'object execution-error payload');
}

// 4. normalizeFastNearBlock (strict completeness on synthetic FASTNEAR payloads)
{
  const headerFor = (over = {}) => ({
    height: 100,
    hash: HASH,
    prev_hash: '11111111111111111111111111111111',
    prev_height: 99,
    timestamp_nanosec: '1794000000000000000',
    ...over,
  });
  const payload = ({ shards, chunks, header = {} }) => ({
    block: { header: headerFor(header), chunks: chunks ?? shards.map((s) => ({ shard_id: s.shard_id })) },
    shards,
  });

  const nb = normalizeFastNearBlock(validPayload());
  check('NORMALIZE_BLOCK', nb.height === 100 && nb.hash === HASH && nb.timestampMs === 1794000000000 && nb.prevHash === '11111111111111111111111111111111' && nb.prevHeight === 99, 'normalized block + linkage fields', JSON.stringify({ h: nb.height, t: nb.timestampMs, prev: nb.prevHeight }));
  check('NORMALIZE_RECEIPT', nb.receipts.length === 1 && nb.receipts[0].executorId === 'c.testnet' && nb.receipts[0].success, 'normalized receipt', nb.receipts.length);

  const emptyOutcomes = normalizeFastNearBlock(payload({
    shards: [
      { shard_id: 0, receipt_execution_outcomes: [] },
      { shard_id: 1, receipt_execution_outcomes: [] },
    ],
  }));
  check('NORMALIZE_EXPLICIT_EMPTY_OUTCOMES_OK', emptyOutcomes.receipts.length === 0, 'explicit empty shard outcome arrays accepted', emptyOutcomes.receipts.length);

  const emptyLogs = normalizeFastNearBlock(payload({ shards: [{ shard_id: 0, receipt_execution_outcomes: [outcome({ logs: [] })] }] }));
  check('NORMALIZE_EXPLICIT_EMPTY_LOGS_OK', emptyLogs.receipts.length === 1 && emptyLogs.receipts[0].logs.length === 0, 'explicit empty logs array accepted', emptyLogs.receipts[0].logs.length);

  const failure = normalizeFastNearBlock(payload({ shards: [{ shard_id: 0, receipt_execution_outcomes: [outcome({ status: { Failure: { ActionError: { index: 0 } } } })] }] }));
  check('NORMALIZE_FAILURE_STATUS', failure.receipts.length === 1 && failure.receipts[0].success === false, 'Failure normalized as non-success', failure.receipts[0].success);

  const noShards = validPayload(); delete noShards.shards;
  expectThrow('NORMALIZE_NO_SHARDS_REJECTED', () => normalizeFastNearBlock(noShards), 'no shards member');
  expectThrow('NORMALIZE_EMPTY_SHARDS_REJECTED', () => normalizeFastNearBlock(payload({ shards: [] })), 'shards array is empty');
  const noReo = validPayload(); delete noReo.shards[0].receipt_execution_outcomes;
  expectThrow('NORMALIZE_SHARD_NO_OUTCOMES_REJECTED', () => normalizeFastNearBlock(noReo), 'no receipt_execution_outcomes member');
  const badReo = validPayload(); badReo.shards[0].receipt_execution_outcomes = {};
  expectThrow('NORMALIZE_OUTCOMES_NOT_ARRAY_REJECTED', () => normalizeFastNearBlock(badReo), 'receipt_execution_outcomes is not an array');
  const missingId = validPayload(); delete missingId.shards[1].receipt_execution_outcomes[0].execution_outcome.id;
  expectThrow('NORMALIZE_MISSING_RECEIPT_ID_REJECTED', () => normalizeFastNearBlock(missingId), 'missing execution_outcome.id');
  const missingExecutor = validPayload(); delete missingExecutor.shards[1].receipt_execution_outcomes[0].execution_outcome.outcome.executor_id;
  expectThrow('NORMALIZE_MISSING_EXECUTOR_REJECTED', () => normalizeFastNearBlock(missingExecutor), 'missing outcome.executor_id');
  const missingLogs = validPayload(); delete missingLogs.shards[1].receipt_execution_outcomes[0].execution_outcome.outcome.logs;
  expectThrow('NORMALIZE_MISSING_LOGS_REJECTED', () => normalizeFastNearBlock(missingLogs), 'no outcome.logs member');
  const badLogs = validPayload(); badLogs.shards[1].receipt_execution_outcomes[0].execution_outcome.outcome.logs = [1];
  expectThrow('NORMALIZE_LOGS_NONSTRING_REJECTED', () => normalizeFastNearBlock(badLogs), 'not a string');
  const badStatus = validPayload(); badStatus.shards[1].receipt_execution_outcomes[0].execution_outcome.outcome.status = { Nope: '' };
  expectThrow('NORMALIZE_MALFORMED_STATUS_REJECTED', () => normalizeFastNearBlock(badStatus), 'unsupported outcome.status variant');
  const wrongBlockHash = validPayload(); wrongBlockHash.shards[1].receipt_execution_outcomes[0].execution_outcome.block_hash = '11111111111111111111111111111111';
  expectThrow('NORMALIZE_OUTCOME_BLOCK_HASH_REJECTED', () => normalizeFastNearBlock(wrongBlockHash), 'block_hash');
  const duplicate = validPayload(); duplicate.shards[1].receipt_execution_outcomes.push(outcome());
  expectThrow('NORMALIZE_DUPLICATE_RECEIPT_REJECTED', () => normalizeFastNearBlock(duplicate), 'duplicate receipt execution outcome');
  const badShardId = validPayload(); badShardId.shards[0].shard_id = '0';
  expectThrow('NORMALIZE_SHARD_ID_REJECTED', () => normalizeFastNearBlock(badShardId), 'shard_id');
  const noTimestamp = validPayload(); delete noTimestamp.block.header.timestamp_nanosec;
  expectThrow('NORMALIZE_TIMESTAMP_MISSING_REJECTED', () => normalizeFastNearBlock(noTimestamp), 'timestamp_nanosec');
  const outOfRange = validPayload(); outOfRange.block.header.timestamp_nanosec = '1000000000000000000';
  expectThrow('NORMALIZE_TIMESTAMP_RANGE_REJECTED', () => normalizeFastNearBlock(outOfRange), 'outside bounded range');
  const unsafeTs = validPayload(); unsafeTs.block.header.timestamp_nanosec = '99999999999999999999999999';
  expectThrow('NORMALIZE_TIMESTAMP_UNSAFE_REJECTED', () => normalizeFastNearBlock(unsafeTs), 'safe integer range');

  const noPrevHash = validPayload(); delete noPrevHash.block.header.prev_hash;
  expectThrow('NORMALIZE_PREV_HASH_REJECTED', () => normalizeFastNearBlock(noPrevHash), 'prev_hash');
  const badPrevHeight = validPayload(); badPrevHeight.block.header.prev_height = 1.5;
  expectThrow('NORMALIZE_PREV_HEIGHT_REJECTED', () => normalizeFastNearBlock(badPrevHeight), 'prev_height');
  const noChunks = validPayload(); delete noChunks.block.chunks;
  expectThrow('NORMALIZE_NO_CHUNKS_REJECTED', () => normalizeFastNearBlock(noChunks), 'chunks member is missing');
  const emptyChunks = validPayload(); emptyChunks.block.chunks = [];
  expectThrow('NORMALIZE_EMPTY_CHUNKS_REJECTED', () => normalizeFastNearBlock(emptyChunks), 'chunks array is empty');
  const partialShards = validPayload(); partialShards.shards.pop();
  expectThrow('NORMALIZE_PARTIAL_SHARD_SET_REJECTED', () => normalizeFastNearBlock(partialShards), 'shard set incomplete');
  const extraShard = validPayload(); extraShard.shards.push({ shard_id: 2, receipt_execution_outcomes: [] });
  expectThrow('NORMALIZE_EXTRA_SHARD_REJECTED', () => normalizeFastNearBlock(extraShard), 'no matching block chunk header');
  const duplicateShardId = validPayload(); duplicateShardId.shards[1].shard_id = 0;
  expectThrow('NORMALIZE_DUPLICATE_SHARD_ID_REJECTED', () => normalizeFastNearBlock(duplicateShardId), 'duplicate shard_id');
  const duplicateChunkId = validPayload(); duplicateChunkId.block.chunks[1].shard_id = 0;
  expectThrow('NORMALIZE_DUPLICATE_CHUNK_ID_REJECTED', () => normalizeFastNearBlock(duplicateChunkId), 'block chunks contains duplicate shard_id');
  const badChunkShardId = validPayload(); badChunkShardId.block.chunks[0].shard_id = '0';
  expectThrow('NORMALIZE_CHUNK_SHARD_ID_REJECTED', () => normalizeFastNearBlock(badChunkShardId), 'chunks[0] shard_id');
}

// 5. identity
{
  check('IDENTITY_B58_HEX', toHex(base58Decode(DEP.codeHash)) === DEP.wasmSha256, 'base58 code_hash decodes to wasm sha256', toHex(base58Decode(DEP.codeHash)));
  check('IDENTITY_VERIFY', verifyCodeIdentity(DEP.codeHash, DEP.wasmSha256), 'code identity verified', true);
  check('IDENTITY_VERIFY_NEG', !verifyCodeIdentity(DEP.codeHash, '0'.repeat(64)), 'wrong sha256 rejected', false);
  expectThrow('IDENTITY_BAD_B58', () => base58Decode('0OIl!'), 'invalid base58');
}

// 6. enrichPublish (positive committed view + negatives)
{
  const view = parseEventView(PUBLISH_VIEW);
  const realPub = classifyEvent(parseShowStakeLogs([PUBLISH_RECEIPT.log])[0]);
  check('PARSE_REAL_PUBLISH', realPub.kind === 'PUBLISH', 'committed publish log parses as PUBLISH', realPub.kind);
  const rules = enrichPublish(realPub.publish, view, DEP);
  check('ENRICH_POSITIVE', rules.rulesHash === 'testnet-first-event-v2' && rules.deposit === '1000000' && rules.capacity === 10, 'committed publish enriched', rules.rulesHash);
  const badFt = { ...view, canonical_ft: 'wrong-ft.testnet' };
  expectThrow('ENRICH_WRONG_FT', () => enrichPublish(realPub.publish, parseEventView(badFt), DEP), 'canonical_ft');
  const badDeadline = { ...view, finalize_deadline: view.checkin_close + 123 };
  expectThrow('ENRICH_BAD_FINALIZE', () => enrichPublish(realPub.publish, parseEventView(badDeadline), DEP), 'checkin_close + 24h');
  const badOrder = { ...view, reg_open: view.reg_close + 1 };
  expectThrow('ENRICH_BAD_TIME_ORDER', () => enrichPublish(realPub.publish, parseEventView(badOrder), DEP), 'time ordering');
}

// 7. cursor state (fail-closed parsing)
{
  check('CURSOR_VALID', parseCursorValue({ block_height: 7, block_hash: 'H7' }).block_height === 7, 'valid cursor parsed', 7);
  expectThrow('CURSOR_JSON_NULL_REJECTED', () => parseCursorValue(null), 'not an object');
  expectThrow('CURSOR_MISSING_HASH_REJECTED', () => parseCursorValue({ block_height: 7 }), 'block_hash');
  expectThrow('CURSOR_BAD_HEIGHT_REJECTED', () => parseCursorValue({ block_height: 7.5, block_hash: 'H7' }), 'safe integer');
  expectThrow('CURSOR_BAD_HASH_REJECTED', () => parseCursorValue({ block_height: 7, block_hash: 'two words' }), 'single non-empty token');
}

// 8. scan missing-height candidates + official bound (offline)
{
  const mkBlock = (h) => ({ height: h, hash: `H${h}`, prevHash: `H${h - 1}`, prevHeight: h - 1, timestampMs: 1794000000000 + h, receipts: [] });
  const mkScan = ({ missing = new Set(), final = 12, sourceFinal = 999, rejectAt = null }) => {
    const ingested = [];
    const store = {
      async ingestBlock(_id, b) {
        if (rejectAt === b.height) throw new Error(`chain linkage: canonical block ${b.height} prev hash does not match cursor`);
        ingested.push(b.height);
      },
    };
    const blockSource = {
      async fetchBlock(h) { if (missing.has(h)) throw new BlockNotFoundError(`synthetic://${h}`); return mkBlock(h); },
      async lastFinalHeight() { return sourceFinal; },
    };
    const verifier = {
      async lastFinalHeight() { return final; },
      async verifyBlock(h) { return { height: h, hash: `H${h}`, prevHash: `H${h - 1}`, prevHeight: h - 1 }; },
    };
    return { store, blockSource, verifier, ingested };
  };

  const linked = mkScan({ missing: new Set([11]), final: 12 });
  const r1 = await runBoundedScan({ store: linked.store, blockSource: linked.blockSource, verifier: linked.verifier, deploymentId: 'd', nextHeight: 10, maxBlocks: 10 });
  check('SCAN_MISSING_HEIGHT_LINKED', r1.blocksIngested === 2 && r1.heightsSkipped.length === 1 && r1.heightsSkipped[0] === 11 && r1.heightsUnprovenMissing.length === 0,
    'a missing height is counted skipped only after a later block is ingested with canonical linkage', JSON.stringify({ n: r1.blocksIngested, skipped: r1.heightsSkipped, unproven: r1.heightsUnprovenMissing }));

  const unproven = mkScan({ missing: new Set([12]), final: 12 });
  const r2 = await runBoundedScan({ store: unproven.store, blockSource: unproven.blockSource, verifier: unproven.verifier, deploymentId: 'd', nextHeight: 12, maxBlocks: 10 });
  check('SCAN_MISSING_HEIGHT_UNPROVEN', r2.blocksIngested === 0 && r2.heightsSkipped.length === 0 && r2.heightsUnprovenMissing.length === 1 && r2.heightsUnprovenMissing[0] === 12,
    'trailing missing heights are reported unproven, never claimed skipped', JSON.stringify({ n: r2.blocksIngested, unproven: r2.heightsUnprovenMissing }));

  const rejected = mkScan({ missing: new Set([11]), final: 12, rejectAt: 12 });
  await expectReject('SCAN_LINKAGE_REJECTION_PROPAGATES', () => runBoundedScan({ store: rejected.store, blockSource: rejected.blockSource, verifier: rejected.verifier, deploymentId: 'd', nextHeight: 10, maxBlocks: 10 }), 'chain linkage');

  const bounded = mkScan({ final: 10, sourceFinal: 999 });
  const r3 = await runBoundedScan({ store: bounded.store, blockSource: bounded.blockSource, verifier: bounded.verifier, deploymentId: 'd', nextHeight: 10, maxBlocks: 10 });
  check('SCAN_BOUND_BY_OFFICIAL_FINAL', r3.blocksIngested === 1 && bounded.ingested.length === 1 && bounded.ingested[0] === 10, 'official RPC final bounds the scan (source claim ignored)', JSON.stringify({ n: r3.blocksIngested, final: r3.officialFinalHeight }));
}

// 9. v6 settlement/lifecycle classification + adversarial parsing (fail closed)
{
  const attendance = classifyEvent(parseShowStakeLogs([log('AttendanceMarked', { event_id: 'e1', registration_id: 'r0', attended: true, changed: true })])[0]);
  check('CLASSIFY_ATTENDANCE', attendance.kind === 'ATTENDANCE' && attendance.attendance.attended === true && attendance.attendance.changed === true, 'AttendanceMarked classified + fields', attendance.kind);

  const fin = classifyEvent(parseShowStakeLogs([log('EventFinalized', { event_id: 'e1', attendee_count: 2, no_show_count: 3, total_registrations: 5, finalized_at: 1794104288580 })])[0]);
  check('CLASSIFY_FINALIZE', fin.kind === 'FINALIZE' && fin.finalize.attendeeCount === 2 && fin.finalize.noShowCount === 3, 'EventFinalized classified', fin.kind);

  const ss = classifyEvent(parseShowStakeLogs([log('SettlementStarted', { event_id: 'e1', pool: '6000000', base_share: '3000000', remainder: '0', attendee_count: 2, actor: 'org.testnet' })])[0]);
  check('CLASSIFY_SETTLE_START', ss.kind === 'SETTLE_START' && ss.settleStart.baseShare === '3000000', 'SettlementStarted classified', ss.kind);

  const sc = classifyEvent(parseShowStakeLogs([log('SettlementChunk', { event_id: 'e1', cursor: 25, total_registrations: 50, allocated_total: '1000000', complete: false })])[0]);
  check('CLASSIFY_SETTLE_CHUNK', sc.kind === 'SETTLE_CHUNK' && sc.settleChunk.complete === false && sc.settleChunk.cursor === 25, 'SettlementChunk classified', sc.kind);

  const se = classifyEvent(parseShowStakeLogs([log('EventSettled', { event_id: 'e1', allocated_total: '10000000', attendee_count: 2, no_show_count: 3, total_registrations: 5 })])[0]);
  check('CLASSIFY_SETTLE_END', se.kind === 'SETTLE_END' && se.settleEnd.allocatedTotal === '10000000', 'EventSettled classified', se.kind);

  const ps = classifyEvent(parseShowStakeLogs([log('PayoutStarted', { payout_id: 'pay-r0-1', registration_id: 'r0', event_id: 'e1', beneficiary: 'a.testnet', amount: '5000000' })])[0]);
  check('CLASSIFY_PAYOUT_START', ps.kind === 'PAYOUT_START' && ps.payout.amount === '5000000', 'PayoutStarted classified', ps.kind);
  const pok = classifyEvent(parseShowStakeLogs([log('PayoutSucceeded', { payout_id: 'pay-r0-1', registration_id: 'r0', event_id: 'e1', beneficiary: 'a.testnet', amount: '5000000' })])[0]);
  check('CLASSIFY_PAYOUT_SUCCESS', pok.kind === 'PAYOUT_SUCCESS', 'PayoutSucceeded classified', pok.kind);
  const pf = classifyEvent(parseShowStakeLogs([log('PayoutFailed', { payout_id: 'pay-r0-1', registration_id: 'r0', event_id: 'e1', beneficiary: 'a.testnet', amount: '5000000' })])[0]);
  check('CLASSIFY_PAYOUT_FAIL', pf.kind === 'PAYOUT_FAIL', 'PayoutFailed classified', pf.kind);

  expectThrow('ADVERSARIAL_ATTENDANCE_NOT_BOOL', () => classifyEvent(parseShowStakeLogs([log('AttendanceMarked', { event_id: 'e1', registration_id: 'r', attended: 'yes', changed: true })])[0]), 'must be a boolean');
  expectThrow('ADVERSARIAL_FINALIZE_NEG_COUNT', () => classifyEvent(parseShowStakeLogs([log('EventFinalized', { event_id: 'e1', attendee_count: -1, no_show_count: 0, total_registrations: 1, finalized_at: 1 })])[0]), 'integer in 0..200');
  expectThrow('ADVERSARIAL_SETTLE_CHUNK_NO_COMPLETE', () => classifyEvent(parseShowStakeLogs([log('SettlementChunk', { event_id: 'e1', cursor: 0, total_registrations: 1, allocated_total: '0' })])[0]), 'must be a boolean');
  expectThrow('ADVERSARIAL_PAYOUT_ZERO', () => classifyEvent(parseShowStakeLogs([log('PayoutStarted', { payout_id: 'pay-r', registration_id: 'r', event_id: 'e1', beneficiary: 'a.testnet', amount: '05000000' })])[0]), 'canonical u128');

  // Unknown FINANCIAL event must fail closed, never downgrade to provenance.
  expectThrow('ADVERSARIAL_UNKNOWN_FINANCIAL_FAILCLOSED', () => classifyEvent(parseShowStakeLogs([log('AutoClaim', { event_id: 'e1' })])[0]), 'unsupported showstake event');

  check('PROJECT_MAP_FORFEITED_TO_ZERO', mapFinancialStatus('Forfeited') === 'ZERO' && mapFinancialStatus('Claimable') === 'CLAIMABLE' && mapFinancialStatus('Paid') === 'PAID', 'FinancialStatus->payout_state map (Forfeited->ZERO)', mapFinancialStatus('Forfeited'));
  const totals = parseTotalsView({ event_id: 'e1', state: 'Settled', accepted_principal: '10000000', paid: '5000000', pending: '0', liability: '5000000' });
  check('PROJECT_PARSE_TOTALS', totals.accepted_principal === '10000000' && totals.liability === '5000000', 'get_event_totals parsed', totals.accepted_principal);
  const st = parseSettlementView({ event_id: 'e1', state: 'Settled', attendance_frozen: true, attendee_count: 2, no_show_count: 3, registrations: 5, pool: '6000000', base_share: '3000000', remainder: '0', allocated_total: '10000000', complete: true, claims_enabled: true });
  check('PROJECT_PARSE_SETTLEMENT', st.complete === true && st.base_share === '3000000' && st.claims_enabled === true, 'get_settlement parsed', st.base_share);
  const pv = parsePayoutView({ payout_id: 'pay-r0-1', registration_id: 'r0', event_id: 'e1', beneficiary: 'a.testnet', amount: '5000000', state: 'Succeeded' });
  check('PROJECT_PARSE_PAYOUT', pv.state === 'Succeeded' && pv.amount === '5000000', 'get_payout parsed', pv.state);
  expectThrow('PROJECT_PARSE_TOTALS_BAD', () => parseTotalsView({ event_id: 'e1', state: 'Settled', accepted_principal: '10000000', paid: '5000000', pending: '0', liability: '05000000' }), 'canonical u128');
}

// Final fail-closed summary: any failure exits non-zero (never a green exit0
// that des.!== complete inventory).
const failed = results.filter((r) => !r.ok);
const REQUIRED = 82;
console.log(`\nverify-worker-fixtures: ${results.length - failed.length}/${results.length} passed`);
if (results.length < REQUIRED) {
  console.error(`verify-worker-fixtures FAILED: incomplete inventory (${results.length} < ${REQUIRED})`);
  process.exit(1);
}
process.exit(failed.length === 0 ? 0 : 1);
