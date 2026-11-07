// Account-control / identity-binding challenge verification with negative rules.
//
// Maps to A01 (wrong domain/account/network/expired/replayed challenge rejected)
// and A02/W04 (login without bound NEAR account cannot act; linking needs both
// controls). The cryptographic core is NEP-413 (see ./nep413.mjs); the rules
// here add the app-level guards from docs/planning/showstake-v2/02-ARCHITECTURE.md:
//   domain, network, purpose, nonce32, account, issued_at, expires_at (<=5m),
//   atomic nonce consumption, signer account == challenge account.
//
// SECURITY NOTES (fail-closed, reviewed after two adversarial defects):
//   * A NEP-413 Ed25519 signature only proves a *key* made the signature. It does
//     NOT prove the key belongs to a NAMED NEAR account. NAMED accounts therefore
//     REQUIRE a trusted network access-key resolver (an RPC adapter) that proves
//     the presented public key is a current access key of the account with the
//     required permission. With no resolver, verification FAILS CLOSED for BOTH
//     named and implicit accounts (live auth must inject a resolver). An implicit
//     account (64-hex, key == account id) may be checked locally ONLY when the
//     caller opts in with the explicit fixture-only `allowLocalImplicitFallback`
//     flag, which live verification must never set.
//   * The whole challenge context (domain, network, purpose, account, issued_at,
//     expires_at, nonce) is folded into a single canonical signed message, so a
//     signature over a different context cannot be replayed under valid-looking
//     fields. Timestamps are validated as finite integers before use.
//   * `consumedNonces` here is an in-memory Set for the probe only; production
//     must persist nonce consumption atomically (DB unique constraint/transaction).

import { verifyNep413SignedMessage, parseNearPublicKey } from './nep413.mjs';
import { validateResolvedAccessKey, REQUIRED_ACCESS_KEY_TYPE, DEFAULT_MAX_KEY_FRESHNESS_MS } from './near-rpc-resolver.mjs';
import { checkNetwork, validateAccountIdShape, isImplicitAccount } from '../../domain/src/index.mjs';

export const MAX_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * Canonicalize a challenge `context` (linking user/session identity) into a
 * stable string for both signing and comparison. Returns:
 *   null      -> no context (absent or empty object),
 *   string    -> canonical JSON of the flat primitive context,
 *   undefined -> malformed context (non-object, array, nested value, or a
 *               non-finite number). A malformed context must fail closed.
 */
