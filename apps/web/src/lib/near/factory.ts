import { leafProfile,LEGACY_LEAF_PROFILE,LINKED_LEAF_PROFILE,LINKED_FACTORY_PROFILE,type ReviewedLeafRelease } from "./reviewed-leaf-release.ts";
import { anchoredReceiptGraph } from "./receipt-graph.ts";
import type { FunctionCallAction } from "./actions.ts";
export const REVIEWED_LEAF_SHA256 = "03076c4a9496e8ae1e6af68c791752d4a7220597942effd0c3a1839a252be9d2";
export const REVIEWED_LEAF_BYTES = 224939;
export interface FactoryIdentity { factory: string; factoryCodeSha256: string; factoryCodeHash: string; organizer: string; canonicalFt: string; policy: string; provider: string; providerKind: string }
export interface FactoryConfig { factory_account: string; canonical_ft: string; network: string; provider_account: string; provider_kind: string; leaf_code_len: number; leaf_policy_version: string; leaf_code_sha256: string; factory_policy_identity?:string; schema_version?:number; min_provision_gas_tgas?:number }
export interface FactoryQuote { organizer: string; child_funding: string; registry_fee: string; total: string; attached_gas_tgas: number }
export interface FactoryAttempt { network: "mainnet"; factory: string; organizer: string; nonce: number; child: string; codeHash: string; total: string; hash: string | null }
const atomic = (s: unknown): s is string => typeof s === "string" && /^(0|[1-9][0-9]*)$/.test(s) && BigInt(s) < 2n ** 128n;
export function validateFactory(config: FactoryConfig, quote: FactoryQuote, identity: FactoryIdentity): boolean {
  const profile=leafProfile(identity.policy,config.leaf_code_sha256);if(!profile)return false;if(profile===LINKED_LEAF_PROFILE&&(identity.factoryCodeSha256!==LINKED_FACTORY_PROFILE.sha256||identity.factoryCodeHash!==LINKED_FACTORY_PROFILE.codeHash||config.factory_policy_identity!==LINKED_FACTORY_PROFILE.policyVersion||config.schema_version!==LINKED_FACTORY_PROFILE.schemaVersion||config.min_provision_gas_tgas!==300))return false;
  return !!identity.factory && !!identity.organizer && !!identity.canonicalFt && !!identity.policy && !!identity.provider && config.factory_account === identity.factory && config.network === "mainnet" && config.canonical_ft === identity.canonicalFt && config.leaf_policy_version === identity.policy && config.provider_account === identity.provider && config.provider_kind === identity.providerKind && config.leaf_code_len === profile.codeBytes && config.leaf_code_sha256 === profile.sha256 && quote.organizer === identity.organizer && atomic(quote.child_funding) && atomic(quote.registry_fee) && atomic(quote.total) && BigInt(quote.child_funding) > 0n && BigInt(quote.total) > 0n && BigInt(quote.child_funding) + BigInt(quote.registry_fee) === BigInt(quote.total) && Number.isSafeInteger(quote.attached_gas_tgas) && quote.attached_gas_tgas >= profile.minProvisionGasTgas && quote.attached_gas_tgas <= 300;
}
export async function provisionAction(code: Uint8Array, nonce: number, quote: FactoryQuote,profile:ReviewedLeafRelease=LEGACY_LEAF_PROFILE): Promise<FunctionCallAction> {
  if (!Number.isSafeInteger(nonce) || nonce < 0 || code.length !== profile.codeBytes || !atomic(quote.total) || !Number.isSafeInteger(quote.attached_gas_tgas) || quote.attached_gas_tgas < profile.minProvisionGasTgas || quote.attached_gas_tgas > 300) throw Error("Invalid provision parameters");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", code));
  if (Array.from(digest, x => x.toString(16).padStart(2, "0")).join("") !== profile.sha256) throw Error("Leaf code does not match reviewed artifact");
  let binary = ""; for (const byte of code) binary += String.fromCharCode(byte);
  return { type: "FunctionCall", params: { methodName: "provision", args: { request_nonce: nonce, code: btoa(binary) }, gas: (BigInt(quote.attached_gas_tgas) * 1000000000000n).toString(), deposit: quote.total } };
}
export function saveFactoryAttempt(storage: Pick<Storage, "getItem" | "setItem">, attempt: FactoryAttempt): string {
  if (attempt.network !== "mainnet" || !attempt.factory || !attempt.organizer || !attempt.child || !Number.isSafeInteger(attempt.nonce) || attempt.nonce < 0 || (attempt.codeHash !== LEGACY_LEAF_PROFILE.sha256 && attempt.codeHash !== LINKED_LEAF_PROFILE.sha256) || !atomic(attempt.total) || attempt.hash !== null) throw Error("Invalid pending attempt");
  const key = `showstake:factory:v1:${attempt.network}:${attempt.factory}:${attempt.organizer}:${attempt.nonce}`;
  const value = JSON.stringify(attempt); if (storage.getItem(key) !== null) throw Error("Attempt already exists; reconcile first"); storage.setItem(key, value); if (storage.getItem(key) !== value) throw Error("Cannot persist attempt"); return key;
}
export interface FactoryRequest { organizer: string; request_nonce: number; child_id: string; state: string; leaf_code_sha256: string; canonical_ft: string; network: string; leaf_policy_version: string }
export function matchFactoryRequest(attempt: FactoryAttempt, request: FactoryRequest, identity: FactoryIdentity): "ready" | "failed" | "pending" {
  if (attempt.factory !== identity.factory || attempt.organizer !== identity.organizer || request.organizer !== attempt.organizer || request.request_nonce !== attempt.nonce || request.child_id !== attempt.child || request.network !== "mainnet" || request.leaf_code_sha256 !== attempt.codeHash || request.canonical_ft !== identity.canonicalFt || request.leaf_policy_version !== identity.policy) return "pending";
  return request.state === "Ready" ? "ready" : request.state === "Failed" ? "failed" : "pending";
}

