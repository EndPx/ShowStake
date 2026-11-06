-- ShowStake migration 0002 — least-privilege table grants.
--
-- Cluster-level role creation and schema-level grants/revokes are performed by
-- the migration-operator BOOTSTRAP (superuser `showstake`), because the `public`
-- schema is owned by pg_database_owner and only its owner may grant USAGE/CREATE
-- on it. Those steps are recorded and verified by migrations/runner.mjs, not
-- duplicated here. Table OBJECTS are owned by `showstake_migration` (0001 ran as
-- that role), so this migration — which runs as `showstake_migration` — may grant
-- and revoke on them. Roles created by the bootstrap:
--
--   * showstake_migration  — NOLOGIN; owns schema objects.
--   * showstake_api        — NOLOGIN; HTTP API role.
--   * showstake_worker     — NOLOGIN; projection/reconciliation worker role.
--
-- Grants are DML only; runtime roles have no CREATE/TEMP/schema ownership.

-- Belt-and-suspenders: no PUBLIC access to any existing table, ever.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- API role (DML on application-owned tables; read-only on projections).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE sessions, event_drafts, protected_resources TO showstake_api;
GRANT SELECT, INSERT, UPDATE ON TABLE
  app_users, auth_identities, wallet_bindings, auth_challenges, event_content_versions,
  funding_attempts, funding_quotes, qr_challenges, checkin_requests, idempotency_keys,
  audit_records, outbox_jobs
TO showstake_api;

-- API reads configuration + finalized projections, but must never update them.
GRANT SELECT ON TABLE
  deployments, events_projection, registrations_projection, passes_projection, payouts_projection
TO showstake_api;

-- ---------------------------------------------------------------------------
-- Worker role (writes chain events + projections; read-only identity context;
-- narrow column-level observation updates on API-owned tables).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON TABLE
  chain_events, events_projection, registrations_projection, passes_projection,
  payouts_projection, worker_cursors
TO showstake_worker;

-- Identity/lookup context the worker may READ (never write).
GRANT SELECT ON TABLE
  app_users, auth_identities, wallet_bindings, deployments, checkin_requests,
  funding_attempts
TO showstake_worker;

-- Worker consumes outbox jobs (claims leases); it does not enqueue new jobs.
GRANT SELECT, UPDATE ON TABLE outbox_jobs TO showstake_worker;

-- Narrow "funding observation" updates (never an identity/session write).
GRANT UPDATE (state, source_tx_hash, commit_tx_hash, registration_id, updated_at)
  ON TABLE funding_attempts TO showstake_worker;

-- Narrow "check-in confirmation" updates.
GRANT UPDATE (state, tx_hash, updated_at)
  ON TABLE checkin_requests TO showstake_worker;

-- Allow both runtime roles to inspect the applied migration set (read-only).
GRANT SELECT ON TABLE schema_migrations TO showstake_api, showstake_worker;