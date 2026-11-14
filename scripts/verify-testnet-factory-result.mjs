// Read-only final proof. It never broadcasts and never overwrites evidence.
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
const dir=resolve(process.argv[2]??'');
assert.ok(process.argv[2], 'evidence directory required');
const run=JSON.parse(await readFile(join(dir,'run.json'),'utf8'));
const txs=JSON.parse(await readFile(join(dir,'transactions.json'),'utf8'));
assert.equal(run.network,'testnet');assert.equal(run.ft,'mockusdc.testnet');
assert.equal(run.users.length,5);assert.equal(run.children.length,2);
const rpc=async(method,params)=>{for(let i=0;i<4;i++){try{const r=await fetch('https://test.rpc.fastnear.com',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'verify',method,params}),signal:AbortSignal.timeout(20000)});if([429,502,503,504].includes(r.status))throw Error(`transient HTTP ${r.status}`);assert.equal(r.status,200);const j=await r.json();if(j.error)throw Error(JSON.stringify(j.error));return j.result;}catch(e){if(i===3||!/429|502|503|504|timeout|timed out|unavailable|temporar|fetch failed/i.test(String(e)))throw e;await new Promise(r=>setTimeout(r,1000+i*2000));}}};
const block=await rpc('block',{finality:'final'}), pin=block.header.hash;
const query=async(params)=>{const x=await rpc('query',{...params,block_id:pin});assert.equal(x.block_hash,pin);if(x.error)throw Error('Contract view failed: '+JSON.stringify(x.error));return x;};
const view=async(account_id,method_name,args={})=>JSON.parse(Buffer.from((await query({request_type:'call_function',account_id,method_name,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')})).result).toString());
const cfg=await view(run.factory,'get_config');
assert.equal(cfg.factory_policy_identity,'showstake-factory-atomic-event/3');assert.equal(cfg.schema_version,3);assert.equal(cfg.atomic_event_initialization,true);assert.equal(cfg.leaf_code_sha256,run.leafSha256.toLowerCase());assert.equal(cfg.provider_account,run.provider);assert.equal(cfg.canonical_ft,run.ft);assert.equal(cfg.provider_kind,'MOCK_TESTNET');
const children=await view(run.factory,'list_all_children',{from_index:0,limit:20});
const observations=[];
for(let j=0;j<2;j++){
 const id=run.children[j], nonce=j+1, eventId=run.events[j];
 const req=await view(run.factory,'get_request',{organizer:run.users[0],request_nonce:nonce});
 const row=await view(run.factory,'get_child',{child_id:id});
 assert.equal(req.state,'Ready');assert.equal(row.state,'Ready');assert.equal(req.child_id,id);assert.equal(row.organizer,run.users[0]);assert.ok(children.some(x=>x.child_id===id&&x.state==='Ready'));
 const account=await query({request_type:'view_account',account_id:id});const keys=await query({request_type:'view_access_key_list',account_id:id});assert.equal(keys.keys.length,0);assert.equal(account.code_hash,run.leafCodeHash);
 const c=await view(id,'get_config'), ev=await view(id,'get_event'), storage=await view(id,'get_storage_state');
 assert.equal(c.organizer,run.users[0]);assert.equal(c.canonical_ft,run.ft);assert.equal(c.network,'testnet');assert.equal(c.provider_account,run.provider);assert.equal(c.provider_kind,'MOCK_TESTNET');assert.equal(c.policy_version,'showstake-native-usdc-event/1');assert.equal(ev.event_id,eventId);assert.equal(ev.active_registrations,5);assert.equal(ev.accepted_principal,'10000000');assert.ok(BigInt(storage.account_balance_yocto)>=BigInt(storage.storage_cost_yocto));
 assert.equal(ev.phase,j===0?'Settled':'Cancelled');if(j===0){assert.equal(ev.earn_state,'Redeemed');assert.equal(ev.realized_yield,'0');}
 assert.equal(await view(run.ft,'ft_balance_of',{account_id:id}),'0');assert.equal(await view(run.provider,'get_position',{account_id:id}),'0');
 const regs=[];
 for(let i=0;i<5;i++){const reg=await view(id,'get_registration',{registration_id:`${eventId}-reg-${i}`});const pass=await view(id,'get_pass',{pass_id:reg.pass_id});const attendee=i===1||i===3;assert.equal(reg.amount,'2000000');assert.equal(reg.participant,run.users[i]);assert.equal(reg.beneficiary,run.users[i]);assert.equal(pass.owner,run.users[i]);assert.equal(pass.registration_id,reg.registration_id);assert.equal(reg.claim_amount,j===1?'2000000':attendee?'5000000':'0');if(j===1||attendee)assert.equal(reg.claim,'Paid');if(j===1&&i===2)assert.equal(reg.claim_attempt,2);if(j===0)assert.equal(reg.attendance,attendee?'Attended':'NoShow');regs.push({registration:reg,pass});}
 observations.push({id,request:req,registry:row,account,config:c,event:ev,storage,registrations:regs});
}
const creation=JSON.parse(await readFile(join(dir,'factory.creation.json'),'utf8'));assert.equal(creation.status,'FINAL_ACCOUNT_OBSERVED');assert.equal(creation.account,run.factory);assert.equal(creation.receipt,'NOT_AVAILABLE');
const failedState=JSON.parse(await readFile(join(dir,'failed-refund-state.json'),'utf8'));assert.equal(failedState.claim,'Claimable');assert.equal(failedState.claim_attempt,1);
const required=['deploy-init-factory','unregister-retry-user','failed-refund','reregister-retry-user','provision-1','provision-2','close-registration','supply','finalize','redeem','settle','claim-1','claim-3','cancel'];
for(let i=0;i<5;i++)required.push(`deposit-1-${i}`,`deposit-2-${i}`,`refund-${i}`);
for(const s of required)assert.ok(txs.some(t=>t.step===s),`missing ${s}`);
const receipts=[];for(const t of txs){assert.match(t.hash,/^[1-9A-HJ-NP-Za-km-z]{32,64}$/);const x=await rpc('EXPERIMENTAL_tx_status',[t.hash,t.sender]);assert.equal(x.final_execution_status,'FINAL');assert.ok(x.status&&Object.hasOwn(x.status,'SuccessValue'));assert.equal(x.transaction.signer_id,t.sender);assert.equal(x.transaction.receiver_id,t.receiver);const failures=x.receipts_outcome.filter(o=>Object.hasOwn(o.outcome.status,'Failure'));if(t.step==='failed-refund'){assert.equal(failures.length,1);assert.equal(failures[0].outcome.executor_id,run.ft);}else assert.equal(failures.length,0);receipts.push({step:t.step,hash:t.hash,sender:t.sender,receiver:t.receiver,actions:x.transaction.actions,status:x.status,transaction_outcome:x.transaction_outcome,receipts_outcome:x.receipts_outcome});}
const balances=[];for(let i=0;i<5;i++){const balance=await view(run.ft,'ft_balance_of',{account_id:run.users[i]});assert.equal(balance,(BigInt(run.baseline[i])-4000000n+(i===0?-16000000n:4000000n)+(i===1||i===3?5000000n:0n)+2000000n).toString());balances.push({account:run.users[i],before:run.baseline[i],after:balance});}
const proof={classification:'PASS_TESTNET',network:'testnet',provider:'TESTNET_MOCK_EARN',rheaLive:'NOT_RUN',realUSDC:'NOT_RUN',browserWallet:'NOT_RUN',finalBlock:{height:block.header.height,hash:pin},factoryCreation:creation,failedRefundState:failedState,factoryConfig:cfg,children:observations,balances,receipts};
await writeFile(join(dir,'result.json'),JSON.stringify(proof,null,2),{flag:'wx'});console.log(`PASS_TESTNET ${join(dir,'result.json')}`);