export interface ChildConfig { organizer: string; canonical_ft: string; network: string; policy_version: string; provider_account: string; provider_kind: string }
/** Registry, child identity and a successful final factory callback are all required. */
export function finalFactoryReceipt(raw: unknown, attempt: FactoryAttempt, request: FactoryRequest, identity: FactoryIdentity, child: ChildConfig, observedChildSha256: string, resolutionHash?: string | null): "confirmed" | "failed" | "pending" {
  if (!raw || typeof raw!=="object") return "pending";
  if (matchFactoryRequest(attempt, request, identity) !== "ready" || child.organizer !== identity.organizer || child.canonical_ft !== identity.canonicalFt || child.network !== "mainnet" || child.policy_version !== identity.policy || child.provider_account !== identity.provider || child.provider_kind !== identity.providerKind || !leafProfile(identity.policy,attempt.codeHash) || observedChildSha256 !== attempt.codeHash || !(resolutionHash || attempt.hash) || !raw || typeof raw !== "object") return "pending";
  const wrap = raw as Record<string, any>, outcome = wrap.final_execution_outcome ?? wrap, tx = outcome.transaction, call = tx?.actions?.[0]?.FunctionCall;
  if (tx?.hash !== (resolutionHash || attempt.hash) || tx?.signer_id !== attempt.organizer || tx?.receiver_id !== attempt.factory || tx?.actions?.length !== 1 || call?.method_name !== (resolutionHash ? "resolve_request" : "provision") || String(call?.deposit) !== (resolutionHash ? "0" : attempt.total)) return "pending";
  try { const args = JSON.parse(atob(call.args)); if (args.request_nonce !== attempt.nonce || (resolutionHash ? args.organizer !== attempt.organizer : typeof args.code !== "string")) return "pending"; } catch { return "pending"; }
  if (outcome.status?.Failure || outcome.receipts_outcome?.some((r: any) => r.outcome?.status?.Failure)) return "pending";
  if (!outcome.status || typeof outcome.status !== "object" || !("SuccessValue" in outcome.status || "SuccessReceiptId" in outcome.status) || !Array.isArray(outcome.receipts_outcome)) return "pending";
  if(!anchoredReceiptGraph(raw)) return "pending";
  for (const receipt of outcome.receipts_outcome) {
    if (receipt.outcome?.executor_id !== attempt.factory || !receipt.outcome?.status || !("SuccessValue" in receipt.outcome.status || "SuccessReceiptId" in receipt.outcome.status)) continue;
    for (const line of receipt.outcome.logs ?? []) {
      if (typeof line !== "string" || !line.startsWith("EVENT_JSON:")) continue;
      try { const log = JSON.parse(line.slice(11)), data = log.data?.[0]; if (log.standard === "showstake_factory" && log.version === "1.0.0" && log.event === (resolutionHash ? "ProvisionRecovered" : "RegistryReady") && data?.organizer === attempt.organizer && data.request_nonce === attempt.nonce && data.child_id === attempt.child && data.leaf_code_sha256 === attempt.codeHash && data.canonical_ft === identity.canonicalFt && data.network === "mainnet" && data.leaf_policy_version === identity.policy) return "confirmed"; } catch { /* Ignore unrelated logs. */ }
    }
  }
  return "pending";
}

