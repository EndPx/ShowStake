import { makeChallenge, MAX_CHALLENGE_TTL_MS } from '@showstake/wallet-adapter';
import { Errors } from '../errors.js';
import { sha256Hex, nonceToHex, randomNonce, newUuid } from '../lib/util.js';
import { isValidNearAccountId } from '../lib/account-id.js';
import type { Config } from '../config.js';
import type { Store } from '../store/types.js';
import type { ChallengeIssueRow } from '../types.js';

export interface ChallengeBody {
  accountId: string;
  network: string;
  domain: string;
}

/**
 * Issue a server-side, short-lived, single-use login challenge. Returns the
 * exact canonical message the wallet must sign (NEP-413), the 32-byte nonce
 * (hex) and challenge id. Only the nonce hash is persisted.
 */
export async function issueLoginChallenge(
  store: Store,
  config: Config,
  body: ChallengeBody,
): Promise<ChallengeIssueRow> {
  if (typeof body.accountId !== 'string' || body.accountId.length === 0) {
    throw Errors.invalid('ACCOUNT_INVALID', 'accountId is required');
  }
  if (!isValidNearAccountId(body.accountId)) {
    throw Errors.invalid('ACCOUNT_INVALID', 'accountId is not a valid NEAR account id', body.accountId);
  }
  if (body.network !== config.authNetwork) {
    throw Errors.invalid('WRONG_NETWORK', `network must match the fixed expected network`);
  }
  if (body.domain !== config.authDomain) {
    throw Errors.invalid('WRONG_DOMAIN', 'domain must match the fixed expected app origin');
  }

  const nonce = randomNonce();
  const nonceHash = sha256Hex(nonce);
  const issuedAtMs = Date.now();
  const ttl = Math.min(config.challengeTtlMs, MAX_CHALLENGE_TTL_MS);
  const expiresAtMs = issuedAtMs + ttl;

  const challenge = makeChallenge({
    purpose: config.authPurpose,
    domain: config.authDomain,
    network: config.authNetwork,
    accountId: body.accountId,
    nonce,
    issuedAtMs,
    expiresAtMs,
    callbackUrl: null,
  });
  if (challenge.message == null) {
    throw new Error('failed to build canonical challenge message');
  }
  const id = newUuid();
  await store.createChallenge({
    id,
    nonceHash,
    purpose: config.authPurpose,
    domain: config.authDomain,
    network: config.authNetwork,
    accountId: body.accountId,
    linkingUserId: null,
    issuedAtMs,
    expiresAtMs,
  });

  return {
    id,
    nonce: nonceToHex(nonce),
    nonceHash,
    purpose: config.authPurpose,
    domain: config.authDomain,
    network: config.authNetwork,
    accountId: body.accountId,
    issuedAtMs,
    expiresAtMs,
    message: challenge.message,
  };
}