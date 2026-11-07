import { makeChallenge, verifyChallengeProof } from '@showstake/wallet-adapter';
import { Errors } from '../errors.js';
import { hexToNonce, isUuid, newUuid, randomToken, sha256Hex } from '../lib/util.js';
import type { Config } from '../config.js';
import type { Store } from '../store/types.js';
import type { AccessKeyVerifier } from '../types-external.js';

export interface VerifyBody {
  challengeId: string;
  accountId: string;
  network: string;
  domain: string;
  nonce: string;
  publicKey: string;
  signature: string;
}

export interface VerifySuccess {
  token: string;
  userId: string;
  sessionId: string;
  accountId: string;
  network: string;
  walletBindingId: string;
  absoluteExpiresAtMs: number;
}

/**
 * Consume a challenge proof and open a session. Crypto + on-chain access-key
 * verification run OUTSIDE the transaction; the DB single-use nonce consumption
 * and session creation are one atomic transaction (per 03-DATABASE.md), so a
 * replayed/concurrent nonce cannot both succeed.
 */
export async function verifyLogin(
  store: Store,
  config: Config,
  accessKeyVerifier: AccessKeyVerifier,
  body: VerifyBody,
  nowFn: () => number = Date.now,
): Promise<VerifySuccess> {
  // Shape validation -> 422 (never treated as a proof attempt).
  if (typeof body.challengeId !== 'string' || !isUuid(body.challengeId)) {
    throw Errors.invalid('CHALLENGE_ID_INVALID', 'challengeId must be a UUID');
  }
  for (const f of ['accountId', 'network', 'domain', 'nonce', 'publicKey', 'signature'] as const) {
    if (typeof body[f] !== 'string' || body[f].length === 0) {
      throw Errors.invalid('VERIFY_PARAM_INVALID', `${f} is required`);
    }
  }

  const challenge = await store.getChallenge(body.challengeId);
  if (!challenge) {
    throw Errors.unauthorized('CHALLENGE_NOT_FOUND', 'challenge does not exist');
  }
  if (challenge.consumedAt !== null) {
    throw Errors.unauthorized('CHALLENGE_ALREADY_CONSUMED', 'challenge nonce already consumed');
  }

  // Echo fields must equal the server-issued challenge (fail-closed).
  if (body.accountId !== challenge.accountId) {
    throw Errors.unauthorized('ACCOUNT_MISMATCH', 'accountId does not match the challenge');
  }
  if (body.network !== challenge.network) {
    throw Errors.unauthorized('WRONG_NETWORK', 'network does not match the challenge');
  }
  if (body.domain !== challenge.domain) {
    throw Errors.unauthorized('WRONG_DOMAIN', 'domain does not match the challenge');
  }

  // The nonce is NOT persisted (only its hash); reconstruct it from the echoed
  // 64-hex value and prove hash equality before any crypto verification.
  const nonce = hexToNonce(body.nonce);
  if (!nonce) {
    throw Errors.invalid('BAD_NONCE', 'nonce must be exactly 32 bytes (64 hex chars)');
  }
  if (sha256Hex(nonce) !== challenge.nonceHash) {
    throw Errors.unauthorized('NONCE_MISMATCH', 'nonce does not match the issued challenge');
  }

  const proof = { accountId: body.accountId, publicKey: body.publicKey, signature: body.signature };
  const rebuilt = makeChallenge({
    purpose: challenge.purpose,
    domain: challenge.domain,
    network: challenge.network,
    accountId: challenge.accountId,
    nonce,
    issuedAtMs: challenge.issuedAtMs,
    expiresAtMs: challenge.expiresAtMs,
    callbackUrl: null,
    message: null,
  });

  // Resolve before taking the verifier's clock snapshot. A real RPC response
  // stamps verifiedAt on arrival; comparing it with the pre-request clock would
  // incorrectly reject every non-instant response as being from the future.
  const resolvedKey = await accessKeyVerifier({ accountId: body.accountId, publicKey: body.publicKey, network: body.network });
  const verdict = await verifyChallengeProof({
    challenge: rebuilt,
    proof,
    consumedNonces: new Set<string>(),
    expectedDomain: config.authDomain,
    expectedNetwork: config.authNetwork,
    expectedPurpose: config.authPurpose,
    nowMs: nowFn(),
    accessKeyVerifier: async () => resolvedKey,
    maxFreshnessMs: config.keyFreshnessMs,
    allowLocalImplicitFallback: false,
    expectedContext: undefined,
  });

  if (!verdict.ok) {
    const code = verdict.code || (verdict.failures?.[0]?.code ?? 'VERIFY_FAILED');
    // Sanitized: never echo signature/nonce material back to the caller/logs.
    const detail = verdict.failures?.[0]?.detail ?? verdict.cryptoFailure?.detail;
    throw Errors.unauthorized(code, 'proof-of-control verification failed', detail ? String(detail).slice(0, 200) : undefined);
  }

  // Re-check expiry/freshness AFTER the awaited verifier. `verifyChallengeProof`
  // validated timestamps BEFORE its own `await accessKeyVerifier(...)`; the RPC
  // may have run long enough to cross `expiresAtMs` since then. Use a fresh clock
  // read and refuse to open a session on an expired challenge (the store also
  // re-checks against DB time at the atomic update, so this cannot be bypassed).
  const nowAfterVerifier = nowFn();
  if (!Number.isFinite(nowAfterVerifier) || nowAfterVerifier >= challenge.expiresAtMs) {
    throw Errors.unauthorized('STALE_PROOF', 'challenge expired during verification');
  }

  const token = randomToken();
  const tokenHash = sha256Hex(token);
  const sessionId = newUuid();

  const opened = await store.consumeAndOpenSession({
    challengeId: challenge.id,
    namespace: 'near',
    network: challenge.network,
    accountId: challenge.accountId,
    walletKind: 'participant',
    sessionId,
    tokenHash,
    idleMs: config.sessionIdleMs,
    absoluteMs: config.sessionAbsoluteMs,
  });
  if (!opened) {
    throw Errors.unauthorized('CHALLENGE_ALREADY_CONSUMED', 'challenge nonce already consumed or expired');
  }

  return {
    token,
    userId: opened.userId,
    sessionId: opened.sessionId,
    accountId: challenge.accountId,
    network: challenge.network,
    walletBindingId: opened.bindingId,
    absoluteExpiresAtMs: opened.nowMs + config.sessionAbsoluteMs,
  };
}
