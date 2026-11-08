// Generate independent expected allocations for the ShowStake settlement
// Sandbox scenarios by importing the ACCEPTED local settlement oracle.
//
// This is a LOCAL test oracle output, not chain evidence and not a contract.
// It runs on the host Node (the WSL sandbox has no Node); the generated JSON
// is a hashed input to the WSL Sandbox runner, which compares every on-chain
// registration allocation and the event total against it.
//
// Usage:
//   node test-support/contract-integration/oracle/generate-settlement-expected.mjs
//     [--scenarios <path>] [--out <path>]

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '../../..');

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

const scenariosPath = path.resolve(
  workspace,
  arg('--scenarios', 'test-support/contract-integration/oracle/scenarios.json'),
);
const outPath = path.resolve(
  workspace,
  arg('--out', 'test-support/contract-integration/evidence/oracle-settlement-expected.json'),
);

const settlementSrc = path.resolve(workspace, 'test-support/settlement-oracle/src/settlement.mjs');
const oracleModules = [
  'test-support/settlement-oracle/src/settlement.mjs',
  'test-support/settlement-oracle/src/atomic.mjs',
  'test-support/settlement-oracle/src/errors.mjs',
].map((relative) => path.resolve(workspace, relative));

for (const modulePath of oracleModules) {
  if (!fs.existsSync(modulePath)) {
    throw new Error(`accepted oracle module missing: ${modulePath}`);
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

const { computeAllocation } = await import(pathToFileURL(settlementSrc).href);

const spec = JSON.parse(fs.readFileSync(scenariosPath, 'utf8'));
if (spec.schema !== 'showstake.oracle-scenarios/1.0.0') {
  throw new Error(`unexpected scenario schema: ${spec.schema}`);
}
if (!Array.isArray(spec.scenarios) || spec.scenarios.length === 0) {
  throw new Error('scenario list is empty');
}

const scenarios = spec.scenarios.map((scenario) => {
  if (!Array.isArray(scenario.attended) || scenario.attended.length === 0) {
    throw new Error(`scenario ${scenario.name} has no attendance vector`);
  }
  const registrations = scenario.attended.map((attended, index) => ({
    registrationId: `reg-${index}`,
    sequence: index,
    state: 'ACTIVE',
    attended: Boolean(attended),
  }));
  const allocation = computeAllocation({
    deposit: scenario.deposit,
    registrations,
  });
  const payouts = allocation.entries.map((entry) => entry.payout.toString());
  const total = payouts.reduce((sum, value) => sum + BigInt(value), 0n);
  if (total !== allocation.totals.total) {
    throw new Error(`oracle total mismatch for ${scenario.name}`);
  }
  return {
    name: scenario.name,
    deposit: scenario.deposit,
    attended: scenario.attended.map(Boolean),
    n: allocation.n,
    a: allocation.a,
    m: allocation.m,
    w: allocation.w,
    pool: allocation.pool.toString(),
    q: allocation.q.toString(),
    r: allocation.r.toString(),
    payouts,
    total: total.toString(),
    expected_total: allocation.totals.expectedTotal.toString(),
  };
});

const record = {
  schema: 'showstake.oracle-expected/1.0.0',
  label:
    'LOCAL independent allocation expectations from the accepted settlement oracle; compared against real Sandbox allocations',
  generated_at_utc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  generator: 'test-support/contract-integration/oracle/generate-settlement-expected.mjs',
  oracle: {
    label: 'LOCAL TEST ORACLE — accepted independently, not chain evidence',
    settlement_module: 'test-support/settlement-oracle/src/settlement.mjs',
    settlement_module_sha256: sha256(fs.readFileSync(oracleModules[0])),
    modules: oracleModules.map((modulePath) => ({
      path: path.relative(workspace, modulePath).replaceAll('\\', '/'),
      sha256: sha256(fs.readFileSync(modulePath)),
    })),
    formula:
      'A>0: pool=M*D, q=floor(pool/A), r=pool%A; attendees in registration-sequence order get D+q+1 for the first r and D+q for the rest; no-shows get 0. A=0: every registration is refunded D. Withdrawals are not part of D036.',
  },
  scenarios_path: path.relative(workspace, scenariosPath).replaceAll('\\', '/'),
  scenarios_sha256: sha256(fs.readFileSync(scenariosPath)),
  scenarios,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

const outSha = sha256(fs.readFileSync(outPath));
console.log(`wrote ${path.relative(workspace, outPath).replaceAll('\\', '/')}`);
console.log(`sha256 ${outSha}`);
for (const scenario of scenarios) {
  console.log(
    `${scenario.name}: n=${scenario.n} a=${scenario.a} m=${scenario.m} pool=${scenario.pool} q=${scenario.q} r=${scenario.r} total=${scenario.total}`,
  );
}
