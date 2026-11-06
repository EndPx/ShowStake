// migrations/tests/lib.mjs — minimal assertion + connection helpers for T01 tests.
//
// Connection is socket-first: when SHOWSTAKE_PG_SOCKET is exported by the suite
// orchestrator, every client (including the readiness probe) connects over the
// per-run Unix socket — never across the Windows->WSL TCP loopback. The artifact
// directory is a UNIQUE per-run directory (not a fixed path), so a run can never
// read a previous run's stale phase JSON.
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectConfig } from '../runner.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the per-run artifact directory. Set by the orchestrator via
 * `--artifacts` (read from env SHOWSTAKE_PG_ARTIFACTS as a fallback). There is
 * deliberately NO fixed default so a bare `node run-t01.mjs d01` cannot write
 * into (or read) a previous run's artifacts.
 */
export function artifactsDir() {
  return process.env.SHOWSTAKE_PG_ARTIFACTS || null;
}

export function runId() {
  return process.env.SHOWSTAKE_PG_RUN_ID || null;
}

export async function ensureArtifacts() {
  const dir = artifactsDir();
  if (!dir) throw new Error('SHOWSTAKE_PG_ARTIFACTS (per-run artifact dir) is required');
  await mkdir(dir, { recursive: true });
}

export async function pg() {
  const mod = await import('pg');
  return mod.default ?? mod;
}

/** Open a fresh pg.Client over the per-run socket (or DATABASE_URL fallback). */
export async function connect(database) {
  const { Client } = await pg();
  const c = new Client(connectConfig(database, process.env.SHOWSTAKE_PG_SOCKET));
  await c.connect();
  return c;
}

export const uuid = randomUUID;

/** A single check result. */
export function result(id, ok, expected, observed, extra = {}) {
  return { id, ok: Boolean(ok), expected, observed, ...extra };
}

/**
 * Represents a D-group of checks. Records evidence to the UNIQUE per-run
 * artifact directory and stamps each file with the current run id so the
 * aggregate step can reject a phase from another run.
 */
export async function recordPhase(phase, title, checks, meta = {}) {
  const ok = checks.filter((c) => !c.ok);
  const summary = {
    phase,
    title,
    run_id: runId(),
    ok: ok.length === 0,
    passed: checks.length - ok.length,
    failed: ok.length,
    checks,
    meta,
    at: new Date().toISOString(),
  };
  await ensureArtifacts();
  await writeFile(join(artifactsDir(), `${phase}.json`), JSON.stringify(summary, null, 2));
  const label = summary.ok ? 'PASS' : 'FAIL';
  console.log(`${label} ${phase}: ${summary.passed}/${checks.length} checks`);
  for (const c of checks) {
    if (c.ok) console.log(`  OK   ${c.id}`);
    else console.log(`  FAIL ${c.id}  expected=${c.expected} observed=${c.observed}`);
  }
  return summary;
}

/**
 * Run a statement expecting a specific SQLSTATE (or any error). Returns the
 * error, or null when it unexpectedly succeeded.
 */
export async function expectSqlError(client, sql, params = [], match = null) {
  try {
    await client.query(sql, params);
    return { threw: false, error: null, code: null, message: null, matched: match === null };
  } catch (e) {
    const code = e.code ?? null;
    let matched = true;
    if (match && code !== match) matched = false;
    return { threw: true, error: e, code, message: e.message, matched };
  }
}

/** Quoted identifier helper (no user input ever passes through this). */
export function qi(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}