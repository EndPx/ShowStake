#!/usr/bin/env node
// Fail-closed T01 phase-aggregation regressions (pure, no DB, no network).
//
// Proves that the aggregate step returns a non-zero classifier for every review
// defect: a missing phase file, a phase from a previous run, a phase that threw
// before recording, invalid JSON, a phase with no checks array, and a pg_dump
// failure — and that only a complete, matching, green run is PASS_LOCAL. A smoke
// run (no dump) is labeled NOT_RUN, never PASS_LOCAL.
import { selfTest } from '../migrations/tests/aggregate.mjs';
import { tmpdir } from 'node:os';

const failures = await selfTest(tmpdir());
if (failures) {
  console.error(`\n${failures} aggregate regression(s) failed`);
  process.exit(1);
}
console.log('\nPASS: T01 aggregate is fail-closed (missing/stale/invalid/empty/failed/static/checksum/cleanup/orchestration all non-zero).');
process.exit(0);