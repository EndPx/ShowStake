// migrations/verify-baseline.mjs — prove migration 0001 is the preserved baseline.
//
// The baseline docs/planning/showstake-v2/schema.sql is authoritative and must not
// be edited. This script asserts:
//   1. the baseline file's sha256 still equals the recorded provenance hash; and
//   2. the DDL body of migration 0001 (after `-- MARKER: ...`) is byte-identical
//      to the baseline DDL body (the statements between `BEGIN;` and `COMMIT;`).
//
// Non-zero exit on any mismatch. This is the machine-checked provenance used by
// T01 evidence (D01) so "preserved baseline" is proven, not asserted.

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(root, 'docs', 'planning', 'showstake-v2', 'schema.sql');
const MIGRATION = join(root, 'migrations', 'schema', '0001_initial.sql');
const RECORDED_SHA = '0e6afec55017ef15da3ab73f3a44ae23bca45c89856b268154a6cf45bc14c822';

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Split into LF-only lines and drop a single trailing newline for a stable diff. */
function normalize(s) {
  return s.replace(/\r\n?/g, '\n').replace(/\n$/, '');
}

function baselineBody(content) {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const begin = lines.findIndex((l) => l.trim() === 'BEGIN;');
  const commit = lines.findIndex((l) => l.trim() === 'COMMIT;');
  if (begin < 0 || commit < 0 || commit <= begin) {
    throw new Error('baseline schema.sql does not contain a BEGIN;/COMMIT; block');
  }
  return normalize(lines.slice(begin + 1, commit).join('\n'));
}

function migrationBody(content) {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const idx = lines.findIndex((l) => l.startsWith('-- MARKER:'));
  if (idx < 0) throw new Error('migration 0001 is missing the DDL marker');
  return normalize(lines.slice(idx + 1).join('\n'));
}

const failures = [];
const baseline = await readFile(BASELINE, 'utf8');
const hash = sha256(Buffer.from(baseline, 'utf8'));
if (hash !== RECORDED_SHA) {
  failures.push(`baseline sha256 ${hash} != recorded ${RECORDED_SHA} (baseline may have drifted)`);
}
try {
  const expected = baselineBody(baseline);
  const actual = migrationBody(await readFile(MIGRATION, 'utf8'));
  if (expected !== actual) {
    failures.push('migration 0001 DDL body is not identical to baseline schema.sql body');
    for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
      if (expected[i] !== actual[i]) {
        failures.push(`  first difference at offset ${i}: baseline=${JSON.stringify(expected.slice(i, i + 60))} migration=${JSON.stringify(actual.slice(i, i + 60))}`);
        break;
      }
    }
  }
} catch (e) {
  failures.push(e.message);
}

if (failures.length) {
  console.error('FAIL: baseline/migration provenance check failed');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(`OK   baseline sha256 ${RECORDED_SHA} (preserved)`);
console.log('OK   migration 0001 DDL body is byte-identical to baseline schema.sql body');
console.log('PASS: preserved baseline provenance verified (no baseline edit).');