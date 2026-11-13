import assert from "node:assert/strict";
import { storageApprovalQuote } from "./storage-approval.ts";
let wrong=false, existing: unknown=null;
const mock=async (_:unknown,init?:RequestInit)=>{const p=JSON.parse(String(init?.body));assert.equal(p.params.block_id,"block");const value=p.params.method_name==="storage_balance_bounds"?{min:"100",max:"500"}:existing;return new Response(JSON.stringify({result:{block_hash:wrong?"other":"block",result:Array.from(new TextEncoder().encode(JSON.stringify(value)))}}));};
assert.equal(await storageApprovalQuote("rpc","ft.near","child.near","block",mock as typeof fetch),"100");existing={total:"60",available:"5"};assert.equal(await storageApprovalQuote("rpc","ft.near","child.near","block",mock as typeof fetch),"40");existing={total:"100",available:"0"};assert.equal(await storageApprovalQuote("rpc","ft.near","child.near","block",mock as typeof fetch),"0");wrong=true;await assert.rejects(()=>storageApprovalQuote("rpc","ft.near","child.near","block",mock as typeof fetch));
console.log("PASS_LOCAL exact storage quote and block binding");
