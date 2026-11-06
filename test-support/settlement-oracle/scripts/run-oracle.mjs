#!/usr/bin/env node
// Run the local settlement oracle and write fail-closed evidence.
//
// Usage (package-relative; works from the isolated folder or a tracked copy):
//   node oracle/scripts/run-oracle.mjs
//   node oracle/scripts/run-oracle.mjs --packet-root <repo-root> --evidence-dir <dir>
//
// Paths are resolved explicitly, never by assuming a fixed number of parents:
//   - PACKAGE_ROOT is the folder that contains oracle/, or the package folder
//     itself when the contents are flattened into a test-support folder;
//   - PACKET_ROOT comes from --packet-root / SHOWSTAKE_PACKET_ROOT, otherwise
//     the nearest ancestor of PACKAGE_ROOT containing
//     docs/planning/showstake-v2/01-PRODUCT.md;
//   - traceability comes from --traceability / SHOWSTAKE_ORACLE_TRACEABILITY,
//     otherwise oracle/TRACEABILITY.md, then the legacy docs/evidence path;
//   - evidence goes to --evidence-dir / SHOWSTAKE_ORACLE_EVIDENCE_DIR,
//     otherwise PACKAGE_ROOT/docs/evidence.
//
// Evidence is NEVER written over a prior run. Every invocation gets a unique
// run id and writes:
//   <evidence-dir>/settlement-oracle-runs/<runId>/result.json
//   <evidence-dir>/settlement-oracle-runs/<runId>/result.tap.txt
// plus a current-run pointer at <evidence-dir>/settlement-oracle-latest.json.
// PASS_LOCAL always describes only the current run.

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { release as osRelease } from 'node:os';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACCEPTANCE_MAP, NOT_RUN } from '../acceptance-map.mjs';
import { OPEN_GATES, PINNED_PACKET_HASHES } from '../src/policy.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ORACLE_DIR = resolve(SCRIPT_DIR, '..');
const PACKAGE_ROOT = basename(ORACLE_DIR) === 'oracle' ? resolve(ORACLE_DIR, '..') : ORACLE_DIR;
const TEST_DIR = resolve(ORACLE_DIR, 'test');
const README_PATH = resolve(ORACLE_DIR, 'README.md');
const ORACLE_PREFIX = relative(PACKAGE_ROOT, ORACLE_DIR).replaceAll('\\', '/');
const ORACLE_REL = (relativeToOracle) => (ORACLE_PREFIX ? `${ORACLE_PREFIX}/${relativeToOracle}` : relativeToOracle);

function usageError(message) {
  console.error(`run-oracle: ${message}`);
  console.error('usage: node oracle/scripts/run-oracle.mjs [--packet-root DIR] [--evidence-dir DIR] [--traceability FILE] [--run-id ID]');
  process.exit(2);
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const take = (name, key) => {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) usageError(`${name} requires a value`);
      parsed[key] = value;
      index += 1;
    };
    if (arg === '--packet-root') take(arg, 'packetRoot');
    else if (arg.startsWith('--packet-root=')) parsed.packetRoot = arg.slice('--packet-root='.length);
    else if (arg === '--evidence-dir') take(arg, 'evidenceDir');
    else if (arg.startsWith('--evidence-dir=')) parsed.evidenceDir = arg.slice('--evidence-dir='.length);
    else if (arg === '--traceability') take(arg, 'traceability');
    else if (arg.startsWith('--traceability=')) parsed.traceability = arg.slice('--traceability='.length);
    else if (arg === '--run-id') take(arg, 'runId');
    else if (arg.startsWith('--run-id=')) parsed.runId = arg.slice('--run-id='.length);
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node oracle/scripts/run-oracle.mjs [--packet-root DIR] [--evidence-dir DIR] [--traceability FILE] [--run-id ID]');
      process.exit(0);
    } else usageError(`unknown argument ${arg}`);
  }
  return parsed;
}

const ARGS = parseArgs(process.argv.slice(2));

