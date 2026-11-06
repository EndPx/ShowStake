// Shared domain state enums.
//
// Every value below mirrors a `CHECK (... IN ('...'))` constraint in
// docs/planning/showstake-v2/schema.sql. The database is authoritative for the
// persisted value; these arrays let the API/worker/web share one vocabulary and
// reject out-of-enum values at the boundary (422) before they reach SQL.
//
// IMPORTANT: this is a *mirror*, not a secondary source of truth. If the schema
// CHECK changes, this file must change in the same reviewed freeze.

/** deployments.environment */
export const ENVIRONMENTS = Object.freeze(['local', 'testnet', 'mainnet']);

/** events_projection.state (financial lifecycle). */
export const EVENT_STATES = Object.freeze([
  'PUBLISHED',
  'ATTENDANCE_FINALIZED',
  'SETTLING',
  'SETTLED',
  'CANCELLED',
  'REFUND_ONLY',
]);

/** registrations_projection.state */
export const REGISTRATION_STATES = Object.freeze([
  'COMMITTED',
  'WITHDRAWN',
  'ATTENDED',
  'NO_SHOW',
  'REFUNDABLE',
]);

/** registrations_projection.payout_state */
export const PAYOUT_STATES = Object.freeze([
  'NOT_CLAIMABLE',
  'CLAIMABLE',
  'PENDING',
  'PAID',
  'ZERO',
]);

/** payouts_projection.state */
export const PAYOUT_EXECUTION_STATES = Object.freeze(['PENDING', 'SUCCEEDED', 'FAILED']);

/** funding_attempts.state */
export const FUNDING_STATES = Object.freeze([
  'CREATED',
  'QUOTED',
  'SOURCE_PENDING',
  'SWAP_SETTLED',
  'READY_TO_COMMIT',
  'COMMIT_PENDING',
  'COMMITTED',
  'EXPIRED',
  'FAILED',
  'PROVIDER_REFUNDED',
  'ACTION_REQUIRED',
  'UNKNOWN',
]);

/** checkin_requests.state */
export const CHECKIN_STATES = Object.freeze([
  'PROPOSED',
  'SUBMITTED',
  'CONFIRMED',
  'FAILED',
  'EXPIRED',
]);

/** outbox_jobs.state */
export const JOB_STATES = Object.freeze(['READY', 'RUNNING', 'DONE', 'FAILED']);

/** A {key: values[]} index used to build the domain-amount document and OpenAPI enums. */
export const STATE_ENUMS = Object.freeze({
  environments: ENVIRONMENTS,
  event_states: EVENT_STATES,
  registration_states: REGISTRATION_STATES,
  payout_states: PAYOUT_STATES,
  payout_execution_states: PAYOUT_EXECUTION_STATES,
  funding_states: FUNDING_STATES,
  checkin_states: CHECKIN_STATES,
  job_states: JOB_STATES,
});

const LOOKUP = Object.freeze({
  environment: ENVIRONMENTS,
  event_state: EVENT_STATES,
  registration_state: REGISTRATION_STATES,
  payout_state: PAYOUT_STATES,
  payout_execution_state: PAYOUT_EXECUTION_STATES,
  funding_state: FUNDING_STATES,
  checkin_state: CHECKIN_STATES,
  job_state: JOB_STATES,
});

/** @param {string} v @returns {boolean} */
export function isEnvironment(v) {
  return ENVIRONMENTS.includes(v);
}
/** @param {string} v @returns {boolean} */
export function isEventState(v) {
  return EVENT_STATES.includes(v);
}
/** @param {string} v @returns {boolean} */
export function isRegistrationState(v) {
  return REGISTRATION_STATES.includes(v);
}
/** @param {string} v @returns {boolean} */
export function isPayoutState(v) {
  return PAYOUT_STATES.includes(v);
}
/** @param {string} v @returns {boolean} */
export function isPayoutExecutionState(v) {
  return PAYOUT_EXECUTION_STATES.includes(v);
}
/** @param {string} v @returns {boolean} */
export function isFundingState(v) {
  return FUNDING_STATES.includes(v);
}
/** @param {string} v @returns {boolean} */
export function isCheckinState(v) {
  return CHECKIN_STATES.includes(v);
}
/** @param {string} v @returns {boolean} */
export function isJobState(v) {
  return JOB_STATES.includes(v);
}

/**
 * Generic enum assertion for a shared state value. Returns null when valid,
 * else a machine-readable error object (mirrors the `requiredPositiveAmount`
 * contract in atomic.mjs).
 *
 * @param {string} kind one of the LOOKUP keys above
 * @param {*} value
 * @returns {{code:string, kind:string, value:string}|null}
 */
export function assertState(kind, value) {
  const allowed = LOOKUP[kind];
  if (!allowed) return { code: 'STATE_KIND_UNKNOWN', kind, value: String(value) };
  if (typeof value !== 'string' || !allowed.includes(value)) {
    return { code: 'STATE_INVALID', kind, value: String(value), allowed };
  }
  return null;
}

/**
 * True when `value` is a valid state for the given kind.
 * @param {string} kind @param {*} value @returns {boolean}
 */
export function isValidState(kind, value) {
  return assertState(kind, value) === null;
}