/** Final refund receipt plus the factory's Paid state; unknown callbacks remain unresolved. */
export function factoryRefundPaidProof(raw:unknown,attempt:FactoryAttempt,request:FactoryRequest & {refund_state?:string;refund_attempt?:number;child_funding?:string},hash:string):boolean {
 if(request.state!=="Failed"||request.refund_state!=="Paid"||!Number.isSafeInteger(request.refund_attempt)||typeof request.child_funding!=="string"||!/^[1-9][0-9]*$/.test(request.child_funding)||request.organizer!==attempt.organizer||request.request_nonce!==attempt.nonce||request.child_id!==attempt.child||!raw||typeof raw!=="object")return false;
 const outer=raw as Record<string,any>,o=outer.final_execution_outcome??outer,t=o.transaction;if((outer.final_execution_status??o.final_execution_status)!=="FINAL"||t?.hash!==hash||t?.signer_id!==attempt.organizer||t?.receiver_id!==attempt.factory||!Array.isArray(t.actions)||t.actions.length!==1||!anchoredReceiptGraph(raw))return false;
 try{const call=t.actions[0].FunctionCall,args=JSON.parse(atob(call.args));if(call.method_name!=="claim_failed_funding"||String(call.deposit)!=="0"||String(call.gas)!=="300000000000000"||Object.keys(args).join(",")!=="request_nonce"||args.request_nonce!==attempt.nonce)return false;}catch{return false;}
 const transfers=o.receipts.filter((r:any)=>r.predecessor_id===attempt.factory&&r.receiver_id===attempt.organizer&&r.receipt?.Action?.actions?.length===1&&String(r.receipt.Action.actions[0]?.Transfer?.deposit)===request.child_funding);if(transfers.length!==1)return false;
 const callbacks=o.receipts.filter((r:any)=>r.predecessor_id===attempt.factory&&r.receiver_id===attempt.factory&&r.receipt?.Action?.actions?.some((a:any)=>{try{const f=a.FunctionCall,args=JSON.parse(atob(f.args));return f.method_name==="on_failed_funding_refund"&&args.organizer===attempt.organizer&&args.request_nonce===attempt.nonce&&args.attempt===request.refund_attempt;}catch{return false;}}));if(callbacks.length!==1)return false;return o.receipts_outcome.find((x:any)=>x.id===callbacks[0].receipt_id)?.outcome?.status?.SuccessValue==="dHJ1ZQ==";
}
