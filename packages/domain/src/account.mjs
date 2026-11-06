// NEAR account identifiers.
//
// A pragmatic local validator used by the probes for "wrong account / wrong
// network" negative checks. It is an approximation of the NEAR account-id rules
// documented at https://docs.near.org/concepts/protocol/account-id and enforced
// by the `near-account-id` crate that `near-api-js` uses. Production code MUST
// reuse the SDK's validator (near-api-js / near-account-id), not this heuristic,
// for final acceptance. This module makes that dependency decision explicit.

/** true for a NEAR implicit account: 64 lowercase hex chars (public key IS the account id). */
export function isImplicitAccount(accountId) {
  return typeof accountId === 'string' && /^[0-9a-f]{64}$/.test(accountId);
}

/**
 * Heuristic NEAR account-id shape check. Returns `true` / `false` / `null`
 * (null = cannot decide locally, e.g. implicit account trusted by callers).
 * Documented limits: 2..64 chars, [a-z0-9._-], no leading/trailing or doubled
 * separators, every dot-separated label starts/ends alphanumeric.
 *
 * @param {string} accountId
 * @returns {boolean|null}
 */
export function validateAccountIdShape(accountId) {
  if (typeof accountId !== 'string') return false;
  if (accountId.length < 2 || accountId.length > 64) return false;
  if (isImplicitAccount(accountId)) return true;
  if (!/^[a-z0-9._-]+$/.test(accountId)) return false;
  if (/^[._-]|[._-]$/.test(accountId)) return false;
  if (/[._-]{2,}/.test(accountId)) return false;
  for (const label of accountId.split('.')) {
    if (!/^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$/.test(label)) return false;
  }
  return true;
}

/** Acceptable network identifiers for this workspace (mirrors schema deployments.environment). */
export const NETWORKS = Object.freeze(['local', 'testnet', 'mainnet']);

/** @param {string} network @returns {boolean} */
export function isKnownNetwork(network) {
  return NETWORKS.includes(network);
}

/** Normalized `{network, ok}` wrapper for network checks in negative probes. */
export function checkNetwork(network) {
  if (!isKnownNetwork(network)) {
    return { ok: false, code: 'UNKNOWN_NETWORK', network };
  }
  return { ok: true, code: 'OK', network };
}