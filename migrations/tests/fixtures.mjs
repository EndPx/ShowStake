import { randomUUID as uuid } from 'node:crypto';

// migrations/tests/fixtures.mjs — LABELED design-sample fixtures for T01 tests.
//
// These rows are explicitly NOT product data and are never treated as chain
// evidence. They exist solely to exercise constraint/role/restore/replay paths
// on a disposable cluster. Every row uses a fixed, deterministic UUID so D04
// (dump/restore roundtrip) can compare DB1 and DB2 byte-for-byte.

export const FIX = Object.freeze({
  appUser: '00000000-0000-4000-8000-000000000001',
  bindingParticipant: '00000000-0000-4000-8000-000000000002',
  bindingOrganizer: '00000000-0000-4000-8000-000000000003',
  deployment: '00000000-0000-4000-8000-000000000004',
  event: '00000000-0000-4000-8000-000000000005',
  regActive: '00000000-0000-4000-8000-000000000006',
  regWithdrawn: '00000000-0000-4000-8000-000000000007',
  fundingAttempt: '00000000-0000-4000-8000-000000000008',
  chainEvent: '00000000-0000-4000-8000-000000000009',
  passActive: '00000000-0000-4000-8000-000000000010',
  replayEvent: '00000000-0000-4000-8000-000000000012',
  replayChainEvent: '00000000-0000-4000-8000-000000000013',
});

export const DEPOSIT = '5000000'; // canonical u128 string, 5_000_000 atomic units

// Deterministic replay scenario IDs (D04): the projection is rebuilt from these
// labeled, immutable chain_events and compared to the independent EXPECTED totals.
//
// Canonical Product01 accounting (docs/planning/showstake-v2/01-PRODUCT.md):
//   accepted_principal = successful_payouts + pending_payouts + outstanding_liabilities
//   — and it INCLUDES withdrawn participants. Four deposits of D=5_000_000, one of
//   which withdraws before the cutoff:
//     accepted             = 20_000_000 (all four principals, incl. the withdrawn)
//     active principal     = 15_000_000 (three non-withdrawn registrations)
//     withdrawn refund credit = 5_000_000 (retained, claimable)
//     no payout yet        => paid 0, pending 0, outstanding liability 20_000_000.
export const REPLAY = Object.freeze({
  expectedAccepted: '20000000', // 4 * D (withdrawn credit INCLUDED)
  expectedActive: '15000000', // 3 * D (state <> WITHDRAWN)
  expectedWithdrawnCredit: '5000000', // 1 * D retained refund credit
  expectedPaid: '0',
  expectedPending: '0',
  expectedLiability: '20000000', // accepted - paid - pending
  expectedCommitted: 3,
  expectedWithdrawn: 1,
  event: {
    id: FIX.replayEvent,
    organizer_account: 'bob.testnet',
    asset_contract: 'ft.showstake.testnet',
    deposit_atomic: '5000000',
    capacity: 50,
    reg_open: '2026-11-06T00:00:00Z',
    reg_close: '2026-11-07T00:00:00Z',
    cancel_cutoff: '2026-11-07T12:00:00Z',
    checkin_open: '2026-11-07T12:00:00Z',
    checkin_close: '2026-11-08T12:00:00Z',
    finalize_deadline: '2026-11-09T12:00:00Z',
    state: 'PUBLISHED',
    policy_version: 'policy-1',
    rules_hash: 'rules-hash-1',
  },
  // id, sequence_no, participant, commitment_id, principal_atomic — all D.
  registrations: [
    ['11000000-0000-4000-8000-000000000001', 0, 'replay.alice', 'commit-r1', '5000000'],
    ['11000000-0000-4000-8000-000000000002', 1, 'replay.bob', 'commit-r2', '5000000'],
    ['11000000-0000-4000-8000-000000000003', 2, 'replay.carol', 'commit-r3', '5000000'],
  ],
  withdrawn: ['11000000-0000-4000-8000-000000000004', 3, 'replay.dan', 'commit-r4', '5000000'],
});

/**
 * Load the immutable labeled ledger for the D04 replay scenario. Deletes any
 * prior rows for this event first (fresh start), then inserts JUST the
 * chain_events source. Projection rows are NOT seeded here — the replay rebuilds
 * them from chain_events. Returns the receipts used so the test can assert the
 * ledger rejects a duplicate receipt (23505).
 */
