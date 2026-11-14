import { FACTORY_EVENT_RELEASE } from "@/lib/near/factory-event";
﻿import { sharedReleaseForNetwork } from "@/lib/near/multi-event";
import { SharedEventRoute } from "@/components/event/shared-event-route";
import { NETWORK } from "@/lib/config";
import { MainnetEventRoute } from "@/components/event/mainnet-event-route";
import { OrganizerPanel } from "@/components/event/lifecycle-panels";
export default async function Page({params,searchParams}:{params:Promise<{eventId:string}>;searchParams:Promise<{contract?:string}>}){const {eventId}=await params;const {contract}=await searchParams;return sharedReleaseForNetwork(NETWORK) && contract===sharedReleaseForNetwork(NETWORK)?.contract?<SharedEventRoute eventId={eventId} mode="host"/>:(NETWORK==="mainnet" || !!FACTORY_EVENT_RELEASE && FACTORY_EVENT_RELEASE.network===NETWORK && !!contract?.endsWith(`.${FACTORY_EVENT_RELEASE.factory}`))?<MainnetEventRoute mode="host" eventId={eventId} contractId={contract??""}/>:<OrganizerPanel eventId={eventId}/>;}
