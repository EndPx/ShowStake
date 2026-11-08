// Exact FT-deposit construction and read-only preflight (pure, no SDK, no
// network). Produces the precise `ft_transfer_call` arguments the participant's
// wallet must sign and the ordered "separate approvals" the UI has to show
// truthfully (native NEAR storage for the ShowStake escrow, FT storage for the
// canonical token, and the FT balance itself). NO transaction is broadcast here
// — live signing is Codex/human's scoped action. This module is only the exact,
// reviewable call shape plus the honest gating logic.

import type { EventState } from "./types";

export const COMMIT_MESSAGE_VERSION = 1 as const;
export const FT_TRANSFER_CALL_GAS_TGAS = 300; // NEP-141 default function-call gas
export const FT_TRANSFER_CALL_ATTACHED_YOCTO = "1"; // NEP-141 requires exactly 1 yocto

const COMMITMENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Bounded, versioned `ft_on_transfer` message (contract `CommitMessage`). */
export interface CommitMessage {
  version: typeof COMMIT_MESSAGE_VERSION;
  event_id: string;
  commitment_id: string;
}

/** Exact, signable NEP-141 `ft_transfer_call` arguments. */
export interface FtTransferCall {
  contractId: string; // canonical FT
  methodName: "ft_transfer_call";
  args: {
    receiver_id: string; // ShowStake escrow
    /** Canonical u128 base-10 string (the event's exact deposit). */
    amount: string;
    /** JSON-serialized `CommitMessage` (field order stable). */
    msg: string;
  };
  attachedDeposit: string; // "1" yocto
  gasTgas: number;
}

export function buildCommitMessage(eventId: string, commitmentId: string): CommitMessage {
  if (!isSafeEventId(eventId)) throw new Error("event_id must be 1..=64 safe ASCII characters");
  if (!COMMITMENT_ID_RE.test(commitmentId)) {
    throw new Error("commitment_id must be 1..=64 of [A-Za-z0-9_-]");
  }
  return { version: COMMIT_MESSAGE_VERSION, event_id: eventId, commitment_id: commitmentId };
}

export function commitMessageToJson(message: CommitMessage): string {
  // Field order is stable so the exact bytes a wallet signs are reproducible.
  return JSON.stringify({
    version: message.version,
    event_id: message.event_id,
    commitment_id: message.commitment_id,
  });
}

/**
 * The exact FT deposit call for an event. `amount` must equal the event's
 * canonical deposit and pass the u128 canonical-string check; mismatches throw
 * rather than silently signing a wrong amount.
 */
export function buildFtTransferCall(params: {
  ftContractId: string;
  showstakeContractId: string;
  depositAtomic: string;
  eventId: string;
  commitmentId: string;
}): FtTransferCall {
  if (!/^(0|[1-9][0-9]*)$/.test(params.depositAtomic)) {
    throw new Error("depositAtomic must be a canonical u128 base-10 string");
  }
  const msg = commitMessageToJson(buildCommitMessage(params.eventId, params.commitmentId));
  return {
    contractId: params.ftContractId,
    methodName: "ft_transfer_call",
    args: {
      receiver_id: params.showstakeContractId,
      amount: params.depositAtomic,
      msg,
    },
    attachedDeposit: FT_TRANSFER_CALL_ATTACHED_YOCTO,
    gasTgas: FT_TRANSFER_CALL_GAS_TGAS,
  };
}

function isSafeEventId(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value);
}

/**
 * A generated commitment id (client-side). UUIDs are hex+hyphens, a safe subset
 * of the contract's accepted id alphabet, and unique per attempt.
 */
export function newCommitmentId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b!.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------

export type PreflightPhase = "open" | "closed" | "ended" | "not_found";

interface PreflightEvent {
  eventId: string;
  state: EventState | null;
  depositAtomic: string;
  capacity: number;
  /** Known reserved count, or `undefined` when the view could not report it (never defaulted to 0). */
  registeredCount?: number;
  regOpen: string; // ISO
  regClose: string; // ISO
}

export interface PreflightStep {
  id: "ft_registered" | "ft_balance" | "native_storage";
  label: string;
  detail: string;
  kind: "ok" | "action" | "unknown" | "blocked";
}

export interface DepositPreflight {
  phase: PreflightPhase;
  phaseReason: string;
  registrationAllowed: boolean;
  steps: PreflightStep[];
  /** True only when every REQUIRED preflight step is `ok`; the wallet prompt may open. */
  readyToSign: boolean;
  /** When false, no FT call may be proposed/signed. */
  canProceed: boolean;
}

