import { finalFactoryReceipt, matchFactoryRequest, type ChildConfig, type FactoryAttempt, type FactoryIdentity, type FactoryRequest } from "./factory.ts";
export type RecoveryStatus = "Ready" | "Pending" | "Failed" | "RefundClaimable" | "InFlight";
export interface RecoveryView { status: RecoveryStatus; request: FactoryRequest & { refund_state: string; created_block: number }; blockHeight: number; blockHash: string; blockTimestampMs:number; resolveEligible: boolean }
export async function inspectFactoryRecovery(attempt: FactoryAttempt, identity: FactoryIdentity, rpcUrl: string, fetchImpl: typeof fetch = fetch, resolutionHash: string | null = null): Promise<RecoveryView> {
  async function rpc(method: string, params: unknown): Promise<any> {
    const response = await fetchImpl(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "showstake-recovery", method, params }), cache: "no-store" });
    if (!response.ok) throw Error("RPC unavailable"); const body = await response.json(); if (body.error || !body.result) throw Error("RPC result unavailable"); return body.result;
  }
  if (attempt.network !== "mainnet" || attempt.factory !== identity.factory || attempt.organizer !== identity.organizer || !attempt.child.endsWith(`.${identity.factory}`) || !Number.isSafeInteger(attempt.nonce) || attempt.nonce < 0) throw Error("Saved attempt identity mismatch");
  const block = await rpc("block", { finality: "final" }), hash = block.header?.hash, height = block.header?.height, stamp=block.header?.timestamp_nanosec;
  if (typeof hash !== "string" || !Number.isSafeInteger(height) || typeof stamp!=="string" || !/^\d+$/.test(stamp)) throw Error("Final block unavailable"); const time=Number(BigInt(stamp)/1000000n); if(!Number.isSafeInteger(time)||Date.now()-time>30000||time>Date.now()+5000)throw Error("Stale final block");
  const query = async (account: string, request: Record<string, unknown>) => { const result = await rpc("query", { ...request, account_id: account, block_id: hash }); if (result.block_hash !== hash || result.block_height !== height || Date.now()-time>30000) throw Error("Block mismatch or stale"); return result; };
  const encode = (v: unknown) => btoa(JSON.stringify(v));
  if(!/^[0-9a-f]{64}$/.test(identity.factoryCodeSha256))throw Error("Factory code identity unavailable");
  const [factoryAccount,factoryCode]=await Promise.all([query(identity.factory,{request_type:"view_account"}),query(identity.factory,{request_type:"view_code"})]);if(!identity.factoryCodeHash||factoryAccount.code_hash!==identity.factoryCodeHash||typeof factoryCode.code_base64!=="string")throw Error("Factory account unavailable");const rawCode=Uint8Array.from(atob(factoryCode.code_base64),c=>c.charCodeAt(0));const factoryDigest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",rawCode)),x=>x.toString(16).padStart(2,"0")).join("");if(factoryDigest!==identity.factoryCodeSha256)throw Error("Factory code mismatch");
  const factoryConfigResult = await query(identity.factory, { request_type: "call_function", method_name: "get_config", args_base64: encode({}) });
  if (!Array.isArray(factoryConfigResult.result)) throw Error("Invalid factory config");
  const factoryConfig = JSON.parse(new TextDecoder().decode(Uint8Array.from(factoryConfigResult.result))) as { pending_timeout_blocks?: number; factory_account?: string; canonical_ft?: string; network?: string; provider_account?: string; provider_kind?: string; leaf_code_sha256?: string; leaf_policy_version?: string; leaf_code_len?: number };
  if (factoryConfig.factory_account !== identity.factory || factoryConfig.canonical_ft !== identity.canonicalFt || factoryConfig.network !== "mainnet" || factoryConfig.provider_account !== identity.provider || factoryConfig.provider_kind !== identity.providerKind || factoryConfig.leaf_code_sha256 !== attempt.codeHash || factoryConfig.leaf_policy_version !== identity.policy || factoryConfig.leaf_code_len !== 224939) throw Error("Factory identity mismatch");
  const requestResult = await query(identity.factory, { request_type: "call_function", method_name: "get_request", args_base64: encode({ organizer: identity.organizer, request_nonce: attempt.nonce }) });
  if (!Array.isArray(requestResult.result)) throw Error("Invalid request view");
  const request = JSON.parse(new TextDecoder().decode(Uint8Array.from(requestResult.result))) as RecoveryView["request"];
  if (!request || request.organizer !== attempt.organizer || request.request_nonce !== attempt.nonce || request.child_id !== attempt.child || request.network !== "mainnet" || request.leaf_code_sha256 !== attempt.codeHash || request.canonical_ft !== identity.canonicalFt || request.leaf_policy_version !== identity.policy) throw Error("Request identity mismatch");
  if (!Number.isSafeInteger(request.created_block) || !Number.isSafeInteger(factoryConfig.pending_timeout_blocks) || factoryConfig.pending_timeout_blocks! < 0) throw Error("Invalid recovery timeout");
  const resolveEligible = request.state === "Pending" && height >= request.created_block + factoryConfig.pending_timeout_blocks!;
  const matched = matchFactoryRequest(attempt, request, identity);
  if (matched === "failed") return { status: request.refund_state === "Claimable" ? "RefundClaimable" : request.refund_state === "InFlight" ? "InFlight" : "Failed", request, blockHeight: height, blockHash: hash, blockTimestampMs:time, resolveEligible };
  if (matched !== "ready" || !(attempt.hash || resolutionHash)) return { status: "Pending", request, blockHeight: height, blockHash: hash, blockTimestampMs:time, resolveEligible };
  const [code, config, keys, tx] = await Promise.all([
    query(attempt.child, { request_type: "view_code" }), query(attempt.child, { request_type: "call_function", method_name: "get_config", args_base64: encode({}) }), query(attempt.child, { request_type: "view_access_key_list" }), rpc("tx", { tx_hash: resolutionHash || attempt.hash, sender_account_id: attempt.organizer, wait_until: "FINAL" }),
  ]);
  if (!Array.isArray(keys.keys) || keys.keys.length !== 0 || typeof code.code_base64 !== "string" || !Array.isArray(config.result) || tx.final_execution_status !== "FINAL") return { status: "Pending", request, blockHeight: height, blockHash: hash, blockTimestampMs:time, resolveEligible };
  const binary = atob(code.code_base64), bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); const sha = Array.from(digest, x => x.toString(16).padStart(2, "0")).join("");
  const outcome = tx.final_execution_outcome ?? tx;
  try {
    const args = JSON.parse(atob(outcome.transaction.actions[0].FunctionCall.args));
    if (!resolutionHash) {
    const submitted = Uint8Array.from(atob(args.code), c => c.charCodeAt(0));
    const submittedDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", submitted));
    if (Array.from(submittedDigest, x => x.toString(16).padStart(2, "0")).join("") !== sha) return { status: "Pending", request, blockHeight: height, blockHash: hash, blockTimestampMs:time, resolveEligible };
    }
  } catch { return { status: "Pending", request, blockHeight: height, blockHash: hash, blockTimestampMs:time, resolveEligible }; }
  const child = JSON.parse(new TextDecoder().decode(Uint8Array.from(config.result))) as ChildConfig;
  const verdict = finalFactoryReceipt(tx, attempt, request, identity, child, sha, resolutionHash);
  return { status: verdict === "confirmed" ? "Ready" : verdict === "failed" ? "Failed" : "Pending", request, blockHeight: height, blockHash: hash, blockTimestampMs:time, resolveEligible };
}
