import { MULTI_EVENT_RELEASE, SHARED_YIELD_RELEASE, reviewedSharedYieldRelease, type MultiEventRelease } from './multi-event.ts';
import { multiCreateMatches, type MultiCreateContext } from './multi-create.ts';
import { sharedActionMatches, type SharedActionContext } from './shared-event.ts';
import type { SignAndSendParams } from './actions.ts';
/** Review and deployment must pin this public CREATE policy before enabling it. */
export interface SharedCreatePolicy {network:'mainnet'|'testnet';contract:string;maxStorageYocto:string;enabled:boolean}
export const SHARED_CREATE_POLICY:SharedCreatePolicy = Object.freeze({network:'mainnet',contract:'showstake-mainnet-escrow-endpx-2026.near',maxStorageYocto:'10000000000000000000000000',enabled:true});
export function sharedCreateAllowed(params:SignAndSendParams,context:MultiCreateContext|undefined,release:MultiEventRelease|null,policy:SharedCreatePolicy):boolean {
 return policy.enabled && !!context && !!release && policy.network===release.network && policy.contract===release.contract && policy.network===params.network && policy.contract===params.receiverId && /^(0|[1-9][0-9]*)$/.test(policy.maxStorageYocto) && /^(0|[1-9][0-9]*)$/.test(context.quote) && BigInt(context.quote)<=BigInt(policy.maxStorageYocto) && multiCreateMatches(context,params,release);
}
export function sharedWalletRequestAllowed(params:SignAndSendParams,context?:unknown):boolean {
 const r=SHARED_YIELD_RELEASE;
 return sharedCreateAllowed(params,context as MultiCreateContext|undefined,MULTI_EVENT_RELEASE,SHARED_CREATE_POLICY) || !!r && reviewedSharedYieldRelease(r) && (sharedCreateAllowed(params,context as MultiCreateContext|undefined,r,{network:r.network,contract:r.contract,maxStorageYocto:r.maxStorageYocto!,enabled:true}) || sharedActionMatches(context as SharedActionContext|undefined,params,r));
}
