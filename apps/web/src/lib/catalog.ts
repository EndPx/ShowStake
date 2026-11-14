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
import { resolveEventTarget } from "./near/event-target";
import { FACTORY_EVENT_RELEASE, listFactoryEventChildren } from "./near/factory-event";
import { mapContractEventState, msToIso } from "./near/views-map";
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
  if (MULTI_EVENT_RELEASE?.network === NETWORK || FACTORY_EVENT_RELEASE?.network === NETWORK) {
    try {
      const items = FACTORY_EVENT_RELEASE ? [] : await loadSharedCatalog(fetchImpl);
      let stale = false;
      const factoryRelease = ACCEPTED_MAINNET_RELEASE ?? FACTORY_EVENT_RELEASE;
      if (FACTORY_EVENT_RELEASE && FACTORY_EVENT_RELEASE.network === NETWORK) {
        try {
          const children=await listFactoryEventChildren(FACTORY_EVENT_RELEASE,RPC_URL,fetchImpl);
          for(const child of children){const e=child.event,state=mapContractEventState(e.phase);if(!state||typeof e.title!=="string"||typeof e.location!=="string"||typeof e.deposit!=="string"||!/^[1-9][0-9]*$/.test(e.deposit)||!Number.isInteger(e.capacity)||Number(e.capacity)<1||Number(e.capacity)>200||!Number.isInteger(e.total_registrations)||Number(e.total_registrations)<0||Number(e.total_registrations)>Number(e.capacity)||![e.reg_open,e.reg_close,e.checkin_open,e.checkin_close].every(v=>typeof v==="number"&&Number.isSafeInteger(v)&&msToIso(v)!==null))throw Error("Invalid factory event");items.push({id:e.event_id,chainEventId:e.event_id,network:NETWORK,contractId:child.contractId,organizerAccount:child.organizer,state,depositAtomic:e.deposit,capacity:Number(e.capacity),title:e.title,venue:e.location,assetSymbol:NETWORK==="testnet"?"Mock USDC":"USDC",assetDecimals:6,participantCount:Number(e.total_registrations),times:{regOpen:msToIso(Number(e.reg_open))??"",regClose:msToIso(Number(e.reg_close))??"",cancelCutoff:msToIso(Number(e.reg_close))??"",checkinOpen:msToIso(Number(e.checkin_open))??"",checkinClose:msToIso(Number(e.checkin_close))??""}});}
        } catch { stale=true; }
      } else if (NETWORK === "mainnet" && factoryRelease) {
        try {
          const envelope = await fetchEventList(apiBaseUrl(), fetchImpl);
          stale = envelope.meta.stale === true || envelope.data?.nextCursor != null;
          const projected = (envelope.data?.items ?? []).map(mapApiEvent);
          const verified = await Promise.all(projected.map(async item => {
            if (item.network !== NETWORK || !item.contractId || !item.chainEventId || !item.contractId.endsWith(`.${factoryRelease.factory}`)) return null;
            try {
              await resolveEventTarget(ACCEPTED_MAINNET_RELEASE, item.contractId, item.chainEventId, RPC_URL, fetchImpl);
              return { ...item, id: item.chainEventId };
            } catch { stale = true; return null; }
          }));
          items.push(...verified.filter((item): item is NonNullable<typeof item> => item !== null));
        } catch { stale = true; }
      }
      const page = { items, nextCursor: null };
      return items.length ? {kind:"ready",page,stale,observedAt:new Date().toISOString()} : {kind:"empty",page,stale,observedAt:new Date().toISOString()};
    } catch { return {kind:"error",message:"On-chain events are temporarily unavailable.",retryable:true}; }
  }
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
