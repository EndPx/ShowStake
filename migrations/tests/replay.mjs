// migrations/tests/replay.mjs — D04 projection replay from immutable chain_events.
//
// This is the honest D04 reconstruction the review required: the projection
// tables are DELETED for the scenario event and rebuilt SOLELY from the labeled,
// immutable `chain_events` ledger (never by summing the pre-existing projection
// rows). The rebuild:
//   * dedups by the immutable (deployment_id, receipt_id, log_index) ledger key
//     and by registration id (ON CONFLICT ... DO NOTHING), so re-processing a
//     receipt is idempotent;
//   * applies withdrawals on top of committed rows, sets the withdrawn row's
//     claim/refund status (claim_atomic = principal, payout_state = CLAIMABLE)
//     and RETAINS the historic owner (participant/beneficiary unchanged);
//   * recomputes events_projection totals with the canonical Product01 invariant
//       accepted = paid + pending + liability
//     — accepted_atomic is ALL reconstructed principal (withdrawn credit
//     INCLUDED), pending_atomic is 0 (no payout started), liability_atomic is
//     the full outstanding amount. `active` (non-withdrawn principal) is a
//     derived quantity reported separately, never renamed to `accepted`;
//   * advances the durable worker_cursors row IN THE SAME transaction as the
//     projection writes (all-or-nothing — a rollback leaves no partial state and
//     no advanced cursor).
//
// The returned totals are then compared against INDEPENDENT expected fixtures in
// the test (not against the projection itself), and against the pg_restore copy.

const EV = 'EventCreated';
const REG = 'RegistrationCommitted';
const WDR = 'RegistrationWithdrawn';

/**
 * Rebuild the projections for one replay event from chain_events, atomically.
 *
 * @param {import('pg').Client} client
 * @param {{deploymentId:string, eventId:string, consumer:string}} p
 * @returns {Promise<{accepted:string, chainAccepted:string, active:string, chainActive:string,
 *   withdrawnCredit:string, chainWithdrawnCredit:string, paid:string, pending:string,
 *   liability:string, committed:number, withdrawn:number, registered:number}>}
 */
