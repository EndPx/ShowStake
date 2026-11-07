// Ambient module declarations for the two in-repo workspace packages the API
// consumes (@showstake/domain and @showstake/wallet-adapter). They are pure
// ESM `.mjs` modules with no `types` export, so this file gives the API a typed,
// boundary-accurate view of exactly the surface it uses. This file is owned by
// apps/api and does NOT modify the packages themselves.
//
// These declarations mirror the real runtime shapes; the shared packages remain
// the implementation authority (their own verify scripts test them).

declare module '@showstake/domain' {
  export const U128_MAX: bigint;

  export function parseAtomic(value: string | bigint): bigint | null;
  export function isAtomic(value: unknown): boolean;
  export function assertAtomic(value: string | bigint, label?: string): bigint;
  export function toAtomicString(value: string | bigint): string;
  export function isPositiveAtomic(value: string | bigint): boolean;
  export function atomicAdd(a: string | bigint, b: string | bigint): string | null;
  export function atomicSub(a: string | bigint, b: string | bigint): string | null;

  export function isMoneyString(v: unknown): boolean;
  export function assertMoneyString(v: unknown, label?: string): bigint;

  export interface Meta {
    requestId: string | null;
    observedAt: string;
    network: string | null;
    stale: boolean;
  }
  export interface ErrorBody {
    code: string;
    message: string;
    retryable: boolean;
  }
  export interface Envelope {
    data: unknown;
    meta: Meta;
    error: ErrorBody | null;
  }
  export function envelope(opts?: {
    data?: unknown;
    meta?: Partial<Meta>;
    error?: { code: string; message: string; retryable?: boolean } | null;
  }): Envelope;
  export function okEnvelope(data: unknown, meta?: Partial<Meta>): Envelope;
  export function errEnvelope(
    code: string,
    message: string,
    opts?: { retryable?: boolean; meta?: Partial<Meta> },
  ): Envelope;
  export function paginationLimit(limit?: number | null): number;

  export function isKnownNetwork(network: string): boolean;
  export function validateAccountIdShape(accountId: string): boolean | null;
  export function isImplicitAccount(accountId: string): boolean;
  export function checkNetwork(network: string): { ok: boolean; code: string; network: string };

  export const EVENT_STATES: readonly string[];
  export const REGISTRATION_STATES: readonly string[];
  export function isEventState(v: string): boolean;
  export function isRegistrationState(v: string): boolean;
}

declare module '@showstake/wallet-adapter' {
  export const NEP413_TAG: bigint;
  export const MAX_CHALLENGE_TTL_MS: number;
  export const DEFAULT_MAX_KEY_FRESHNESS_MS: number;
  export const REQUIRED_ACCESS_KEY_TYPE: string;
  export const NEAR_RPC_URLS: Readonly<Record<string, string | null>>;

  export function nep413Hash(payload: Uint8Array): Uint8Array;
  export function parseNearPublicKey(publicKey: string): { keyType: string; bytes: Uint8Array };
  export function verifyNep413SignedMessage(s: {
    message: string;
    nonce: Uint8Array;
    recipient: string;
    callbackUrl?: string;
    accountId: string;
    publicKey: string;
    signature: string;
  }): { ok: boolean; code: string; hashHex?: string; detail?: string };

  export interface Challenge {
    purpose: string;
    domain: string;
    network: string;
    accountId: string;
    nonce: Uint8Array;
    issuedAtMs: number;
    expiresAtMs: number;
    callbackUrl: string | null;
    context?: Record<string, string | number | boolean>;
    message: string | null;
  }
  export function makeChallenge(c: {
    purpose: string;
    domain: string;
    network: string;
    accountId: string;
    nonce: Uint8Array;
    issuedAtMs?: number;
    expiresAtMs?: number;
    callbackUrl?: string | null;
    context?: Record<string, string | number | boolean>;
    message?: string | null;
  }): Challenge;
  export function canonicalChallengeMessage(c: Challenge): string | null;
  export function nonceKey(nonce: Uint8Array): string;
  export function validateChallengeTimes(
    times: { issuedAtMs: number; expiresAtMs: number },
    nowMs: number,
  ): { code: string; detail: string }[];

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
  export function makeNearRpcAccessKeyVerifier(opts: {
    getRpcUrl: (network: string) => string | null;
    transport?: (url: string, opts: { method: string; body: string }) => Promise<unknown>;
    nowProvider?: () => number;
    maxFreshnessMs?: number;
  }): AccessKeyVerifier;
  export function interpretAccessKeyView(
    json: unknown,
    req: { accountId: string; publicKey: string; keyType: string; network: string; nowMs: number },
  ): ResolverResult;
  export function validateResolvedAccessKey(
    rv: ResolverResult | null,
    expected: {
      accountId: string;
      network: string;
      publicKey: string;
      keyType: string;
      nowMs: number;
      maxFreshnessMs?: number;
      requiredAccessKeyType?: string;
      allowImplicitAccountNotFound?: boolean;
    },
  ): { ok: boolean; failures: { code: string; detail?: string }[] };

  export function verifyChallengeProof(input: {
    challenge: Challenge;
    proof: { accountId: string; publicKey: string; signature: string };
    consumedNonces: Set<string>;
    expectedDomain: string;
    expectedNetwork: string;
    expectedPurpose: string;
    nowMs?: number;
    accessKeyVerifier?: AccessKeyVerifier | null;
    expectedContext?: Record<string, string | number | boolean>;
    maxFreshnessMs?: number;
    allowLocalImplicitFallback?: boolean;
  }): Promise<{
    ok: boolean;
    code: string;
    failures?: { code: string; detail?: string }[];
    cryptoFailure?: { code: string; detail?: string } | null;
  }>;

  export function makeLocalFixtureSignature(input: {
    message: string;
    nonce: Uint8Array;
    recipient: string;
    callbackUrl?: string;
  }): {
    accountId: string;
    publicKey: string;
    signature: string;
    signer: { publicKey: Uint8Array; keyType: string };
  };
  export function nonceOf(seed: string): Uint8Array;
}