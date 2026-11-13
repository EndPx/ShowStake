import { anchoredReceiptGraph } from "./receipt-graph.ts";
import type { ConnectorAction } from "./actions.ts";
export interface MainnetEvent { event_id: string; organizer: string; canonical_ft: string; policy_version: string; phase: string; earn_state: string; accepted_principal: string; reg_close: number; checkin_open: number; checkin_close: number; finalize_deadline: number; [key: string]: unknown }
export function actionAllowed(method: string, event: MainnetEvent, now: number, organizer: boolean, registration?: { beneficiary?: string; claim?: string; claim_amount?: string; amount?: string }, account?: string): boolean {
  if (!Number.isSafeInteger(now)) return false;
  if (method === "claim") { if(!account || registration?.beneficiary!==account)return false; if(event.phase==="Settled")return event.earn_state==="Redeemed" && registration.claim==="Claimable" && /^[1-9][0-9]*$/.test(registration.claim_amount??""); return ["Cancelled","RefundOnly"].includes(event.phase) && ["NotStarted","Redeemed"].includes(event.earn_state) && ["None","Claimable"].includes(registration.claim??"") && /^[1-9][0-9]*$/.test(registration.amount??""); }
  if (method === "activate_timeout_refund") return ["RegistrationOpen","RegistrationClosed"].includes(event.phase) && now>=event.finalize_deadline;
  if (!organizer) return false;
  switch(method) {
    case "cancel_event": return ["RegistrationOpen","RegistrationClosed","AttendanceFinalized"].includes(event.phase);
    case "close_registration": return event.phase === "RegistrationOpen" && now >= event.reg_close;
    case "trigger_earn_supply": return event.phase === "RegistrationClosed" && event.earn_state === "NotStarted" && /^[1-9][0-9]*$/.test(event.accepted_principal);
    case "reconcile_earn": return ["SupplyPending", "RedeemPending"].includes(event.earn_state);
    case "mark_attendance": return event.phase === "RegistrationClosed" && now >= event.checkin_open && now < event.checkin_close;
    case "finalize_attendance": return event.phase === "RegistrationClosed" && event.earn_state === "Supplied" && now >= event.checkin_close && now < event.finalize_deadline;
    case "trigger_earn_redeem": return event.earn_state === "Supplied" && ["AttendanceFinalized", "Cancelled", "RefundOnly"].includes(event.phase);
    case "settle": return event.phase === "AttendanceFinalized" && event.earn_state === "Redeemed";
    default: return false;
  }
}
export interface MainnetAttempt { account: string; child: string; eventId: string; actions: ConnectorAction[]; hash: string | null; claimEvidence?: { registrationId:string;amount:string;attempt:number } }
function same(a: unknown,b: unknown): boolean { if(a===b)return true; if(!a||!b||typeof a!=="object"||typeof b!=="object")return false; const x=a as Record<string,unknown>,y=b as Record<string,unknown>; const keys=Object.keys(x); return keys.length===Object.keys(y).length && keys.every(k=>Object.hasOwn(y,k)&&same(x[k],y[k])); }
export function mainnetReceipt(raw: unknown, attempt: MainnetAttempt): "success" | "failed" | "pending" {
  if(!raw || typeof raw!=="object" || !attempt.hash)return "pending"; const outer=raw as Record<string,any>; const o=outer.final_execution_outcome??outer; const tx=o.transaction;
  if(outer.final_execution_status!=="FINAL" || tx?.hash!==attempt.hash || tx?.signer_id!==attempt.account || tx?.receiver_id!==attempt.child || !Array.isArray(tx.actions) || tx.actions.length!==attempt.actions.length) return "pending";
  for(let i=0;i<attempt.actions.length;i++) { const a=attempt.actions[i]!; if(a.type==="Transfer") { if(String(tx.actions[i]?.Transfer?.deposit)!==a.params.deposit)return "pending"; continue; } const c=tx.actions[i]?.FunctionCall; try { if(c?.method_name!==a.params.methodName || String(c.deposit)!==a.params.deposit || String(c.gas)!==a.params.gas || !same(JSON.parse(atob(c.args)),a.params.args)) return "pending"; } catch { return "pending"; } }
  if(o.status?.Failure || (Array.isArray(o.receipts_outcome) && o.receipts_outcome.some((r:any)=>r.outcome?.status?.Failure)))return "pending";
  if(!o.status || typeof o.status!=="object" || !("SuccessValue" in o.status || "SuccessReceiptId" in o.status) || !Array.isArray(o.receipts_outcome)) return "pending";
  if(!anchoredReceiptGraph(raw))return "pending";
  const method=attempt.actions.find(a=>a.type==="FunctionCall");
  if(method?.type==="FunctionCall" && method.params.methodName==="claim") {
    const id=method.params.args.registration_id;
    const callback=o.receipts.some((r:any)=>r.predecessor_id===attempt.child&&r.receiver_id===attempt.child&&r.receipt?.Action?.actions?.some((a:any)=>{try{return a.FunctionCall?.method_name==="on_claim_result"&&JSON.parse(atob(a.FunctionCall.args)).registration_id===id;}catch{return false;}}));
    if(!callback)return "pending";
  }
  if(method?.type==="FunctionCall" && method.params.methodName==="rhea_storage_deposit") {
    const target=method.params.args.target==="ft"?"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1":method.params.args.target==="provider"?"contract.main.burrow.near":null;
    if(!target||!o.receipts.some((r:any)=>r.predecessor_id===attempt.child&&r.receiver_id===target&&r.receipt?.Action?.actions?.some((a:any)=>a.FunctionCall?.method_name==="storage_deposit")))return "pending";
  }
  return o.receipts_outcome.some((r:any)=>r.outcome?.executor_id===attempt.child && r.outcome?.status && typeof r.outcome.status==="object" && ("SuccessValue" in r.outcome.status || "SuccessReceiptId" in r.outcome.status)) ? "success" : "pending";
}
export function publishMatches(event: MainnetEvent, rules: Record<string,unknown>, organizer: string, ft: string, policy: string): boolean {
  return event.organizer===organizer && event.canonical_ft===ft && event.policy_version===policy && Object.entries(rules).every(([key,value])=>same(event[key],value));
}
export function claimReconciliation(receipt: "success" | "failed" | "pending", account: string, registration: { beneficiary?: string; claim?: string } | null): "paid" | "retry" | "pending" {
  if (!registration || registration.beneficiary !== account) return "pending";
  if (receipt === "success" && registration.claim === "Paid") return "paid";
  if (receipt === "failed" && registration.claim === "Claimable") return "retry";
  return "pending";
}