export function canonicalizeContext(context) {
  if (context === undefined || context === null) return null;
  if (typeof context !== 'object' || Array.isArray(context)) return undefined;
  const entries = Object.entries(context);
  if (entries.length === 0) return null;
  for (const [, v] of entries) {
    if (v === null) continue;
    const t = typeof v;
    if (!['string', 'number', 'boolean'].includes(t)) return undefined;
    if (t === 'number' && !Number.isFinite(v)) return undefined;
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(Object.fromEntries(entries));
}

/** Canonical nonce key for single-use (replay) detection. */
export function nonceKey(nonce) {
  return Buffer.from(nonce).toString('hex');
}

/**
 * Canonical signed message that cryptographically binds every challenge field
 * the verifier enforces. Must be the exact value the signer is shown. Returns
 * `null` when the nonce is not a valid 32-byte value (in which case the caller
 * must rely on the nonce validation failure, not on message equality).
 */
export function canonicalChallengeMessage(c) {
  if (!(c?.nonce instanceof Uint8Array) || c.nonce.length !== 32) return null;
  const nonceHex = Buffer.from(c.nonce).toString('hex');
  // A malformed context prevents building a canonical message (fail closed).
  const ctx = canonicalizeContext(c?.context);
  if (ctx === undefined) return null;
  const lines = [
    'ShowStake v2 proof-of-control',
    `domain=${c.domain}`,
    `network=${c.network}`,
    `purpose=${c.purpose}`,
    `account_id=${c.accountId}`,
    `issued_at_ms=${c.issuedAtMs}`,
    `expires_at_ms=${c.expiresAtMs}`,
    `nonce=${nonceHex}`,
  ];
  // Bind the linking user/session identity into the signed payload so a proof
  // issued for one session/user cannot be replayed into another.
  if (ctx !== null) lines.push(`context=${ctx}`);
  return lines.join('\n');
}

/**
 * Validate challenge timestamps (fail-closed). Returns an array of `{code,detail}`
 * failures. Enforces: present, finite, integer ms, not issued in the future,
 * expiry strictly after issuance, positive TTL, TTL <= 5m, and exact expiry
 * (nowMs >= expiresAtMs is already expired).
 */
export function validateChallengeTimes({ issuedAtMs, expiresAtMs }, nowMs) {
  const failures = [];
  const push = (code, detail) => failures.push({ code, detail });
  for (const [name, v] of [['issuedAtMs', issuedAtMs], ['expiresAtMs', expiresAtMs]]) {
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
      push('BAD_TIMESTAMP', `${name} must be a finite integer ms epoch (got ${String(v)})`);
    }
  }
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    push('BAD_NOW', `nowMs must be a finite number (got ${String(nowMs)})`);
  }
  if (failures.length === 0) {
    if (issuedAtMs > nowMs) push('FUTURE_ISSUANCE', `issuedAtMs ${issuedAtMs} > now ${nowMs}`);
    const ttl = expiresAtMs - issuedAtMs;
    if (ttl <= 0) push('NONPOSITIVE_TTL', `expiresAtMs ${expiresAtMs} <= issuedAtMs ${issuedAtMs}`);
    else if (ttl > MAX_CHALLENGE_TTL_MS) push('EXPIRY_TOO_LONG', `TTL ${ttl}ms exceeds ${MAX_CHALLENGE_TTL_MS}ms`);
    if (nowMs >= expiresAtMs) push('STALE_PROOF', `expired at ${expiresAtMs} (now ${nowMs})`);
  }
  return failures;
}

/**
 * Build a challenge object (what the API would issue). Times are UTC ms. When
 * `message` is omitted it is derived from the canonical binder; an explicit
 * `message` is kept but MUST still equal the canonical binder at verify time.
 */
export function makeChallenge(c) {
  const issuedAtMs = c.issuedAtMs ?? Date.now();
  const expiresAtMs = c.expiresAtMs ?? issuedAtMs + MAX_CHALLENGE_TTL_MS;
  const challenge = {
    purpose: c.purpose,
    domain: c.domain,
    network: c.network,
    accountId: c.accountId,
    nonce: c.nonce,
    issuedAtMs,
    expiresAtMs,
    callbackUrl: c.callbackUrl ?? null,
    ...(c.context !== undefined ? { context: c.context } : {}),
    message: c.message ?? null,
  };
  if (challenge.message == null) {
    challenge.message = canonicalChallengeMessage(challenge);
  }
  return challenge;
}

/**
 * The injected network access-key resolver contract. Production supplies a
 * trusted RPC-backed implementation (see `near-rpc-resolver.mjs`) that proves
 * `publicKey` is a CURRENT access key of `accountId` on `network` with the
 * required permission, and returns the FULLY-DECLARED context, which the
 * verifier re-validates with `validateResolvedAccessKey` (account/key/keyType/
 * network/accessKeyType/verifiedAt freshness/blockHeight). A resolver must
 * return:
 *   { ok:true,  accountId, publicKey, keyType, accessKeyType, verifiedAt, network, blockHeight }
 *   { ok:false, code, detail }   // ACCOUNT_NOT_FOUND, KEY_NOT_FOUND, KEY_REMOVED,
 *                                // WRONG_PERMISSION, STALE, RPC_ERROR,
 *                                // MALFORMED_RPC_RESPONSE, ...
 * A bare `{ok:true}` without those declared fields is DENIED (see
 * `validateResolvedAccessKey`), not treated as proof.
 *
 * @typedef {(q:{accountId:string, publicKey:string, network:string}) =>
 *   Promise<{ok:boolean, code?:string, detail?:string, accountId?:string,
 *            publicKey?:string, keyType?:string, accessKeyType?:string,
 *            verifiedAt?:number, network?:string, blockHeight?:number}>} AccessKeyVerifier
 */

