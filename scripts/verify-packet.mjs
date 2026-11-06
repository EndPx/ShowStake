#!/usr/bin/env node
// Read-only packet integrity check (T00/T01 foundation).
// Compares the baseline planning files under docs/planning/showstake-v2/ against the
// SHA-256 hashes recorded in docs/evidence/bootstrap.json. Never writes to any file.
// Exits non-zero on a missing file or byte drift, never merely "prints ready".
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packetDir = join(root, 'docs', 'planning', 'showstake-v2');
const baselinePath = join(root, 'docs', 'evidence', 'bootstrap.json');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
const expected = baseline && baseline.baseline_sha256;
if (!expected || typeof expected !== 'object' || Object.keys(expected).length === 0) {
  console.error('FAIL: docs/evidence/bootstrap.json has no usable baseline_sha256 map');
  process.exit(1);
}

const names = Object.keys(expected).sort();
const results = [];
for (const name of names) {
  let observed = null;
  try { observed = sha256(await readFile(join(packetDir, name))); } catch { /* missing */ }
  results.push({ name, observed, ok: observed === expected[name] });
}

let failures = 0;
for (const r of results) {
  if (r.ok) console.log(`OK   ${r.name}`);
  else if (r.observed === null) { failures++; console.error(`MISSING ${r.name}`); }
  else { failures++; console.error(`DRIFT  ${r.name}\n        expected ${expected[r.name]}\n        observed ${r.observed}`); }
}

console.log(`\nChecked ${results.length} baseline files (read-only).`);
if (failures) {
  console.error(`FAIL: ${failures} baseline file(s) missing or drifted`);
  process.exit(1);
}
console.log('PASS: baseline packet integrity verified (no byte drift).');