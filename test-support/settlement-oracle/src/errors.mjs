// Typed oracle failures.
//
// The oracle models contract-level *rejections* as typed errors so tests can
// assert the precise reason a call was denied, not merely "something threw".
// Codes are oracle-local vocabulary; they are NOT a frozen contract ABI.

export const CODES = Object.freeze({
  // exact amounts
  AMOUNT_INVALID: 'AMOUNT_INVALID',
  AMOUNT_ZERO: 'AMOUNT_ZERO',
  AMOUNT_OUT_OF_RANGE: 'AMOUNT_OUT_OF_RANGE',
  ATOMIC_OVERFLOW: 'ATOMIC_OVERFLOW',

  // event rules
  CAPACITY_INVALID: 'CAPACITY_INVALID',
  DECIMALS_INVALID: 'DECIMALS_INVALID',
  TIME_INVALID: 'TIME_INVALID',
  TIME_ORDER_INVALID: 'TIME_ORDER_INVALID',
  DEADLINE_INVALID: 'DEADLINE_INVALID',
  RULES_INVALID: 'RULES_INVALID',
  IMMUTABLE_RULES: 'IMMUTABLE_RULES',
  EVENT_NOT_FOUND: 'EVENT_NOT_FOUND',
  EVENT_EXISTS: 'EVENT_EXISTS',

  // deposits / seat acquisition
  PHASE_DENIED: 'PHASE_DENIED',
  EVENT_FULL: 'EVENT_FULL',
  WRONG_TOKEN: 'WRONG_TOKEN',
  WRONG_AMOUNT: 'WRONG_AMOUNT',
  DUPLICATE_COMMITMENT: 'DUPLICATE_COMMITMENT',
  DUPLICATE_ACTIVE_REGISTRATION: 'DUPLICATE_ACTIVE_REGISTRATION',
  IDENTITY_MISMATCH: 'IDENTITY_MISMATCH',
  STORAGE_NOT_PREPAID: 'STORAGE_NOT_PREPAID',
  UNSUPPORTED_TRANSFER: 'UNSUPPORTED_TRANSFER',

  // registration / pass
  REGISTRATION_NOT_FOUND: 'REGISTRATION_NOT_FOUND',
  REGISTRATION_EVENT_MISMATCH: 'REGISTRATION_EVENT_MISMATCH',
  REGISTRATION_WITHDRAWN: 'REGISTRATION_WITHDRAWN',
  PASS_NOT_FOUND: 'PASS_NOT_FOUND',
  PASS_INVALID_FOR_CHECKIN: 'PASS_INVALID_FOR_CHECKIN',
  TRANSFER_FORBIDDEN: 'TRANSFER_FORBIDDEN',
  APPROVAL_FORBIDDEN: 'APPROVAL_FORBIDDEN',
  ADMIN_REASSIGN_FORBIDDEN: 'ADMIN_REASSIGN_FORBIDDEN',
  IMMUTABLE_BENEFICIARY: 'IMMUTABLE_BENEFICIARY',

  // authority / windows
  UNAUTHORIZED_ORGANIZER: 'UNAUTHORIZED_ORGANIZER',
  UNAUTHORIZED_PARTICIPANT: 'UNAUTHORIZED_PARTICIPANT',
  UNAUTHORIZED_CLAIMANT: 'UNAUTHORIZED_CLAIMANT',
  UNAUTHORIZED_CALLBACK: 'UNAUTHORIZED_CALLBACK',
  WITHDRAWAL_WINDOW_CLOSED: 'WITHDRAWAL_WINDOW_CLOSED',
  ATTENDANCE_FROZEN: 'ATTENDANCE_FROZEN',
  LATE_FINALIZATION: 'LATE_FINALIZATION',
  REFUND_ONLY_DENIED: 'REFUND_ONLY_DENIED',
  CANCELLATION_TOO_LATE: 'CANCELLATION_TOO_LATE',
  CANCELLATION_LOCKED: 'CANCELLATION_LOCKED',
  INVALID_TRANSITION: 'INVALID_TRANSITION',

  // settlement
  SETTLEMENT_NOT_STARTED: 'SETTLEMENT_NOT_STARTED',
  SETTLEMENT_COMPLETE: 'SETTLEMENT_COMPLETE',
  CLAIMS_DISABLED: 'CLAIMS_DISABLED',
  CURSOR_GAP: 'CURSOR_GAP',
  SUM_VERIFICATION_FAILED: 'SUM_VERIFICATION_FAILED',
  CONSERVATION_BROKEN: 'CONSERVATION_BROKEN',

  // claims / payouts
  NOT_CLAIMABLE: 'NOT_CLAIMABLE',
  NOTHING_TO_CLAIM: 'NOTHING_TO_CLAIM',
  CLAIM_ALREADY_PENDING: 'CLAIM_ALREADY_PENDING',
  CLAIM_ALREADY_PAID: 'CLAIM_ALREADY_PAID',
  PAYOUT_UNKNOWN: 'PAYOUT_UNKNOWN',
  DUPLICATE_PAYOUT_ID: 'DUPLICATE_PAYOUT_ID',
  CALLBACK_STALE: 'CALLBACK_STALE',
});

export class OracleError extends Error {
  /**
   * @param {string} code one of CODES
   * @param {string} message
   * @param {Record<string, unknown>} [details] machine-readable context
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OracleError';
    this.code = code;
    this.details = details;
  }
}

/** @returns {never} */
export function fail(code, message, details = {}) {
  throw new OracleError(code, message, details);
}

export function assertOrFail(condition, code, message, details) {
  if (!condition) fail(code, message, details);
}

/**
 * Assert that `fn` throws an OracleError with the expected code and return it.
 * Tests use this so an unexpected error (or silent success) is a real failure.
 *
 * @param {() => unknown} fn
 * @param {string} expectedCode
 * @returns {OracleError}
 */
export function expectCode(fn, expectedCode) {
  try {
    fn();
  } catch (error) {
    if (error instanceof OracleError && error.code === expectedCode) return error;
    throw new Error(
      `expected ${expectedCode}, got ${error instanceof OracleError ? error.code : `${error?.name}: ${error?.message}`}`,
      { cause: error },
    );
  }
  throw new Error(`expected ${expectedCode}, but the call succeeded`);
}
