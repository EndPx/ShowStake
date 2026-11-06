import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { CITATIONS, OPEN_GATES, PINNED_PACKET_HASHES } from '../src/policy.mjs';
import { readPacket } from './helpers.mjs';

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

test('every policy quote exists verbatim in the immutable packet copy', () => {
  assert.ok(CITATIONS.length >= 30, 'citation set should cover settlement, identity, limits and evidence labels');
  for (const citation of CITATIONS) {
    const text = readPacket(citation.file);
    assert.ok(
      text.includes(citation.quote),
      `${citation.id} quote no longer present in ${citation.file}: ${JSON.stringify(citation.quote.slice(0, 80))}`,
    );
  }
});

test('cited packet files match the pinned SHA-256 snapshot', () => {
  for (const [file, expected] of Object.entries(PINNED_PACKET_HASHES)) {
    const actual = sha256(readPacket(file));
    assert.equal(actual, expected, `${file} changed; re-pin the oracle deliberately`);
  }
});

test('citation ids are unique and every citation names a section and use', () => {
  const ids = new Set();
  for (const citation of CITATIONS) {
    assert.equal(ids.has(citation.id), false, `duplicate citation ${citation.id}`);
    ids.add(citation.id);
    assert.equal(typeof citation.section, 'string');
    assert.ok(citation.section.length > 0);
    assert.ok(citation.use.length > 0);
  }
});

test('OPEN_GATE register is explicit and supplies vectors rather than silent assumptions', () => {
  const ids = new Set();
  for (const gate of OPEN_GATES) {
    assert.match(gate.id, /^OG-\d{2}$/);
    assert.equal(ids.has(gate.id), false, `duplicate gate ${gate.id}`);
    ids.add(gate.id);
    for (const key of ['title', 'packet', 'unresolved', 'oracleDefault']) {
      assert.equal(typeof gate[key], 'string', `${gate.id}.${key}`);
      assert.ok(gate[key].length > 0, `${gate.id}.${key} must not be empty`);
    }
    assert.ok(Array.isArray(gate.vectors) && gate.vectors.length > 0, `${gate.id} must supply test vectors`);
  }
  assert.ok(ids.has('OG-01'), 'deadline boundary must be tracked');
  assert.ok(ids.has('OG-05'), 'stale callback must be tracked');
  assert.ok(ids.has('OG-06'), 'gas/chunking necessity must be tracked');
});

test('sources cited by the task are present in the citation set', () => {
  const files = new Set(CITATIONS.map((citation) => citation.file));
  for (const required of ['01-PRODUCT.md', '02-ARCHITECTURE.md', '03-DATABASE.md', '05-EXECUTION-AND-TESTS.md', '06-DECISIONS-AND-SOURCES.md', 'schema.sql']) {
    assert.equal(files.has(required), true, `no citation from ${required}`);
  }
  const ids = new Set(CITATIONS.map((citation) => citation.id));
  for (const required of ['CIT-SETTLE-FORMULA', 'CIT-CONSERVATION', 'CIT-ISOLATION', 'CIT-CLAIM-EXACTLY-ONCE', 'CIT-D05', 'CIT-EVIDENCE-LABELS']) {
    assert.equal(ids.has(required), true, `missing citation ${required}`);
  }
});
