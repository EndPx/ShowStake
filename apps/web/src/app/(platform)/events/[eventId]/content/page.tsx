import { MULTI_EVENT_RELEASE } from "@/lib/near/multi-event";
import { SharedEventRoute } from "@/components/event/shared-event-route";
import { NETWORK } from "@/lib/config";
import { MainnetEventRoute } from "@/components/event/mainnet-event-route";
import { ContentPanel } from "@/components/event/lifecycle-panels";
export default async function Page({params,searchParams}:{params:Promise<{eventId:string}>;searchParams:Promise<{contract?:string}>}){const {eventId}=await params;const {contract}=await searchParams;return MULTI_EVENT_RELEASE && contract === MULTI_EVENT_RELEASE.contract ? <SharedEventRoute eventId={eventId} mode="content"/> : NETWORK==="mainnet"?<MainnetEventRoute mode="content" eventId={eventId} contractId={contract??""}/>:<ContentPanel eventId={eventId}/>;}
