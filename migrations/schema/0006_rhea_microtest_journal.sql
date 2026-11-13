-- App-side one-time approval journal. It never grants custody or changes escrow
-- state; every funded action still needs the treasury wallet's signature.
CREATE TABLE rhea_microtest_runs (
  approval_id uuid PRIMARY KEY,
  treasury_account text NOT NULL,
  network text NOT NULL CHECK (network = 'mainnet'),
  plan_hash text NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  native_reserved_atomic atomic_amount NOT NULL DEFAULT 0,
  usdc_reserved_atomic atomic_amount NOT NULL DEFAULT 0,
  journal jsonb NOT NULL CHECK (jsonb_typeof(journal) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON rhea_microtest_runs FROM PUBLIC, showstake_api, showstake_worker;
GRANT SELECT, INSERT, UPDATE ON rhea_microtest_runs TO showstake_api;
