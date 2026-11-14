import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { errEnvelope } from '@showstake/domain';
import { ApiError } from './errors.js';
import { newUuid } from './lib/util.js';
import type { Config } from './config.js';
import type { Store } from './store/types.js';
import type { AccessKeyVerifier } from './types-external.js';
import { registerHealth } from './routes/health.js';
import { registerEvents } from './routes/events.js';
import { registerAuth } from './routes/auth.js';
import { registerPrivate } from './routes/private.js';
import { registerMainnetReadiness } from './routes/mainnet-readiness.js';
import { registerRheaMicrotest } from './routes/rhea-microtest.js';
import { registerFunding } from './routes/funding.js';
import type { FundingStore } from './store/funding-store.js';
import type { DirectStore } from './store/direct-store.js';
import { registerDirect } from './routes/direct.js';

export interface BuildOptions {
  store: Store;
  config: Config;
  accessKeyVerifier: AccessKeyVerifier;
  fundingStore?: FundingStore;
  directStore?: DirectStore;
}

/**
 * Build the Fastify app (injectable for tests). Every /v1 response is the
 * {data,meta,error} envelope; money stays a canonical u128 string at the JSON
 * boundary (enforced by @showstake/domain on writes AND when reading projection
 * money columns).
 */
export function buildApp(opts: BuildOptions): FastifyInstance {
  const app: FastifyInstance = Fastify({
    logger: false,
    trustProxy: opts.config.trustProxy,
    genReqId: () => newUuid(),
  });

  app.register(cookie, {});

  app.setErrorHandler((err, req, reply) => {
    const e = err as ApiError & { code?: string };
    if (e.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send(errEnvelope('BODY_TOO_LARGE', 'request body too large', { retryable:false, meta:{requestId:req.id,network:null} }));
    if (err instanceof ApiError && e.expose) {
      return reply.code(e.statusCode).send(
        errEnvelope(e.code, e.message, { retryable: e.retryable, meta: { requestId: req.id, network: null } }),
      );
    }
    // Uncontrolled error: sanitized 500 (no stack, no secret material).
    req.log.error({ kind: 'unhandled', code: e.code ?? null, message: e.message ?? null });
    return reply.code(500).send(
      errEnvelope('INTERNAL', 'internal server error', { retryable: true, meta: { requestId: req.id, network: null } }),
    );
  });

  registerHealth(app, opts.store);
  registerMainnetReadiness(app, opts.config);
  registerRheaMicrotest(app, opts.store, opts.config);
  registerEvents(app, opts.store, opts.config);
  registerAuth(app, opts.store, opts.config, opts.accessKeyVerifier);
  registerPrivate(app, opts.store, opts.config);
  registerDirect(app, opts.store, opts.config, opts.directStore);
  registerFunding(app, opts.store, opts.config, opts.fundingStore);

  return app;
}
