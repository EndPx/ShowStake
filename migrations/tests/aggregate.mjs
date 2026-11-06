// migrations/tests/aggregate.mjs — fail-closed phase + orchestration aggregation.
//
// Pure (no database, no network). The single place that decides whether a T01 run
// is PASS_LOCAL or FAILED (a no-dump "all" run is labeled NOT_RUN / partial). It
// enforces EVERY required outcome from the SAME run:
//   * the FULL required phase set is present;
//   * every phase file is valid JSON with the expected shape AND a non-empty
//     checks array (an empty/malformed phase is never green);
//   * every phase belongs to THIS run (run_id match) — a phase from a previous
//     run is rejected even if it is green;
//   * every phase is ok and every check in it is ok — a phase that threw before
//     `recordPhase` leaves no file and is treated as missing;
//   * the orchestration result (static-domain/static-baseline/static-aggregate/
//     static-openapi, readiness, CLI status, pg_dump/pg_restore, server stop and
//     cleanup) is present, from this run, and every required stage exited 0.
// Any violation makes the aggregate FAILED (exit non-zero). Old green artifacts
// can never mask a failed/missing/stale/invalid phase because each run writes to
// its own fresh directory and the run id is stamped into every file.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const REQUIRED_PHASES = Object.freeze([
  'd01', 'd02', 'd03', 'd04-fixtures', 'd04-verify', 'd05', 'd06',
]);

/** Orchestration stages required for full acceptance (all must exit 0). */
export const REQUIRED_STAGES = Object.freeze([
  'static-domain', 'static-baseline', 'static-aggregate', 'static-openapi',
  'readiness', 'cli-status', 'pg_dump', 'pg_restore', 'stop', 'cleanup',
]);

