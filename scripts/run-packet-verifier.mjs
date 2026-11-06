#!/usr/bin/env node
// Packet-verifier wrapper (read-only against the baseline).
// Runs the supplied verify_packet.py on a TEMPORARY COPY so the baseline
// docs/planning/showstake-v2/VALIDATION.json is never mutated, then asserts the
// baseline VALIDATION.json bytes are still identical to the recorded baseline hash.
// Exits non-zero if the verifier fails, python is missing, or the baseline drifted.
import { createHash } from 'node:crypto';
import { readFile, copyFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packetDir = join(root, 'docs', 'planning', 'showstake-v2');
const validationFile = join(packetDir, 'VALIDATION.json');
const baselinePath = join(root, 'docs', 'evidence', 'bootstrap.json');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
const recordedHash = baseline.baseline_sha256 && baseline.baseline_sha256['VALIDATION.json'];
const beforeHash = sha256(await readFile(validationFile));

if (recordedHash && beforeHash !== recordedHash) {
  console.error(`FAIL: baseline VALIDATION.json already drifted before running verifier.
  recorded ${recordedHash}
  actual   ${beforeHash}`);
  process.exit(1);
}
console.log(`OK   baseline VALIDATION.json matches recorded hash (${recordedHash})`);

// Copy the whole packet (including verify_packet.py) to a throwaway directory.
const names = Object.keys(baseline.baseline_sha256).sort();
const temp = await mkdtemp(join(tmpdir(), 'showstake-packet-verify-'));
for (const name of names) await copyFile(join(packetDir, name), join(temp, name));

const pyArgs = ['verify_packet.py'];
const candidates = ['python', 'py', 'python3'];
let verifier = null;
for (const c of candidates) {
  const probe = spawnSync(c, ['--version'], { stdio: 'ignore' });
  if (!probe.error) { verifier = c; break; }
}

if (!verifier) {
  const afterHash = sha256(await readFile(validationFile));
  await rm(temp, { recursive: true, force: true });
  console.error(`FAIL: no python interpreter found (tried ${candidates.join(', ')})`);
  console.error(`      baseline VALIDATION.json ${afterHash === beforeHash ? 'preserved' : 'DRIFTED'}`);
  process.exit(1);
}

const run = spawnSync(verifier, pyArgs, { cwd: temp, stdio: 'inherit' });

const afterHash = sha256(await readFile(validationFile));
await rm(temp, { recursive: true, force: true });

console.log(`\nVerifier (${verifier}) exit code: ${run.status ?? 'spawn-error'}`);
console.log(`Baseline VALIDATION.json ${afterHash === beforeHash ? 'preserved (byte-identical)' : 'DRIFTED'}`);

const failures = [];
if (run.error) failures.push(`spawn error: ${run.error.message}`);
else if (run.status !== 0) failures.push(`verify_packet.py exited ${run.status}`);
if (afterHash !== beforeHash) failures.push('baseline VALIDATION.json mutated by wrapper');

if (failures.length) {
  for (const f of failures) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log('PASS: verifier ran on a temporary copy; baseline left intact.');