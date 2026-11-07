// Trusted network-specific final RPC access-key resolver for NAMED NEAR accounts.
//
// A NEP-413 Ed25519 signature proves a *key* signed a message. It does NOT prove
// the key is a current access key of a NAMED account. This module provides the
// missing half: a resolver that queries a NEAR RPC node for the CURRENT on-chain
// access-key state and returns a fully-declared context, plus a validator that
// enforces account/key/network/permission/freshness over that context. Nothing
// here treats a bare `{ok:true}` as proof.
//
// OFFICIAL SEMANTICS (inspected 2026-11-06, NEP-413 + NEAR Auth sign-messages):
//   * NEP-413 MUST be signed by a FULL-access key (RPC `view_access_key` returns
//     `permission: "FullAccess"`). A `FunctionCall` (limited) key may NOT sign.
//   * For a NEW, not-yet-funded implicit account (64-hex id == ed25519 public
//     key byte-for-byte), the account does not exist on-chain yet, so
//     `view_access_key` fails with an UNKNOWN_ACCOUNT-class error. Only in that
//     specific case is the local hex==key relationship acceptable; once the
//     account exists on-chain its keys can change and the RPC check is REQUIRED.
//     (https://docs.auth.near.org/home/guides/sign-messages — "Verify the signature on your backend".)
//   * "Final state unavailability denies": if the RPC cannot return a definitive
//     final-block answer (network error, malformed body, unknown error), we
//     DENY (RPC_ERROR / MALFORMED_RPC_RESPONSE), never pass.
//
// TRANSPORT: injectable, so tests use local fixtures and production uses a
// real HTTPS JSON-RPC client. The LIVE mode is read-only (`query`/`view_access_key`
// is a view call); it never broadcasts or spends. It is gated behind an explicit
// opt-in so no network I/O runs in a default `pnpm verify` pass.

export const NEAR_RPC_URLS = Object.freeze({
  testnet: 'https://rpc.testnet.near.org',
  mainnet: 'https://rpc.mainnet.near.org',
  local: null, // no public endpoint; an explicit local node URL must be supplied
});

/** Result freshness window: the resolver's answer must be no older than this. */
export const DEFAULT_MAX_KEY_FRESHNESS_MS = 5 * 60 * 1000;

/** NEP-413 requires a full-access key (see spec "Why using a FullAccess Key?"). */
export const REQUIRED_ACCESS_KEY_TYPE = 'FullAccess';

/**
 * Canonical JSON-RPC `query` request for `view_access_key` (final block).
 * Read-only; never broadcasts.
 *
 * @param {string} accountId
 * @param {string} publicKey  "ed25519:<base58>" or "secp256k1:<base58>"
 */
export function buildViewAccessKeyQuery(accountId, publicKey) {
  return {
    jsonrpc: '2.0',
    id: 'showstake-akv',
    method: 'query',
    params: {
      request_type: 'view_access_key',
      finality: 'final',
      account_id: accountId,
      public_key: publicKey,
    },
  };
}

/**
 * Interpret a `view_access_key` JSON-RPC response into a fully-declared context,
 * or a structured denial. Fail-closed: anything that is not a definitive final
 * answer denies.
 *
 * @param {object} json   parsed JSON-RPC response body (from transport)
 * @param {object} req
 * @param {string} req.accountId
 * @param {string} req.publicKey
 * @param {string} req.keyType      e.g. 'ed25519' (from the presented key label)
 * @param {string} req.network      network the RPC node is pinned to
 * @param {number} req.nowMs
 * @returns {{ok:boolean, code:string, accountId?:string, publicKey?:string,
 *   keyType?:string, accessKeyType?:string, verifiedAt?:number, network?:string,
 *   blockHeight?:number, detail?:string}}
 */
