// Local structural types for the wallet-adapter RPC verifier boundary. The
// runtime shapes come from packages/wallet-adapter (declared in external.d.ts);
// these aliases let app code name and re-declare those shapes without importing
// from an ambient module.

export interface ResolverResult {
  ok: boolean;
  code?: string;
  detail?: string;
  accountId?: string;
  publicKey?: string;
  keyType?: string;
  accessKeyType?: string;
  verifiedAt?: number;
  network?: string;
  blockHeight?: number;
}

export type AccessKeyVerifier = (q: {
  accountId: string;
  publicKey: string;
  network: string;
}) => Promise<ResolverResult>;