import { isKnownNetwork } from '@showstake/domain';

/** Fixed, server-side configuration. No secrets live here (only non-secret policy). */
export interface Config {
  host: string;
  accessContractAllowlist?: string[];
  /** Explicit deployment-to-ABI binding, e.g. testnet:escrow.testnet=candidate-v1. */
  accessContractAbis: Record<string, string>;
  qrHmacKey?: string;
  privateContentDir?: string;
  port: number;
  /** Fixed expected app domain (the NEP-413 `recipient` the user is shown). */
  authDomain: string;
  /** Fixed expected network for proof-of-control challenges. */
  authNetwork: string;
  /** Fixed challenge purpose string. */
  authPurpose: string;
  /** Challenge TTL in ms (capped at the wallet-adapter 5-minute maximum when issued). */
  challengeTtlMs: number;
  /** Session idle/absolute lifetimes in ms. */
  sessionIdleMs: number;
  sessionAbsoluteMs: number;
  /** Mainnet/testnet/local RPC base URLs or null when unavailable (fail-closed). */
  rpcUrls: { testnet: string | null; mainnet: string | null; local: string | null };
  /** how long a resolved on-chain access key may be taken before it counts as stale. */
  keyFreshnessMs: number;
  cookieName: string;
  cookieSecure: boolean;
  cookieSameSite: 'strict' | 'lax' | 'none';
  cookiePath: string;
  trustProxy: boolean;
  databaseUrl: string | null;
  dbRole: string | null;
  /** Exact allowed browser origins for CSRF/origin defense on session writes. */
  allowedOrigins: string[];
  /** Projection reads older than this are reported `meta.stale: true`. */
  projectionFreshnessMs: number;
  /** Challenge rate limit: fixed window (default 10 per 60s per IP). */
  challengeRateLimit: { windowMs: number; maxPerWindow: number };
}

const N = (v: string | undefined, d: number): number => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return d;
  return Math.floor(n);
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const authDomain = env.AUTH_DOMAIN ?? '';
  const authNetwork = env.AUTH_NETWORK ?? '';
  const authPurpose = env.AUTH_PURPOSE ?? 'login';

  if (!authDomain) throw new Error('AUTH_DOMAIN is required (fixed expected app origin)');
  if (!authNetwork || !isKnownNetwork(authNetwork)) {
    throw new Error(`AUTH_NETWORK must be one of local|testnet|mainnet (got ${JSON.stringify(env.AUTH_NETWORK ?? null)})`);
  }
  if (!authPurpose) throw new Error('AUTH_PURPOSE must not be empty');

  return {
    accessContractAllowlist: (env.ACCESS_CONTRACT_ALLOWLIST ?? '').split(',').map(x=>x.trim()).filter(Boolean),
    accessContractAbis: Object.fromEntries((env.ACCESS_CONTRACT_ABIS ?? '').split(',').map(x=>x.trim()).filter(Boolean).map(x=>{ const parts=x.split('='); if(parts.length!==2 || !parts[0] || !['candidate-v1','legacy-v6'].includes(parts[1]!)) throw new Error('invalid ACCESS_CONTRACT_ABIS'); return [parts[0]!,parts[1]!]; })),
    qrHmacKey: env.QR_HMAC_KEY,
    privateContentDir: env.PRIVATE_CONTENT_DIR,
    host: env.HOST ?? '127.0.0.1',
    port: N(env.PORT, 3001),
    authDomain,
    authNetwork,
    authPurpose,
    challengeTtlMs: N(env.CHALLENGE_TTL_MS, 5 * 60 * 1000),
    sessionIdleMs: N(env.SESSION_IDLE_MS, 15 * 60 * 1000),
    sessionAbsoluteMs: N(env.SESSION_ABSOLUTE_MS, 24 * 60 * 60 * 1000),
    rpcUrls: {
      testnet: env.RPC_TESTNET_URL || 'https://rpc.testnet.near.org',
      mainnet: env.RPC_MAINNET_URL || 'https://rpc.mainnet.near.org',
      local: env.RPC_LOCAL_URL || null,
    },
    keyFreshnessMs: N(env.KEY_FRESHNESS_MS, 5 * 60 * 1000),
    cookieName: env.COOKIE_NAME ?? 'showstake_session',
    cookieSecure: env.COOKIE_SECURE !== 'false',
    cookieSameSite: env.COOKIE_SAME_SITE === 'none' ? 'none' : env.COOKIE_SAME_SITE === 'strict' ? 'strict' : 'lax',
    cookiePath: '/',
    trustProxy: env.TRUST_PROXY === 'true',
    databaseUrl: env.DATABASE_URL ?? null,
    dbRole: env.DB_ROLE ?? null,
    allowedOrigins: buildAllowedOrigins(env, authDomain),
    projectionFreshnessMs: N(env.PROJECTION_FRESHNESS_MS, 60 * 1000),
    challengeRateLimit: {
      windowMs: N(env.RATE_LIMIT_WINDOW_MS, 60 * 1000),
      maxPerWindow: N(env.RATE_LIMIT_CHALLENGE_MAX, 10),
    },
  };
}

/** Allowed browser origins: explicit `AUTH_ALLOWED_ORIGINS` (comma-separated) wins; otherwise derive from the fixed app domain over http/https. */
function buildAllowedOrigins(env: NodeJS.ProcessEnv, authDomain: string): string[] {
  const raw = env.AUTH_ALLOWED_ORIGINS;
  if (raw !== undefined && raw.trim() !== '') {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [`https://${authDomain}`, `http://${authDomain}`];
}