export function interpretAccessKeyView(json, { accountId, publicKey, keyType, network, nowMs }) {
  // A denial is still a FULLY-DECLARED context: the verifier must be able to
  // confirm the denial was produced for the exact account/key/network it asked
  // about, at a fresh moment, so a bare `{ok:false, code}` stub cannot satisfy
  // the implicit not-yet-funded exception. `verifiedAt` is the check time (the
  // final-block RPC answer is "as of finality at this instant").
  const deny = (code, detail, blockHeight = null) => ({
    ok: false,
    code,
    detail,
    accountId,
    publicKey,
    keyType,
    network,
    verifiedAt: nowMs,
    blockHeight,
  });

  if (!json || typeof json !== 'object') {
    return deny('MALFORMED_RPC_RESPONSE', 'resolver returned no JSON object');
  }

  if (json.result) {
    const result = json.result;
    const permission = result.permission;
    let accessKeyType = null;
    if (permission === 'FullAccess') accessKeyType = 'FullAccess';
    else if (permission && typeof permission === 'object' && permission.FunctionCall) accessKeyType = 'FunctionCall';
    else {
      return deny('MALFORMED_RESOLVER', `unrecognized access-key permission ${JSON.stringify(permission)}`);
    }
    if (typeof result.block_height !== 'number' || !Number.isFinite(result.block_height)) {
      return deny('MALFORMED_RESOLVER', 'view_access_key result missing finite block_height');
    }
    return {
      ok: true,
      code: 'VERIFIED_ACCESS_KEY',
      accountId,
      publicKey,
      keyType,
      accessKeyType,
      verifiedAt: nowMs,
      network,
      blockHeight: result.block_height,
    };
  }

  if (json.error) {
    const message = String(json.error?.message || json.error?.cause?.name || '').toLowerCase();
    // NEAR RPC distinguishes the two not-found cases by message; anything else is
    // an unknown/failure and must deny (final state unavailability denies).
    if (message.includes('account') && message.includes('does not exist')) {
      return deny('ACCOUNT_NOT_FOUND', JSON.stringify(json.error));
    }
    if (message.includes('key') && message.includes('does not exist')) {
      return deny('KEY_NOT_FOUND', JSON.stringify(json.error));
    }
    return deny('RPC_ERROR', `RPC error ${json.error?.code}: ${message}`);
  }

  return deny('MALFORMED_RPC_RESPONSE', 'unrecognized JSON-RPC response shape');
}

/**
 * Validate a resolver's declared context against what the verifier actually
 * needs. This is the anti-`{ok:true}`-stub gate: an `ok:true` without matching
 * account/key/network/permission/freshness/blockHeight DENIES.
 *
 * @param {object} rv        resolver result (see interpretAccessKeyView)
 * @param {object} expected
 * @param {string} expected.accountId     challenge account
 * @param {string} expected.network       challenge network (final-network pin)
 * @param {string} expected.publicKey     presented key string
 * @param {string} expected.keyType       presented key type (parsed)
 * @param {number} expected.nowMs
 * @param {number} [expected.maxFreshnessMs]
 * @param {string} [expected.requiredAccessKeyType]
 * @param {boolean} [expected.allowImplicitAccountNotFound] when true, an
 *   `ACCOUNT_NOT_FOUND` for an implicit (64-hex == key) account is acceptable
 *   (the not-yet-funded account case); otherwise it denies.
 * @returns {{ok:boolean, failures:{code:string, detail?:string}[]}}
 */