export async function seedReplayLedger(client) {
  const ev = REPLAY.event;
  // Fresh: remove prior replay rows (registrations, event projection, chain events).
  await client.query('DELETE FROM registrations_projection WHERE event_id = $1', [FIX.replayEvent]);
  await client.query('DELETE FROM events_projection WHERE id = $1', [FIX.replayEvent]);
  await client.query('DELETE FROM chain_events WHERE payload->>\'event_id\' = $1', [String(FIX.replayEvent)]);

  await client.query(
    `INSERT INTO chain_events
       (id, deployment_id, receipt_id, log_index, block_height, block_hash, block_time, event_name, schema_version, payload, ingested_at)
     VALUES ($1, $2, $3, 0, 100, $4, now(), 'EventCreated', 'showstake/1.0.0', $5::jsonb, now())`,
    [uuid(), FIX.deployment, 'receipt-replay-created', '0'.repeat(64), JSON.stringify({
      event_id: ev.id, organizer_account: ev.organizer_account, asset_contract: ev.asset_contract,
      deposit_atomic: ev.deposit_atomic, capacity: ev.capacity, reg_open: ev.reg_open, reg_close: ev.reg_close,
      cancel_cutoff: ev.cancel_cutoff, checkin_open: ev.checkin_open, checkin_close: ev.checkin_close,
      finalize_deadline: ev.finalize_deadline, state: ev.state, policy_version: ev.policy_version,
      rules_hash: ev.rules_hash,
    })],
  );

  const receipts = new Set(['receipt-replay-created']);
  let height = 101;
  for (const [rid, seq, participant, commitment, principal] of REPLAY.registrations) {
    const receipt = `receipt-replay-${rid.slice(-4)}`;
    receipts.add(receipt);
    await client.query(
      `INSERT INTO chain_events
         (id, deployment_id, receipt_id, log_index, block_height, block_hash, block_time, event_name, schema_version, payload, ingested_at)
       VALUES ($1, $2, $3, 0, $4, $5, now(), 'RegistrationCommitted', 'showstake/1.0.0', $6::jsonb, now())`,
      [uuid(), FIX.deployment, receipt, height++, '0'.repeat(64), JSON.stringify({
        event_id: ev.id, registration_id: rid, sequence_no: seq, participant, commitment_id: commitment,
        principal_atomic: principal,
      })],
    );
  }
  {
    const [rid, seq, participant, commitment, principal] = REPLAY.withdrawn;
    const receipt = `receipt-replay-${rid.slice(-4)}`;
    receipts.add(receipt);
    await client.query(
      `INSERT INTO chain_events
         (id, deployment_id, receipt_id, log_index, block_height, block_hash, block_time, event_name, schema_version, payload, ingested_at)
       VALUES ($1, $2, $3, 0, $4, $5, now(), 'RegistrationCommitted', 'showstake/1.0.0', $6::jsonb, now())`,
      [uuid(), FIX.deployment, receipt, height++, '0'.repeat(64), JSON.stringify({
        event_id: ev.id, registration_id: rid, sequence_no: seq, participant, commitment_id: commitment,
        principal_atomic: principal,
      })],
    );
    receipts.add('receipt-replay-wd4');
    await client.query(
      `INSERT INTO chain_events
         (id, deployment_id, receipt_id, log_index, block_height, block_hash, block_time, event_name, schema_version, payload, ingested_at)
       VALUES ($1, $2, 'receipt-replay-wd4', 0, $3, $4, now(), 'RegistrationWithdrawn', 'showstake/1.0.0', $5::jsonb, now())`,
      [uuid(), FIX.deployment, height++, '0'.repeat(64), JSON.stringify({ event_id: ev.id, registration_id: rid })],
    );
  }
  return receipts;
}

/**
 * Insert the minimal, FK-satisfying base dataset as the superuser. Idempotent:
 * it deletes prior fixture rows (by fixed PK) first so a rerun is safe. Money is
 * authored as canonical strings; participant==beneficiary (immutable rule).
 */