/**
 * Verify a control proof against a challenge. Returns a structured result (and
 * marks the nonce consumed on success).
 *
 * @param {object} input
 * @param {ReturnType<typeof makeChallenge>} input.challenge
 * @param {{accountId:string, publicKey:string, signature:string}} input.proof
 * @param {Set<string>} input.consumedNonces
 * @param {string} input.expectedDomain   required app origin
 * @param {string} input.expectedNetwork  required network (testnet/mainnet/local)
 * @param {string} input.expectedPurpose  required challenge purpose
 * @param {number} [input.nowMs]
 * @param {AccessKeyVerifier} [input.accessKeyVerifier] required for NAMED accounts
 * @param {object} [input.expectedContext] linking user/session identity the
 *   server issued this challenge for; enforced exactly when present (and
 *   required for a linking challenge), so a proof cannot cross sessions/users.
 * @param {number} [input.maxFreshnessMs] resolver freshness window
 * @param {boolean} [input.allowLocalImplicitFallback] explicit fixture-only opt-in:
 *   when true and NO resolver is injected, a not-yet-funded implicit account may be
 *   checked locally (id == key). Default false = fail closed for BOTH implicit and
 *   named accounts when the resolver is missing. Live auth must always inject a
 *   resolver and must never set this flag.
 * @returns {Promise<{ok:boolean, code:string, failures?:{code:string,detail?:string}[]}>}
 */