export function validateResolvedAccessKey(rv, expected) {
  const failures = [];
  const push = (code, detail) => failures.push({ code, detail });
  const maxFreshnessMs = expected.maxFreshnessMs ?? DEFAULT_MAX_KEY_FRESHNESS_MS;
  const required = expected.requiredAccessKeyType ?? REQUIRED_ACCESS_KEY_TYPE;

  if (!rv || rv.ok !== true) {
    push(rv?.code || 'ACCOUNT_KEY_UNVERIFIED', rv?.detail || 'named-account access-key relation not verified by a trusted resolver');
    return { ok: false, failures };
  }

  if (rv.accountId !== expected.accountId) {
    push('ACCOUNT_MISMATCH', `resolver account '${rv.accountId}' != challenge '${expected.accountId}'`);
  }
  if (rv.network !== expected.network) {
    push('WRONG_NETWORK', `resolver final-network '${rv.network}' != challenge '${expected.network}'`);
  }
  if (rv.publicKey !== expected.publicKey) {
    push('KEY_MISMATCH', `resolver key '${rv.publicKey}' != presented '${expected.publicKey}'`);
  }
  if (rv.keyType !== expected.keyType) {
    push('KEY_TYPE_MISMATCH', `resolver keyType '${rv.keyType}' != presented '${expected.keyType}'`);
  }
  if (rv.accessKeyType !== required) {
    push('WRONG_PERMISSION', `access key permission '${rv.accessKeyType}' is not '${required}'`);
  }
  if (typeof rv.verifiedAt !== 'number' || !Number.isFinite(rv.verifiedAt)) {
    push('BAD_KEY_VERIFIED_AT', `resolver verifiedAt must be a finite epoch-ms (got ${String(rv.verifiedAt)})`);
  } else {
    if (rv.verifiedAt > expected.nowMs) push('BAD_KEY_VERIFIED_AT', `resolver verifiedAt ${rv.verifiedAt} is in the future (now ${expected.nowMs})`);
    else if (expected.nowMs - rv.verifiedAt > maxFreshnessMs) push('STALE_KEY', `resolver answer is stale (verifiedAt ${rv.verifiedAt}, now ${expected.nowMs}, max ${maxFreshnessMs}ms)`);
  }
  if (typeof rv.blockHeight !== 'number' || !Number.isFinite(rv.blockHeight)) {
    push('MALFORMED_RESOLVER', 'resolver ok:true without a finite blockHeight is malformed');
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Default live transport: a read-only HTTPS JSON-RPC POST. Returns the parsed
 * JSON body (an `error` key on a non-2xx or non-JSON body carries the denial).
 * Requires the caller to opt in to live RPC; never runs in `pnpm verify`.
 */
export async function fetchJsonRpcTransport(url, { body }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* non-json */ }
  if (!res.ok) {
    return { error: { code: `HTTP_${res.status}`, message: parsed?.error?.message || text.slice(0, 300) } };
  }
  return parsed ?? { error: { code: 'NON_JSON', message: text.slice(0, 300) } };
}

/**
 * Build a network-pinned access-key verifier.
 *
 * @param {object} opts
 * @param {(network:string) => (string|null)} opts.getRpcUrl  strictly maps a
 *   network to its trusted RPC URL; returns null for unsupported networks.
 * @param {typeof fetchJsonRpcTransport} [opts.transport]
 * @param {() => number} [opts.nowProvider]
 * @param {number} [opts.maxFreshnessMs]
 * @returns {(q:{accountId:string, publicKey:string, network:string}) =>
 *   Promise<{ok:boolean, code?:string, detail?:string, accountId?:string,
 *     publicKey?:string, keyType?:string, accessKeyType?:string,
 *     verifiedAt?:number, network?:string, blockHeight?:number}>}
 */
export function makeNearRpcAccessKeyVerifier({ getRpcUrl, transport = fetchJsonRpcTransport, nowProvider = Date.now, maxFreshnessMs = DEFAULT_MAX_KEY_FRESHNESS_MS }) {
  return async function accessKeyVerifier({ accountId, publicKey, network }) {
    const url = getRpcUrl(network);
    if (!url) {
      return { ok: false, code: 'UNSUPPORTED_NETWORK', detail: `no trusted RPC endpoint for network '${network}'` };
    }
    let keyType;
    try {
      const m = /^(ed25519|secp256k1):([1-9A-HJ-NP-Za-km-z]+)$/.exec(String(publicKey));
      if (!m) throw new Error('bad key format');
      keyType = m[1];
    } catch (e) {
      return { ok: false, code: 'BAD_PUBLIC_KEY', detail: `resolver cannot parse '${publicKey}'` };
    }
    const query = buildViewAccessKeyQuery(accountId, publicKey);
    let json;
    try {
      json = await transport(url, { method: 'POST', body: JSON.stringify(query) });
    } catch (e) {
      return { ok: false, code: 'RPC_ERROR', detail: `transport failed: ${String(e && e.message ? e.message : e)}` };
    }
    return interpretAccessKeyView(json, { accountId, publicKey, keyType, network, nowMs: nowProvider() });
  };
}