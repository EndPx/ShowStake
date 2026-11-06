// Shared test scaffolding. Not a test file (no .test.mjs suffix).

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettlementOracle } from '../src/engine.mjs';

/** Folder containing test/, src/, fixtures/ and TRACEABILITY.md (relocatable). */
export const ORACLE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Package root: parent of an oracle/ subfolder, or ORACLE_DIR when flattened. */
export const ROOT = basename(ORACLE_DIR) === 'oracle' ? dirname(ORACLE_DIR) : ORACLE_DIR;

/** Walk upward from a start folder until a marker path exists. */
export function findUp(start, markerRelativePath) {
  let current = resolve(start);
  for (;;) {
    if (existsSync(resolve(current, markerRelativePath))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Resolve the repository packet root explicitly:
 *   1. SHOWSTAKE_PACKET_ROOT (absolute or cwd-relative)
 *   2. nearest ancestor of this package containing docs/planning/showstake-v2
 *   3. this package root (current isolated delivery layout)
 * Never assumes .local or a fixed number of parent directories.
 */
export function resolvePacketRoot() {
  const explicit = process.env.SHOWSTAKE_PACKET_ROOT;
  if (explicit !== undefined && explicit !== '') {
    const root = resolve(explicit);
    const marker = resolve(root, 'docs/planning/showstake-v2/01-PRODUCT.md');
    if (!existsSync(marker)) {
      throw new Error(`SHOWSTAKE_PACKET_ROOT does not contain docs/planning/showstake-v2/01-PRODUCT.md: ${root}`);
    }
    return root;
  }
  const discovered = findUp(ROOT, 'docs/planning/showstake-v2/01-PRODUCT.md');
  if (discovered !== null) return discovered;
  if (existsSync(resolve(ROOT, 'docs/planning/showstake-v2/01-PRODUCT.md'))) return ROOT;
  throw new Error('packet root not found; set SHOWSTAKE_PACKET_ROOT to the repository root');
}

export const PACKET_ROOT = resolvePacketRoot();

/** Resolve the acceptance traceability matrix without assuming .local/docs. */
export function resolveTraceabilityPath() {
  const explicit = process.env.SHOWSTAKE_ORACLE_TRACEABILITY;
  const candidates = [];
  if (explicit !== undefined && explicit !== '') candidates.push(resolve(explicit));
  candidates.push(resolve(ORACLE_DIR, 'TRACEABILITY.md'));
  candidates.push(resolve(ROOT, 'docs/evidence/settlement-oracle-traceability.md'));
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error('traceability matrix not found; set SHOWSTAKE_ORACLE_TRACEABILITY');
}

export function readTraceability() {
  return readFileSync(resolveTraceabilityPath(), 'utf8');
}
export const TOKEN = 'ft.showstake.oracle';
export const ORGANIZER = 'organizer.showstake.oracle';

export const TIMES = Object.freeze({
  regOpen: 1_000_000,
  regClose: 2_000_000,
  cancelCutoff: 2_500_000,
  checkinOpen: 3_000_000,
  checkinClose: 4_000_000,
});
export const DEADLINE = TIMES.checkinClose + 24 * 60 * 60 * 1000;

export function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(ROOT, relativePath), 'utf8'));
}

export function readFixture(name) {
  return JSON.parse(readFileSync(resolve(ORACLE_DIR, 'fixtures', name), 'utf8'));
}

export function readPacket(relativePath) {
  return readFileSync(resolve(PACKET_ROOT, 'docs/planning/showstake-v2', relativePath), 'utf8');
}

/** Materialize a fixture amount value ({type,value}) into a JS value. */
export function materializeAmount(entry) {
  switch (entry.type) {
    case 'string':
      return entry.value;
    case 'number':
      return entry.value;
    case 'boolean':
      return entry.value;
    case 'null':
      return null;
    case 'object':
      return {};
    case 'array':
      return [];
    default:
      throw new Error(`unknown fixture amount type ${entry.type}`);
  }
}

