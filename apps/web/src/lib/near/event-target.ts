import { resolvePublicChild, type PublicChild } from "./public-child.ts";
import { MANUAL_TARGET, resolveManualTarget } from "./manual-target.ts";
import type { AcceptedMainnetRelease } from "./mainnet-actions.ts";
import { FACTORY_EVENT_RELEASE, resolveFactoryEventChild } from "./factory-event.ts";
export async function resolveEventTarget(release:AcceptedMainnetRelease|null,contractId:string,eventId:string,rpcUrl:string,fetchImpl:typeof fetch=fetch):Promise<PublicChild>{
 if(FACTORY_EVENT_RELEASE && contractId.endsWith(`.${FACTORY_EVENT_RELEASE.factory}`))return resolveFactoryEventChild(FACTORY_EVENT_RELEASE,contractId,eventId,rpcUrl,fetchImpl);
 if(contractId!==MANUAL_TARGET.contract)return resolvePublicChild(release,contractId,eventId,rpcUrl,fetchImpl);
 const target=await resolveManualTarget(eventId,rpcUrl,fetchImpl);if(!target.event)throw Error("Event unavailable");return {...target,event:target.event,factory:"",factoryCodeHash:"",factoryCodeSha256:"",canonicalFt:MANUAL_TARGET.canonicalFt,policy:MANUAL_TARGET.policy,provider:MANUAL_TARGET.provider};
}
