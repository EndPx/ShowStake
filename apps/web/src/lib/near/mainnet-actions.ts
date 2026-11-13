import { leafProfile } from "./reviewed-leaf-release.ts";
import { MAINNET_POLICY } from "../mainnet-policy.ts";
import type { ConnectorAction, FunctionCallAction } from "./actions.ts";
import { REVIEWED_LEAF_SHA256 } from "./factory.ts";
export interface AcceptedMainnetRelease { factory: string; factoryCodeSha256: string; factoryCodeHash: string; canonicalFt: string; policy: string; provider: string; providerKind: "RHEA_MAINNET"; codeSha256: string }
// Filled only after an explicit code, provider and deployment acceptance review.
export const ACCEPTED_MAINNET_RELEASE: AcceptedMainnetRelease | null = MAINNET_POLICY.acceptedFactory;
export interface MainnetBinding { network: "mainnet"; organizer: string; child: string; canonicalFt: string; policy: string; provider: string; providerKind: string; codeSha256: string }
export function acceptedBinding(binding: MainnetBinding, release: AcceptedMainnetRelease | null): boolean {
  return !!release && binding.network === "mainnet" && !!binding.organizer && !!binding.child && binding.child.endsWith(`.${release.factory}`) && binding.canonicalFt === release.canonicalFt && binding.policy === release.policy && binding.provider === release.provider && binding.providerKind === release.providerKind && binding.codeSha256 === release.codeSha256 && !!leafProfile(release.policy,release.codeSha256);
}
function call(methodName: string, args: Record<string, unknown>, gas = "300000000000000", deposit = "0"): FunctionCallAction { return { type: "FunctionCall", params: { methodName, args, gas, deposit } }; }
const positive = (value: string) => /^[1-9][0-9]*$/.test(value) && BigInt(value) < 2n ** 128n;
export function publishBatch(cap: string, rules: Record<string, unknown>, nativeTopup?: string): ConnectorAction[] {
  if (!positive(cap) || typeof rules.deposit !== "string" || !positive(rules.deposit) || !Number.isInteger(rules.capacity) || Number(rules.capacity) < 1 || Number(rules.capacity) > 200 || BigInt(rules.deposit) * BigInt(Number(rules.capacity)) !== BigInt(cap)) throw Error("Invalid principal cap");
  if (nativeTopup !== undefined && !positive(nativeTopup)) throw Error("Invalid native storage top-up");
  return [...(nativeTopup ? [{ type: "Transfer" as const, params: { deposit: nativeTopup } }] : []), call("configure_rhea_cap", { principal_cap: cap }, "30000000000000"), call("set_rhea_paused", { paused: false }, "30000000000000"), call("create_event", { rules }, "30000000000000")];
}
export function lifecycleAction(method: "trigger_rhea_redeem_partial" | "retry_rhea_redeem_partial_preflight" | "recover_rhea_ambiguous" | "cancel_event" | "activate_timeout_refund" | "close_registration" | "mark_attendance" | "finalize_attendance" | "trigger_earn_supply" | "reconcile_earn" | "trigger_earn_redeem" | "settle" | "claim", registrationId?: string, attended?: boolean, amount?:string): FunctionCallAction {
  if(method === "trigger_rhea_redeem_partial" || method === "retry_rhea_redeem_partial_preflight") {if(!amount||!positive(amount))throw Error("Positive atomic amount required");return call(method,{amount});}
  if (method === "cancel_event" || method === "activate_timeout_refund") { if (!registrationId) throw Error("Event ID is required"); return call(method, { event_id: registrationId }); }
  if (method === "mark_attendance") { if (!registrationId || typeof attended !== "boolean") throw Error("Registration and attendance are required"); return call(method, { registration_id: registrationId, attended }); }
  if (method === "claim") { if (!registrationId) throw Error("Registration is required"); return call(method, { registration_id: registrationId }, "300000000000000", "1"); }
  return call(method, {});
}
export function storageAction(target: "ft" | "provider", amount: string): FunctionCallAction {
  if (!positive(amount)) throw Error("Storage amount must be positive atomic NEAR");
  return call("rhea_storage_deposit", { target }, "100000000000000", amount);
}
