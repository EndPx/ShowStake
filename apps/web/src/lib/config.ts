// ShowStake first-slice runtime configuration.
//
// Single source of truth for the accepted (Codex-reviewed) testnet deployment
// and the browser's public API base. Nothing below is a secret; the RPC URL is
// a public read-only endpoint. The public API is reached SAME-ORIGIN through a
// Next.js rewrite to the backend (see apps/web/next.config.ts), so the client
// never reads a dynamic `process.env[...]` (NEXT_PUBLIC values must be
// statically inlined) and never crosses origins (no CORS in this slice).

export type NetworkId = "testnet" | "mainnet";
const configuredNetwork = process.env.NEXT_PUBLIC_SHOWSTAKE_NETWORK;
if (configuredNetwork !== undefined && configuredNetwork !== "testnet" && configuredNetwork !== "mainnet") {
  throw new Error("NEXT_PUBLIC_SHOWSTAKE_NETWORK must be testnet or mainnet");
}
export const NETWORK: NetworkId = configuredNetwork ?? "testnet";

/** Filled only after review and deployment of the clean mock-Earn instance. */
export const CANDIDATE_LIFECYCLE_TARGET: { contractId: string; eventId: string; apiEventId: string; policyVersion: string; canonicalFt: string; abi: "single-event"; network: NetworkId } | null = NETWORK === "testnet" ? { contractId: "ss-e2e-1113013557.testnet", eventId: "five-two-attendees", apiEventId: "31fe9bbc-3db8-4c65-ae46-f5d4aef07e2b", policyVersion: "showstake-native-usdc-event/1", canonicalFt: "mockusdc.testnet", abi: "single-event", network: NETWORK } : null;
export function candidateTarget(): typeof CANDIDATE_LIFECYCLE_TARGET { return CANDIDATE_LIFECYCLE_TARGET; }

/** Public read-only NEAR testnet RPC. No keys are ever sent. */
export const RPC_URL = NETWORK === "testnet" ? "https://test.rpc.fastnear.com" : "https://free.rpc.fastnear.com";

/**
 * Accepted v6 product deployment (README/ABI, source b744c00, deployed
 * `showstake-settle-endpx.testnet`, policy `showstake-v2-d036-settle/1`).
 * The only accepted live event is `d036-settle-five`, which is **Settled**.
 */
export const SHOWSTAKE_CONTRACT = NETWORK === "testnet" ? "showstake-settle-endpx.testnet" : "";
/** Canonical synthetic FT for this deployment: 6 decimals, testnet only. */
export const CANONICAL_FT = NETWORK === "testnet" ? "showstake-ft-endpx.testnet" : "";
export const CANONICAL_FT_DECIMALS = 6;
export const POLICY_VERSION = NETWORK === "testnet" ? "showstake-v2-d036-settle/1" : "";

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
  /** Event-specific canonical FT when the deployment does not use the v6 default. */
  canonicalFt?: string;
  abi: "v6" | "single-event";
}

export const ACCEPTED_EVENTS: Readonly<Record<string, AcceptedEvent>> = NETWORK === "testnet" ? {
  "d036-settle-five": {
    eventId: "d036-settle-five",
    contractId: SHOWSTAKE_CONTRACT,
    network: NETWORK,
    policyVersion: POLICY_VERSION,
    abi: "v6",
  },
} : {};

/**
 * Explicit OPEN test-event slot for Codex to point at a NEW, freshly-deployed
 * live testnet instance whose registration is OPEN (unlike `d036-settle-five`,
 * which is Settled). It is `null` by default — a real deployment reference, NOT
 * a fixture — so nothing is invented and every route stays fail-closed until
 * Codex fills it in. The deposit/approval flow is only exercisable through this
 * slot.
 */
export const OPEN_TEST_EVENT_SLOT: AcceptedEvent | null = NETWORK === "testnet" ? {
  eventId: "wallet-browser-test",
  contractId: "showstake-event-v2-endpx.testnet",
  network: NETWORK,
  policyVersion: "showstake-native-usdc-event/1",
  canonicalFt: "mockusdc.testnet",
  abi: "single-event",
} : null;

export function isAcceptedEvent(eventId: string): boolean {
  if (candidateTarget()?.eventId === eventId) return true;
  if (Object.prototype.hasOwnProperty.call(ACCEPTED_EVENTS, eventId)) return true;
  return OPEN_TEST_EVENT_SLOT !== null && OPEN_TEST_EVENT_SLOT.eventId === eventId;
}

export function acceptedEvent(eventId: string): AcceptedEvent | null {
  const candidate = candidateTarget();
  if (candidate?.eventId === eventId) return candidate;
  if (Object.prototype.hasOwnProperty.call(ACCEPTED_EVENTS, eventId)) return ACCEPTED_EVENTS[eventId]!;
  return OPEN_TEST_EVENT_SLOT !== null && OPEN_TEST_EVENT_SLOT.eventId === eventId ? OPEN_TEST_EVENT_SLOT : null;
}

/** Accepted deployment (contract) whose single event we may resolve by id. */
export function acceptedContract(contractId: string): AcceptedEvent | null {
  const candidate = candidateTarget();
  if (candidate?.contractId === contractId) return candidate;
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
