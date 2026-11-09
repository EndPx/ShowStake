import type { FastifyReply, FastifyRequest } from 'fastify';
import { Errors } from '../errors.js';
import { sha256Hex } from '../lib/util.js';
import type { Config } from '../config.js';
import type { Store } from '../store/types.js';
import { idleDeadlineFrom, sessionIsActive } from './session.js';

/**
 * Resolve and slide the current session from the HttpOnly session cookie.
 * Rejects missing/revoked/absolute-expired/idle-expired sessions with 401.
 */
export function requireSession(store: Store, config: Config) {
  return async function preHandler(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies;
    const token = cookies?.[config.cookieName];
    if (typeof token !== 'string' || token.length === 0) {
      throw Errors.unauthorized('NO_SESSION', 'missing or empty session cookie');
    }
    const tokenHash = sha256Hex(token);
    const nowMs = Date.now();
    const session = await store.getSessionByTokenHash(tokenHash, nowMs);
    const verdict = sessionIsActive(session, nowMs);
    if (!verdict.ok) {
      throw Errors.unauthorized(verdict.code, 'session is not active');
    }
    // Slide the idle deadline on authenticated activity.
    await store.touchSession(tokenHash, nowMs, idleDeadlineFrom(nowMs, config.sessionIdleMs));
    req.auth = {
      userId: verdict.session!.userId,
      sessionId: verdict.session!.id,
      tokenHash,
      accountId: null,
      network: null,
    };
    if (verdict.session!.walletBindingId) {
      const binding = await store.getBindingById(verdict.session!.walletBindingId);
      if (!binding) throw Errors.unauthorized('WALLET_BINDING_UNAVAILABLE', 'verified wallet binding is unavailable');
      req.auth.accountId = binding.accountId;
      req.auth.network = binding.network;
    }
  };
}
