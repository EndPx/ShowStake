import { sharedFinalBlock } from './shared-final.ts';
import { finalBlockViews } from './rpc.ts';
import { multiEventIdentity, multiEventAllowed, multiEventAction, multiEventTransfer, type MultiEventRelease, type MultiEventView, type MultiRegistration } from './multi-event.ts';
import type { SignAndSendParams, FunctionCallAction } from './actions.ts';
const accepted = new WeakSet<object>();
export type SharedEvent = MultiEventView & {title:string;location:string;capacity:number;total_registrations:number;[key:string]:unknown};
export interface SharedSnapshot {release:MultiEventRelease;event:SharedEvent;now:number;blockHash:string;blockHeight:number;blockTimestampMs:number;registration:MultiRegistration|null}
export interface SharedActionContext {snapshot:SharedSnapshot;account:string;receiver:string;action:FunctionCallAction}
export async function sharedSnapshot(release:MultiEventRelease|null,eventId:string,rpc:string,registrationId?:string,fetchImpl:typeof fetch=fetch):Promise<SharedSnapshot>{
 if(!release||!eventId)throw Error('Shared release unavailable');
 const methods:Array<{method:string;args:unknown}>=[{method:'get_config',args:{}},{method:'get_event',args:{event_id:eventId}}];if(registrationId)methods.push({method:'get_registration',args:{registration_id:registrationId}});
 const block=await sharedFinalBlock(rpc,fetchImpl);const r=await finalBlockViews(release.contract,methods,rpc,fetchImpl,block);if(!r.ok)throw Error('Shared event unavailable');
 const [config,event,reg]=r.value.views as [Record<string,unknown>,SharedEvent|null,MultiRegistration|null];const now=block.blockTimestampMs;
 if(!config||!Number.isSafeInteger(now)||Date.now()-now>30000||now>Date.now()+5000||config.token_decimals!==6||!event||event.event_id!==eventId||!multiEventIdentity(release,{network:String(config.network),contract:release.contract,codeHash:String(r.value.account.code_hash),canonicalFt:String(config.canonical_ft),policy:String(config.policy_version)},event))throw Error('Shared event identity mismatch');
 if(registrationId){if(!reg||reg.registration_id!==registrationId)throw Error('Registration unavailable');const pass=await finalBlockViews(release.contract,[{method:'get_pass',args:{pass_id:(reg as any).pass_id}}],rpc,fetchImpl,block);const p=pass.ok?pass.value.views[0] as any:null;if(!p||p.event_id!==eventId||p.registration_id!==registrationId||p.owner!==(reg as any).participant)throw Error('Registration event mismatch');(reg as MultiRegistration).event_id=eventId;}
 return {release,event,now,blockHash:r.blockHash,blockHeight:r.blockHeight,blockTimestampMs:now,registration:reg??null};
}
export async function prepareSharedAction(release:MultiEventRelease|null,eventId:string,account:string,method:string,rpc:string,registrationId?:string,attended?:boolean,commitment?:string):Promise<SharedActionContext>{
 const snapshot=await sharedSnapshot(release,eventId,rpc,registrationId),{event,now,registration}=snapshot;let receiver=snapshot.release.contract,action:FunctionCallAction;
 if(method==='ft_transfer_call'){
  if(event.phase!=='RegistrationOpen'||now<event.reg_open||now>=event.reg_close||!Number.isInteger(event.capacity)||!Number.isInteger(event.total_registrations)||event.total_registrations>=event.capacity||!commitment)throw Error('Registration unavailable');
  const token=await finalBlockViews(snapshot.release.canonicalFt,[{method:'ft_metadata',args:{}},{method:'ft_balance_of',args:{account_id:account}},{method:'storage_balance_of',args:{account_id:account}},{method:'storage_balance_of',args:{account_id:snapshot.release.contract}}],rpc,fetch,snapshot);
  if(!token.ok)throw Error('Token preflight unavailable');const [meta,balance,participant,escrow]=token.value.views as [any,unknown,unknown,unknown];if(meta?.decimals!==6||typeof balance!=='string'||!/^(0|[1-9][0-9]*)$/.test(balance)||BigInt(balance)<BigInt(event.deposit)||!participant||!escrow)throw Error('Token balance or storage unavailable');
  for(let from=0;from<event.total_registrations;from+=50){const page=await finalBlockViews(snapshot.release.contract,[{method:'list_event_registrations',args:{event_id:eventId,from,limit:50}}],rpc,fetch,snapshot);const rows=page.ok?page.value.views[0]:null;if(!Array.isArray(rows)||rows.length!==Math.min(50,event.total_registrations-from)||rows.some((r:any)=>r.participant===account))throw Error('Registration list incomplete or wallet already registered');}
  receiver=snapshot.release.canonicalFt;action=multiEventTransfer(snapshot.release.contract,event,commitment);
 }else{if(!multiEventAllowed(method,event,account,now,registration??undefined))throw Error('Action unavailable for this event and account');action=multiEventAction(method,eventId,registrationId,attended);}
 const context=Object.freeze({snapshot:Object.freeze(snapshot),account,receiver,action:Object.freeze({...action,params:Object.freeze({...action.params,args:Object.freeze({...action.params.args})})})});accepted.add(context);return context;
}
export function sharedActionMatches(context:SharedActionContext|undefined,params:SignAndSendParams,release:MultiEventRelease|null):boolean {return !!context&&accepted.has(context)&&!!release&&JSON.stringify(context.snapshot.release)===JSON.stringify(release)&&Date.now()-context.snapshot.now<=30000&&context.snapshot.now<=Date.now()+5000&&params.network===release.network&&params.signerId===context.account&&params.receiverId===context.receiver&&params.actions.length===1&&JSON.stringify(params.actions[0])===JSON.stringify(context.action);}
