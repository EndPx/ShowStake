-- Funding may precede event selection; retain the foreign key when present.
ALTER TABLE funding_attempts ALTER COLUMN event_id DROP NOT NULL;
ALTER TABLE funding_attempts ADD CONSTRAINT funding_registration_requires_event
 CHECK (registration_id IS NULL OR event_id IS NOT NULL);
-- Provider status is observational and does not confer registration or payout rights.
ALTER TABLE funding_attempts ADD COLUMN provider_status text CHECK (provider_status IN ('PENDING_DEPOSIT','KNOWN_DEPOSIT_TX','PROCESSING','SUCCESS','REFUNDED','FAILED','INCOMPLETE_DEPOSIT')),
 ADD COLUMN provider_status_observed_at timestamptz,
 ADD CONSTRAINT funding_provider_status_pair CHECK ((provider_status IS NULL) = (provider_status_observed_at IS NULL));
