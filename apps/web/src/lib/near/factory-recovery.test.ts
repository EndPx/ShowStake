import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { inspectFactoryRecovery } from "./factory-recovery.ts";
import { REVIEWED_LEAF_SHA256 } from "./factory.ts";
const identity = { factory:"factory.near", factoryCodeSha256:createHash("sha256").update("factory").digest("hex"), factoryCodeHash:"hash", organizer:"alice.near", canonicalFt:"usdc.near", policy:"policy/1", provider:"provider.near", providerKind:"RHEA_MAINNET" };
const attempt = { network:"mainnet" as const, factory:identity.factory, organizer:identity.organizer, nonce:7, child:"child.factory.near", codeHash:REVIEWED_LEAF_SHA256, total:"235", hash:"tx-hash" };
const request = { organizer:identity.organizer, request_nonce:7, child_id:attempt.child, state:"Ready", refund_state:"None", created_block:5, leaf_code_sha256:REVIEWED_LEAF_SHA256, canonical_ft:identity.canonicalFt, network:"mainnet", leaf_policy_version:identity.policy };
const config = { organizer:identity.organizer, canonical_ft:identity.canonicalFt, network:"mainnet", policy_version:identity.policy, provider_account:identity.provider, provider_kind:identity.providerKind };
const event = { standard:"showstake_factory",version:"1.0.0",event:"RegistryReady",data:[{organizer:identity.organizer,request_nonce:7,child_id:attempt.child,leaf_code_sha256:REVIEWED_LEAF_SHA256,canonical_ft:identity.canonicalFt,network:"mainnet",leaf_policy_version:identity.policy}] };
const wasm = await readFile("test-support/contract-integration/wasm/showstake-mainnet-review.wasm");
const tx = { final_execution_status:"FINAL", status:{SuccessValue:""}, transaction:{hash:attempt.hash,signer_id:identity.organizer,receiver_id:identity.factory,actions:[{FunctionCall:{method_name:"provision",deposit:"235",args:btoa(JSON.stringify({request_nonce:7,code:wasm.toString("base64")}))}}]},receipts_outcome:[{outcome:{executor_id:identity.factory,status:{SuccessValue:""},logs:[`EVENT_JSON:${JSON.stringify(event)}`]}}] };
const txLinked={...tx,transaction_outcome:{id:tx.transaction.hash,outcome:{executor_id:identity.organizer,status:{SuccessReceiptId:"r1"},receipt_ids:["r1"]}},receipts:[{receipt_id:"r1",predecessor_id:identity.organizer,receiver_id:identity.factory,receipt:{Action:{actions:tx.transaction.actions}}}],receipts_outcome:[{id:"r1",outcome:{...tx.receipts_outcome[0]!.outcome,receipt_ids:[]}}]};
let wrongBlock = false, alteredCode = false, wrongFactory = false, staleBlock = false, wrongHeight = false;
const mock = async (_: unknown, options?: RequestInit) => { const p=JSON.parse(String(options?.body)); let result: unknown;
 if(p.method === "block") result={header:{hash:"block",height:42,timestamp_nanosec:String(BigInt(Date.now()-(staleBlock?60000:0))*1000000n)}};
 else if(p.method === "tx") { txLinked.transaction=tx.transaction;txLinked.transaction_outcome.id=tx.transaction.hash;txLinked.receipts[0]!.receipt.Action.actions=tx.transaction.actions;txLinked.receipts_outcome[0]!.outcome.logs=tx.receipts_outcome[0]!.outcome.logs;result=txLinked; }
 else { assert.equal(p.params.block_id,"block"); const block_hash=wrongBlock?"wrong":"block",block_height=wrongHeight?41:42; if(p.params.request_type === "view_access_key_list") result={block_hash,block_height,keys:[]}; else if(p.params.request_type === "view_account") result={block_hash,block_height,code_hash:"hash"}; else if(p.params.request_type === "view_code") result={block_hash,block_height,code_base64:(p.params.account_id===identity.factory?Buffer.from(wrongFactory?"wrong":"factory"):alteredCode?Buffer.from("wrong"):wasm).toString("base64")}; else { const v=p.params.method_name === "get_request"?request:p.params.account_id === identity.factory?{ pending_timeout_blocks: 10, factory_account:identity.factory, canonical_ft:identity.canonicalFt, network:"mainnet", provider_account:identity.provider, provider_kind:identity.providerKind, leaf_code_sha256:REVIEWED_LEAF_SHA256, leaf_policy_version:identity.policy, leaf_code_len:224939 }:config; result={block_hash,block_height,result:Array.from(new TextEncoder().encode(JSON.stringify(v)))}; } }
 return new Response(JSON.stringify({result})); };
assert.equal((await inspectFactoryRecovery(attempt,identity,"rpc",mock as typeof fetch)).status,"Ready");
alteredCode=true; assert.equal((await inspectFactoryRecovery(attempt,identity,"rpc",mock as typeof fetch)).status,"Pending"); alteredCode=false;
wrongBlock=true; await assert.rejects(() => inspectFactoryRecovery(attempt,identity,"rpc",mock as typeof fetch),/Block mismatch/); wrongBlock=false;
request.state="Failed"; request.refund_state="Claimable"; assert.equal((await inspectFactoryRecovery(attempt,identity,"rpc",mock as typeof fetch)).status,"RefundClaimable");
request.refund_state="InFlight"; assert.equal((await inspectFactoryRecovery(attempt,identity,"rpc",mock as typeof fetch)).status,"InFlight");
console.log("PASS_LOCAL factory recovery RPC provenance");
request.state="Pending"; request.refund_state="None";
assert.equal((await inspectFactoryRecovery(attempt,identity,"rpc",mock as typeof fetch)).resolveEligible,true);
request.created_block=40;
assert.equal((await inspectFactoryRecovery(attempt,identity,"rpc",mock as typeof fetch)).resolveEligible,false);
request.created_block=5; request.state="Ready";
const resolveEvent={...event,event:"ProvisionRecovered"};
tx.transaction.hash="resolve-hash"; tx.transaction.actions=[{FunctionCall:{method_name:"resolve_request",deposit:"0",args:btoa(JSON.stringify({organizer:identity.organizer,request_nonce:7}))}}];
tx.receipts_outcome[0]!.outcome.logs=[`EVENT_JSON:${JSON.stringify(resolveEvent)}`];
assert.equal((await inspectFactoryRecovery(attempt,identity,"rpc",mock as typeof fetch,"resolve-hash")).status,"Ready");
tx.receipts_outcome[0]!.outcome.logs=[];
assert.equal((await inspectFactoryRecovery(attempt,identity,"rpc",mock as typeof fetch,"resolve-hash")).status,"Pending");

staleBlock=true;await assert.rejects(()=>inspectFactoryRecovery(attempt,identity,"rpc",mock as typeof fetch),/Stale/);staleBlock=false;wrongFactory=true;await assert.rejects(()=>inspectFactoryRecovery(attempt,identity,"rpc",mock as typeof fetch),/Factory code mismatch/);wrongFactory=false;wrongHeight=true;await assert.rejects(()=>inspectFactoryRecovery(attempt,identity,"rpc",mock as typeof fetch),/Block mismatch/);