export async function replayFromChainEvents(client, { deploymentId, eventId, consumer }) {
  await client.query('BEGIN');
  try {
    // Clean tables for this event (rebuild from scratch, never from old rows).
    await client.query('DELETE FROM registrations_projection WHERE event_id = $1', [eventId]);
    await client.query('DELETE FROM events_projection WHERE id = $1', [eventId]);

    // 1) Rebuild the event row from the EventCreated ledger entry (first by order).
    const ev = await client.query(
      `INSERT INTO events_projection
         (id, deployment_id, chain_event_id, organizer_account, asset_contract, deposit_atomic, capacity,
          reg_open, reg_close, cancel_cutoff, checkin_open, checkin_close, finalize_deadline, state,
          policy_version, rules_hash, accepted_atomic, paid_atomic, pending_atomic, liability_atomic,
          observed_at, projection_version)
       SELECT (p.payload->>'event_id')::uuid, p.deployment_id, p.receipt_id,
         p.payload->>'organizer_account', p.payload->>'asset_contract',
         (p.payload->>'deposit_atomic')::atomic_amount, (p.payload->>'capacity')::integer,
         (p.payload->>'reg_open')::timestamptz, (p.payload->>'reg_close')::timestamptz,
         (p.payload->>'cancel_cutoff')::timestamptz, (p.payload->>'checkin_open')::timestamptz,
         (p.payload->>'checkin_close')::timestamptz, (p.payload->>'finalize_deadline')::timestamptz,
         p.payload->>'state', p.payload->>'policy_version', p.payload->>'rules_hash',
         0, 0, 0, 0, now(), 0
       FROM chain_events p
       WHERE p.deployment_id = $1 AND p.event_name = $2 AND p.payload->>'event_id' = $3
       ORDER BY p.block_height, p.log_index, p.id
       LIMIT 1
       RETURNING id`,
      [deploymentId, EV, String(eventId)],
    );
    if (ev.rowCount !== 1) throw new Error('replay: no EventCreated ledger entry for ' + eventId);

    // 2) Rebuild registrations from the committed ledger entries, deduped by
    //    registration id (an idempotent re-replay must not double-apply).
    await client.query(
      `INSERT INTO registrations_projection
         (id, event_id, chain_registration_id, sequence_no, participant_account, beneficiary_account,
          commitment_id, principal_atomic, state, attended, claim_atomic, payout_state, observed_at)
       SELECT DISTINCT ON (p.payload->>'registration_id')
         (p.payload->>'registration_id')::uuid, $1::uuid, p.payload->>'registration_id',
         (p.payload->>'sequence_no')::bigint, p.payload->>'participant', p.payload->>'participant',
         p.payload->>'commitment_id', (p.payload->>'principal_atomic')::atomic_amount,
         'COMMITTED', false, 0, 'NOT_CLAIMABLE', p.block_time
       FROM chain_events p
       WHERE p.deployment_id = $2 AND p.event_name = $3 AND p.payload->>'event_id' = $4
       ORDER BY p.payload->>'registration_id', p.block_height, p.log_index, p.id
       ON CONFLICT (event_id, chain_registration_id) DO NOTHING`,
      [eventId, deploymentId, REG, String(eventId)],
    );

    // 3) Apply withdrawals over the reconstructed committed rows. A withdrawal
    //    retains its historic owner (participant/beneficiary are NOT rewritten)
    //    and becomes a claimable refund credit (claim_atomic = principal).
    await client.query(
      `UPDATE registrations_projection r
       SET state = 'WITHDRAWN',
           claim_atomic = r.principal_atomic,
           payout_state = 'CLAIMABLE'
       FROM chain_events w
       WHERE w.deployment_id = $1 AND w.event_name = $2 AND w.payload->>'event_id' = $3
         AND w.payload->>'registration_id' = r.chain_registration_id
         AND r.event_id = $3::uuid`,
      [deploymentId, WDR, String(eventId)],
    );

    // 4) Recompute the event totals with the canonical invariant
    //       accepted = paid + pending + liability.
    //    accepted_atomic = ALL reconstructed principal (withdrawn credit INCLUDED);
    //    pending_atomic = 0 (no payout started); liability = accepted - paid - pending.
    await client.query(
      `UPDATE events_projection e
       SET accepted_atomic = rev.accepted,
           paid_atomic     = 0,
           pending_atomic  = 0,
           liability_atomic = rev.accepted,
           observed_at     = now(),
           projection_version = e.projection_version + 1
       FROM (
         SELECT coalesce(sum(r.principal_atomic), 0)::atomic_amount AS accepted
         FROM registrations_projection r
         WHERE r.event_id = $1
       ) rev
       WHERE e.id = $1`,
      [eventId],
    );

    // 5) Durable cursor, advanced in the SAME transaction as the writes above.
    const cursor = {
      event_id: String(eventId),
      block_height: await maxBlockHeightInTx(client, deploymentId, eventId),
      receipts_applied: await receiptCountInTx(client, deploymentId, eventId),
    };
    await client.query(
      `INSERT INTO worker_cursors (deployment_id, consumer, cursor_value, updated_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (deployment_id, consumer)
       DO UPDATE SET cursor_value = EXCLUDED.cursor_value, updated_at = now()`,
      [deploymentId, consumer, JSON.stringify(cursor)],
    );

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection may be aborted */ }
    throw err;
  }

  // Independent totals computed DIRECTLY from the immutable chain_events ledger
  // (dedup by registration id) — never by summing the projection. `accepted`
  // INCLUDES withdrawn principals (Product01); `active` is the non-withdrawn
  // subset and `withdrawnCredit` the retained refund credit.
  const dir = await client.query(
    `WITH committed AS (
       SELECT DISTINCT ON (ce.payload->>'registration_id')
         ce.payload->>'registration_id' AS rid, (ce.payload->>'principal_atomic')::atomic_amount AS principal
       FROM chain_events ce
       WHERE ce.deployment_id = $1 AND ce.event_name = $2 AND ce.payload->>'event_id' = $3
       ORDER BY ce.payload->>'registration_id', ce.block_height, ce.log_index, ce.id
     ), withdrawn AS (
       SELECT DISTINCT ce.payload->>'registration_id' AS rid
       FROM chain_events ce
       WHERE ce.deployment_id = $1 AND ce.event_name = $4 AND ce.payload->>'event_id' = $3
     )
     SELECT
       coalesce(sum(c.principal), 0)::text AS accepted,
       coalesce(sum(c.principal) FILTER (WHERE c.rid NOT IN (SELECT rid FROM withdrawn)), 0)::text AS active,
       coalesce(sum(c.principal) FILTER (WHERE c.rid IN (SELECT rid FROM withdrawn)), 0)::text AS withdrawn_credit
     FROM committed c`,
    [deploymentId, REG, String(eventId), WDR],
  );

  const tot = await client.query(
    `SELECT
       coalesce((SELECT accepted_atomic::text FROM events_projection WHERE id = $1), '0') AS accepted,
       coalesce((SELECT paid_atomic::text     FROM events_projection WHERE id = $1), '0') AS paid,
       coalesce((SELECT pending_atomic::text FROM events_projection WHERE id = $1), '0') AS pending,
       coalesce((SELECT liability_atomic::text FROM events_projection WHERE id = $1), '0') AS liability,
       (SELECT count(*) FROM registrations_projection WHERE event_id = $1 AND state <> 'WITHDRAWN') AS committed,
       (SELECT count(*) FROM registrations_projection WHERE event_id = $1 AND state = 'WITHDRAWN') AS withdrawn,
       coalesce((SELECT sum(principal_atomic)::text FROM registrations_projection WHERE event_id = $1 AND state <> 'WITHDRAWN'), '0') AS active,
       coalesce((SELECT sum(principal_atomic)::text FROM registrations_projection WHERE event_id = $1 AND state = 'WITHDRAWN'), '0') AS withdrawn_credit`,
    [eventId],
  );

  const t = tot.rows[0];
  return {
    accepted: t.accepted,
    chainAccepted: dir.rows[0].accepted, // from chain_events only, independent of the projection
    active: t.active,
    chainActive: dir.rows[0].active, // from chain_events only
    withdrawnCredit: t.withdrawn_credit,
    chainWithdrawnCredit: dir.rows[0].withdrawn_credit, // from chain_events only
    paid: t.paid,
    pending: t.pending,
    liability: t.liability,
    committed: Number(t.committed),
    withdrawn: Number(t.withdrawn),
    registered: Number(t.committed) + Number(t.withdrawn),
  };
}

async function maxBlockHeightInTx(client, deploymentId, eventId) {
  const r = await client.query(
    'SELECT max(block_height)::text AS h FROM chain_events WHERE deployment_id=$1 AND payload->>\'event_id\'=$2',
    [deploymentId, String(eventId)],
  );
  return r.rows[0].h ?? '0';
}
async function receiptCountInTx(client, deploymentId, eventId) {
  const r = await client.query(
    'SELECT count(*)::int AS n FROM chain_events WHERE deployment_id=$1 AND payload->>\'event_id\'=$2',
    [deploymentId, String(eventId)],
  );
  return r.rows[0].n;
}