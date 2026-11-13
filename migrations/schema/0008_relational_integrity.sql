-- Keep user, event, deployment and beneficiary references consistent.
-- Existing inconsistent rows abort the enclosing migration transaction.
ALTER TABLE wallet_bindings
  ADD CONSTRAINT wallet_binding_id_user_unique UNIQUE (id, user_id),
  ADD CONSTRAINT wallet_binding_id_user_account_unique UNIQUE (id, user_id, account_id);

ALTER TABLE sessions
  ADD CONSTRAINT session_binding_owner_fk
    FOREIGN KEY (wallet_binding_id, user_id) REFERENCES wallet_bindings(id, user_id);

ALTER TABLE event_drafts
  ADD CONSTRAINT draft_binding_owner_fk
    FOREIGN KEY (organizer_binding_id, owner_user_id) REFERENCES wallet_bindings(id, user_id);

ALTER TABLE deployments
  ADD CONSTRAINT deployment_id_ft_unique UNIQUE (id, ft_contract_id);

ALTER TABLE events_projection
  ADD CONSTRAINT event_id_deployment_unique UNIQUE (id, deployment_id),
  ADD CONSTRAINT event_deployment_asset_fk
    FOREIGN KEY (deployment_id, asset_contract) REFERENCES deployments(id, ft_contract_id);

ALTER TABLE registrations_projection
  ADD CONSTRAINT registration_id_event_unique UNIQUE (id, event_id),
  ADD CONSTRAINT registration_id_participant_unique UNIQUE (id, participant_account),
  ADD CONSTRAINT registration_id_beneficiary_unique UNIQUE (id, beneficiary_account);

ALTER TABLE funding_attempts
  ADD CONSTRAINT funding_near_owner_account_fk
    FOREIGN KEY (near_binding_id, user_id, participant_account)
    REFERENCES wallet_bindings(id, user_id, account_id),
  ADD CONSTRAINT funding_source_owner_fk
    FOREIGN KEY (source_binding_id, user_id) REFERENCES wallet_bindings(id, user_id),
  ADD CONSTRAINT funding_registration_event_fk
    FOREIGN KEY (registration_id, event_id) REFERENCES registrations_projection(id, event_id);

-- Event identity is repeated on passes so composite FKs can bind all three levels.
ALTER TABLE passes_projection ADD COLUMN event_id uuid;
UPDATE passes_projection p SET event_id = r.event_id
  FROM registrations_projection r WHERE r.id = p.registration_id;
ALTER TABLE passes_projection
  ALTER COLUMN event_id SET NOT NULL,
  ADD CONSTRAINT pass_registration_event_fk
    FOREIGN KEY (registration_id, event_id) REFERENCES registrations_projection(id, event_id),
  ADD CONSTRAINT pass_event_deployment_fk
    FOREIGN KEY (event_id, deployment_id) REFERENCES events_projection(id, deployment_id),
  ADD CONSTRAINT pass_registration_owner_fk
    FOREIGN KEY (registration_id, owner_account) REFERENCES registrations_projection(id, participant_account);

ALTER TABLE payouts_projection
  ADD CONSTRAINT payout_registration_recipient_fk
    FOREIGN KEY (registration_id, recipient_account) REFERENCES registrations_projection(id, beneficiary_account);

ALTER TABLE qr_challenges
  ADD CONSTRAINT qr_id_registration_unique UNIQUE (id, registration_id),
  ADD CONSTRAINT qr_registration_owner_fk
    FOREIGN KEY (registration_id, owner_account) REFERENCES registrations_projection(id, participant_account);

ALTER TABLE checkin_requests
  ADD CONSTRAINT checkin_qr_registration_fk
    FOREIGN KEY (qr_challenge_id, registration_id) REFERENCES qr_challenges(id, registration_id);

CREATE INDEX passes_event_deployment_idx ON passes_projection(event_id, deployment_id);
CREATE INDEX qr_registration_idx ON qr_challenges(registration_id);
CREATE INDEX checkin_registration_idx ON checkin_requests(registration_id);
CREATE INDEX funding_registration_event_idx ON funding_attempts(registration_id, event_id)
  WHERE registration_id IS NOT NULL;
