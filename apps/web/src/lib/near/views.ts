// Typed read-only contract views for the accepted ShowStake v6 deployment and
// its canonical FT, bound to the frozen ABI in contracts/showstake/README.md and
// src/lib.rs. JSON serialization conventions (near-sdk): `U128` -> base-10
// string, `u64`/`u32` -> number, `AccountId` -> string, `bool` -> boolean.

import {
  callView,
  type RpcResult,
} from "./rpc";
import type { ContractEventState } from "./views-map";
export {
  msToIso,
  mapEventViewToSummary as eventViewToSummary,
  mapContractEventState,
} from "./views-map";
export type { ContractEventState } from "./views-map";

// ---- raw contract JSON shapes ----------------------------------------------

export interface ContractEventView {
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
  /** Raw near-sdk JSON variant name (CamelCase). Normalize via `mapContractEventState`. */
  state: ContractEventState;
  phase: string;
  active_registrations: number;
  total_registrations: number;
  withdrawn_registrations: number;
  accepted_principal: string;
  created_at: number;
}

export interface ContractRegistrationView {
  registration_id: string;
  event_id: string;
  pass_id: string;
  participant: string;
  beneficiary: string;
  commitment_id: string;
  amount: string;
  event_sequence: number;
  registration_status: string;
  attendance_status: string;
  financial_status: string;
  registered_at: number;
}

export interface ContractPassView {
  pass_id: string;
  event_id: string;
  registration_id: string;
  owner: string;
  issued_at: number;
  registration_status: string;
  attendance_status: string;
  financial_status: string;
  policy_version: string;
}

export interface ContractSettlementView {
  event_id: string;
  state: ContractEventState;
  attendance_frozen: boolean;
  attendee_count: number;
  no_show_count: number;
  registrations: number;
  pool: string;
  base_share: string;
  remainder: string;
  cursor: number;
  allocated_count: number;
  allocated_total: string;
  complete: boolean;
  claims_enabled: boolean;
  finalized_at: number;
  completed_at: number;
}

export interface ContractTotalsView {
  event_id: string;
  state: ContractEventState;
  registrations: number;
  active_registrations: number;
  withdrawn_registrations: number;
  accepted_principal: string;
  paid: string;
  pending: string;
  liability: string;
}

export interface ContractConfigView {
  organizer: string;
  canonical_ft: string;
  network: string;
  policy_version: string;
}

interface CandidateEventView {
  event_id: string;
  phase: ContractEventState;
  organizer: string;
  canonical_ft: string;
  policy_version: string;
  deposit: string;
  capacity: number;
  reg_open: number;
  reg_close: number;
  checkin_open: number;
  checkin_close: number;
  cancel_cutoff: number;
  finalize_deadline: number;
  active_registrations: number;
  total_registrations: number;
  withdrawn_registrations: number;
  rules_hash: string;
  created_at: number;
  accepted_principal: string;
}

export interface FtMetadata {
  spec: string;
  name: string;
  symbol: string;
  icon: string | null;
  reference: string | null;
  reference_hash: string | null;
  decimals: number;
}

export interface FtStorageBalance {
  total: string;
  available: string;
}

// ---- typed view calls ------------------------------------------------------

export function getEvent(
  contractId: string,
  eventId: string,
  rpcUrl: string,
  fetchImpl?: typeof fetch,
): Promise<RpcResult<ContractEventView>> {
  const fetcher = fetchImpl ?? fetch;
  return (async () => {
    const primary = await callView<ContractEventView>(contractId, "get_event", { event_id: eventId }, rpcUrl, fetcher);
    if (primary.ok) return primary;

    // The deployable native-USDC candidate exposes a single-event view with no
    // argument. Keep the accepted v6 ABI path first, then adapt that bounded
    // shape without weakening the fail-closed error returned by either call.
    const candidate = await callView<CandidateEventView>(contractId, "get_event", {}, rpcUrl, fetcher);
    if (!candidate.ok) return primary;
    const value = candidate.value;
    if (value.event_id !== eventId) {
      return { ok: false, code: "UNKNOWN_EVENT", message: `contract returned ${value.event_id}` };
    }
    return {
      ...candidate,
      value: {
        event_id: value.event_id,
        organizer: value.organizer,
        canonical_ft: value.canonical_ft,
        rules_hash: value.rules_hash,
        deposit: value.deposit,
        capacity: value.capacity,
        reg_open: value.reg_open,
        reg_close: value.reg_close,
        cancel_cutoff: value.cancel_cutoff,
        checkin_open: value.checkin_open,
        checkin_close: value.checkin_close,
        finalize_deadline: value.finalize_deadline,
        policy_version: value.policy_version,
        state: value.phase,
        phase: value.phase,
        active_registrations: value.active_registrations,
        total_registrations: value.total_registrations,
        withdrawn_registrations: value.withdrawn_registrations,
        accepted_principal: value.accepted_principal,
        created_at: value.created_at,
      },
    };
  })();
}

