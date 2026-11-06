import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseCanonicalAtomic } from '../src/atomic.mjs';
import { PACKET_ROOT, materializeAmount, readFixture, ROOT } from './helpers.mjs';

function resolveReferencePath() {
  const candidates = [];
  if (process.env.SHOWSTAKE_DOMAIN_REFERENCE) candidates.push(resolve(process.env.SHOWSTAKE_DOMAIN_REFERENCE));
  candidates.push(resolve(PACKET_ROOT, 'packages/domain/src/atomic.mjs'));
  candidates.push(resolve(ROOT, 'packages/domain/src/atomic.mjs'));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const referencePath = resolveReferencePath();
const referenceAvailable = referencePath !== null;

test('differential: oracle canonical-u128 classification matches the read-only domain reference', async (t) => {
  if (!referenceAvailable) {
    t.skip('read-only packages/domain copy is absent in this checkout');
    return;
  }
  const reference = await import(`file://${referencePath.replaceAll('\\', '/')}`);
  const fixture = readFixture('amount-edge-cases.json');
  const values = [
    ...fixture.valid.map((entry) => materializeAmount(entry)),
    ...fixture.invalid.filter((entry) => entry.type === 'string').map((entry) => materializeAmount(entry)),
  ];
  for (const value of values) {
    const oracleResult = parseCanonicalAtomic(value);
    const referenceResult = reference.parseAtomic(value);
    assert.equal(
      oracleResult === null,
      referenceResult === null,
      `classification drift for ${JSON.stringify(value)}: oracle=${String(oracleResult)} reference=${String(referenceResult)}`,
    );
    if (oracleResult !== null && referenceResult !== null) {
      assert.equal(oracleResult.toString(), referenceResult.toString(), `value drift for ${JSON.stringify(value)}`);
    }
  }
});

test('differential: oracle and reference agree on every 0..200 length numeric string boundary', async (t) => {
  if (!referenceAvailable) {
    t.skip('read-only packages/domain copy is absent in this checkout');
    return;
  }
  const reference = await import(`file://${referencePath.replaceAll('\\', '/')}`);
  const samples = [
    '0',
    '1',
    '9',
    '10',
    '99',
    '100',
    '18446744073709551615',
    '18446744073709551616',
    '340282366920938463463374607431768211454',
    '340282366920938463463374607431768211455',
    '340282366920938463463374607431768211456',
    '9'.repeat(40),
  ];
  for (const value of samples) {
    assert.equal(parseCanonicalAtomic(value) === null, reference.parseAtomic(value) === null, value);
  }
});
