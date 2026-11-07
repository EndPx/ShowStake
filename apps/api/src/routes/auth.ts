import { okEnvelope } from '@showstake/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Store } from '../store/types.js';
import type { AccessKeyVerifier } from '../types-external.js';
import { issueLoginChallenge, type ChallengeBody } from '../auth/challenge.js';
import { verifyLogin, type VerifyBody } from '../auth/verify.js';
import { requireSession } from '../auth/middleware.js';
import { sessionIsActive } from '../auth/session.js';
import { InMemoryRateLimiter, makeChallengeRateLimitHandler } from '../http/rate-limit.js';
import { makeOriginCheck } from '../http/origin.js';

/**
 * `meta.stale` is the projection-source freshness flag. Auth/session responses do
 * NOT carry projection data, so — conservatively and to honour "never assert
 * freshness before worker freshness exists" — they always report `stale: true`.
 * Only the events routes derive a (possibly fresh) value from their `observedAt`.
 */
function meta(req: FastifyRequest, network: string | null): Record<string, unknown> {
  return { requestId: req.id, observedAt: new Date().toISOString(), network, stale: true };
}

export function registerAuth(app: FastifyInstance, store: Store, config: Config, accessKeyVerifier: AccessKeyVerifier): void {
  const challengeLimiter = new InMemoryRateLimiter(config.challengeRateLimit.maxPerWindow, config.challengeRateLimit.windowMs);
  const challengeRateLimit = makeChallengeRateLimitHandler(challengeLimiter);
  const originCheck = makeOriginCheck(config);

  // Public: issue a server-signed short-lived single-use login challenge.
  app.post<{ Body: ChallengeBody }>('/v1/auth/challenge', { preHandler: challengeRateLimit }, async (req, reply) => {
    const c = await issueLoginChallenge(store, config, req.body ?? ({} as ChallengeBody));
    return reply.send(okEnvelope(
      {
        challengeId: c.id,
        nonce: c.nonce,
        domain: c.domain,
        network: c.network,
        accountId: c.accountId,
        purpose: c.purpose,
        issuedAtMs: c.issuedAtMs,
        expiresAtMs: c.expiresAtMs,
        expiresAt: new Date(c.expiresAtMs).toISOString(),
        message: c.message,
      },
      meta(req, config.authNetwork),
    ));
  });

  // Public: verify the NEP-413 proof and open a session (sets the session cookie).
  // Session write => same-origin (CSRF) origin defense applies before any work.
  app.post<{ Body: VerifyBody }>('/v1/auth/verify', { preHandler: originCheck }, async (req, reply) => {
    const result = await verifyLogin(store, config, accessKeyVerifier, req.body ?? ({} as VerifyBody));
    reply.setCookie(config.cookieName, result.token, {
      path: config.cookiePath,
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: config.cookieSameSite,
      maxAge: Math.floor(config.sessionAbsoluteMs / 1000),
    });
    return reply.send(okEnvelope(
      {
        userId: result.userId,
        accountId: result.accountId,
        network: result.network,
        expiresAt: new Date(result.absoluteExpiresAtMs).toISOString(),
      },
      meta(req, result.network),
    ));
  });

  // Authenticated: revoke the current session and clear the cookie.
  app.post<{ Body: Record<string, never> }>(
    '/v1/auth/logout',
    { preHandler: [requireSession(store, config), originCheck] },
    async (req, reply) => {
      const revoked = await store.revokeSession(req.auth!.tokenHash, Date.now());
      reply.clearCookie(config.cookieName, { path: config.cookiePath });
      return reply.send(okEnvelope({ loggedOut: true, revoked }, meta(req, null)));
    },
  );

  // Authenticated: current session identity (session-lifecycle test surface).
  app.get('/v1/me', { preHandler: requireSession(store, config) }, async (req, reply) => {
    const tokenHash = req.auth!.tokenHash;
    const session = await store.getSessionByTokenHash(tokenHash, Date.now());
    const verdict = sessionIsActive(session, Date.now());
    return reply.send(okEnvelope(
      { userId: req.auth!.userId, sessionId: req.auth!.sessionId, active: verdict.ok },
      meta(req, null),
    ));
  });
}