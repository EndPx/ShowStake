// ShowStake frontend view models.
//
// Canonical event state and money-field shapes mirror the frozen OpenAPI v1
// contract (packages/api-contract/openapi.yaml `Event` / `EventState` / `Money`)
// and the shared domain enums (packages/domain/src/states.mjs). The public
// catalog is honest: the API is not wired in this slice, so these types define
// the client boundary without fabricating live data.

/** packages/domain EVENT_STATES + OpenAPI EventState. */
export type EventState =
  | "PUBLISHED"
  | "ATTENDANCE_FINALIZED"
  | "SETTLING"
  | "SETTLED"
  | "CANCELLED"
  | "REFUND_ONLY";

/** OpenAPI Event.times — all values are ISO-8601 date-time strings (UTC). */
export interface EventTimes {
  regOpen: string;
  regClose: string;
  cancelCutoff: string;
  checkinOpen: string;
  checkinClose: string;
}

/**
 * Public event summary for the discover/list views.
 *
 * The first `id, network, contractId, state, depositAtomic, capacity, times`
 * fields are the frozen OpenAPI `Event` schema. The remaining fields are a
 * presentation projection (title/venue/timezone/asset metadata/participant
 * count) that the future ShowStake API will expose; they are carried here so
 * the card/list primitives render without an EVM-shaped type, but they are
 * never populated with fake data in this slice.
 */
export interface EventSummary {
  id: string;
  network: string;
  contractId?: string;
  organizerAccount?: string;
  state: EventState;
  /** Canonical unsigned-128 base-10 string (OpenAPI `Money`). */
  depositAtomic: string;
  capacity: number;
  times: EventTimes;

  // ---- presentation projection (populated by ShowStake API when wired) -----
  title?: string;
  cover?: string | null;
  description?: string;
  venue?: string;
  /** IANA timezone the organizer declared for the venue. */
  venueTimezone?: string;
  assetSymbol?: string;
  assetDecimals?: number;
  participantCount?: number;
  /** The chain event id used as the detail-route key (never the API UUID). */
  chainEventId?: string;
}

/** OpenAPI EventListEnvelope.data shape (`items` + opaque `nextCursor`). */
export interface EventPage {
  items: EventSummary[];
  nextCursor: string | null;
}

/**
 * Event detail: the public summary plus the finalized rules/counts the
 * OpenAPI `Event` schema exposes and the read-only contract views it enriches.
 * Every money field is an atomic string; times are ISO-8601. Nothing here is
 * invented — missing fields stay `undefined` and render as "Unavailable".
 */
export interface EventDetail extends EventSummary {
  organizer?: string;
  canonicalFt?: string;
  policyVersion?: string;
  rulesHash?: string;
  /** ISO-8601 (derived from the chain `finalize_deadline` ms). */
  finalizeDeadline?: string;
  /** Accepted canonical-FT principal, atomic string (contract `accepted_principal`). */
  acceptedPrincipal?: string;
  /** Freeze/totals snapshot from `get_settlement` (settled/finalized events). */
  settlement?: SettlementSummary;
}

/**
 * Attendance/settlement snapshot (contract `get_settlement`) for finished
 * events. Derived no-shows and allocation terms are read-only display facts;
 * never a claim authorization.
 */
export interface SettlementSummary {
  attendeeCount: number;
  noShowCount: number;
  registrations: number;
  /** `M*D` no-show pool, atomic string. */
  pool: string;
  /** `floor(pool/A)`, atomic string. */
  baseShare: string;
  /** `pool mod A`, atomic string. */
  remainder: string;
  claimsEnabled: boolean;
  complete: boolean;
}
