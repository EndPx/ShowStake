-- Earlier projection adapters populated realized_yield_atomic only when yield
-- entered participant allocations. Preserve those allocations while distinguishing
-- all realized yield from funds currently allocated to claims.
ALTER TABLE events_projection
  ADD COLUMN allocated_yield_atomic atomic_amount NOT NULL DEFAULT 0;
UPDATE events_projection SET allocated_yield_atomic = realized_yield_atomic;
ALTER TABLE events_projection DROP CONSTRAINT events_projection_balance_with_yield;
ALTER TABLE events_projection ADD CONSTRAINT events_projection_balance_with_yield
  CHECK (
    allocated_yield_atomic <= realized_yield_atomic
    AND accepted_atomic + realized_yield_atomic <= 340282366920938463463374607431768211455
    AND accepted_atomic + allocated_yield_atomic = paid_atomic + pending_atomic + liability_atomic
  );
