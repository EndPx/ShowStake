-- ShowStake migration 0001 — initial schema (baseline-derived).
--
-- Provenance: the DDL body below (everything after the MARKER line) is the
-- VERBATIM statement list from docs/planning/showstake-v2/schema.sql, which is
-- preserved byte-for-byte and is NOT edited by the migration process. The only
-- transformation is that the baseline file's wrapping `BEGIN;` / `COMMIT;` and
-- its one-line header comment are removed, because the migration runner wraps
-- each migration in its own transaction (and records the checksum).
--
--   source file:               docs/planning/showstake-v2/schema.sql
--   source sha256:             0e6afec55017ef15da3ab73f3a44ae23bca45c89856b268154a6cf45bc14c822
--   equivalence:               migrations/verify-baseline.mjs asserts the DDL
--                              body below matches the baseline DDL body exactly.
--
-- no-edit: this table list is the candidate DDL only. Apply to a disposable DB.

-- MARKER: baseline-derived DDL (verbatim) ------------------------------------
-- Unconstrained numeric plus integer check avoids silently rounding fractions.
CREATE DOMAIN atomic_amount AS numeric
 CHECK(VALUE = trunc(VALUE) AND VALUE >= 0 AND VALUE <= 340282366920938463463374607431768211455);
CREATE TABLE app_users(id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE auth_identities(
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES app_users(id),
 provider text NOT NULL,subject text NOT NULL,verified_at timestamptz NOT NULL,
 UNIQUE(provider,subject));
CREATE TABLE wallet_bindings(
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES app_users(id),
 namespace text NOT NULL,network text NOT NULL,account_id text NOT NULL,
 wallet_kind text NOT NULL,verified_at timestamptz NOT NULL,disabled_at timestamptz,
 UNIQUE(namespace,network,account_id));
CREATE TABLE auth_challenges(
 id uuid PRIMARY KEY,nonce_hash text NOT NULL UNIQUE,purpose text NOT NULL,
 domain text NOT NULL,network text NOT NULL,account_id text NOT NULL,
 linking_user_id uuid REFERENCES app_users(id),issued_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,consumed_at timestamptz,
 CHECK(expires_at>issued_at));
CREATE TABLE sessions(
 id uuid PRIMARY KEY,token_hash text NOT NULL UNIQUE,user_id uuid NOT NULL REFERENCES app_users(id),
 wallet_binding_id uuid REFERENCES wallet_bindings(id),created_at timestamptz NOT NULL,
 last_seen_at timestamptz NOT NULL,idle_expires_at timestamptz NOT NULL,
 absolute_expires_at timestamptz NOT NULL,revoked_at timestamptz,
 CHECK(idle_expires_at<=absolute_expires_at));
CREATE TABLE deployments(
 id uuid PRIMARY KEY,environment text NOT NULL CHECK(environment IN('local','testnet','mainnet')),
 network text NOT NULL,contract_id text NOT NULL,ft_contract_id text NOT NULL,
 ft_decimals smallint NOT NULL CHECK(ft_decimals BETWEEN 0 AND 38),
 start_block numeric(20,0) NOT NULL,code_hash text NOT NULL,
 UNIQUE(network,contract_id));
CREATE TABLE event_drafts(
 id uuid PRIMARY KEY,owner_user_id uuid NOT NULL REFERENCES app_users(id),
 organizer_binding_id uuid NOT NULL REFERENCES wallet_bindings(id),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 body jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE events_projection(
 id uuid PRIMARY KEY,deployment_id uuid NOT NULL REFERENCES deployments(id),
 chain_event_id text NOT NULL,organizer_account text NOT NULL,
 asset_contract text NOT NULL,deposit_atomic atomic_amount NOT NULL CHECK(deposit_atomic>0),
 capacity integer NOT NULL CHECK(capacity BETWEEN 1 AND 200),
 reg_open timestamptz NOT NULL,reg_close timestamptz NOT NULL,cancel_cutoff timestamptz NOT NULL,
 checkin_open timestamptz NOT NULL,checkin_close timestamptz NOT NULL,finalize_deadline timestamptz NOT NULL,
 state text NOT NULL CHECK(state IN('PUBLISHED','ATTENDANCE_FINALIZED','SETTLING','SETTLED','CANCELLED','REFUND_ONLY')),
 policy_version text NOT NULL,rules_hash text NOT NULL,
 accepted_atomic atomic_amount NOT NULL DEFAULT 0,paid_atomic atomic_amount NOT NULL DEFAULT 0,
 pending_atomic atomic_amount NOT NULL DEFAULT 0,liability_atomic atomic_amount NOT NULL DEFAULT 0,
 observed_at timestamptz NOT NULL,projection_version bigint NOT NULL DEFAULT 0,
 UNIQUE(deployment_id,chain_event_id),
 CHECK(reg_open<reg_close AND reg_close<=cancel_cutoff AND cancel_cutoff<=checkin_open AND checkin_open<checkin_close),
 CHECK(finalize_deadline=checkin_close+interval '24 hours'),
 CHECK(accepted_atomic=paid_atomic+pending_atomic+liability_atomic));
CREATE INDEX events_list_idx ON events_projection(state,reg_open,id);
CREATE TABLE event_content_versions(
 id uuid PRIMARY KEY,event_id uuid REFERENCES events_projection(id),draft_id uuid REFERENCES event_drafts(id),
 revision integer NOT NULL CHECK(revision>0),author_user_id uuid NOT NULL REFERENCES app_users(id),
 title text NOT NULL,description text NOT NULL,venue text NOT NULL,venue_timezone text NOT NULL,
 cover_object_key text,created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((event_id IS NOT NULL) <> (draft_id IS NOT NULL)));
CREATE UNIQUE INDEX content_event_revision ON event_content_versions(event_id,revision) WHERE event_id IS NOT NULL;
CREATE UNIQUE INDEX content_draft_revision ON event_content_versions(draft_id,revision) WHERE draft_id IS NOT NULL;
CREATE TABLE registrations_projection(
 id uuid PRIMARY KEY,event_id uuid NOT NULL REFERENCES events_projection(id),chain_registration_id text NOT NULL,
 sequence_no bigint NOT NULL CHECK(sequence_no>=0),participant_account text NOT NULL,beneficiary_account text NOT NULL,
 commitment_id text NOT NULL,principal_atomic atomic_amount NOT NULL,
 state text NOT NULL CHECK(state IN('COMMITTED','WITHDRAWN','ATTENDED','NO_SHOW','REFUNDABLE')),
 attended boolean NOT NULL DEFAULT false,claim_atomic atomic_amount NOT NULL DEFAULT 0,
 payout_state text NOT NULL CHECK(payout_state IN('NOT_CLAIMABLE','CLAIMABLE','PENDING','PAID','ZERO')),
 observed_at timestamptz NOT NULL,
 UNIQUE(event_id,chain_registration_id),UNIQUE(event_id,sequence_no),
 UNIQUE(event_id,participant_account,commitment_id),
 CHECK(participant_account=beneficiary_account));
CREATE UNIQUE INDEX one_active_registration ON registrations_projection(event_id,participant_account) WHERE state<>'WITHDRAWN';
CREATE INDEX registrations_claims_idx ON registrations_projection(beneficiary_account,payout_state,id);
CREATE TABLE passes_projection(
 id uuid PRIMARY KEY,registration_id uuid NOT NULL UNIQUE REFERENCES registrations_projection(id),
 deployment_id uuid NOT NULL REFERENCES deployments(id),pass_id text NOT NULL,owner_account text NOT NULL,
 issued_at timestamptz NOT NULL,observed_at timestamptz NOT NULL,metadata jsonb NOT NULL DEFAULT '{}',
 UNIQUE(deployment_id,pass_id));
CREATE TABLE payouts_projection(
 id uuid PRIMARY KEY,registration_id uuid NOT NULL REFERENCES registrations_projection(id),
 payout_id text NOT NULL,recipient_account text NOT NULL,amount_atomic atomic_amount NOT NULL,
 state text NOT NULL CHECK(state IN('PENDING','SUCCEEDED','FAILED')),receipt_id text,observed_at timestamptz NOT NULL,
 UNIQUE(registration_id,payout_id));
CREATE UNIQUE INDEX one_pending_payout ON payouts_projection(registration_id) WHERE state='PENDING';
CREATE TABLE funding_attempts(
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES app_users(id),event_id uuid NOT NULL REFERENCES events_projection(id),
 near_binding_id uuid NOT NULL REFERENCES wallet_bindings(id),source_binding_id uuid REFERENCES wallet_bindings(id),
 commitment_id text NOT NULL UNIQUE,source_chain text,source_asset text,destination_asset text NOT NULL,
 participant_account text NOT NULL,expected_atomic atomic_amount NOT NULL,
 state text NOT NULL CHECK(state IN('CREATED','QUOTED','SOURCE_PENDING','SWAP_SETTLED','READY_TO_COMMIT','COMMIT_PENDING','COMMITTED','EXPIRED','FAILED','PROVIDER_REFUNDED','ACTION_REQUIRED','UNKNOWN')),
 source_tx_hash text,commit_tx_hash text,registration_id uuid REFERENCES registrations_projection(id),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX funding_owner_idx ON funding_attempts(user_id,created_at DESC,id);
CREATE TABLE funding_quotes(
 id uuid PRIMARY KEY,attempt_id uuid NOT NULL REFERENCES funding_attempts(id),provider text NOT NULL,
 provider_quote_id text,deposit_address text,deposit_memo text,expires_at timestamptz NOT NULL,
 input_atomic atomic_amount NOT NULL,expected_output_atomic atomic_amount NOT NULL,
 minimum_output_atomic atomic_amount NOT NULL,validated_payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE qr_challenges(
 id uuid PRIMARY KEY,registration_id uuid NOT NULL REFERENCES registrations_projection(id),
 nonce_hash text NOT NULL UNIQUE,owner_account text NOT NULL,key_id text NOT NULL,
 issued_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,consumed_at timestamptz,
 CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '60 seconds'));
CREATE TABLE checkin_requests(
 id uuid PRIMARY KEY,registration_id uuid NOT NULL REFERENCES registrations_projection(id),
 qr_challenge_id uuid UNIQUE REFERENCES qr_challenges(id),organizer_account text NOT NULL,
 manual_reason text,state text NOT NULL CHECK(state IN('PROPOSED','SUBMITTED','CONFIRMED','FAILED','EXPIRED')),
 tx_hash text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(qr_challenge_id IS NOT NULL OR (manual_reason IS NOT NULL AND length(trim(manual_reason))>0)));
CREATE TABLE protected_resources(
 id uuid PRIMARY KEY,event_id uuid NOT NULL REFERENCES events_projection(id),object_key text NOT NULL UNIQUE,
 title text NOT NULL,mime_type text NOT NULL,bytes_size bigint NOT NULL CHECK(bytes_size>=0),
 published_at timestamptz,deleted_at timestamptz);
CREATE TABLE chain_events(
 id uuid PRIMARY KEY,deployment_id uuid NOT NULL REFERENCES deployments(id),receipt_id text NOT NULL,
 log_index integer NOT NULL CHECK(log_index>=0),block_height numeric(20,0) NOT NULL,
 block_hash text NOT NULL,block_time timestamptz NOT NULL,event_name text NOT NULL,
 schema_version text NOT NULL,payload jsonb NOT NULL,ingested_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(deployment_id,receipt_id,log_index));
CREATE INDEX chain_replay_idx ON chain_events(deployment_id,block_height,id);
CREATE TABLE worker_cursors(
 deployment_id uuid NOT NULL REFERENCES deployments(id),consumer text NOT NULL,
 cursor_value jsonb NOT NULL,updated_at timestamptz NOT NULL,PRIMARY KEY(deployment_id,consumer));
CREATE TABLE idempotency_keys(
 scope text NOT NULL,key text NOT NULL,body_hash text NOT NULL,result_reference text,
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,PRIMARY KEY(scope,key));
CREATE TABLE outbox_jobs(
 id uuid PRIMARY KEY,kind text NOT NULL,dedupe_key text NOT NULL UNIQUE,payload jsonb NOT NULL,
 state text NOT NULL CHECK(state IN('READY','RUNNING','DONE','FAILED')),
 run_at timestamptz NOT NULL,lease_until timestamptz,attempts integer NOT NULL DEFAULT 0,
 last_error_code text,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX jobs_ready_idx ON outbox_jobs(state,run_at,id);
CREATE TABLE audit_records(
 id uuid PRIMARY KEY,actor_user_id uuid REFERENCES app_users(id),actor_account text,
 action text NOT NULL,resource_type text NOT NULL,resource_id text NOT NULL,
 request_id text NOT NULL,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());