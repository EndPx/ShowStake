import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  ORACLE_DIR,
  ROOT,
  findUp,
  readTraceability,
  resolvePacketRoot,
  resolveTraceabilityPath,
} from './helpers.mjs';

test('findUp locates a marker from a relocated nested package without fixed parent depth', () => {
  const temp = mkdtempSync(join(tmpdir(), 'showstake-oracle-paths-'));
  try {
    const repo = join(temp, 'repo');
    const nested = join(repo, 'tests', 'settlement-oracle');
    mkdirSync(join(repo, 'docs', 'planning', 'showstake-v2'), { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(repo, 'docs', 'planning', 'showstake-v2', '01-PRODUCT.md'), '# fixture\n', 'utf8');
    assert.equal(findUp(nested, 'docs/planning/showstake-v2/01-PRODUCT.md'), repo);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('resolvePacketRoot honours an explicit packet root instead of parent-depth assumptions', () => {
  const temp = mkdtempSync(join(tmpdir(), 'showstake-oracle-explicit-'));
  const previous = process.env.SHOWSTAKE_PACKET_ROOT;
  try {
    mkdirSync(join(temp, 'docs', 'planning', 'showstake-v2'), { recursive: true });
    writeFileSync(join(temp, 'docs', 'planning', 'showstake-v2', '01-PRODUCT.md'), '# fixture\n', 'utf8');
    process.env.SHOWSTAKE_PACKET_ROOT = temp;
    assert.equal(resolvePacketRoot(), resolve(temp));
  } finally {
    if (previous === undefined) delete process.env.SHOWSTAKE_PACKET_ROOT;
    else process.env.SHOWSTAKE_PACKET_ROOT = previous;
    rmSync(temp, { recursive: true, force: true });
  }
});

test('canonical traceability lives with the package, not only in ignored docs/evidence', () => {
  const canonical = resolve(ORACLE_DIR, 'TRACEABILITY.md');
  assert.equal(existsSync(canonical), true, 'oracle/TRACEABILITY.md must ship with the package');
  assert.equal(resolveTraceabilityPath(), canonical);
  const text = readTraceability();
  assert.ok(text.includes('Codex round-1'));
  assert.ok(text.includes('settlement-oracle-runs'));
  const legacy = resolve(ROOT, 'docs/evidence/settlement-oracle-traceability.md');
  if (existsSync(legacy)) {
    assert.equal(text, readFileSync(legacy, 'utf8'), 'legacy delivery copy must match canonical');
  }
});

test('README documents relocation, explicit roots and unique runs', () => {
  const readme = readFileSync(resolve(ORACLE_DIR, 'README.md'), 'utf8');
  assert.ok(readme.includes('--packet-root'));
  assert.ok(readme.includes('settlement-oracle-runs'));
  assert.ok(readme.includes('oracle/TRACEABILITY.md'));
  assert.ok(readme.includes('worker attribution'));
});