/** Read + JSON-parse one phase file. Throws an Error naming the defect. */
export async function readPhaseFile(artifactsDir, phase) {
  let raw;
  try {
    raw = await readFile(join(artifactsDir, `${phase}.json`), 'utf8');
  } catch {
    throw new Error(`missing phase file: ${phase}.json`);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid JSON in ${phase}.json: ${e.message}`);
  }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.checks)) {
    throw new Error(`invalid phase shape in ${phase}.json (expected {phase,title,ok,checks[]})`);
  }
  if (obj.checks.length === 0) {
    throw new Error(`empty checks array in ${phase}.json (a phase with no checks is not green)`);
  }
  return obj;
}

/** @param {string} artifactsDir @param {string} runId */
export async function loadPhases(artifactsDir, runId) {
  const phases = {};
  const errors = { missing: [], stale: [], invalid: [], failed: [] };
  for (const phase of REQUIRED_PHASES) {
    let p;
    try {
      p = await readPhaseFile(artifactsDir, phase);
    } catch (e) {
      if (e.message.startsWith('missing phase file')) errors.missing.push(phase);
      else errors.invalid.push({ phase, reason: e.message });
      continue;
    }
    if (p.run_id !== runId) errors.stale.push({ phase, run_id: p.run_id ?? null });
    else {
      phases[phase] = p;
      // ok !== true, any failed check, or a malformed check is a failed phase.
      if (p.ok !== true || p.checks.some((c) => !c || c.ok !== true)) errors.failed.push(phase);
    }
  }
  return { phases, errors };
}

/** Read the dump/restore exit info, or null when absent (smoke runs). */
export async function readDumpInfo(artifactsDir) {
  try {
    return JSON.parse(await readFile(join(artifactsDir, 'd04-dump-restore.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Read the orchestration result (static/readiness/cli/dump/stop/cleanup), or null. */
export async function readOrchestrator(artifactsDir) {
  try {
    return JSON.parse(await readFile(join(artifactsDir, 'orchestrator.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Validate the orchestration result. Returns {required, ok, stages, problems}.
 * Full acceptance requires every REQUIRED_STAGE to be present and exit 0 from
 * THIS run. Smoke mode does not consume an orchestration result.
 */
export function validateOrchestrator(orchestrator, runId, mode) {
  const stages = (orchestrator && typeof orchestrator.stages === 'object') ? orchestrator.stages : {};
  const problems = [];
  if (mode === 'smoke') {
    return { required: false, ok: false, stages, problems: [] };
  }
  if (!orchestrator) {
    problems.push('full acceptance requires orchestration result (static/readiness/cli/dump/stop/cleanup)');
  } else if (orchestrator.run_id !== runId) {
    problems.push(`orchestration result is from another run (run_id=${orchestrator.run_id})`);
  }
  for (const s of REQUIRED_STAGES) {
    if (!Object.prototype.hasOwnProperty.call(stages, s)) problems.push(`missing orchestration stage: ${s}`);
    else if (stages[s]?.exit !== 0) problems.push(`orchestration stage failed: ${s} (exit ${stages[s]?.exit})`);
  }
  return { required: true, ok: problems.length === 0, stages, problems };
}

/**
 * Aggregate a run into a fail-closed summary.
 *
 * @param {string} artifactsDir per-run artifact directory (unique every run)
 * @param {string} runId run id stamped into every phase
 * @param {object|null} orchestrator orchestration result (orchestrator.json)
 * @param {{mode?: 'full'|'smoke'}} [opts]
 */
export async function aggregate(artifactsDir, runId, orchestrator, opts = {}) {
  const mode = opts.mode ?? 'full';
  const { phases, errors } = await loadPhases(artifactsDir, runId);
  const orch = validateOrchestrator(orchestrator, runId, mode);

  const totalChecks = Object.values(phases).reduce((n, p) => n + (p.checks?.length || 0), 0);
  const failedChecks = Object.values(phases).reduce((n, p) => n + (p.checks?.filter((c) => !c || !c.ok).length || 0), 0);

  const problems = [];
  if (errors.missing.length) problems.push(`missing phases: ${errors.missing.join(', ')}`);
  if (errors.invalid.length) problems.push(`invalid phases: ${errors.invalid.map((i) => i.phase).join(', ')}`);
  if (errors.stale.length) problems.push(`stale (other-run) phases: ${errors.stale.map((s) => s.phase).join(', ')}`);
  if (errors.failed.length) problems.push(`failed phases: ${errors.failed.join(', ')}`);
  if (failedChecks) problems.push(`${failedChecks} check(s) failed`);
  problems.push(...orch.problems);
  if (mode === 'smoke') problems.push('no pg_dump/pg_restore — full acceptance NOT_RUN (partial smoke only)');

  const phasesOk = errors.missing.length === 0 && errors.invalid.length === 0 && errors.stale.length === 0 &&
    errors.failed.length === 0 && failedChecks === 0;

  const ok = mode === 'smoke' ? false : (phasesOk && orch.ok);
  const classifier = mode === 'smoke' ? 'NOT_RUN' : (ok ? 'PASS_LOCAL' : 'FAILED');

  return {
    mode,
    classifier,
    ok,
    run_id: runId,
    problems,
    phases,
    errors,
    stages: orch,
    totals: { checks: totalChecks, failed: failedChecks },
    dump: { info: orchestrator ? (orchestrator.dump ?? null) : null, required: mode !== 'smoke', ok: mode === 'smoke' ? false : orch.ok },
  };
}

/**
 * Run the pure regressions the review requires. Phase regressions: missing
 * phase, other-run phase, phase-threw-before-record (missing file), invalid
 * JSON, empty-checks array. Orchestration regressions (fault injection): a
 * failed static/checksum stage, a failed cleanup stage, and a missing
 * orchestration result cannot be reported PASS. A complete matching run is
 * PASS_LOCAL; a no-dump "all" run is NOT_RUN. Returns the number of failures.
 */
export async function selfTest(tmpdir) {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const { join } = await import('node:path');

  const goodPhase = (phase, runId, ok = true) => ({
    phase, title: phase, run_id: runId, ok, passed: ok ? 1 : 0, failed: ok ? 0 : 1,
    checks: [{ id: `${phase}_x`, ok, expected: 'x', observed: 'x' }], at: new Date().toISOString(),
  });
  const goodOrchestrator = (runId, overrides = {}) => {
    const stages = {};
    for (const s of REQUIRED_STAGES) stages[s] = { exit: 0 };
    Object.assign(stages, overrides);
    return { run_id: runId, mode: 'full', stages };
  };
  const writeAll = async (dir, runId, { skip = [], overwrite = {}, orchestrator = goodOrchestrator(runId) } = {}) => {
    if (orchestrator) await writeFile(join(dir, 'orchestrator.json'), JSON.stringify(orchestrator));
    for (const phase of REQUIRED_PHASES) {
      if (skip.includes(phase)) continue;
      const override = overwrite[phase];
      if (override === 'invalid-json') { await writeFile(join(dir, `${phase}.json`), '{not json'); continue; }
      if (override === 'no-checks') { await writeFile(join(dir, `${phase}.json`), JSON.stringify({ phase, run_id: runId })); continue; }
      if (override === 'empty-checks') { await writeFile(join(dir, `${phase}.json`), JSON.stringify({ phase, run_id: runId, ok: true, checks: [] })); continue; }
      const obj = override ?? goodPhase(phase, runId, true);
      await writeFile(join(dir, `${phase}.json`), JSON.stringify(obj));
    }
  };

  const cases = [
    ['missing phase file -> FAILED', { skip: ['d06'] }, (s) => s.classifier === 'FAILED' && s.errors.missing.includes('d06')],
    ['other-run (stale) phase -> FAILED', { overwrite: { d05: goodPhase('d05', 'OTHER-RUN', true) } }, (s) => s.classifier === 'FAILED' && s.errors.stale.some((x) => x.phase === 'd05')],
    ['phase throws before record (missing d03) -> FAILED', { skip: ['d03'] }, (s) => s.classifier === 'FAILED' && s.errors.missing.includes('d03')],
    ['invalid JSON phase -> FAILED', { overwrite: { d02: 'invalid-json' } }, (s) => s.classifier === 'FAILED' && s.errors.invalid.some((x) => x.phase === 'd02')],
    ['invalid shape (no checks array) -> FAILED', { overwrite: { d01: 'no-checks' } }, (s) => s.classifier === 'FAILED'],
    ['empty checks array -> FAILED (never green)', { overwrite: { 'd04-verify': 'empty-checks' } }, (s) => s.classifier === 'FAILED' && s.errors.invalid.some((x) => x.phase === 'd04-verify')],
    ['orchestration result missing in full mode -> FAILED', { orchestrator: null }, (s) => s.classifier === 'FAILED' && s.problems.some((p) => p.includes('orchestration result'))],
    ['static-baseline/checksum failure (exit 1) -> FAILED (fault injection)', { orchestrator: goodOrchestrator('RUN-TEST', { 'static-baseline': { exit: 1 } }) }, (s) => s.classifier === 'FAILED' && s.problems.some((p) => p.includes('static-baseline'))],
    ['static-openapi failure (exit 2) -> FAILED (fault injection)', { orchestrator: goodOrchestrator('RUN-TEST', { 'static-openapi': { exit: 2 } }) }, (s) => s.classifier === 'FAILED' && s.problems.some((p) => p.includes('static-openapi'))],
    ['cleanup failure (exit 1) -> FAILED (fault injection)', { orchestrator: goodOrchestrator('RUN-TEST', { cleanup: { exit: 1 } }) }, (s) => s.classifier === 'FAILED' && s.problems.some((p) => p.includes('cleanup'))],
    ['missing stage key -> FAILED', { orchestrator: { run_id: 'RUN-TEST', stages: { 'static-domain': { exit: 0 } } } }, (s) => s.classifier === 'FAILED' && s.problems.some((p) => p.includes('missing orchestration stage'))],
  ];

  const root = await mkdtemp(join(tmpdir, 't01-aggregate-'));
  let failures = 0;
  try {
    for (const [label, opts, expect] of cases) {
      const dir = await mkdtemp(join(root, 'case-'));
      await writeAll(dir, 'RUN-TEST', opts);
      const s = await aggregate(dir, 'RUN-TEST', await readOrchestrator(dir), { mode: 'full' });
      const good = expect(s);
      console.log(`${good ? 'OK  ' : 'FAIL'} ${label}: classifier=${s.classifier}${s.problems.length ? ' (' + s.problems.join('; ') + ')' : ''}`);
      if (!good) failures++;
    }
    // A complete, matching, green run with all orchestration stages is PASS_LOCAL.
    {
      const dir = await mkdtemp(join(root, 'ok-'));
      await writeAll(dir, 'RUN-TEST', {});
      const s = await aggregate(dir, 'RUN-TEST', await readOrchestrator(dir), { mode: 'full' });
      const good = s.classifier === 'PASS_LOCAL' && s.ok === true;
      console.log(`${good ? 'OK  ' : 'FAIL'} complete matching run (phases + orchestration) -> PASS_LOCAL`);
      if (!good) failures++;
    }
    // A no-dump "all" run is NOT_RUN/partial — never PASS_LOCAL and never the
    // invented "SMOKE" classifier.
    {
      const dir = await mkdtemp(join(root, 'smoke-'));
      await writeAll(dir, 'RUN-TEST', { orchestrator: null });
      const s = await aggregate(dir, 'RUN-TEST', null, { mode: 'smoke' });
      const good = s.classifier === 'NOT_RUN' && s.ok === false;
      console.log(`${good ? 'OK  ' : 'FAIL'} no-dump "all" run -> NOT_RUN (cannot finalize full acceptance)`);
      if (!good) failures++;
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
  return failures;
}