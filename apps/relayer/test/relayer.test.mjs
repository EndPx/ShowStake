import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, RelayerError, RelayerPlanner, STATES, planCandidateAction } from '../index.mjs';

const provider = {
  providerName: 'Rhea local mock', verified: true, network: 'near-testnet', usdcAccount: 'usdc.mock',
  lendingAccount: 'rhea.mock', codeHash: 'sha256:local-only', abiRevision: 'local-mock-v1', receiptAsset: 'receipt.mock',
  methods: { supply: 'mock_supply', redeem: 'mock_redeem' }
};
test('candidate planner is a pinned, no-broadcast proposal with pause and lifecycle gates', () => {
 const s={contractId:'showstake-mainnet-escrow-endpx-2026.near',codeHash:'CpnhymSeF785ZBVTaBZfW8ApsfMVUByNCrys8R2i8os',policyVersion:'showstake-native-usdc-rhea-review/1',finalized:true,stale:false,control:{paused:true,principal_cap:'100'},event:{event_id:'e',phase:'RegistrationClosed',earn_state:'NotStarted',accepted_principal:'100',reg_close:10,checkin_close:30,finalize_deadline:40}};
 assert.equal(planCandidateAction(s,20),null);
 assert.deepEqual(planCandidateAction({...s,control:{...s.control,paused:false}},20),{target:s.contractId,method:'trigger_earn_supply',args:{},dryRun:true,broadcasted:false,providerStatus:'UNVERIFIED'});
 assert.equal(planCandidateAction(s,40).method,'activate_timeout_refund');
 assert.equal(planCandidateAction({...s,event:{...s.event,phase:'RefundOnly',earn_state:'Supplied'}},40).method,'trigger_earn_redeem');
 assert.throws(()=>planCandidateAction({...s,stale:true},20),/fresh finalized/);
 assert.throws(()=>planCandidateAction({...s,control:{paused:false,principal_cap:'01'}},20),/canonical/);
});
function planner(options = {}) { return new RelayerPlanner({ provider, baseBackoffMs: 10, maxBackoffMs: 100, ...options }); }
function event(p, id = 'event-a', extra = {}) { return p.registerEvent({ eventId: id, contractId: `escrow.${id}`, registrationCloseMs: 10, startTimeMs: 20, endTimeMs: 30, principalAtomic: '1000', ...extra }); }
function receipt(proposal, status = 'success', extra = {}) { return { eventId: proposal.eventId, action: proposal.action, attempt: proposal.attempt, idempotencyKey: proposal.idempotencyKey, status, observedAtMs: 0, ...(proposal.action === ACTIONS.START_YIELD ? { amountAtomic: '1000' } : {}), ...(proposal.action === ACTIONS.FINISH_REDEEM ? { amountAtomic: '1000' } : {}), ...extra }; }
function complete(p, now, status = 'success') { const proposal = p.plan('event-a', now); assert.ok(proposal); p.applyReceipt(receipt(proposal, status)); return proposal; }

 test('unverified Rhea configuration is a hard gate', () => {
  assert.throws(() => new RelayerPlanner({ provider: { ...provider, verified: false } }), e => e.code === 'PROVIDER_UNVERIFIED');
  assert.throws(() => new RelayerPlanner({ provider: { ...provider, codeHash: '' } }), e => e.code === 'INVALID_CONFIG');
 });

test('early and late boundaries produce the ordered lifecycle', () => {
  const p = planner(); event(p);
  assert.equal(p.plan('event-a', 9), null);
  const close = complete(p, 10); assert.equal(close.action, ACTIONS.CLOSE_REGISTRATION);
  const start = complete(p, 20); assert.equal(start.action, ACTIONS.START_YIELD);
  assert.equal(p.plan('event-a', 29), null);
  const prep = complete(p, 30); assert.equal(prep.action, ACTIONS.PREPARE_REDEEM);
  const finish = complete(p, 30); assert.equal(finish.action, ACTIONS.FINISH_REDEEM);
  const settle = complete(p, 30); assert.equal(settle.action, ACTIONS.FINALIZE_SETTLE);
  assert.equal(p.snapshot('event-a').state, STATES.SETTLEMENT_OPEN);
});