export async function seedBase(client) {
  // Reset ALL application tables (never schema_migrations, which stays applied)
  // so re-runs are idempotent even after earlier D-groups injected extra rows
  // that reference these fixtures. Superuser TRUNCATE; children are listed with
  // their parents so no FK is violated.
  await client.query(`TRUNCATE TABLE
    passes_projection, payouts_projection, checkin_requests, qr_challenges,
    registrations_projection, chain_events, funding_quotes, funding_attempts,
    event_content_versions, events_projection, event_drafts, protected_resources,
    outbox_jobs, idempotency_keys, worker_cursors, audit_records, sessions,
    auth_challenges, wallet_bindings, auth_identities, app_users, deployments`);

  await client.query(
    'INSERT INTO app_users (id, created_at) VALUES ($1, $2)',
    [FIX.appUser, '2026-11-06T00:00:00Z'],
  );
  await client.query(
    "INSERT INTO auth_identities (id, user_id, provider, subject, verified_at) VALUES ($1,$2,'google','sub-google-1',$3)",
    [FIX.appUser, FIX.appUser, '2026-11-06T00:00:00Z'],
  );
  const bindingRows = [
    [FIX.bindingParticipant, FIX.appUser, 'near', 'testnet', 'alice.testnet', 'participant'],
    [FIX.bindingOrganizer, FIX.appUser, 'near', 'testnet', 'bob.testnet', 'organizer'],
  ];
  for (const [id, userId, ns, net, acct, kind] of bindingRows) {
    await client.query(
      'INSERT INTO wallet_bindings (id, user_id, namespace, network, account_id, wallet_kind, verified_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, userId, ns, net, acct, kind, '2026-11-06T00:00:00Z'],
    );
  }
  await client.query(
    "INSERT INTO deployments (id, environment, network, contract_id, ft_contract_id, ft_decimals, start_block, code_hash) VALUES ($1,'testnet','testnet','escrow.showstake.testnet','ft.showstake.testnet',6,1,$2)",
    [FIX.deployment, '0'.repeat(64)],
  );
  await client.query(
    `INSERT INTO events_projection
       (id, deployment_id, chain_event_id, organizer_account, asset_contract, deposit_atomic,
        capacity, reg_open, reg_close, cancel_cutoff, checkin_open, checkin_close, finalize_deadline,
        state, policy_version, rules_hash, accepted_atomic, paid_atomic, pending_atomic, liability_atomic,
        observed_at, projection_version)
     VALUES ($1,$2,'evt-0001','bob.testnet','ft.showstake.testnet','5000000',
        50, '2026-11-06T00:00:00Z','2026-11-07T00:00:00Z','2026-11-07T12:00:00Z',
        '2026-11-07T12:00:00Z','2026-11-08T12:00:00Z','2026-11-09T12:00:00Z',
        -- accepted=5_000_000, paid=0, pending=0, liability=5_000_000 (no payout yet:
        -- outstanding liability, NOT "all cash held as pending").
        'PUBLISHED','policy-1','rules-hash-1','5000000','0','0','5000000',
        '2026-11-06T00:00:00Z', 0)`,
    [FIX.event, FIX.deployment],
  );
  const regs = [
    [FIX.regActive, 'reg-0001', 0, 'commit-0', 'COMMITTED', FIX.event],
  ];
  for (const [id, chainReg, seq, commit, state, eventId] of regs) {
    await client.query(
      `INSERT INTO registrations_projection
         (id, event_id, chain_registration_id, sequence_no, participant_account, beneficiary_account,
          commitment_id, principal_atomic, state, attended, claim_atomic, payout_state, observed_at)
       VALUES ($1,$2,$3,$4,'alice.testnet','alice.testnet',$5,'5000000',$6,false,0,'NOT_CLAIMABLE','2026-11-06T00:00:00Z')`,
      [id, eventId, chainReg, seq, commit, state],
    );
  }
  await client.query(
    `INSERT INTO funding_attempts
       (id, user_id, event_id, near_binding_id, source_binding_id, commitment_id, source_chain, source_asset,
        destination_asset, participant_account, expected_atomic, state, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$4,'commit-fund-1','ethereum','0xasset','ft.showstake.testnet','alice.testnet','5000000','CREATED','2026-11-06T00:00:00Z','2026-11-06T00:00:00Z')`,
    [FIX.fundingAttempt, FIX.appUser, FIX.event, FIX.bindingParticipant],
  );
}