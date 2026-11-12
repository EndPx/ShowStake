// Pure contract-view mapping helpers, self-contained (type-only import) so the
// Node verification script can import them directly without loading the RPC
// client. `lib/near/views.ts` re-exports these next to the network calls.

import type { EventState, EventSummary } from "../types";

/** Chain millisecond epoch -> ISO-8601 UTC string, or null when not a finite ms. */
export function msToIso(ms: unknown): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || !Number.isInteger(ms)) {
    return null;
  }
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * The deployeded contract serializes its `EventState` variants VERBATIM
 * (CamelCase): `Published`, `Cancelled`, `RefundOnly`, `AttendanceFinalized`,
 * `Settling`, `Settled`. The frontend view model + OpenAPI enum use the
 * SCREAMING_SNAKE form (`PUBLISHED`, …). This is the ONE contract-view boundary
 * that converts between them; it is exhaustive and REJECTS anything else
 * (returns `null`) so an unknown state fails closed instead of being silently
 * treated as a known phase.
 */
export type ContractEventState =
  | "RegistrationOpen"
  | "RegistrationClosed"
  | "Published"
  | "Cancelled"
  | "RefundOnly"
  | "AttendanceFinalized"
  | "Settling"
  | "Settled";

export function mapContractEventState(value: unknown): EventState | null {
  switch (value) {
    case "RegistrationOpen":
      return "PUBLISHED";
    case "RegistrationClosed":
      return "PUBLISHED";
    case "Published":
      return "PUBLISHED";
    case "Cancelled":
      return "CANCELLED";
    case "RefundOnly":
      return "REFUND_ONLY";
    case "AttendanceFinalized":
      return "ATTENDANCE_FINALIZED";
    case "Settling":
      return "SETTLING";
    case "Settled":
      return "SETTLED";
    default:
      return null;
  }
}

export interface ContractEventViewMap {
  event_id: string;
  organizer: string;
  canonical_ft: string;
  rules_hash: string;
  deposit: string;
  capacity: number;
  reg_open: number;
  reg_close: number;
  cancel_cutoff: number;
  checkin_open: number;
  checkin_close: number;
  finalize_deadline: number;
  policy_version: string;
  state: ContractEventState;
  phase: string;
  active_registrations: number;
  total_registrations: number;
  withdrawn_registrations: number;
  accepted_principal: string;
  created_at: number;
}

/**
 * Map a contract `EventView` onto the shared summary shape (as enriched detail
 * facts). Times are converted ms -> ISO and the CamelCase contract state is
 * normalized; an unknown state throws (fail closed) rather than fabricate a
 * phase. The asset symbol/decimals are supplied by callers from `ft_metadata`.
 */
export function mapEventViewToSummary(
  view: ContractEventViewMap,
  meta: { assetSymbol?: string; assetDecimals?: number; contractId?: string },
): EventSummary {
  const state = mapContractEventState(view.state);
  if (state === null) {
    throw new Error(`unknown contract event state: ${String(view.state)}`);
  }
  return {
    id: view.event_id,
    network: "testnet",
    contractId: meta.contractId,
    state,
    depositAtomic: view.deposit,
    capacity: view.capacity,
    times: {
      regOpen: msToIso(view.reg_open) ?? "",
      regClose: msToIso(view.reg_close) ?? "",
      cancelCutoff: msToIso(view.cancel_cutoff) ?? "",
      checkinOpen: msToIso(view.checkin_open) ?? "",
      checkinClose: msToIso(view.checkin_close) ?? "",
    },
    assetSymbol: meta.assetSymbol,
    assetDecimals: meta.assetDecimals,
    participantCount: view.active_registrations,
  };
}