test('one pending action and idempotency key prevent duplicate plans', () => {
  const p = planner(); event(p); const proposal = p.plan('event-a', 10);
  assert.equal(p.plan('event-a', 10), null);
  assert.equal(proposal.idempotencyKey, 'event-a/close_registration/1');
  assert.equal(proposal.call.args.idempotency_key, proposal.idempotencyKey);
});

test('stale and duplicate callbacks are rejected', () => {
  const p = planner(); event(p); const proposal = p.plan('event-a', 10);
  assert.throws(() => p.applyReceipt(receipt(proposal, 'success', { attempt: 99 })), e => e.code === 'STALE_RECEIPT');
  p.applyReceipt(receipt(proposal));
  assert.throws(() => p.applyReceipt(receipt(proposal)), e => e.code === 'STALE_RECEIPT');
});

test('failed action retries with bounded exponential backoff', () => {
  const p = planner({ maxAttempts: 2 }); event(p); const first = p.plan('event-a', 10);
  const failed = p.applyReceipt(receipt(first, 'failed', { observedAtMs: 100 }));
  assert.equal(failed.retryable, true); assert.equal(failed.retryAtMs, 110);
  assert.equal(p.plan('event-a', 109), null);
  const second = p.plan('event-a', 110); assert.equal(second.attempt, 2);
  assert.equal(p.plan('event-a', 111), null);
  p.applyReceipt(receipt(second, 'failed', { observedAtMs: 110 }));
  assert.equal(p.plan('event-a', 1000), null);
});

test('failed supply and redeem callbacks retry without changing event isolation or amount', () => {
  const p = planner({ maxAttempts: 3 }); event(p);
  complete(p, 10);
  const supply = p.plan('event-a', 20);
  p.applyReceipt(receipt(supply, 'failed', { observedAtMs: 0 }));
  const supplyRetry = p.plan('event-a', 9); // backoff is bounded; still too early for retry
  assert.equal(supplyRetry, null);
  const supplyRetryAt = p.plan('event-a', 1000);
  assert.equal(supplyRetryAt.attempt, 2);
  assert.throws(() => p.applyReceipt(receipt(supplyRetryAt, 'success', { amountAtomic: '999' })), e => e.code === 'AMOUNT_MISMATCH');
  p.applyReceipt(receipt(supplyRetryAt, 'success'));
  complete(p, 30);
  const redeem = p.plan('event-a', 30);
  p.applyReceipt(receipt(redeem, 'failed', { observedAtMs: 0 }));
  const redeemRetry = p.plan('event-a', 1000);
  assert.equal(redeemRetry.attempt, 2);
  p.applyReceipt(receipt(redeemRetry, 'success', { amountAtomic: '1100' }));
  assert.equal(p.snapshot('event-a').redeemedAtomic, '1100');
});

test('events are isolated and cannot consume one another receipts', () => {
  const p = planner(); event(p, 'event-a'); event(p, 'event-b');
  const a = p.plan('event-a', 10); const b = p.plan('event-b', 10);
  assert.notEqual(a.idempotencyKey, b.idempotencyKey);
  assert.throws(() => p.applyReceipt({ ...receipt(a), eventId: 'event-b' }), e => e.code === 'STALE_RECEIPT');
  assert.equal(p.snapshot('event-b').state, STATES.REGISTRATION_OPEN);
});

test('redemption cannot run before settlement and dry-run never broadcasts', async () => {
  let broadcasts = 0; const p = planner({ broadcaster: async () => { broadcasts += 1; } }); event(p);
  complete(p, 10); complete(p, 20);
  assert.equal(p.plan('event-a', 29), null);
  const prep = complete(p, 30); assert.equal(prep.call.target, 'escrow.event-a');
  const finish = p.plan('event-a', 30); assert.equal(finish.action, ACTIONS.FINISH_REDEEM);
  assert.equal(finish.call.target, provider.lendingAccount);
  const result = await p.execute(finish); assert.equal(result.broadcasted, false); assert.equal(broadcasts, 0);
  p.applyReceipt(receipt(finish));
  const settle = p.plan('event-a', 30); assert.equal(settle.action, ACTIONS.FINALIZE_SETTLE);
});

test('exact atomic strings are required', () => {
  const p = planner();
  assert.throws(() => event(p, 'bad', { principalAtomic: 1 }), e => e.code === 'INVALID_ATOMIC');
  assert.throws(() => event(p, 'bad2', { principalAtomic: '01' }), e => e.code === 'INVALID_ATOMIC');
});

