import type { FastifyInstance } from 'fastify';
import type { Store } from '../store/types.js';

/**
 * Liveness + readiness for the process. /health is outside /v1 and returns a
 * plain ops payload (not the /v1 {data,meta,error} envelope).
 */
export function registerHealth(app: FastifyInstance, store: Store): void {
  app.get('/health', async (_req, reply) => {
    const db = await store.ping();
    if (db) {
      return reply.code(200).send({ status: 'ok', db: 'up' });
    }
    return reply.code(503).send({ status: 'degraded', db: 'down' });
  });
}