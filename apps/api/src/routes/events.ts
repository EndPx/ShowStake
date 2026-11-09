import { paginationLimit, okEnvelope } from '@showstake/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Errors } from '../errors.js';
import { isUuid } from '../lib/util.js';
import { decodeEventCursor } from '../lib/cursor.js';
import type { Config } from '../config.js';
import type { Store } from '../store/types.js';
import type { PublicEvent } from '../types.js';

/**
 * Conservative projection freshness for the `meta.stale` flag. A projection read
 * is fresh only when its `observedAt` is supplied AND within the freshness window;
 * a missing/unparseable/too-old observed stamp reports `stale: true` (never assert
 * freshness we cannot prove). Old seeded projections therefore report stale.
 */
export function projectionStale(observedAtMs: number | null, nowMs: number, freshnessMs: number): boolean {
  if (observedAtMs === null || !Number.isFinite(observedAtMs)) return true;
  return nowMs - observedAtMs > freshnessMs;
}

function meta(req: FastifyRequest, props: { network: string | null; stale: boolean }): Record<string, unknown> {
  return { requestId: req.id, observedAt: new Date().toISOString(), network: props.network, stale: props.stale };
}

function itemsStale(items: PublicEvent[], nowMs: number, freshnessMs: number): boolean {
  if (items.length === 0) return true; // no reliable observed state -> stale/unavailable
  let newest: number | null = null;
  for (const it of items) {
    const t = Date.parse(it.observedAt);
    const valid = Number.isFinite(t) ? t : null;
    if (valid === null) return true; // any unparseable stamp => conservative stale
    newest = newest === null ? valid : Math.max(newest, valid);
  }
  return projectionStale(newest, nowMs, freshnessMs);
}

/**
 * Public event reads (no pass, no session): content + finalized rules/counts.
 * Money is serialized as canonical u128 strings; `registeredCount` is the
 * non-withdrawn registration count (a real derived count, never a guessed
 * "available seats").
 */
export function registerEvents(app: FastifyInstance, store: Store, config: Config): void {
  app.get<{ Querystring: { cursor?: string; limit?: string } }>('/v1/events', async (req, reply) => {
    let cursor: { regOpen: string; id: string } | null = null;
    if (req.query.cursor !== undefined) {
      const decoded = decodeEventCursor(req.query.cursor);
      if (!decoded) throw Errors.invalid('CURSOR_INVALID', 'cursor is not a valid opaque pagination cursor');
      cursor = decoded;
    }
    let limit: number = paginationLimit();
    if (req.query.limit !== undefined) {
      if (!/^[0-9]+$/.test(req.query.limit)) throw Errors.invalid('LIMIT_INVALID', 'limit must be a positive integer');
      limit = paginationLimit(Number(req.query.limit));
    }
    const data = await store.listEvents({ limit, cursor });
    return reply.send(okEnvelope(data, meta(req, { network: null, stale: itemsStale(data.items, Date.now(), config.projectionFreshnessMs) })));
  });

  app.get<{ Params: { eventId: string } }>('/v1/events/:eventId', async (req, reply) => {
    const { eventId } = req.params;
    if (!isUuid(eventId) && (!/^[A-Za-z0-9._:-]{1,128}$/.test(eventId) || eventId.toLowerCase().includes('uuid'))) throw Errors.invalid('EVENT_ID_INVALID', 'eventId must be a UUID or contract event id');
    const event = isUuid(eventId) ? await store.getEvent(eventId) : await store.getEventByChainEventId(eventId);
    if (!event) throw Errors.notFound('event');
    const observedMs = Number.isFinite(Date.parse(event.observedAt)) ? Date.parse(event.observedAt) : null;
    return reply.send(okEnvelope(event, meta(req, { network: event.network, stale: projectionStale(observedMs, Date.now(), config.projectionFreshnessMs) })));
  });

  app.get<{ Params: { eventId: string } }>('/v1/events/:eventId/results', async (req, reply) => {
    const { eventId } = req.params;
    if (!isUuid(eventId) && (!/^[A-Za-z0-9._:-]{1,128}$/.test(eventId) || eventId.toLowerCase().includes('uuid'))) throw Errors.invalid('EVENT_ID_INVALID', 'eventId must be a UUID or contract event id');
    const results = await store.getEventResults(eventId);
    if (!results) throw Errors.notFound('event');
    const event = isUuid(eventId) ? await store.getEvent(eventId) : await store.getEventByChainEventId(eventId);
    const stale = projectionStale(Date.parse(results.observedAt), Date.now(), config.projectionFreshnessMs);
    return reply.send(okEnvelope(results, meta(req, { network: event?.network ?? null, stale })));
  });
}
