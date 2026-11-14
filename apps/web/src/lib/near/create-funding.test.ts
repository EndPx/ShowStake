import assert from 'node:assert/strict';
import {readCreateFunding} from './create-funding.ts';
let amount='1',locked='0',badBlock=false,missing=false;
const fake=async(_:unknown,init?:RequestInit)=>{const q=JSON.parse(String(init?.body));let result:any;
 if(q.method==='block')result={header:{hash:'B',height:12,timestamp_nanosec:String(BigInt(Date.now())*1000000n)}};
 else if(q.method==='query'){assert.equal(q.params.block_id,'B');assert.equal(q.params.account_id,'host.near');result={amount,locked,storage_usage:100,block_hash:badBlock?'foreign':'B',block_height:12};}
 else if(q.method==='gas_price'){assert.deepEqual(q.params,['B']);result={gas_price:'100000000'};}
 else if(q.method==='EXPERIMENTAL_protocol_config'){assert.equal(q.params.block_id,'B');result={runtime_config:missing?{}:{storage_amount_per_byte:'10000000000000000000'}};}
 else throw Error('Unexpected mutable RPC method');
 return new Response(JSON.stringify({result}));};
const empty=await readCreateFunding('host.near','200000000000000000000000','rpc',fake as typeof fetch);assert.equal(empty.available,'0');assert.equal(empty.gasBudget,'33000000000000000000000');assert.equal(empty.shortfall,'233000000000000000000000');
amount='1000000000000000000000000';const funded=await readCreateFunding('host.near',empty.storage,'rpc',fake as typeof fetch);assert.equal(funded.available,'999000000000000000000000');assert.equal(funded.shortfall,'0');
locked='1000000000000000000000';const stakeBacked=await readCreateFunding('host.near',empty.storage,'rpc',fake as typeof fetch);assert.equal(stakeBacked.available,amount);
badBlock=true;await assert.rejects(()=>readCreateFunding('host.near',empty.storage,'rpc',fake as typeof fetch),/invalid/);badBlock=false;missing=true;await assert.rejects(()=>readCreateFunding('host.near',empty.storage,'rpc',fake as typeof fetch),/invalid/);
console.log('PASS_LOCAL exact NEAR shortfall, gas planning buffer, locked storage stake, pinned block and malformed config denial');
