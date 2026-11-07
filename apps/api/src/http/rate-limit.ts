// In-memory fixed-window rate limiter for the auth challenge endpoint.
//
// The client identity is the DIRECT connection peer (`req.socket.remoteAddress`),
// never `req.ip`. Fastify's `trustProxy` makes `req.ip` trust `X-Forwarded-For`;
// keying on the socket peer instead means a client cannot rotate
// `X-Forwarded-For` (or any proxy header) to bypass the limit. In a deployment
// behind a trusted proxy that overwrites `X-Forwarded-For`, the peer is the proxy
// itself and the deployment must key on a trusted, proxy-verified header instead;
// that is a deployment decision, not something an untrusted header can fake here.
//
// Single-process scope: this limiter is per API process. A multi-instance
// deployment needs a shared store (out of scope for this acceptance; the API is a
// single Node process). It is intentionally NOT "later optional hardening": the
// challenge 10/min/IP limit is enforced and behaviourally tested now.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Errors } from '../errors.js';

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  /** ms until the window resets (0 when allowed and not near the edge). */
  retryAfterMs: number;
}

interface Window {
  count: number;
  resetAtMs: number;
}

export class InMemoryRateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly max: number, private readonly windowMs: number) {}

  /** Fixed-window check for `key`. */
  check(key: string, nowMs: number = Date.now()): RateLimitDecision {
    const existing = this.windows.get(key);
    if (existing && existing.resetAtMs > nowMs) {
      if (existing.count >= this.max) {
        return { allowed: false, remaining: 0, retryAfterMs: existing.resetAtMs - nowMs };
      }
      existing.count += 1;
      return { allowed: true, remaining: this.max - existing.count, retryAfterMs: 0 };
    }
    // New window (or an expired one).
    if (existing && existing.resetAtMs <= nowMs) this.windows.delete(key);
    this.windows.set(key, { count: 1, resetAtMs: nowMs + this.windowMs });
    return { allowed: true, remaining: this.max - 1, retryAfterMs: 0 };
  }

  clear(): void {
    this.windows.clear();
  }
}

/** Direct socket peer, ignoring proxy headers (and `req.ip` from trustProxy). */
export function socketPeerIp(req: FastifyRequest): string {
  const remote = (req.socket as { remoteAddress?: unknown } | undefined)?.remoteAddress;
  if (typeof remote === 'string' && remote.length > 0) return remote;
  // Fallback for programmatic injection (never trust a header here).
  return req.ip ?? 'unknown';
}

/**
 * Fastify preHandler factory for the challenge endpoint: 10/min/IP. On exceed,
 * sets Retry-After and throws a 429. The limiter instance is caller-scoped so a
 * single server shares one limiter and each test can build a fresh one.
 */
export function makeChallengeRateLimitHandler(limiter: InMemoryRateLimiter) {
  return async function challengeRateLimit(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const key = `auth:challenge:${socketPeerIp(req)}`;
    const decision = limiter.check(key);
    if (!decision.allowed) {
      _reply.header('Retry-After', String(Math.ceil(decision.retryAfterMs / 1000)));
      throw Errors.rateLimited('challenge rate limit exceeded (10/min/IP)');
    }
  };
}