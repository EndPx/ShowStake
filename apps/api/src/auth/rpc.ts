import { makeNearRpcAccessKeyVerifier, DEFAULT_MAX_KEY_FRESHNESS_MS } from '@showstake/wallet-adapter';
import type { AccessKeyVerifier, ResolverResult } from '../types-external.js';
import type { Config } from '../config.js';

/**
 * Build the trusted network access-key resolver from fixed config. Read-only
 * (`query`/`view_access_key`); never broadcasts or spends. Fail-closed:
 *  - a network whose URL is absent (e.g. `local` unless RPC_LOCAL_URL is set) is
 *    DENIED with UNSUPPORTED_NETWORK (never a local fallback);
 *  - a transport/network error DENIES (final-state unavailability denies).
 */
export function buildAccessKeyVerifier(config: Config, keyType?: 'ed25519'): AccessKeyVerifier {
  const urls: Record<string, string | null> = {
    testnet: config.rpcUrls.testnet,
    mainnet: config.rpcUrls.mainnet,
    local: config.rpcUrls.local,
  };
  // type argument only used to infer via keyType (kept for future secp256k1 SDK path)
  void keyType;
  return makeNearRpcAccessKeyVerifier({
    getRpcUrl: (network: string) => urls[network] ?? null,
    transport: async (url: string, opts: { method: string; body: string }): Promise<unknown> => {
      const res = await fetch(url, { method: opts.method, headers: { 'content-type': 'application/json' }, body: opts.body, signal: AbortSignal.timeout(10000) });
      const text = await res.text();
      let parsed: unknown = null;
      try { parsed = JSON.parse(text); } catch { /* non-json */ }
      if (!res.ok) {
        return { error: { code: `HTTP_${res.status}`, message: (parsed as { error?: { message?: string } } | null)?.error?.message ?? text.slice(0, 300) } };
      }
      return parsed ?? { error: { code: 'NON_JSON', message: text.slice(0, 300) } };
    },
    maxFreshnessMs: config.keyFreshnessMs || DEFAULT_MAX_KEY_FRESHNESS_MS,
  });
}

/**
 * A deterministic fail-closed resolver for offline/local tests (never a wallet
 * proof). Maps named accounts to KEY_NOT_FOUND unless the test overrides it.
 */
export function makeDenyResolver(_config: Config): AccessKeyVerifier {
  return async (): Promise<ResolverResult> => ({ ok: false, code: 'RPC_ERROR', detail: 'no RPC resolver injected (local test double)' });
}