/**
 * Publish a standard oracle event.
 * @param {SettlementOracle} oracle
 * @param {{deposit?: string, capacity?: number, organizer?: string, eventId?: string}} [options]
 */
export function publishStandardEvent(oracle, options = {}) {
  const {
    deposit = '10',
    capacity = 200,
    organizer = ORGANIZER,
    eventId,
    registerOpen = TIMES.regOpen,
  } = options;
  const publish = {
    organizerAccount: organizer,
    assetContract: TOKEN,
    decimals: 6,
    deposit,
    capacity,
    times: { ...TIMES, regOpen: registerOpen },
    policyVersion: 'showstake/1.0.0',
    rulesHash: 'sha256:oracle-fixture',
    title: 'Oracle fixture event',
    description: 'Local settlement oracle fixture',
  };
  if (eventId !== undefined) publish.eventId = eventId;
  return oracle.publishEvent(publish);
}

export function commitAs(oracle, eventId, sequence, options = {}) {
  const {
    amount = '10',
    account = `acct-${sequence}.showstake.oracle`,
    commitmentId = `commit-${sequence}`,
    now = TIMES.regOpen,
    tokenContract = TOKEN,
    beneficiaryAccount,
    storagePrepaid = true,
  } = options;
  return oracle.commitDeposit({
    eventId,
    participantAccount: account,
    beneficiaryAccount,
    commitmentId,
    amount,
    tokenContract,
    now,
    storagePrepaid,
  });
}

/**
 * Execute one frozen acceptance vector through the stateful oracle:
 * commit all registrations, withdraw the withdrawn ones, mark attendees,
 * finalize at checkin_close, settle permissionlessly.
 */
export function executeVector(vector) {
  const oracle = new SettlementOracle();
  const eventId = publishStandardEvent(oracle, {
    deposit: vector.deposit,
    capacity: Math.max(1, vector.n),
  });
  const registrationBySequence = new Map();
  for (let sequence = 0; sequence < vector.n; sequence += 1) {
    const result = commitAs(oracle, eventId, sequence, { amount: vector.deposit });
    registrationBySequence.set(sequence, result.registrationId);
  }
  for (const sequence of vector.withdrawn) {
    oracle.withdrawRegistration({
      eventId,
      registrationId: registrationBySequence.get(sequence),
      actor: `acct-${sequence}.showstake.oracle`,
      now: TIMES.regOpen + 1,
    });
  }
  for (const sequence of vector.attendees) {
    oracle.markAttendance({
      eventId,
      registrationId: registrationBySequence.get(sequence),
      attended: true,
      actor: ORGANIZER,
      now: TIMES.checkinOpen,
    });
  }
  oracle.finalizeAttendance({ eventId, actor: ORGANIZER, now: TIMES.checkinClose });
  const settlement = oracle.settle({ eventId, actor: 'anyone', now: TIMES.checkinClose + 1 });
  return { oracle, eventId, registrationBySequence, settlement };
}

/** Build pure-allocation registration inputs from a fixture vector. */
export function vectorRegistrations(vector) {
  const withdrawn = new Set(vector.withdrawn);
  const attendees = new Set(vector.attendees);
  const rows = [];
  for (let sequence = 0; sequence < vector.n; sequence += 1) {
    rows.push({
      registrationId: `reg-${sequence}`,
      sequence,
      state: withdrawn.has(sequence) ? 'WITHDRAWN' : 'ACTIVE',
      attended: attendees.has(sequence),
    });
  }
  return rows;
}

/** Deterministic LCG for reproducible randomized sequences. */
export function lcg(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export function randomInt(next, maxExclusive) {
  return Math.floor(next() * maxExclusive);
}

export function pick(next, array) {
  return array[randomInt(next, array.length)];
}

/** Shuffle a copy deterministically. */
export function shuffled(next, array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(next, i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function bigintOf(view) {
  return BigInt(view);
}