function findUp(start, markerRelativePath) {
  let current = resolve(start);
  for (;;) {
    if (existsSync(resolve(current, markerRelativePath))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolvePacketRoot() {
  const explicit = ARGS.packetRoot ?? process.env.SHOWSTAKE_PACKET_ROOT;
  if (explicit !== undefined && explicit !== '') {
    const root = resolve(explicit);
    if (!existsSync(resolve(root, 'docs/planning/showstake-v2/01-PRODUCT.md'))) {
      return { root: null, source: 'explicit-invalid', explicit: root };
    }
    return { root, source: 'explicit' };
  }
  const discovered = findUp(PACKAGE_ROOT, 'docs/planning/showstake-v2/01-PRODUCT.md');
  if (discovered !== null) return { root: discovered, source: 'ancestor-discovery' };
  return { root: null, source: 'not-found' };
}

function resolveTraceabilityPath() {
  const explicit = ARGS.traceability ?? process.env.SHOWSTAKE_ORACLE_TRACEABILITY;
  const candidates = [];
  if (explicit !== undefined && explicit !== '') candidates.push(resolve(explicit));
  candidates.push(resolve(ORACLE_DIR, 'TRACEABILITY.md'));
  candidates.push(resolve(PACKAGE_ROOT, 'docs/evidence/settlement-oracle-traceability.md'));
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return null;
}

function resolveEvidenceDir() {
  const explicit = ARGS.evidenceDir ?? process.env.SHOWSTAKE_ORACLE_EVIDENCE_DIR;
  if (explicit !== undefined && explicit !== '') return resolve(explicit);
  return resolve(PACKAGE_ROOT, 'docs/evidence');
}

const PACKET = resolvePacketRoot();
const PACKET_ROOT = PACKET.root;
const EVIDENCE_DIR = resolveEvidenceDir();
const TRACEABILITY_PATH = resolveTraceabilityPath();
const RUNS_DIR = resolve(EVIDENCE_DIR, 'settlement-oracle-runs');
const LATEST_PATH = resolve(EVIDENCE_DIR, 'settlement-oracle-latest.json');

const RELATIVE = (absolute) => relative(PACKAGE_ROOT, absolute).replaceAll('\\', '/');

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function collectFiles(directory, predicate) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function sanitizeRunId(value) {
  const cleaned = String(value).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'run';
}

function makeRunId(startedAt) {
  const compact = startedAt.replace(/[^0-9]/g, '');
  return sanitizeRunId(`${compact}-pid${process.pid}-${randomBytes(4).toString('hex')}`);
}

const startedAt = new Date().toISOString();
const requestedRunId = sanitizeRunId(
  ARGS.runId ?? process.env.SHOWSTAKE_ORACLE_RUN_ID ?? makeRunId(startedAt),
);
let runId = requestedRunId;
let runDir = resolve(RUNS_DIR, runId);
let suffix = 2;
while (existsSync(runDir)) {
  runId = `${requestedRunId}-${suffix}`;
  runDir = resolve(RUNS_DIR, runId);
  suffix += 1;
}
const RESULTS_PATH = resolve(runDir, 'result.json');
const TAP_PATH = resolve(runDir, 'result.tap.txt');

const testFiles = collectFiles(TEST_DIR, (name) => name.endsWith('.test.mjs')).map((name) => ORACLE_REL(`test/${name}`));
const argv = [process.execPath, '--test', '--test-reporter=tap', ...testFiles];
const childEnv = { ...process.env };
if (PACKET_ROOT !== null) childEnv.SHOWSTAKE_PACKET_ROOT = PACKET_ROOT;
if (TRACEABILITY_PATH !== null) childEnv.SHOWSTAKE_ORACLE_TRACEABILITY = TRACEABILITY_PATH;

let run;
try {
  run = spawnSync(argv[0], argv.slice(1), {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
    env: childEnv,
  });
} catch (error) {
  run = { status: null, stdout: '', stderr: String(error?.stack ?? error), error };
}

const stdout = run.stdout ?? '';
const stderr = run.stderr ?? '';
const tap = stdout;
const finishedAt = new Date().toISOString();

function tapCount(label) {
  const match = tap.match(new RegExp(`^# ${label} (\\d+)\\s*$`, 'm'));
  return match ? Number(match[1]) : null;
}
function tapDuration() {
  const match = tap.match(/^# duration_ms ([\d.]+)\s*$/m);
  return match ? Number(match[1]) : null;
}

const cases = [];
for (const line of tap.split(/\r?\n/)) {
  const match = line.match(/^(not ok|ok) (\d+) - (.+)$/);
  if (match) cases.push({ name: match[3].trim(), status: match[1] === 'ok' ? 'pass' : 'fail' });
}

const counts = {
  tests: tapCount('tests') ?? cases.length,
  pass: tapCount('pass') ?? cases.filter((entry) => entry.status === 'pass').length,
  fail: tapCount('fail') ?? cases.filter((entry) => entry.status === 'fail').length,
  cancelled: tapCount('cancelled') ?? 0,
  skipped: tapCount('skipped') ?? 0,
  todo: tapCount('todo') ?? 0,
  durationMs: tapDuration(),
};

function findCase(fragment) {
  return cases.some((entry) => entry.name.includes(fragment));
}

const acceptance = ACCEPTANCE_MAP.map((entry) => ({
  id: entry.id,
  level: entry.level,
  requirement: entry.requirement,
  citations: entry.citations,
  testsPresent: entry.tests.map((description) => ({ description, found: findCase(description.split(' > ').at(-1)) })),
  limits: entry.limits,
}));

const fixtures = collectFiles(resolve(ORACLE_DIR, 'fixtures'), (name) => name.endsWith('.json')).map((name) => {
  const path = resolve(ORACLE_DIR, 'fixtures', name);
  return { path: ORACLE_REL(`fixtures/${name}`), bytes: statSync(path).size, sha256: sha256File(path) };
});

const packetRefs = PACKET_ROOT === null
  ? []
  : Object.entries(PINNED_PACKET_HASHES).map(([file, pinned]) => {
      const path = resolve(PACKET_ROOT, 'docs/planning/showstake-v2', file);
      const actual = existsSync(path) ? sha256File(path) : null;
      return { path: `docs/planning/showstake-v2/${file}`, pinnedSha256: pinned, actualSha256: actual, unchanged: actual === pinned };
    });

const sourceFiles = [
  ...collectFiles(resolve(ORACLE_DIR, 'src'), (name) => name.endsWith('.mjs')).map((name) => ORACLE_REL(`src/${name}`)),
  ORACLE_REL('acceptance-map.mjs'),
  ORACLE_REL('scripts/run-oracle.mjs'),
].map((file) => {
  const path = resolve(PACKAGE_ROOT, file);
  return { path: file, bytes: statSync(path).size, sha256: sha256File(path) };
});

const testFileEvidence = testFiles.map((file) => {
  const path = resolve(PACKAGE_ROOT, file);
  return { path: file, bytes: statSync(path).size, sha256: sha256File(path) };
});

function readWorkspaceConfigSelector() {
  const path = resolve(PACKAGE_ROOT, '.zcode/config.json');
  if (!existsSync(path)) {
    return { path: '.zcode/config.json', present: false, model: null, role: 'workspace setup selector (absent)', executionEvidence: false };
  }
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'));
    return {
      path: '.zcode/config.json',
      present: true,
      // Only the non-secret selector is recorded.
      model: typeof config.model === 'string' ? config.model : null,
      role: 'leftover workspace setup selector; NOT execution evidence',
      executionEvidence: false,
    };
  } catch {
    return { path: '.zcode/config.json', present: true, model: null, parseError: true, role: 'workspace setup selector', executionEvidence: false };
  }
}
const workspaceConfigSelector = readWorkspaceConfigSelector();

const WORKER_ATTRIBUTION = Object.freeze({
  source: 'Codex round-1 review docs/evidence/oracle-codex-review-round1.json + dispatch clarification; read-only Orca sqlite model_selection',
  attributionOnly: true,
  nodeProcessProvesModel: false,
  orcaSessionId: process.env.SHOWSTAKE_ORACLE_WORKER_SESSION ?? 'sess_8132d973-be55-4805-83a6-fcb32ff1e54f',
  provider: process.env.SHOWSTAKE_ORACLE_WORKER_PROVIDER ?? 'new-provider',
  model: process.env.SHOWSTAKE_ORACLE_WORKER_MODEL ?? 'deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated',
  reasoningLevel: process.env.SHOWSTAKE_ORACLE_WORKER_REASONING ?? 'max',
  note: 'Worker attribution, not inferred from the Node process. The workspace .zcode selector differs and is leftover setup, not execution evidence.',
});

const README_PRESENT = existsSync(README_PATH);
const TRACEABILITY_PRESENT = TRACEABILITY_PATH !== null && existsSync(TRACEABILITY_PATH);

const failureReasons = [];
if (run.error) failureReasons.push(`spawn error: ${run.error.message ?? run.error}`);
if (run.status !== 0) failureReasons.push(`node:test exit code ${String(run.status)}${run.signal ? ` signal ${run.signal}` : ''}`);
if (counts.tests === 0) failureReasons.push('no tests discovered');
if (counts.fail > 0) failureReasons.push(`${counts.fail} test(s) failed`);
if (counts.pass !== counts.tests) failureReasons.push(`pass count ${counts.pass} != tests ${counts.tests}`);
if (counts.cancelled > 0) failureReasons.push(`${counts.cancelled} cancelled`);
if (counts.skipped > 0) failureReasons.push(`${counts.skipped} skipped`);
if (counts.todo > 0) failureReasons.push(`${counts.todo} todo`);
if (PACKET_ROOT === null) failureReasons.push(`packet root ${PACKET.source}`);
if (!README_PRESENT) failureReasons.push('oracle/README.md missing');
if (!TRACEABILITY_PRESENT) failureReasons.push('traceability matrix missing (oracle/TRACEABILITY.md or explicit path)');
const changedPacket = packetRefs.filter((entry) => !entry.unchanged).map((entry) => entry.path);
if (changedPacket.length > 0) failureReasons.push(`packet snapshot changed: ${changedPacket.join(', ')}`);
const missingAcceptanceTests = acceptance.flatMap((entry) =>
  entry.testsPresent.filter((test) => !test.found).map((test) => `${entry.id}: ${test.description}`),
);
if (missingAcceptanceTests.length > 0) failureReasons.push(`acceptance test names not found in TAP: ${missingAcceptanceTests.length}`);

const status = failureReasons.length === 0 ? 'PASS_LOCAL' : 'FAILED';

const limits = [
  'LOCAL TEST ORACLE ONLY: this is test support, not a NEAR contract implementation, production settlement authority, ABI decision or chain evidence.',
  'Fixtures never prove onchain acceptance or real FT movement.',
  'NEAR contract tests for T03/T04 are NOT_RUN.',
  'Testnet and mainnet/live paths are NOT_RUN; no network, RPC, wallet, provider or credential was used.',
  'Single-threaded executable model: concurrency, cross-transaction races and real receipt atomicity are NOT_RUN.',
  'Max-200 settlement gas is not measured; G09/OG-06 remains OPEN_GATE.',
  'Chunking necessity is unresolved; only chunk semantics (frozen cursor, idempotent replay, claims disabled, cancel locked, sum verification) are modelled.',
  'Policy boundary defaults are recorded in OPEN_GATES OG-01..OG-08 and must be confirmed by contract authority.',
  'No contract ABI, database schema or API interface is frozen by this oracle.',
  'No secret, signing key, auth credential or wallet key is printed or recorded; .zcode/config.json is parsed only to record its model selector.',
  'Worker attribution is external/read-only and separate from Node execution; the Node run does not prove which model executed it, and the workspace selector is leftover setup.',
  'Each run is preserved under a unique run id; settlement-oracle-latest.json is only a pointer and never rewrites prior run artifacts.',
  'Host environment recorded below; Linux/NEAR sandbox was not used.',
];

mkdirSync(EVIDENCE_DIR, { recursive: true });
mkdirSync(runDir, { recursive: true });
writeFileSync(TAP_PATH, tap, 'utf8');

const evidence = {
  schema: 'showstake.settlement-oracle-result/1.1.0',
  runId,
  label: status === 'PASS_LOCAL'
    ? 'LOCAL TEST ORACLE — PASS_LOCAL (current run only; not NEAR contract evidence)'
    : 'LOCAL TEST ORACLE — FAILED (see failureReasons; this run only)',
  status,
  failureReasons,
  run: {
    runId,
    unique: true,
    startedAt,
    finishedAt,
    resultPath: RESULTS_PATH,
    tapPath: TAP_PATH,
    latestPointerPath: LATEST_PATH,
    overridesPriorRun: false,
  },
  command: {
    argv,
    commandLine: 'node --test --test-reporter=tap ' + testFiles.join(' '),
    cwd: PACKAGE_ROOT,
  },
  paths: {
    packageRoot: PACKAGE_ROOT,
    packetRoot: PACKET_ROOT,
    packetRootSource: PACKET.source,
    evidenceDir: EVIDENCE_DIR,
    traceability: TRACEABILITY_PATH,
    readme: README_PATH,
  },
  exitCode: run.status,
  signal: run.signal ?? null,
  environment: {
    runtime: `Node ${process.version}`,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: osRelease(),
    hostShell: 'Git Bash (win32)',
    cwd: PACKAGE_ROOT,
    network: 'none required (no fetch/RPC/provider calls)',
    dependencies: 'none — Node built-in modules only',
    packageManager: 'none',
  },
  workerAttribution: WORKER_ATTRIBUTION,
  workspaceConfigSelector,
  tests: {
    ...counts,
    cases,
    tapArtifact: TAP_PATH,
    stderrTail: stderr.slice(-4000),
  },
  fixtures,
  packetRefs,
  sourceFiles,
  testFiles: testFileEvidence,
  deliverables: {
    readme: README_PRESENT ? { path: ORACLE_REL('README.md'), sha256: sha256File(README_PATH) } : null,
    traceability: TRACEABILITY_PRESENT
      ? { path: TRACEABILITY_PATH, sha256: sha256File(TRACEABILITY_PATH) }
      : null,
    results: RESULTS_PATH,
    tap: TAP_PATH,
    latestPointer: LATEST_PATH,
    runsDir: RUNS_DIR,
  },
  acceptance,
  notRun: NOT_RUN,
  openGates: OPEN_GATES.map((gate) => ({
    id: gate.id,
    title: gate.title,
    unresolved: gate.unresolved,
    oracleDefault: gate.oracleDefault,
    vectors: gate.vectors,
  })),
  limits,
};

writeFileSync(RESULTS_PATH, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
const latest = {
  schema: 'showstake.settlement-oracle-latest/1.0.0',
  generatedAt: finishedAt,
  runId,
  status,
  result: RESULTS_PATH,
  tap: TAP_PATH,
  note: 'Pointer to the current run only. Prior run folders are preserved and never overwritten.',
};
writeFileSync(LATEST_PATH, JSON.stringify(latest, null, 2) + '\n', 'utf8');

console.log(`ORACLE_STATUS ${status}`);
console.log(`runId=${runId}`);
console.log(`tests=${counts.tests} pass=${counts.pass} fail=${counts.fail} skipped=${counts.skipped} exit=${String(run.status)}`);
console.log(`result=${RESULTS_PATH}`);
console.log(`latest=${LATEST_PATH}`);
if (failureReasons.length > 0) {
  for (const reason of failureReasons) console.log(`FAILURE ${reason}`);
}

process.exitCode = status === 'PASS_LOCAL' ? 0 : (run.status && run.status !== 0 ? run.status : 1);
