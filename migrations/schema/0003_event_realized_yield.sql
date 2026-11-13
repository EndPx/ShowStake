-- Keep accepted principal distinct from realized yield in observational totals.
-- Existing zero-yield rows retain the same conservation equation.
ALTER TABLE events_projection
  ADD COLUMN realized_yield_atomic atomic_amount NOT NULL DEFAULT 0;

-- The immutable 0001 baseline names its original four-column balance check here.
ALTER TABLE events_projection DROP CONSTRAINT events_projection_check2;
ALTER TABLE events_projection ADD CONSTRAINT events_projection_balance_with_yield
  CHECK (
    accepted_atomic + realized_yield_atomic <= 340282366920938463463374607431768211455
    AND accepted_atomic + realized_yield_atomic = paid_atomic + pending_atomic + liability_atomic
  );