export function claimFailureProof(raw:unknown,attempt:MainnetAttempt,registration:{registration_id?:string;beneficiary?:string;claim?:string;claim_amount?:string;claim_attempt?:number}|null,expected:{registrationId:string;amount:string;attempt:number}):boolean {
 if(!raw||typeof raw!=="object"||!attempt.hash||!registration||registration.registration_id!==expected.registrationId||registration.beneficiary!==attempt.account||registration.claim!=="Claimable"||registration.claim_amount!==expected.amount||registration.claim_attempt!==expected.attempt)return false;
 const wrap=raw as Record<string,any>,o=wrap.final_execution_outcome??wrap,t=o.transaction,a=attempt.actions[0];if(!o.status||typeof o.status!=="object"||Object.keys(o.status).length!==1||!Object.hasOwn(o.status,"SuccessValue"))return false;if(wrap.final_execution_status!=="FINAL"||t?.hash!==attempt.hash||t?.signer_id!==attempt.account||t?.receiver_id!==attempt.child||attempt.actions.length!==1||a?.type!=="FunctionCall"||a.params.methodName!=="claim"||a.params.args.registration_id!==expected.registrationId||!Array.isArray(t.actions)||t.actions.length!==1)return false;
 try{const f=t.actions[0].FunctionCall;if(f.method_name!=="claim"||String(f.deposit)!==a.params.deposit||String(f.gas)!==a.params.gas||!same(JSON.parse(atob(f.args)),a.params.args))return false;}catch{return false;}
 if(!Array.isArray(o.receipts)||!Array.isArray(o.receipts_outcome))return false;const ft="17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
 const failures=o.receipts.filter((r:any)=>r.predecessor_id===attempt.child&&r.receiver_id===ft&&r.receipt?.Action?.actions?.some((x:any)=>{try{const f=x.FunctionCall,args=JSON.parse(atob(f.args));return f.method_name==="ft_transfer"&&String(f.deposit)==="1"&&args.receiver_id===attempt.account&&args.amount===expected.amount&&args.memo===`${expected.registrationId}:${expected.attempt}`;}catch{return false;}}));if(failures.length!==1)return false;const failure=failures[0];const failureOutcome=o.receipts_outcome.find((x:any)=>x.id===failure.receipt_id)?.outcome;if(!failureOutcome?.status?.Failure)return false;
 const callbacks=o.receipts.filter((r:any)=>r.predecessor_id===attempt.child&&r.receiver_id===attempt.child&&r.receipt?.Action?.actions?.some((x:any)=>{try{const f=x.FunctionCall,args=JSON.parse(atob(f.args));return f.method_name==="on_claim_result"&&args.registration_id===expected.registrationId&&args.attempt===expected.attempt;}catch{return false;}}));if(callbacks.length!==1)return false;const callbackOutcome=o.receipts_outcome.find((x:any)=>x.id===callbacks[0].receipt_id)?.outcome;if(!callbackOutcome?.status||!Object.hasOwn(callbackOutcome.status,"SuccessValue"))return false;
 return anchoredReceiptGraph(raw,failure.receipt_id);
}