const ENDED_STATES: ReadonlySet<EventState> = new Set(["SETTLED", "CANCELLED", "REFUND_ONLY"]);

/** Registration is open only when `state === PUBLISHED` inside `reg_open <= now < reg_close`. */
export function registrationPhase(event: PreflightEvent, nowMs: number): PreflightPhase {
  if (!event.state) return "not_found";
  if (ENDED_STATES.has(event.state)) return "ended";
  if (event.state !== "PUBLISHED") return "closed";
  const open = Date.parse(event.regOpen);
  const close = Date.parse(event.regClose);
  if (!Number.isFinite(open) || !Number.isFinite(close)) return "closed";
  return nowMs >= open && nowMs < close ? "open" : "closed";
}

function phaseReason(phase: PreflightPhase, event: PreflightEvent): string {
  switch (phase) {
    case "ended":
      return `This event has ${event.state === "SETTLED" ? "settled" : "ended"}; registration is closed. Claim outcomes are shown separately where applicable.`;
    case "closed":
      return "Registration is not open for this event right now.";
    case "open":
      return "Registration is open; commit the exact deposit to reserve your spot.";
    case "not_found":
      return "The event could not be read from the contract.";
  }
}

/**
 * Read-only preflight inputs. Every unknown input fails closed (kind "unknown"
 * / "action"), never assumed good:
 *  * `nativeStorageDeposited` is the ONLY signal that the native-NEAR storage
 *    approval has happened in this session — the current credit alone is NOT
 *    treated as "enough" (the exact measured charge is only known at commit).
 *  * `registeredCount` is optional; when absent the capacity is not assumed.
 */
export function computeDepositPreflight(params: {
  event: PreflightEvent;
  nowMs: number;
  ftRegistered: boolean | null; // participant has FT storage for the FT
  ftBalanceAtomic: string | null; // participant's canonical FT balance
  nativeStorageDeposited: boolean | null; // explicit in-session storage approval
  escrowFtRegistered?: boolean | null; // informational only (deployment property)
}): DepositPreflight {
  const { event, nowMs } = params;
  const phase = registrationPhase(event, nowMs);

  const steps: PreflightStep[] = [
    {
      id: "ft_registered",
      label: "Token account registered",
      detail: "Your account must be registered to hold the canonical FT.",
      kind: params.ftRegistered === null ? "unknown" : params.ftRegistered ? "ok" : "action",
    },
    {
      id: "ft_balance",
      label: "Sufficient balance",
      detail: `Your balance must cover the exact deposit (${event.depositAtomic}).`,
      kind: params.ftBalanceAtomic === null
        ? "unknown"
        : isEnough(params.ftBalanceAtomic, event.depositAtomic)
          ? "ok"
          : "action",
    },
    {
      id: "native_storage",
      label: "Escrow storage approved",
      detail:
        "A native NEAR storage deposit covers the measured storage for your registration and pass. The exact charge is only known at commit, so a positive credit alone is never treated as sufficient.",
      kind: params.nativeStorageDeposited === null
        ? "unknown"
        : params.nativeStorageDeposited
          ? "ok"
          : "action",
    },
  ];

  const phaseBlocks = phase !== "open";
  const hardBlocked = steps.some((s) => s.kind === "blocked");
  const missingUnknown = steps.some((s) => s.kind === "unknown");
  const allOk = steps.every((s) => s.kind === "ok");
  const registrationAllowed = !phaseBlocks && !hardBlocked;
  // Capacity is only claimed when a KNOWN integer count is available.
  const capacityFull =
    phase === "open" &&
    Number.isInteger(event.capacity) &&
    typeof event.registeredCount === "number" &&
    Number.isInteger(event.registeredCount) &&
    event.registeredCount >= event.capacity;

  void params.escrowFtRegistered;

  return {
    phase,
    phaseReason: capacityFull
      ? "This event is full."
      : phaseReason(phase, event),
    registrationAllowed: registrationAllowed && !capacityFull,
    steps,
    readyToSign: allOk && !phaseBlocks && !capacityFull,
    canProceed: registrationAllowed && !missingUnknown,
  };
}

/** Exact string comparison (never a float) for two canonical u128 amount strings. */
function isEnough(have: string, need: string): boolean {
  if (!/^(0|[1-9][0-9]*)$/.test(have) || !/^(0|[1-9][0-9]*)$/.test(need)) return false;
  const a = have.length > need.length ? 1 : have.length < need.length ? -1 : 0;
  if (a !== 0) return a > 0;
  return have >= need; // equal length => lexicographic == numeric
}