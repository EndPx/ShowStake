-- Preserve finalized contract rule metadata separately from editable app content.
ALTER TABLE events_projection
  ADD COLUMN onchain_title text,
  ADD COLUMN onchain_location text,
  ADD COLUMN onchain_rules_text text,
  ADD CONSTRAINT event_onchain_title_size
    CHECK (onchain_title IS NULL OR octet_length(onchain_title) BETWEEN 1 AND 256),
  ADD CONSTRAINT event_onchain_location_size
    CHECK (onchain_location IS NULL OR octet_length(onchain_location) BETWEEN 1 AND 512),
  ADD CONSTRAINT event_onchain_rules_size
    CHECK (onchain_rules_text IS NULL OR octet_length(onchain_rules_text) BETWEEN 1 AND 8192);
