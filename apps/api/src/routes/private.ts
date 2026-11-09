import { okEnvelope } from '@showstake/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { Errors } from '../errors.js';
import { requireSession } from '../auth/middleware.js';
import type { Store } from '../store/types.js';
import { isUuid } from '../lib/util.js';

const meta = (req: FastifyRequest, network: string | null, stale: boolean) => ({ requestId:req.id, observedAt:new Date().toISOString(), network, stale });
const staleAt = (iso: string, now: number, max: number) => { const t=Date.parse(iso); return !Number.isFinite(t) || now-t>max; };
function account(req: FastifyRequest): { accountId:string; network:string } {
  if (!req.auth?.accountId || !req.auth.network) throw Errors.forbidden('NEAR_BINDING_REQUIRED','a verified NEAR wallet binding is required');
  return {accountId:req.auth.accountId,network:req.auth.network};
}

export function registerPrivate(app: FastifyInstance, store: Store, config: Config): void {
  const auth = requireSession(store, config);
  app.get('/v1/me/passes', { preHandler: auth }, async (req, reply) => {
    const a=account(req); const items=await store.listPasses(a.accountId,a.network);
    return reply.send(okEnvelope({items},meta(req,a.network,items.some(x=>staleAt(x.observedAt,Date.now(),config.projectionFreshnessMs)))));
  });
  app.get('/v1/me/claims', { preHandler: auth }, async (req, reply) => {
    const a=account(req); const items=await store.listClaims(a.accountId,a.network);
    return reply.send(okEnvelope({items},meta(req,a.network,items.some(x=>staleAt(x.observedAt,Date.now(),config.projectionFreshnessMs)))));
  });
  app.get<{Params:{eventId:string}}>('/v1/events/:eventId/attendance', { preHandler: auth }, async (req, reply) => {
    if (!isUuid(req.params.eventId)) throw Errors.invalid('EVENT_ID_INVALID','eventId must be a UUID');
    const a=account(req); const items=await store.getAttendance(req.params.eventId,a.accountId,a.network);
    if (items===null) throw Errors.forbidden('ORGANIZER_REQUIRED','authenticated account is not the event organizer');
    const stale=items.some(x=>staleAt(x.observedAt,Date.now(),config.projectionFreshnessMs));
    if (stale) throw Errors.unavailable('PROJECTION_STALE','attendance projection is stale or unavailable');
    return reply.send(okEnvelope({items},meta(req,a.network,false)));
  });
  app.get<{Params:{eventId:string}}>('/v1/events/:eventId/content', { preHandler: auth }, async (req) => {
    if (!isUuid(req.params.eventId)) throw Errors.invalid('EVENT_ID_INVALID','eventId must be a UUID');
    const a=account(req); const items=await store.getContentAccess(req.params.eventId,a.accountId,a.network);
    if (items===null) throw Errors.forbidden('CONTENT_NOT_ELIGIBLE','current owner, finalized attendance, and SETTLED state are required');
    if (items.some(x=>staleAt(x.observedAt,Date.now(),config.projectionFreshnessMs))) throw Errors.unavailable('PROJECTION_STALE','content authorization data is stale or unavailable');
    // Object-storage signing is deliberately not guessed or replaced with a public URL.
    throw Errors.unavailable('CONTENT_SIGNER_UNAVAILABLE','private content is authorized but no verified object-storage signer is configured');
  });
}
