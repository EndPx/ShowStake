// ShowStake catalog data-source boundary, wired to the real `/v1/events`
// projection via the same-origin proxy. Loading / error / empty / stale /
// unavailable are all distinct and honest. Crucially, detail links are only
// ever built from a resolved CHAIN event id (never the API's UUID): each
// accepted deployment's single event id is resolved read-only from the contract
// (`list_events`) so a discovery row can only route to an accepted event.

import { MULTI_EVENT_RELEASE } from "./near/multi-event";
import { loadSharedCatalog } from "./shared-catalog";
import { fetchEventList, mapApiEvent, ApiRequestError } from "./api";
import { apiBaseUrl, acceptedContract, isAcceptedEvent, RPC_URL, NETWORK } from "./config";
import { MANUAL_TARGET } from "./near/manual-target";
import { ACCEPTED_MAINNET_RELEASE } from "./near/mainnet-actions";
import { listEvents } from "./near/views";
import type { EventPage, EventSummary } from "./types";

export type CatalogResult =
  | { kind: "ready"; page: EventPage; stale: boolean; observedAt: string | null }
  | { kind: "empty"; page: EventPage; stale: boolean; observedAt: string | null }
  | { kind: "error"; message: string; retryable: boolean };

/** Dependency-injected loader so loading/error/empty/stale/ready states are all real. */
export type CatalogLoader = (fetchImpl?: typeof fetch) => Promise<CatalogResult>;

/** Resolve a detail-route chain event id for a single-event-per-contract deployment. */
async function resolveChainEventId(contractId: string): Promise<string | null> {
  const accepted = acceptedContract(contractId);
  if (!accepted) return null;
  try {
    const list = await listEvents(contractId, 0, 1, RPC_URL);
    if (!list.ok || list.value.length === 0) return null;
    const id = list.value[0]!.event_id;
    return isAcceptedEvent(id) ? id : null;
  } catch {
    return null;
  }
}

async function annotateDetailKeys(items: EventSummary[]): Promise<EventSummary[]> {
  const seen = new Map<string, Promise<string | null>>();
  return Promise.all(
    items.map(async (item) => {
      if (NETWORK === "mainnet") {
        const contract=item.contractId; const accepted=contract===MANUAL_TARGET.contract || (!!ACCEPTED_MAINNET_RELEASE && !!contract && contract.endsWith(`.${(ACCEPTED_MAINNET_RELEASE as {factory:string}).factory}`));
        return item.network==="mainnet" && accepted && item.chainEventId ? {...item,id:item.chainEventId} : {...item,chainEventId:undefined};
      }
      if (item.chainEventId && isAcceptedEvent(item.chainEventId)) {
        return { ...item, id: item.chainEventId };
      }
      if (item.contractId) {
        if (!seen.has(item.contractId)) {
          seen.set(item.contractId, resolveChainEventId(item.contractId));
        }
        const chainId = await seen.get(item.contractId)!;
        if (chainId) return { ...item, id: chainId, chainEventId: chainId };
      }
      // No resolvable chain id: keep the API id for display but expose no detail
      // link (chainEventId stays undefined; the card renders non-linked).
      return { ...item, chainEventId: undefined };
    }),
  );
}

export async function loadCatalog(fetchImpl: typeof fetch = fetch): Promise<CatalogResult> {
  if (MULTI_EVENT_RELEASE?.network === NETWORK) { try { const items=await loadSharedCatalog(fetchImpl); const page={items,nextCursor:null}; return items.length ? {kind:"ready",page,stale:false,observedAt:new Date().toISOString()} : {kind:"empty",page,stale:false,observedAt:new Date().toISOString()}; } catch { return {kind:"error",message:"On-chain events are temporarily unavailable.",retryable:true}; } }
  const baseUrl = apiBaseUrl();
  try {
    const envelope = await fetchEventList(baseUrl, fetchImpl);
    const raw = (envelope.data?.items ?? []).map(mapApiEvent);
    const items = await annotateDetailKeys(raw);
    const page: EventPage = { items, nextCursor: envelope.data?.nextCursor ?? null };
    const stale = envelope.meta.stale === true;
    const observedAt = envelope.meta.observedAt;
    return items.length === 0
      ? { kind: "empty", page, stale, observedAt }
      : { kind: "ready", page, stale, observedAt };
  } catch (value) {
    if (value instanceof ApiRequestError) {
      return { kind: "error", message: value.message || "The ShowStake API reported an error.", retryable: value.retryable };
    }
    return {
      kind: "error",
      message: "Events are temporarily unavailable. Please try again.",
      retryable: true,
    };
  }
}