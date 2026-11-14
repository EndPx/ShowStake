import { sharedFinalBlock } from './shared-final.ts';
import { finalBlockViews } from './rpc.ts';
import type { SignAndSendParams } from './actions.ts';
import { multiEventIdentity, sharedConfigMatches, type MultiEventRelease } from './multi-event.ts';
const contexts = new WeakSet<object>();
export interface MultiCreateContext { readonly release: MultiEventRelease; readonly signer: string; readonly rules: Readonly<Record<string,unknown>>; readonly quote: string; readonly at: number }
/** All identity, event existence and quote observations come from the same final block. */
export async function prepareMultiCreate(release:MultiEventRelease|null,signer:string,rules:Record<string,unknown>,rpc:string,fetchImpl:typeof fetch=fetch):Promise<MultiCreateContext> {
 if(!release || !signer || typeof rules.event_id!=='string' || !rules.event_id)throw Error('Shared release unavailable');
 const block=await sharedFinalBlock(rpc,fetchImpl);
 const result=await finalBlockViews(release.contract,[{method:'get_config',args:{}},{method:'get_event',args:{event_id:rules.event_id}},{method:'quote_create_event',args:{rules,organizer:signer}}],rpc,fetchImpl,block);
 if(!result.ok)throw Error('Final block unavailable');
 const [config,event,quote]=result.value.views as [Record<string,unknown>,unknown,unknown];
 if(!config || !multiEventIdentity(release,{network:String(config.network),contract:release.contract,codeHash:String(result.value.account.code_hash),canonicalFt:String(config.canonical_ft),policy:String(config.policy_version)}) || (!sharedConfigMatches(release,config) || config.token_decimals!==6) || event!==null || typeof quote!=='string' || !/^(0|[1-9][0-9]*)$/.test(quote) || BigInt(quote)>=2n**128n)throw Error('Shared contract identity, event or quote mismatch');
 const context=Object.freeze({release:Object.freeze({...release}),signer,rules:Object.freeze(structuredClone(rules)),quote,at:block.blockTimestampMs});contexts.add(context);return context;
}
export function multiCreateMatches(context:MultiCreateContext|undefined,params:SignAndSendParams,release:MultiEventRelease|null):boolean {
 if(!context||!contexts.has(context)||!release||Date.now()-context.at>30000||Date.now()<context.at||JSON.stringify(context.release)!==JSON.stringify(release)||params.network!==release.network||params.signerId!==context.signer||params.receiverId!==release.contract||params.actions.length!==1)return false;
 const a=params.actions[0];return a?.type==='FunctionCall'&&a.params.methodName==='create_event'&&a.params.gas==='300000000000000'&&a.params.deposit===context.quote&&JSON.stringify(a.params.args)===JSON.stringify({rules:context.rules});
}