export async function verifyChallengeProof({
  challenge,
  proof,
  consumedNonces,
  expectedDomain,
  expectedNetwork,
  expectedPurpose,
  nowMs = Date.now(),
  accessKeyVerifier = null,
  expectedContext,
  maxFreshnessMs = DEFAULT_MAX_KEY_FRESHNESS_MS,
  allowLocalImplicitFallback = false,
}) {
  const failures = [];
  const push = (code, detail) => failures.push({ code, detail });

  // 0. The verifier must be told what it is protecting; absent expectations are
  //    a fail-closed error, not "skip the check" (reviewed defect).
  if (typeof expectedDomain !== 'string' || expectedDomain.length === 0) push('MISSING_EXPECTED_DOMAIN');
  if (typeof expectedNetwork !== 'string' || expectedNetwork.length === 0) push('MISSING_EXPECTED_NETWORK');
  if (typeof expectedPurpose !== 'string' || expectedPurpose.length === 0) push('MISSING_EXPECTED_PURPOSE');

  // 1. network known and matches the server's expected network for this attempt.
  const net = checkNetwork(challenge?.network);
  if (!net.ok) push('WRONG_NETWORK', `unknown network '${challenge?.network}'`);
  else if (expectedNetwork && challenge.network !== expectedNetwork) {
    push('WRONG_NETWORK', `challenge '${challenge.network}' != expected '${expectedNetwork}'`);
  }

  // 2. domain (recipient) present and matches the expected app origin.
  if (typeof challenge?.domain !== 'string' || challenge.domain.length === 0) {
    push('WRONG_DOMAIN', 'missing domain');
  } else if (expectedDomain && challenge.domain !== expectedDomain) {
    push('WRONG_DOMAIN', `challenge '${challenge.domain}' != expected '${expectedDomain}'`);
  }

  // 3. purpose present and matches.
  if (typeof challenge?.purpose !== 'string' || challenge.purpose.length === 0) {
    push('MISSING_PURPOSE', 'challenge purpose required');
  } else if (expectedPurpose && challenge.purpose !== expectedPurpose) {
    push('WRONG_PURPOSE', `challenge '${challenge.purpose}' != expected '${expectedPurpose}'`);
  }

  // 3b. linking user/session context: a malformed context denies; when the
  //     server expects a context (or the challenge carries one) they must match
  //     exactly, so a proof cannot cross sessions/users. The canonical signed
  //     message also commits to this context (see step 10).
  let challengeContextString = canonicalizeContext(challenge?.context);
  if (challengeContextString === undefined) push('MALFORMED_CONTEXT', 'challenge context must be a flat object of finite primitives');
  else {
    const expectedContextString = canonicalizeContext(expectedContext);
    if (expectedContext !== undefined && expectedContextString === undefined) push('MALFORMED_CONTEXT', 'expectedContext must be a flat object of finite primitives');
    if (challengeContextString === null && expectedContext !== undefined) {
      push('MISSING_CONTEXT', 'challenge lacks the required linking user/session context');
    } else if (expectedContext === undefined && challengeContextString !== null) {
      // A context-bearing challenge cannot be accepted when the server did not
      // state what user/session it belongs to (fail closed on identity binding).
      push('MISSING_EXPECTED_CONTEXT', 'challenge carries a context but no expected user/session context was supplied');
    } else if (challengeContextString !== null && challengeContextString !== expectedContextString) {
      push('CONTEXT_MISMATCH', `challenge context ${challengeContextString} != expected ${expectedContextString}`);
    }
  }

  // 4. nonce is exactly 32 bytes.
  const badNonce = !(challenge?.nonce instanceof Uint8Array) || challenge.nonce.length !== 32;
  if (badNonce) push('BAD_NONCE', 'nonce must be exactly 32 bytes');

  // 4b. single-use reservation (synchronous, BEFORE any await): reserve the nonce
  //     so overlapping/await-interleaved verifications of the same nonce cannot
  //     both pass. A failure releases the reservation below (so a retry after a
  //     transient failure stays possible); success keeps it consumed exactly once.
  let reservedNonce = null;
  if (!badNonce) {
    const nk = nonceKey(challenge.nonce);
    if (consumedNonces.has(nk)) {
      push('REUSED_NONCE', nk);
    } else {
      consumedNonces.add(nk);
      reservedNonce = nk;
    }
  }

  // 5. timestamps: present (not NaN/Infinity), integer, not future, positive
  //    TTL <= 5m, and exact expiry.
  for (const f of validateChallengeTimes(challenge ?? {}, nowMs)) push(f.code, f.detail);

  // 6. account shape sanity (heuristic; SDK/RPC validator is authoritative).
  if (validateAccountIdShape(challenge?.accountId) === false) {
    push('INVALID_ACCOUNT', `account '${challenge?.accountId}'`);
  }

  // 7. signer account must equal the challenge account (no foreign-key claim).
  if (proof?.accountId !== challenge?.accountId) {
    push('ACCOUNT_MISMATCH', `proof by '${proof?.accountId}' != challenge '${challenge?.accountId}'`);
  }

  // 8. account-control: prove the presented key belongs to the account.
  if (!badNonce && validateAccountIdShape(challenge?.accountId) !== false) {
    let keyBytes = null;
    let keyType = null;
    let keyParseError = null;
    try {
      const parsed = parseNearPublicKey(proof?.publicKey);
      keyBytes = parsed.bytes;
      keyType = parsed.keyType;
      if (parsed.bytes.length !== 32) keyParseError = 'BAD_PUBLIC_KEY';
    } catch (e) {
      keyParseError = 'BAD_PUBLIC_KEY';
    }

    const implicit = isImplicitAccount(challenge.accountId);
    if (keyParseError) {
      push(keyParseError, proof?.publicKey);
    } else if (typeof accessKeyVerifier === 'function') {
      // A trusted resolver is the production path for BOTH implicit and named
      // accounts: crypto alone cannot prove current on-chain membership/permission.
      const rv = await accessKeyVerifier({
        accountId: challenge.accountId,
        publicKey: proof.publicKey,
        network: challenge.network,
      });
      const implicitNotYetFunded =
        implicit &&
        keyType === 'ed25519' &&
        Buffer.from(keyBytes).toString('hex') === challenge.accountId.toLowerCase();
      const va = validateResolvedAccessKey(rv, {
        accountId: challenge.accountId,
        network: challenge.network,
        publicKey: proof.publicKey,
        keyType,
        nowMs,
        maxFreshnessMs,
        requiredAccessKeyType: REQUIRED_ACCESS_KEY_TYPE,
      });
      for (const f of va.failures) {
        // Only for a not-yet-funded implicit account (id == key, ed25519) is an
        // ACCOUNT_NOT_FOUND acceptable — and ONLY when the caller explicitly opted
        // into the fixture-only `allowLocalImplicitFallback` flag (the account does
        // not exist on-chain yet, so there are no keys to add/remove). Without that
        // explicit opt-in, ACCOUNT_NOT_FOUND DENIES (fail-closed) exactly like any
        // other resolver denial (removed key, wrong permission, wrong account/key/
        // network, stale, malformed). Codex harness-review: the exception previously
        // bypassed live resolver denial even with the flag false — now it is gated.
        if (allowLocalImplicitFallback === true && implicitNotYetFunded && f.code === 'ACCOUNT_NOT_FOUND') continue;
        push(f.code, f.detail);
      }
    } else if (implicit && allowLocalImplicitFallback === true) {
      // EXPLICIT FIXTURE-ONLY fallback (caller opted in via allowLocalImplicitFallback).
      // An implicit account id IS the ed25519 public key (64 hex chars). Necessary
      // but not sufficient once the account exists on-chain; live auth MUST inject a
      // resolver instead. This branch is unreachable in live verification.
      const keyHex = Buffer.from(keyBytes).toString('hex');
      if (keyType !== 'ed25519') push('KEY_TYPE_MISMATCH', `implicit account requires ed25519 (got ${keyType})`);
      else if (keyHex !== challenge.accountId.toLowerCase()) {
        push('ACCOUNT_KEY_MISMATCH', `implicit account '${challenge.accountId}' but key is ${keyHex}`);
      }
    } else {
      // No trusted resolver, and no explicit fixture opt-in: fail closed for BOTH
      // named and implicit accounts. Default live authentication has no local
      // access-key membership proof.
      const detail = implicit
        ? `implicit account '${challenge.accountId}' requires a trusted network access-key resolver (or the explicit fixture-only flag)`
        : `named account '${challenge.accountId}' requires a trusted network access-key resolver`;
      push('ACCOUNT_KEY_UNVERIFIED', detail);
    }
  }

  // 9. replay: handled by the synchronous nonce reservation in step 4b (a
  //    REUSED_NONCE failure is recorded there before any await; a stale/foreign
  //    nonce never reaches the crypto step, and overlapping awaits share one Set).

  // 10. canonical message binding: the signed message must commit to the exact
  //     domain/network/purpose/account/times/nonce we are enforcing.
  if (!badNonce && challenge.message !== canonicalChallengeMessage(challenge)) {
    push('MESSAGE_NOT_BOUND', 'signed message must equal the canonical binding of domain/network/purpose/account/times/nonce');
  }

  // 11. cryptographic binding (ed25519 only; secp256k1 fails closed in nep413).
  let cryptoFailure = null;
  if (!badNonce) {
    const v = verifyNep413SignedMessage({
      message: challenge.message,
      nonce: challenge.nonce,
      recipient: challenge.domain,
      callbackUrl: challenge.callbackUrl ?? undefined,
      accountId: proof?.accountId,
      publicKey: proof?.publicKey,
      signature: proof?.signature,
    });
    if (!v.ok) {
      push(v.code, v.detail);
      cryptoFailure = v;
    }
  } else {
    cryptoFailure = { code: 'BAD_NONCE', detail: 'crypto verification skipped (nonce malformed)' };
  }

  if (failures.length === 0) {
    // The nonce stays reserved (== consumed) in `consumedNonces` on success.
    return { ok: true, code: 'OK' };
  }
  if (reservedNonce) consumedNonces.delete(reservedNonce); // release on failure -> a later honest retry is allowed
  return { ok: false, code: failures[0].code, failures, cryptoFailure: cryptoFailure ?? null };
}