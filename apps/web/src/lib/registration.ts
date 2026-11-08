// Receipt-confirmed registration/pass interpretation (pure). A deposit is NOT
// "confirmed" merely because a transaction was accepted; the final ShowStake
// receiver must produce a `Registration` whose `participant`/`beneficiary` are
// the signer AND a `Pass` whose `owner` is the same account. This module
// enforces exactly that, plus event-id and pass/registration cross-consistency.
// It never queries itself — callers supply the read-only contract views.

import type { ContractPassView, ContractRegistrationView } from "./near/views";

export type ConfirmationStatus =
  | "confirmed"
  | "not_found"
  | "mismatch"
  | "wrong_event"
  | "pending";

export interface RegistrationConfirmation {
  status: ConfirmationStatus;
  registrationId: string;
  passId: string | null;
  participant: string;
  beneficiary: string;
  owner: string | null;
  amount: string;
  attendanceStatus: string;
  financialStatus: string;
  contractId?: string;
  network?: string;
  reason?: string;
}

export function confirmRegistration(options: {
  eventId: string;
  accountId: string;
  /** Accepted deployment identity the views were read from (provenance/binding). */
  contractId?: string;
  network?: string;
  registration: ContractRegistrationView | null;
  pass: ContractPassView | null;
  committedDepositAtomic?: string;
  /** The commitment id of THIS attempt; a mismatch fails closed. */
  expectedCommitmentId?: string;
}): RegistrationConfirmation {
  const { eventId, accountId, contractId, network, registration, pass, committedDepositAtomic, expectedCommitmentId } = options;

  if (!registration) {
    return {
      ...signoff(registration, null, "pending"),
      reason: "No registration found yet. Check the final ShowStake receiver receipt, then retry.",
    };
  }
  if (registration.event_id !== eventId) {
    return { ...signoff(registration, null, "wrong_event"), reason: "Registration belongs to a different event." };
  }
  if (registration.participant !== accountId || registration.beneficiary !== accountId) {
    return {
      ...signoff(registration, pass, "mismatch"),
      reason: "Registration participant/beneficiary does not match the connected account.",
    };
  }
  if (!pass) {
    return { ...signoff(registration, null, "mismatch"), reason: "Pass view is missing for this registration." };
  }
  if (pass.owner !== accountId) {
    return { ...signoff(registration, pass, "mismatch"), reason: "Pass owner does not match the connected account." };
  }
  if (pass.pass_id !== registration.pass_id) {
    return { ...signoff(registration, pass, "mismatch"), reason: "Pass id does not match the registration's pass id." };
  }
  if (pass.registration_id !== registration.registration_id || pass.event_id !== eventId) {
    return { ...signoff(registration, pass, "mismatch"), reason: "Pass does not bind to this registration/event." };
  }
  if (expectedCommitmentId !== undefined && registration.commitment_id !== expectedCommitmentId) {
    return {
      ...signoff(registration, pass, "mismatch"),
      reason: `Commitment ${registration.commitment_id} differs from this attempt ${expectedCommitmentId}.`,
    };
  }
  if (
    committedDepositAtomic !== undefined &&
    committedDepositAtomic !== registration.amount
  ) {
    return {
      ...signoff(registration, pass, "mismatch"),
      reason: `Committed amount ${registration.amount} differs from the event deposit ${committedDepositAtomic}.`,
    };
  }

  return {
    status: "confirmed",
    registrationId: registration.registration_id,
    passId: pass.pass_id,
    participant: registration.participant,
    beneficiary: registration.beneficiary,
    owner: pass.owner,
    amount: registration.amount,
    attendanceStatus: registration.attendance_status,
    financialStatus: registration.financial_status,
    contractId,
    network,
  };
}

function signoff(
  registration: ContractRegistrationView | null,
  pass: ContractPassView | null,
  status: ConfirmationStatus,
): RegistrationConfirmation {
  return {
    status,
    registrationId: registration?.registration_id ?? "",
    passId: pass?.pass_id ?? null,
    participant: registration?.participant ?? "",
    beneficiary: registration?.beneficiary ?? "",
    owner: pass?.owner ?? null,
    amount: registration?.amount ?? "",
    attendanceStatus: registration?.attendance_status ?? "",
    financialStatus: registration?.financial_status ?? "",
  };
}

/** First registration in a bounded `list_event_registrations` whose participant
 *  is `accountId` (one lifetime registration per account/event; no volunteer
 *  withdrawal). Returns null when the account has none in the page. */
export function findRegistrationForAccount(
  registrations: ContractRegistrationView[],
  accountId: string,
): ContractRegistrationView | null {
  return registrations.find((r) => r.participant === accountId) ?? null;
}