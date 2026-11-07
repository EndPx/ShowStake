// Origin / CSRF authorization for session-writing requests.
//
// State-changing requests that write session state (set a session cookie, or
// revoke it) must be authorized by a same-origin browser context. The check reads
// ONLY the `origin` header (falling back to a same-origin `referer` for clients
// that omit `Origin`); it never reads `x-forwarded-*`, so `trustProxy` and
// spoofed proxy headers cannot satisfy the check. A missing origin/referer on a
// session write is rejected (fail-closed) — browsers always send `Origin` on
// cross-origin-and-same-origin unsafe (POST) fetches/XHR.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Errors } from '../errors.js';
import type { Config } from '../config.js';

function normalizeOrigin(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().replace(/\/+$/, '').toLowerCase();
  if (v.length === 0 || v === 'null' || v === 'undefined') return null;
  return v;
}

function originFromReferer(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  try {
    const u = new URL(value);
    return normalizeOrigin(u.origin);
  } catch {
    return null;
  }
}

/** Allowed origins from config (exact lowercase origin strings, no trailing slash). */
export function allowedOrigins(config: Config): Set<string> {
  const set = new Set<string>();
  for (const o of config.allowedOrigins) {
    const n = normalizeOrigin(o);
    if (n) set.add(n);
  }
  return set;
}

/**
 * preHandler factory used on session-writing mutations (`/v1/auth/verify`,
 * `/v1/auth/logout`). Returns 403 on a missing/foreign origin; never consults a
 * proxy header.
 */
export function makeOriginCheck(config: Config) {
  const allowed = allowedOrigins(config);
  return async function requireOrigin(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const origin = normalizeOrigin((req.headers as { origin?: string }).origin);
    const candidate = origin ?? originFromReferer((req.headers as { referer?: string }).referer);
    if (!candidate) {
      throw Errors.forbidden('ORIGIN_REQUIRED', 'session write requires a same-origin Origin/Referer header');
    }
    if (!allowed.has(candidate)) {
      throw Errors.forbidden('ORIGIN_MISMATCH', 'Origin is not an allowed app origin for a session write');
    }
  };
}