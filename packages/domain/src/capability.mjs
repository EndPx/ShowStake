// Capability / status result vocabulary shared by wallet-adapter and
// intents-adapter. Every probe returns one of these structured results rather
// than throwing or returning bare booleans, so the evidence classifier and the
// "explicit capability/status" requirement stay machine-checkable.
//
// Classifiers come from docs/planning/showstake-v2/06-DECISIONS-AND-SOURCES.md
// and are recorded verbatim on every test in evidence.

export const CLASSIFIERS = Object.freeze([
  'PASS_LOCAL',
  'PASS_TESTNET',
  'PASS_LIVE',
  'BLOCKED_EXTERNAL',
  'FAILED',
  'NOT_RUN',
]);

/** @param {string} c @returns {boolean} */
export function isClassifier(c) {
  return CLASSIFIERS.includes(c);
}

/**
 * A capability probe result. `capability` is one of the G01..G11 gate ids or a
 * W01..W08 acceptance id the probe exercises; `level` states how far the probe
 * actually went; `done` is true only when the probe itself succeeded (a fixture
 * never sets `done` for a live gate).
 *
 * @param {object} p
 * @param {string} p.id
 * @param {string} p.capability
 * @param {'SDK_SUPPORTED'|'DOCUMENTED'|'EXECUTABLE_LOCAL'|'TESTED_PROVIDER'|'AUTHENTICATED'|'TESTNET'|'LIVE'} p.level
 * @param {string} p.classifier
 * @param {boolean} p.done
 * @param {string[]} p.observations
 * @param {object} [p.details]
 */
export function capabilityResult(p) {
  if (!isClassifier(p.classifier)) throw new TypeError(`unknown classifier ${p.classifier}`);
  return {
    kind: 'capability',
    id: p.id,
    capability: p.capability,
    level: p.level,
    classifier: p.classifier,
    done: Boolean(p.done),
    observations: Array.isArray(p.observations) ? p.observations : [],
    details: p.details ?? {},
    at: new Date().toISOString(),
  };
}

/** ok/err result envelope used by typed adapters for their inputs/outputs. */
export function okResult(kind, payload = {}) {
  return { ok: true, kind, ...payload };
}

export function errResult(kind, code, message, payload = {}) {
  return { ok: false, kind, code, message, ...payload };
}

/**
 * An explicit status result for one probe step. Matches the evidence schema:
 * id / requirement / base commit / environment / commands / expected / observed /
 * exit / classifier / reviewer-pending / limits.
 *
 * @param {object} s
 * @param {string} s.id
 * @param {string} s.requirement
 * @param {string} [s.command]
 * @param {string} s.expected
 * @param {string} s.observed
 * @param {number} [s.exit]
 * @param {string} [s.classifier]
 * @param {string[]} [s.limits]
 */
export function statusResult(s) {
  return {
    kind: 'status',
    id: s.id,
    requirement: s.requirement,
    command: s.command ?? null,
    expected: s.expected,
    observed: s.observed,
    exit: typeof s.exit === 'number' ? s.exit : null,
    classifier: s.classifier && isClassifier(s.classifier) ? s.classifier : null,
    reviewer_pending: true,
    limits: Array.isArray(s.limits) ? s.limits : [],
    at: new Date().toISOString(),
  };
}