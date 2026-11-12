// Read-only final receipt and balance acceptance for the five-person testnet run.
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
const dir=resolve(process.argv[2]??'docs/evidence/testnet-lifecycle-1113013557');
const run=JSON.parse(await readFile(join(dir,'run.json'),'utf8'));
assert.equal(run.network,'testnet');
const txs=JSON.parse(await readFile(join(dir,'transactions.json'),'utf8'));
async function rpc(method,params){const response=await fetch('https://rpc.testnet.near.org',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'acceptance',method,params})});assert.equal(response.status,200);const data=await response.json();if(data.error)throw Error(JSON.stringify(data.error));return data.result;}
const block=await rpc('block',{finality:'final'});
const pin=block.header.hash;
async function view(contract,method,args={}){const r=await rpc('query',{request_type:'call_function',block_id:pin,account_id:contract,method_name:method,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')});assert.equal(r.block_hash,pin);return JSON.parse(Buffer.from(r.result).toString());}
const ev=await view(run.contract,'get_event');
assert.equal(ev.phase,'Settled');assert.equal(ev.earn_state,'Redeemed');assert.equal(ev.accepted_principal,'10000000');assert.equal(ev.active_registrations,5);assert.equal(ev.realized_yield,'0');
assert.equal(await view(run.ft,'ft_balance_of',{account_id:run.contract}),'0');
assert.equal(await view(run.ft,'ft_balance_of',{account_id:run.providerContract}),'0');
assert.equal(await view(run.providerContract,'get_position',{account_id:run.contract}),'0');
const observations=[];
for(let i=0;i<5;i++){
 const reg=await view(run.contract,'get_registration',{registration_id:`five-two-attendees-reg-${i}`});
 const pass=await view(run.contract,'get_pass',{pass_id:reg.pass_id});
 const balance=await view(run.ft,'ft_balance_of',{account_id:run.users[i]});
 const attended=[1,3].includes(i);
 assert.equal(reg.amount,'2000000');assert.equal(reg.beneficiary,run.users[i]);assert.equal(pass.owner,run.users[i]);assert.equal(pass.registration_id,reg.registration_id);
 assert.equal(reg.attendance,attended?'Attended':'NoShow');assert.equal(reg.claim_amount,attended?'5000000':'0');if(attended)assert.equal(reg.claim,'Paid');
 if(i>0)assert.equal(balance,attended?'5000000':'0');
 observations.push({accountId:run.users[i],principal:'2000000',allocation:reg.claim_amount,claim:reg.claim,attendance:reg.attendance,balance,passId:pass.pass_id});
}
const receipts=[];
for(const step of ['supply','redeem','settle','claim-1','claim-3']){
 const tx=txs.find(t=>t.step===step);assert.ok(tx);
 const sender=step==='claim-1'?run.users[1]:step==='claim-3'?run.users[3]:run.users[0];
 const result=await rpc('EXPERIMENTAL_tx_status',[tx.hash,sender]);assert.equal(result.final_execution_status,'FINAL');assert.ok('SuccessValue' in result.status);
 assert.equal(result.transaction.receiver_id,run.contract);assert.equal(result.transaction.signer_id,sender);
 assert.ok(result.receipts_outcome.every(r=>!('Failure' in r.outcome.status)));
 await writeFile(join(dir,`${step}.receipt.json`),JSON.stringify(result,null,2));
 receipts.push({step,hash:tx.hash,sender,final:true,executors:result.receipts_outcome.map(r=>r.outcome.executor_id)});
}
const proof={classification:'PASS_TESTNET',scope:'5 real testnet accounts deposit 2 Mock USDC; real testnet MockEarn supply/redeem zero yield; two attendees actually paid 5 Mock USDC each',network:'testnet',provider:'TESTNET_MOCK_EARN',rheaLive:'NOT_RUN',contract:run.contract,providerContract:run.providerContract,token:run.ft,event:ev,finalBlock:{height:block.header.height,hash:pin},observations,receipts,runnerCorrection:'Initial balance assertion omitted 8 USDC of organizer funding to four test users. Fixed without replaying deposits or settlement; resumed only unsubmitted claims.',remaining:['browser wallet E2E NOT_RUN','real Rhea supply/redeem NOT_RUN','cancel/timeout/failure retry testnet scenarios NOT_RUN']};
await writeFile(join(dir,'result.json'),JSON.stringify(proof,null,2));
console.log(JSON.stringify({classification:proof.classification,contract:proof.contract,attendees:observations.filter(o=>o.claim==='Paid'),escrowBalance:'0',providerPosition:'0',evidence:join(dir,'result.json')},null,2));
