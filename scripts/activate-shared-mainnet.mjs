// Read-only by default. --execute additionally requires an exact recorded human approval.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {requireFeeWithinLimit} from './shared-upgrade-fee-bound.mjs';
const account='showstake-mainnet-escrow-endpx-2026.near';
const ft='17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',provider='contract.main.burrow.near';
const oldHash='EUA9Rm9RvU6SwDbkAsqosP9JCSD4qBRhe75p5PnapdyY',newHash='4Dq4uEH2PE9FEB7n67d3r3fvHPUy5KAvjhgZ8q5sX4PU';
const sha='2fdc615b6427858b8a351b03343385052353ef1b466caad47d16a19c49e24c53',providerHash='6Nek1MZ8cwJJ2xMQAUWup9V5AToYS9rkTxJfwo6BCpFa';
const publicKey='ed25519:FQJ3SrmLBtQU7xjigLN9NW2aMu2PUTT6Tper1CvnYe2X';
const artifact='test-support/contract-integration/wasm/showstake-shared-yield-v2.wasm',maxFee=10000000000000000000000n;
const minimumFundedBalance=2896370729841206400000000n;
const marker='.local/shared-upgrade-v8-attempt.json',out='docs/evidence/shared-mainnet-upgrade-v8-20261114';
const execute=process.argv.includes('--execute');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const save=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n');
async function rpc(method,params){const r=await fetch('https://free.rpc.fastnear.com',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'shared-upgrade-v8',method,params}),signal:AbortSignal.timeout(20000)});const b=await r.json();assert.ok(r.ok&&!b.error&&b.result,'RPC unavailable; no retry of signing');return b.result;}
async function snapshot(){
 const h=(await rpc('block',{finality:'final'})).header;
 const query=async(id,request_type,extra={})=>{const r=await rpc('query',{account_id:id,request_type,block_id:h.hash,...extra});assert.equal(r.block_hash,h.hash);assert.equal(r.block_height,h.height);return r;};
 const view=async(id,method,args={})=>{const r=await query(id,'call_function',{method_name:method,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')});return JSON.parse(Buffer.from(r.result).toString());};
 const state=await query(account,'view_account'),keys=(await query(account,'view_access_key_list')).keys;
 const config=await view(account,'get_config'),events=await view(account,'list_events',{from_index:0,limit:50}),accounting=await view(account,'get_accounting');
 const usdc=await view(ft,'ft_balance_of',{account_id:account}),position=await view(provider,'get_account',{account_id:account});
 const providerState=await query(provider,'view_account'),metadata=await view(ft,'ft_metadata');
 const protocol=await rpc('EXPERIMENTAL_protocol_config',{block_id:h.hash}),gas=await rpc('gas_price',{block_id:h.hash});
 return {block:{height:h.height,hash:h.hash},account:state,keys,config,events,accounting,usdc,position,providerState,metadata,storagePrice:protocol.runtime_config.storage_amount_per_byte,gasPrice:gas.gas_price,transactionCosts:protocol.runtime_config.transaction_costs,...(state.code_hash===newHash?{vault:await view(account,'get_vault')}:{})};
}
let attempt;
try{
 assert.ok(!fs.existsSync(marker),'Submission marker exists: reconcile read-only; never resend');
 const bytes=fs.readFileSync(artifact);assert.equal(bytes.length,276035);assert.equal(digest(bytes),sha);
 const before=await snapshot();assert.equal(before.account.code_hash,oldHash,'Old code changed');
 assert.equal(before.config.policy_version,'showstake-native-usdc-multievent/1');assert.equal(before.config.provider_enabled,false);
 assert.equal(before.config.network,'mainnet');assert.equal(before.config.canonical_ft,ft);assert.equal(before.config.provider_account,provider);assert.equal(before.config.provider_kind,'RHEA_MAINNET');
 assert.equal(before.events.length,0);for(const[k,v]of Object.entries(before.accounting))assert.equal(v,k==='global_operation'?null:'0');
 assert.equal(before.usdc,'0');assert.equal(before.position,null);assert.equal(before.providerState.code_hash,providerHash);assert.equal(before.metadata.symbol,'USDC');assert.equal(before.metadata.decimals,6);
 assert.equal(before.keys.length,1);assert.equal(before.keys[0].public_key,publicKey);assert.equal(before.keys[0].access_key.permission,'FullAccess');
 assert.equal(before.storagePrice,'10000000000000000000');assert.ok(BigInt(before.gasPrice)<=100000000n,'Gas price exceeds reviewed ceiling');
 const feeAssessment=requireFeeWithinLimit({transactionCosts:before.transactionCosts,gasPrice:before.gasPrice,wasmBytes:bytes,initializerMethod:'migrate_empty_create',initializerArgs:Buffer.from('{}'),attachedGas:'10000000000000'},maxFee);
 // This conservative assessment is operational, not an EVM-style protocol maxFee field.
 before.feeAssessment=feeAssessment;
 const fundingNeeded=minimumFundedBalance>BigInt(before.account.amount)?minimumFundedBalance-BigInt(before.account.amount):0n;
 if(!execute){save('.local/shared-upgrade-v8-prepared.json',{classification:'NOT_RUN',scope:'Read-only upgrade preparation; no authorization implied',sha256:sha,bytes:bytes.length,oldCodeHash:oldHash,newCodeHash:newHash,maxFeeAtomic:maxFee.toString(),fundingNeededAtomic:fundingNeeded.toString(),before});console.log(JSON.stringify({mode:'READ_ONLY',network:'mainnet',account,sha256:sha,oldCodeHash:oldHash,newCodeHash:newHash,events:0,usdcAtomic:'0',providerPosition:null,maxFeeAtomic:maxFee.toString(),fundingNeededAtomic:fundingNeeded.toString(),readyToRequestApproval:true}));}
 else{
  const n=process.argv.indexOf('--authorization');assert.ok(n>=0&&process.argv[n+1],'Recorded scoped human approval required');const approval=JSON.parse(fs.readFileSync(process.argv[n+1],'utf8'));
  assert.equal(approval.approved,true);assert.equal(approval.network,'mainnet');assert.equal(approval.account,account);assert.equal(approval.sha256,sha);assert.equal(approval.initializer,'migrate_empty_create');assert.equal(approval.maxFeeAtomic,maxFee.toString());assert.ok(typeof approval.userMessage==='string'&&approval.userMessage.trim());
  assert.equal(fundingNeeded,0n,'Wait for the reviewed native top-up; no agent funding transfer');
  fs.mkdirSync(out,{recursive:true});save(out+'/before.json',before);
  attempt={state:'PREPARED',network:'mainnet',account,sha256:sha,maxFeeAtomic:maxFee.toString(),beforeBlock:before.block,approvedAt:approval.approvedAt,createdAt:new Date().toISOString()};fs.writeFileSync(marker,JSON.stringify(attempt,null,2)+'\n',{flag:'wx'});
  attempt.state='DISPATCHING';save(marker,attempt);
  const cli=path.join(process.env.APPDATA,'npm/node_modules/near-cli-rs/run-near.js');
  const args=[cli,'contract','deploy',account,'use-file',path.resolve(artifact),'with-init-call','migrate_empty_create','json-args','{}','prepaid-gas','10 Tgas','attached-deposit','0 NEAR','network-config','mainnet','sign-with-keychain','send'];
  const sent=spawnSync(process.execPath,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:180000,maxBuffer:4000000});
  const text=((sent.stdout??'')+'\n'+(sent.stderr??'')).replace(/\x1b\[[0-9;]*[A-Za-z]/g,'');const match=text.match(/Transaction ID:\s+([1-9A-HJ-NP-Za-km-z]{43,44})/);
  attempt.cliExit=sent.status;attempt.state='NEEDS_READ_ONLY_RECONCILIATION';if(match)attempt.transactionHash=match[1];save(marker,attempt);
  assert.ok(match,'No known hash: stop and reconcile without another signing attempt');
  console.log(JSON.stringify({state:'SUBMITTED',network:'mainnet',account,hash:match[1]}));
  const tx=await rpc('tx',{tx_hash:match[1],sender_account_id:account,wait_until:'FINAL'});assert.equal(tx.final_execution_status,'FINAL');assert.ok(Object.hasOwn(tx.status,'SuccessValue'));assert.equal(tx.transaction.signer_id,account);assert.equal(tx.transaction.receiver_id,account);assert.equal(tx.transaction.public_key,publicKey);
  const actions=tx.transaction.actions;assert.equal(actions.length,2);const code=Buffer.from(actions[0].DeployContract.code,'base64');assert.ok(code.length===32?code.toString('hex')===sha:digest(code)===sha);
  const init=actions[1].FunctionCall;assert.equal(init.method_name,'migrate_empty_create');assert.equal(String(init.gas),'10000000000000');assert.equal(init.deposit,'0');assert.deepEqual(JSON.parse(Buffer.from(init.args,'base64').toString()),{});
  assert.ok(tx.receipts_outcome.every(r=>!Object.hasOwn(r.outcome.status,'Failure')));const burnt=[tx.transaction_outcome,...tx.receipts_outcome].reduce((n,r)=>n+BigInt(r.outcome.tokens_burnt),0n);assert.ok(burnt<=maxFee,'Final fee exceeded approved ceiling');
  const after=await snapshot();assert.equal(after.account.code_hash,newHash);assert.equal(after.config.schema_version,2);assert.equal(after.config.policy_version,'showstake-native-usdc-shared-yield/2');assert.equal(after.config.provider_enabled,true);assert.equal(after.events.length,0);assert.equal(after.usdc,'0');assert.equal(after.position,null);assert.deepEqual(after.keys.map(x=>[x.public_key,x.access_key.permission]),before.keys.map(x=>[x.public_key,x.access_key.permission]));
  for(const[k,v]of Object.entries(after.accounting))assert.equal(v,k==='global_operation'?null:'0');assert.equal(after.vault.total_shares,'0');assert.equal(after.vault.strategy_cash,'0');assert.equal(after.vault.operation,null);
  const actual=await rpc('query',{request_type:'view_code',account_id:account,block_id:after.block.hash});assert.equal(digest(Buffer.from(actual.code_base64,'base64')),sha);
  const rootId=tx.transaction_outcome.outcome.receipt_ids[0],actionReceipt=tx.receipts_outcome.find(x=>x.id===rootId);assert.ok(actionReceipt);const upgradeHeader=(await rpc('block',{block_id:actionReceipt.block_hash})).header;
  delete tx.transaction.signature;save(out+'/receipt.json',tx);save(out+'/after.json',after);
  const result={classification:'PASS_LIVE',scope:'Approved shared-yield code migration only; no event, USDC or provider asset action by agent',network:'mainnet',account,transactionHash:match[1],sha256:sha,codeHash:newHash,upgradeBlock:{height:upgradeHeader.height,hash:upgradeHeader.hash},fees:{maximumAtomic:maxFee.toString(),tokensBurntAtomic:burnt.toString(),netAccountDebitAtomic:(BigInt(before.account.amount)-BigInt(after.account.amount)).toString()},accountBalance:after.account.amount,storageBytes:after.account.storage_usage,events:0,usdcAtomic:'0',providerPosition:null};save(out+'/result.json',result);attempt.state='FINALIZED';attempt.resultPath=out+'/result.json';save(marker,attempt);console.log(JSON.stringify(result));
 }
}catch(e){if(attempt){attempt.state='NEEDS_READ_ONLY_RECONCILIATION';attempt.error=e.message;save(marker,attempt);}console.error('Shared upgrade stopped: '+e.message);process.exitCode=1;}
