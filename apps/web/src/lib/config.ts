// ShowStake first-slice runtime configuration.
//
// Single source of truth for the accepted (Codex-reviewed) testnet deployment
// and the browser's public API base. Nothing below is a secret; the RPC URL is
// a public read-only endpoint. The public API is reached SAME-ORIGIN through a
// Next.js rewrite to the backend (see apps/web/next.config.ts), so the client
// never reads a dynamic `process.env[...]` (NEXT_PUBLIC values must be
// statically inlined) and never crosses origins (no CORS in this slice).

export const NETWORK = "testnet" as const;
export type NetworkId = typeof NETWORK;

/** Public read-only NEAR testnet RPC. No keys are ever sent. */
export const RPC_URL = "https://rpc.testnet.near.org";

/**
 * Accepted v6 product deployment (README/ABI, source b744c00, deployed
 * `showstake-settle-endpx.testnet`, policy `showstake-v2-d036-settle/1`).
 * The only accepted live event is `d036-settle-five`, which is **Settled**.
 */
export const SHOWSTAKE_CONTRACT = "showstake-settle-endpx.testnet";
/** Canonical synthetic FT for this deployment: 6 decimals, testnet only. */
export const CANONICAL_FT = "showstake-ft-endpx.testnet";
export const CANONICAL_FT_DECIMALS = 6;
export const POLICY_VERSION = "showstake-v2-d036-settle/1";

/**
 * Accepted event instances. A key is an event id that Codex has reviewed for
 * this environment. Adding an entry does NOT invent chain data — the UI still
 * reads every field from the contract/API, so a wrong id simply fails closed.
 */
export interface AcceptedEvent {
  eventId: string;
  contractId: string;
  network: NetworkId;
  policyVersion: string;
}

export const ACCEPTED_EVENTS: Readonly<Record<string, AcceptedEvent>> = {
  "d036-settle-five": {
    eventId: "d036-settle-five",
    contractId: SHOWSTAKE_CONTRACT,
    network: NETWORK,
    policyVersion: POLICY_VERSION,
  },
};

/**
 * Explicit OPEN test-event slot for Codex to point at a NEW, freshly-deployed
 * live testnet instance whose registration is OPEN (unlike `d036-settle-five`,
 * which is Settled). It is `null` by default — a real deployment reference, NOT
 * a fixture — so nothing is invented and every route stays fail-closed until
 * Codex fills it in. The deposit/approval flow is only exercisable through this
 * slot.
 */
export const OPEN_TEST_EVENT_SLOT: AcceptedEvent | null = null;

export function isAcceptedEvent(eventId: string): boolean {
  if (Object.prototype.hasOwnProperty.call(ACCEPTED_EVENTS, eventId)) return true;
  return OPEN_TEST_EVENT_SLOT !== null && OPEN_TEST_EVENT_SLOT.eventId === eventId;
}

export function acceptedEvent(eventId: string): AcceptedEvent | null {
  if (Object.prototype.hasOwnProperty.call(ACCEPTED_EVENTS, eventId)) return ACCEPTED_EVENTS[eventId]!;
  return OPEN_TEST_EVENT_SLOT !== null && OPEN_TEST_EVENT_SLOT.eventId === eventId ? OPEN_TEST_EVENT_SLOT : null;
}

/** Accepted deployment (contract) whose single event we may resolve by id. */
export function acceptedContract(contractId: string): AcceptedEvent | null {
  const open = OPEN_TEST_EVENT_SLOT;
  if (open !== null && open.contractId === contractId) return open;
  for (const key of Object.keys(ACCEPTED_EVENTS)) {
    const accepted = ACCEPTED_EVENTS[key]!;
    if (accepted.contractId === contractId) return accepted;
  }
  return null;
}

/**
 * Same-origin public API base. The Next.js rewrite `/api/v1/:path*` forwards
 * this to the backend (server-side `SHOWSTAKE_API_UPSTREAM_URL`, default
 * `http://127.0.0.1:3001`). The client therefore never crosses origins and
 * never needs `NEXT_PUBLIC_*` inlining.
 */
export const API_PUBLIC_BASE = "/api/v1";

export function apiBaseUrl(): string {
  return API_PUBLIC_BASE;
}

export function isApiConfigured(): boolean {
  return true; // same-origin proxy is always present; reachability is surfaced as an error
}