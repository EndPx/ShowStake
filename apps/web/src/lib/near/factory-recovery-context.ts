import { inspectFactoryRecovery } from "./factory-recovery.ts";
import type { FactoryAttempt, FactoryIdentity } from "./factory.ts";
import type { SignAndSendParams } from "./actions.ts";
// In-process marker prevents accidental context substitution; it is not an XSS or chain-proof boundary. Production callers use the fixed RPC_URL.
const verified=new WeakSet<object>();
export interface FactoryRecoveryContext {readonly identity:Readonly<FactoryIdentity>;readonly nonce:number;readonly method:"resolve_request"|"claim_failed_funding";readonly blockTimestampMs:number}
export async function prepareFactoryRecoveryContext(attempt:FactoryAttempt,identity:FactoryIdentity,method:FactoryRecoveryContext["method"],rpcUrl:string,fetchImpl:typeof fetch=fetch):Promise<FactoryRecoveryContext>{
 if(!attempt.hash)throw Error("Original transaction hash required for recovery");const view=await inspectFactoryRecovery(attempt,identity,rpcUrl,fetchImpl);
 if(method==="resolve_request"?(view.status!=="Pending"||!view.resolveEligible):(view.status!=="RefundClaimable"))throw Error("Factory request is not eligible for this action");
 const context=Object.freeze({identity:Object.freeze({...identity}),nonce:attempt.nonce,method,blockTimestampMs:view.blockTimestampMs});verified.add(context);return context;
}
export function factoryRecoveryMatches(context:FactoryRecoveryContext|undefined,params:SignAndSendParams,now=Date.now()):boolean {
 if(!context||!verified.has(context)||now-context.blockTimestampMs>30000||context.blockTimestampMs>now+5000||params.network!=="mainnet"||params.signerId!==context.identity.organizer||params.receiverId!==context.identity.factory||params.actions.length!==1)return false;
 const a=params.actions[0];if(!a||a.type!=="FunctionCall"||a.params.methodName!==context.method||a.params.gas!=="300000000000000"||a.params.deposit!=="0")return false;const args=a.params.args;
 return context.method==="resolve_request"?Object.keys(args).sort().join(",")==="organizer,request_nonce"&&args.organizer===context.identity.organizer&&args.request_nonce===context.nonce:Object.keys(args).join(",")==="request_nonce"&&args.request_nonce===context.nonce;
}
