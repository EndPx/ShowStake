// Module augmentation for FastifyRequest. The `export {}` makes this file a
// module, so `declare module 'fastify'` AUGMENTS the real fastify types instead
// of replacing them.
export {};

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireSession for authenticated routes. */
    auth?: {
      userId: string;
      sessionId: string;
      tokenHash: string;
      accountId: string | null;
      network: string | null;
    };
  }
}
