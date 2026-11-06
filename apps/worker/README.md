# apps/worker — ShowStake projection & reconciliation worker

Planned module: Node TypeScript worker. Ingests finalized contract receipts, maintains
projections/cursors, runs outbox jobs and reconciliation; never logs users in and never
signs financial actions per `docs/planning/showstake-v2/02-ARCHITECTURE.md`.

Status: **placeholder only** (T00/T01 foundation). No polling, projection, or job code yet.