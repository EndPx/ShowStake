// Read-only regression against the recorded Mock USDC testnet provision.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { FACTORY_EVENT_RELEASE, verifyFactoryEvent, type EventAttempt } from "./factory-event.ts";
import { anchoredReceiptGraph } from "./receipt-graph.ts";

const rpc="https://test.rpc.fastnear.com",hash="31D22m1uwAXXUKixPdoEJoRP9HUWtL1qrMBmwQAFq9EQ",account="showstake-participant-endpx.testnet";
assert.ok(FACTORY_EVENT_RELEASE && FACTORY_EVENT_RELEASE.network==="testnet");
const evidence=JSON.parse(await readFile("docs/evidence/testnet-factory-c1113232934/result.json","utf8")),event=evidence.children[0].event;
const rules=Object.fromEntries(["event_id","title","location","rules_text","deposit","capacity","reg_open","reg_close","checkin_open","checkin_close","finalize_deadline"].map(k=>[k,event[k]]));
const code=await readFile("apps/web/public/contracts/showstake-event-factory-a90cc890.wasm");
const attempt:EventAttempt={account,nonce:1,child:evidence.children[0].id,rules,hash,action:{type:"FunctionCall",params:{methodName:"provision_event",args:{request_nonce:1,rules,code:code.toString("base64")},gas:"300000000000000",deposit:evidence.children[0].request.attached}}};
const observed:string[]=[];
const tracked:typeof fetch=async(url,init)=>{const request=JSON.parse(String(init?.body));if(request.method==="EXPERIMENTAL_tx_status"){assert.deepEqual(request.params,[hash,account]);observed.push(request.method);}return fetch(url,init);};
const response=await fetch(rpc,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:"proof",method:"EXPERIMENTAL_tx_status",params:[hash,account]})});const body=await response.json();assert.equal(body.result?.final_execution_status,"FINAL");assert.equal(anchoredReceiptGraph(body.result),true);assert.equal(anchoredReceiptGraph({...body.result,receipts:undefined}),false);
await verifyFactoryEvent(FACTORY_EVENT_RELEASE,attempt,rpc,tracked);assert.deepEqual(observed,["EXPERIMENTAL_tx_status"]);
console.log("PASS_TESTNET read-only full factory receipt and child identity");
