CREATE TABLE direct_event_refs (
 id uuid PRIMARY KEY, deployment_id uuid NOT NULL REFERENCES deployments(id),
 chain_event_id text NOT NULL CHECK(length(chain_event_id) BETWEEN 1 AND 128),
 UNIQUE(deployment_id,chain_event_id)
);
CREATE TABLE direct_qr_challenges (
 id uuid PRIMARY KEY, event_ref_id uuid NOT NULL REFERENCES direct_event_refs(id),
 owner_binding_id uuid NOT NULL REFERENCES wallet_bindings(id), nonce_hash text NOT NULL UNIQUE,
 chain_pass_id text NOT NULL, chain_registration_id text NOT NULL, code_hash text NOT NULL,
 issued_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 used_at timestamptz, CHECK(expires_at > issued_at AND expires_at <= issued_at + interval '60 seconds')
);
CREATE TABLE direct_checkin_requests (
 id uuid PRIMARY KEY, challenge_id uuid NOT NULL UNIQUE REFERENCES direct_qr_challenges(id),
 organizer_binding_id uuid NOT NULL REFERENCES wallet_bindings(id),
 status text NOT NULL CHECK(status='PENDING_SIGNATURE'), created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE direct_content_resources (
 id uuid PRIMARY KEY, event_ref_id uuid NOT NULL REFERENCES direct_event_refs(id),
 uploader_binding_id uuid NOT NULL REFERENCES wallet_bindings(id), object_key uuid NOT NULL UNIQUE,
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), mime_type text NOT NULL, title text NOT NULL,
 bytes_size integer NOT NULL CHECK(bytes_size BETWEEN 1 AND 524288), published_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON direct_event_refs,direct_qr_challenges,direct_checkin_requests,direct_content_resources FROM PUBLIC, showstake_api, showstake_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON direct_event_refs,direct_qr_challenges,direct_checkin_requests,direct_content_resources TO showstake_api;
