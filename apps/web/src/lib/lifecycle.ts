/** Pure UI boundary for the native-USDC EventEscrow slice.
 *
 * The ABI is intentionally not embedded here. These states let the UI explain
 * what is known while every write remains disabled until an accepted ABI is
 * configured and a wallet receipt proves the transition.
 */
export type ReceiptState = "idle" | "pending" | "confirmed" | "failed" | "stale";
export type ActorRole = "organizer" | "participant" | "unknown";
export type ContentEligibility = "eligible" | "denied" | "checking" | "unavailable";

export interface LifecycleState {
  receipt: ReceiptState;
  eventState: "DRAFT" | "PUBLISHED" | "ATTENDANCE_FINALIZED" | "SETTLING" | "SETTLED" | "CANCELLED" | "REFUND_ONLY";
  role: ActorRole;
  attendance: "none" | "requested" | "attended" | "no_show";
  claimsEnabled: boolean;
  abiConfigured: boolean;
  content: ContentEligibility;
  error?: string;
}

export type LifecycleAction =
  | { type: "submit" }
  | { type: "receipt_pending" }
  | { type: "receipt_confirmed"; eventState?: LifecycleState["eventState"] }
  | { type: "receipt_failed"; message: string }
  | { type: "receipt_stale" }
  | { type: "attendance_requested" }
  | { type: "attendance_confirmed" }
  | { type: "settlement_confirmed" }
  | { type: "content_checked"; eligible: boolean };

export function lifecycleReducer(state: LifecycleState, action: LifecycleAction): LifecycleState {
  switch (action.type) {
    case "submit":
      if (!state.abiConfigured || state.role === "unknown") return state;
      return { ...state, receipt: "pending", error: undefined };
    case "receipt_pending":
      return { ...state, receipt: "pending", error: undefined };
    case "receipt_confirmed":
      return { ...state, receipt: "confirmed", eventState: action.eventState ?? state.eventState, error: undefined };
    case "receipt_failed":
      return { ...state, receipt: "failed", error: action.message };
    case "receipt_stale":
      return { ...state, receipt: "stale", error: "The chain read is stale. Refresh before taking a money or attendance action." };
    case "attendance_requested":
      return state.role === "organizer" && state.receipt !== "stale"
        ? { ...state, attendance: "requested", receipt: "pending" }
        : state;
    case "attendance_confirmed":
      return state.role === "organizer" && state.receipt === "confirmed"
        ? { ...state, attendance: "attended" }
        : state;
    case "settlement_confirmed":
      return state.role === "organizer" && state.receipt === "confirmed"
        ? { ...state, eventState: "SETTLED", claimsEnabled: true }
        : state;
    case "content_checked":
      return { ...state, content: action.eligible ? "eligible" : "denied" };
  }
}

export function canClaim(state: LifecycleState): boolean {
  return state.claimsEnabled && state.eventState === "SETTLED" && state.receipt !== "pending" && state.receipt !== "stale";
}

export function contentReason(state: LifecycleState): string {
  if (state.content === "eligible") return "Attendance and settlement are finalized for this account-bound pass.";
  if (state.eventState !== "SETTLED") return "Content stays locked until the event is settled.";
  if (state.attendance !== "attended") return "Only an organizer-confirmed attendee can access this content.";
  if (state.receipt === "stale") return "Refresh the authoritative chain state before checking access.";
  return "This account-bound pass is not eligible for the private resource.";
}

export const initialLifecycleState: LifecycleState = {
  receipt: "idle", eventState: "DRAFT", role: "unknown", attendance: "none",
  claimsEnabled: false, abiConfigured: false, content: "unavailable",
};