export function getRegistration(
  contractId: string,
  registrationId: string,
  rpcUrl: string,
  fetchImpl?: typeof fetch,
): Promise<RpcResult<ContractRegistrationView>> {
  return callView<ContractRegistrationView>(
    contractId,
    "get_registration",
    { registration_id: registrationId },
    rpcUrl,
    fetchImpl ?? fetch,
  );
}

export function getPass(
  contractId: string,
  passId: string,
  rpcUrl: string,
  fetchImpl?: typeof fetch,
): Promise<RpcResult<ContractPassView>> {
  return callView<ContractPassView>(contractId, "get_pass", { pass_id: passId }, rpcUrl, fetchImpl ?? fetch);
}

export function getSettlement(
  contractId: string,
  eventId: string,
  rpcUrl: string,
  fetchImpl?: typeof fetch,
): Promise<RpcResult<ContractSettlementView>> {
  return callView<ContractSettlementView>(
    contractId,
    "get_settlement",
    { event_id: eventId },
    rpcUrl,
    fetchImpl ?? fetch,
  );
}

export function getEventTotals(
  contractId: string,
  eventId: string,
  rpcUrl: string,
  fetchImpl?: typeof fetch,
): Promise<RpcResult<ContractTotalsView>> {
  return callView<ContractTotalsView>(contractId, "get_event_totals", { event_id: eventId }, rpcUrl, fetchImpl ?? fetch);
}

export function getConfig(
  contractId: string,
  rpcUrl: string,
  fetchImpl?: typeof fetch,
): Promise<RpcResult<ContractConfigView>> {
  return callView<ContractConfigView>(contractId, "get_config", {}, rpcUrl, fetchImpl ?? fetch);
}

export function showstakeStorageBalance(
  contractId: string,
  accountId: string,
  rpcUrl: string,
  fetchImpl?: typeof fetch,
): Promise<RpcResult<string>> {
  return callView<string>(contractId, "storage_balance_of", { account_id: accountId }, rpcUrl, fetchImpl ?? fetch);
}

export function getBlockTimestampMs(
  contractId: string,
  rpcUrl: string,
  fetchImpl?: typeof fetch,
): Promise<RpcResult<number>> {
  return callView<number>(contractId, "get_block_timestamp_ms", {}, rpcUrl, fetchImpl ?? fetch);
}

export function ftMetadata(
  ftContractId: string,
  rpcUrl: string,
  fetchImpl?: typeof fetch,
): Promise<RpcResult<FtMetadata>> {
  return callView<FtMetadata>(ftContractId, "ft_metadata", {}, rpcUrl, fetchImpl ?? fetch);
}

export function ftStorageBalance(
  ftContractId: string,
  accountId: string,
  rpcUrl: string,
  fetchImpl?: typeof fetch,
): Promise<RpcResult<FtStorageBalance | null>> {
  return callView<FtStorageBalance | null>(
    ftContractId,
    "storage_balance_of",
    { account_id: accountId },
    rpcUrl,
    fetchImpl ?? fetch,
  );
}

export function listEventRegistrations(
  contractId: string,
  eventId: string,
  from: number,
  limit: number,
  rpcUrl: string,
  fetchImpl?: typeof fetch,
): Promise<RpcResult<ContractRegistrationView[]>> {
  return callView<ContractRegistrationView[]>(
    contractId,
    "list_event_registrations",
    { event_id: eventId, from, limit },
    rpcUrl,
    fetchImpl ?? fetch,
  );
}

export function listEvents(
  contractId: string,
  from: number,
  limit: number,
  rpcUrl: string,
  fetchImpl?: typeof fetch,
): Promise<RpcResult<ContractEventView[]>> {
  return callView<ContractEventView[]>(
    contractId,
    "list_events",
    { from, limit },
    rpcUrl,
    fetchImpl ?? fetch,
  );
}

export function ftBalanceOf(
  ftContractId: string,
  accountId: string,
  rpcUrl: string,
  fetchImpl?: typeof fetch,
): Promise<RpcResult<string>> {
  return callView<string>(ftContractId, "ft_balance_of", { account_id: accountId }, rpcUrl, fetchImpl ?? fetch);
}
