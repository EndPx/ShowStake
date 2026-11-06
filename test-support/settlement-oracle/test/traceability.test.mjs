import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ACCEPTANCE_MAP, NOT_RUN } from '../acceptance-map.mjs';
import { CITATIONS, OPEN_GATES } from '../src/policy.mjs';
import { ORACLE_DIR, PACKET_ROOT, ROOT, readTraceability } from './helpers.mjs';

const LEVELS = new Set(['PASS_LOCAL', 'PARTIAL_LOCAL', 'NOT_RUN']);
const citationIds = new Set(CITATIONS.map((citation) => citation.id));

test('traceability covers all required acceptance IDs exactly once', () => {
  const required = [
    'F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07', 'F08',
    'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07',
    'D02', 'D05', 'E02', 'E03',
  ];
  const ids = ACCEPTANCE_MAP.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate acceptance id');
  for (const id of required) assert.equal(ids.includes(id), true, `missing acceptance ${id}`);
});

test('every acceptance entry declares a valid level, tests and known citations', () => {
  for (const entry of ACCEPTANCE_MAP) {
    assert.equal(LEVELS.has(entry.level), true, `${entry.id}: bad level ${entry.level}`);
    assert.ok(Array.isArray(entry.tests) && entry.tests.length > 0, `${entry.id}: no tests`);
    for (const testRef of entry.tests) {
      assert.equal(typeof testRef, 'string');
      assert.ok(testRef.includes('.test.mjs > '), `${entry.id}: test reference must name file and test: ${testRef}`);
    }
    assert.ok(Array.isArray(entry.citations) && entry.citations.length > 0, `${entry.id}: no citations`);
    for (const citation of entry.citations) {
      assert.equal(citationIds.has(citation), true, `${entry.id}: unknown citation ${citation}`);
    }
  }
  assert.ok(NOT_RUN.some((line) => line.includes('NEAR contract')));
});

test('open gates are all referenced by the human traceability matrix', () => {
  const traceability = readTraceability();
  for (const gate of OPEN_GATES) assert.ok(traceability.includes(gate.id), `traceability missing ${gate.id}`);
  for (const entry of ACCEPTANCE_MAP) assert.ok(traceability.includes(`| ${entry.id} |`), `traceability missing row ${entry.id}`);
});

test('README contains the runnable command and the non-authority label', () => {
  const readmePath = resolve(ORACLE_DIR, 'README.md');
  assert.equal(existsSync(readmePath), true);
  const readme = readFileSync(readmePath, 'utf8');
  assert.ok(readme.includes('node oracle/scripts/run-oracle.mjs'));
  assert.ok(readme.includes('LOCAL TEST ORACLE'));
  assert.ok(readme.includes('NEAR contract tests = NOT_RUN') || readme.includes('NEAR contract'));
  assert.ok(readme.includes('OG-01') && readme.includes('OG-08'));
});

test('all oracle source and packet reference files exist', () => {
  for (const file of ['src/errors.mjs', 'src/atomic.mjs', 'src/policy.mjs', 'src/settlement.mjs', 'src/engine.mjs', 'src/index.mjs', 'acceptance-map.mjs']) {
    assert.equal(existsSync(resolve(ORACLE_DIR, file)), true, file);
  }
  for (const file of ['01-PRODUCT.md', '02-ARCHITECTURE.md', '03-DATABASE.md', '05-EXECUTION-AND-TESTS.md', '06-DECISIONS-AND-SOURCES.md', 'schema.sql']) {
    assert.equal(existsSync(resolve(PACKET_ROOT, 'docs/planning/showstake-v2', file)), true, file);
  }
});
