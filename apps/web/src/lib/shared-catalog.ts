import { sharedFinalBlock } from './near/shared-final';
import { sharedReleaseForNetwork, multiEventIdentity, sharedConfigMatches } from './near/multi-event';
import { finalBlockViews } from './near/rpc';
import { mapContractEventState, msToIso } from './near/views-map';
import { RPC_URL, NETWORK } from './config';
import type { EventSummary } from './types';
/** The shared contract, rather than the API index, is the source of event discovery. */
export async function loadSharedCatalog(fetchImpl:typeof fetch=fetch):Promise<EventSummary[]> {
 const release=sharedReleaseForNetwork(NETWORK);if(!release||release.network!==NETWORK)throw Error('Shared release unavailable');
 const block=await sharedFinalBlock(RPC_URL,fetchImpl);const first=await finalBlockViews(release.contract,[{method:'get_config',args:{}},{method:'list_events',args:{from_index:0,limit:50}}],RPC_URL,fetchImpl,block);if(!first.ok)throw Error('Shared catalog unavailable');
 const [config,initial]=first.value.views as [Record<string,unknown>,unknown];const time=block.blockTimestampMs;if(!Number.isSafeInteger(time)||Date.now()-time>30000||time>Date.now()+5000||(!sharedConfigMatches(release,config) || config.token_decimals!==6)||!multiEventIdentity(release,{network:String(config.network),contract:release.contract,codeHash:String(first.value.account.code_hash),canonicalFt:String(config.canonical_ft),policy:String(config.policy_version)})||!Array.isArray(initial))throw Error('Shared catalog identity mismatch');
 const rows=[...initial], pinned={blockHash:first.blockHash,blockHeight:first.blockHeight,blockTimestampMs:time};let next=initial;
 while(next.length===50){if(rows.length>=10000)throw Error('Catalog exceeds safe page limit');const page=await finalBlockViews(release.contract,[{method:'list_events',args:{from_index:rows.length,limit:50}}],RPC_URL,fetchImpl,pinned);if(!page.ok||!Array.isArray(page.value.views[0]))throw Error('Catalog page unavailable');next=page.value.views[0] as unknown[];rows.push(...next);}
 return rows.map((v:any)=>{const state=mapContractEventState(v.phase);if(!state||!multiEventIdentity(release,{network:release.network,contract:release.contract,codeHash:release.codeHash,canonicalFt:release.canonicalFt,policy:release.policy},v))throw Error('Invalid catalog event');return {id:v.event_id,chainEventId:v.event_id,network:release.network,contractId:release.contract,organizerAccount:v.organizer,state,depositAtomic:v.deposit,capacity:v.capacity,title:v.title,venue:v.location,assetSymbol:release.network==='testnet'?'Mock USDC':'USDC',assetDecimals:6,participantCount:v.total_registrations,times:{regOpen:msToIso(v.reg_open)??'',regClose:msToIso(v.reg_close)??'',cancelCutoff:msToIso(v.reg_close)??'',checkinOpen:msToIso(v.checkin_open)??'',checkinClose:msToIso(v.checkin_close)??''}};});
}
