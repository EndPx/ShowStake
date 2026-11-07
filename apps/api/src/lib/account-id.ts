// NEAR account-id validation, mirroring the validation algorithm of the
// official `near-account-id` crate (https://github.com/near/near-account-id),
// the NEAR account-id validation authority. The crate does NOT
// ship a JS validator in near-api-js@7.4.0 (the bundled build validates RPC
// types via is-my-json-valid, not account strings), so this module mirrors the
// crate's exact algorithm and is pinned to the crate's own test vectors (see
// apps/api/test/account-id-official-vectors.mjs) rather than the previously
// heuristic, nonproduction `@showstake/domain` shape check.
//
// Authoritative crate rules (src/validation.rs, `validate`):
//   * length 2..=64 chars
//   * every char is a-z, 0-9, or one of the separators `-` `_` `.`
//   * no leading / trailing separator
//   * no two consecutive separators (the valid-account-id regex the crate
//     documents is /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/)
//
// Implicit accounts (64 lowercase hex) are a *classification*, not a separate
// validation gate: they all match the charset/length rules above, exactly as in
// the crate where `validate(implicit)` is Ok and `is_near_implicit` only labels
// them afterwards.

export const NEAR_ACCOUNT_ID_MIN_LEN = 2;
export const NEAR_ACCOUNT_ID_MAX_LEN = 64;

export type AccountIdReason =
  | 'OK'
  | 'TOO_SHORT'
  | 'TOO_LONG'
  | 'INVALID_CHAR'
  | 'LEADING_SEPARATOR'
  | 'TRAILING_SEPARATOR'
  | 'CONSECUTIVE_SEPARATOR';

export interface AccountIdVerdict {
  ok: boolean;
  reason: AccountIdReason;
}

const FAIL = (reason: AccountIdReason): AccountIdVerdict => ({ ok: false, reason });

/**
 * Mirror of near-account-id `validate`. Returns an `ok` boolean plus a stable
 * reason code; the boolean is checked against official OK_ACCOUNT_IDS / BAD_ACCOUNT_IDS
 * vectors and additional boundaries; this is not a formal equivalence proof.
 */
export function validateNearAccountId(input: unknown): AccountIdVerdict {
  if (typeof input !== 'string') return FAIL('INVALID_CHAR');
  const id = input;
  if (id.length < NEAR_ACCOUNT_ID_MIN_LEN) return FAIL('TOO_SHORT');
  if (id.length > NEAR_ACCOUNT_ID_MAX_LEN) return FAIL('TOO_LONG');

  // The crate "safely assumes the last char was a separator" before the loop, so
  // a leading separator and any consecutive-separator pair both read as
  // "separator follows separator" and are rejected. We keep the distinction for
  // diagnostics but the accept/reject outcome is identical.
  let lastIsSeparator = true;
  for (let i = 0; i < id.length; i += 1) {
    const c = id[i] as string;
    let isSeparator: boolean;
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
      isSeparator = false;
    } else if (c === '-' || c === '_' || c === '.') {
      isSeparator = true;
    } else {
      return FAIL('INVALID_CHAR');
    }
    if (isSeparator && lastIsSeparator) {
      return FAIL(i === 0 ? 'LEADING_SEPARATOR' : 'CONSECUTIVE_SEPARATOR');
    }
    lastIsSeparator = isSeparator;
  }
  if (lastIsSeparator) return FAIL('TRAILING_SEPARATOR');
  return { ok: true, reason: 'OK' };
}

export function isValidNearAccountId(input: unknown): boolean {
  return validateNearAccountId(input).ok;
}