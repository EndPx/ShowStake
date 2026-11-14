import {sharedFinalBlock} from './shared-final.ts';
import {finalBlockViews} from './rpc.ts';
import {multiEventIdentity,sharedConfigMatches,type MultiEventRelease} from './multi-event.ts';
import {publishMatches,type MainnetAttempt} from './mainnet-lifecycle.ts';
/** A retry must use the original event ID and exact original action, never a new draft. */
export function savedCreateRules(attempt:MainnetAttempt,release:MultiEventRelease,account:string):Record<string,unknown>{
  const action=attempt.actions?.[0];
  if(attempt.account!==account||attempt.child!==release.contract||attempt.actions.length!==1||action?.type!=='FunctionCall'||action.params.methodName!=='create_event'||action.params.gas!=='300000000000000'||typeof action.params.args.rules!=='object'||!action.params.args.rules||Array.isArray(action.params.args.rules))throw Error('Saved event creation identity is invalid.');
  const rules=action.params.args.rules as Record<string,unknown>;
  if(rules.event_id!==attempt.eventId||!attempt.eventId||! /^(0|[1-9][0-9]*)$/.test(action.params.deposit))throw Error('Saved event creation identity is invalid.');
  return rules;
}
export async function inspectSavedCreate(attempt:MainnetAttempt,release:MultiEventRelease,account:string,rpc:string,fetchImpl:typeof fetch=fetch){
  const rules=savedCreateRules(attempt,release,account),block=await sharedFinalBlock(rpc,fetchImpl);
  const result=await finalBlockViews(release.contract,[{method:'get_config',args:{}},{method:'get_event',args:{event_id:attempt.eventId}}],rpc,fetchImpl,block);
  if(!result.ok)throw Error('Final event state unavailable. Keep this attempt and check again.');
  const [config,event]=result.value.views as [Record<string,unknown>,any];
  if(!config||!sharedConfigMatches(release,config)||!multiEventIdentity(release,{network:String(config.network),contract:release.contract,codeHash:String(result.value.account.code_hash),canonicalFt:String(config.canonical_ft),policy:String(config.policy_version)}))throw Error('Contract identity changed. Keep this attempt for review.');
  if(event!==null&&!publishMatches(event,rules,account,release.canonicalFt,release.policy))throw Error('This event ID exists with different details. Do not retry.');
  return {found:event!==null,rules,blockHeight:block.blockHeight};
}
