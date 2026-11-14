// Real disposable PostgreSQL acceptance. No source-chain or NEAR transaction.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import pg from 'pg';
import {connectConfig} from '../../../migrations/runner.mjs';
import {createScopedPool,assertRuntimeLeastPrivilege} from '../dist/db.js';
import {PgFundingStore} from '../dist/store/funding-store.js';

if(!process.env.SHOWSTAKE_PG_SOCKET)throw Error('disposable Unix socket required');
const db=process.env.SHOWSTAKE_PG_DB1||'showstake_disposable';
const connection=connectConfig(db,process.env.SHOWSTAKE_PG_SOCKET);
const admin=new pg.Client(connection);await admin.connect();
const pool=createScopedPool({...connection,user:'showstake_api_service'},'showstake_api');
const second=createScopedPool({...connection,user:'showstake_api_service'},'showstake_api');
const results=[];
function check(id,value){assert.ok(value,id);results.push({id,ok:true});}
try {
 await assertRuntimeLeastPrivilege(pool,'showstake_api');
 const owner={userId:randomUUID(),bindingId:randomUUID(),accountId:'funding-alice.near',network:'mainnet'};
 const stranger={userId:randomUUID(),bindingId:randomUUID(),accountId:'funding-bob.near',network:'mainnet'};
 for(const o of [owner,stranger]) {
  await admin.query('INSERT INTO app_users(id) VALUES($1)',[o.userId]);
  await admin.query(`INSERT INTO wallet_bindings(id,user_id,namespace,network,account_id,wallet_kind,verified_at) VALUES($1,$2,'near','mainnet',$3,'test-fixture',now())`,[o.bindingId,o.userId,o.accountId]);
 }
 const quote={dry:false,originAsset:'nep141:base.omft.near',destinationAsset:'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',recipient:owner.accountId,refundTo:'0x'+'1'.repeat(40),depositAddress:'0x'+'2'.repeat(40),amountIn:'1000000000000',amountOut:'2000000',minAmountOut:'2000000',deadline:new Date(Date.now()+300000).toISOString(),observedAt:new Date().toISOString(),correlationId:'local-quote-'+randomUUID(),chainId:'0x2105',slippageTolerance:50};
 const one=new PgFundingStore(pool),two=new PgFundingStore(second);
 const created=await Promise.all([one.create(owner,quote),two.create(owner,quote)]);
 check('CONCURRENT_CREATE_ONE_ATTEMPT',created[0].id===created[1].id);
 const id=created[0].id;
 const raw=await admin.query('SELECT event_id,registration_id FROM funding_attempts WHERE id=$1',[id]);
 check('GENERIC_FUNDING_NO_INVENTED_EVENT',raw.rows[0].event_id===null&&raw.rows[0].registration_id===null);
 const reserved=await Promise.all([one.reserve(owner,id),two.reserve(owner,id)]);
 check('CONCURRENT_RESERVE_EXACTLY_ONCE',reserved.filter(Boolean).length===1);
 check('OTHER_OWNER_CANNOT_READ',(await two.list(stranger)).length===0);
 check('OTHER_OWNER_CANNOT_RESERVE',await two.reserve(stranger,id)===false);
 await assert.rejects(()=>two.submitted(stranger,id,'0x'+'3'.repeat(64)));check('OTHER_OWNER_CANNOT_BIND_HASH',true);
 await assert.rejects(()=>two.create({...owner,bindingId:stranger.bindingId},quote));check('BINDING_OWNER_FK_ENFORCED',true);
 const hash='0x'+'4'.repeat(64);await one.submitted(owner,id,hash);
 await two.submitted(owner,id,hash);
 await assert.rejects(()=>two.submitted(owner,id,'0x'+'5'.repeat(64)));check('SUBMISSION_HASH_IMMUTABLE',true);
 await one.observe(owner,id,'PROCESSING');
 const processing=(await two.list(owner)).find(x=>x.id===id);
 check('PROVIDER_SUBSTATUS_DURABLE',processing.state==='SOURCE_PENDING'&&processing.providerStatus==='PROCESSING'&&!!processing.providerStatusObservedAt);
 await assert.rejects(()=>one.observe(owner,id,'INVENTED_SUCCESS'));check('UNKNOWN_PROVIDER_STATUS_DENIED',true);
 await one.observe(owner,id,'SUCCESS');
 await assert.rejects(()=>one.observe(owner,id,'PROCESSING'));check('TERMINAL_OBSERVATION_CANNOT_REGRESS',true);
 const restored=(await new PgFundingStore(second).list(owner)).find(x=>x.id===id);
 check('NEW_STORE_RESTORES_HASH_AND_TERMINAL',restored.sourceTxHash===hash&&restored.state==='SWAP_SETTLED'&&restored.providerStatus==='SUCCESS');
 check('SETTLED_CANNOT_RESEND',await two.reserve(owner,id)===false);
 const untouched=await admin.query('SELECT registration_id,event_id FROM funding_attempts WHERE id=$1',[id]);
 check('SWAP_COMPLETION_CREATES_NO_REGISTRATION',untouched.rows[0].registration_id===null&&untouched.rows[0].event_id===null);
 await assert.rejects(()=>pool.query(`UPDATE funding_attempts SET registration_id=$2 WHERE id=$1`,[id,randomUUID()]));check('REGISTRATION_REQUIRES_EVENT_SCOPE',true);
 await assert.rejects(()=>pool.query(`UPDATE events_projection SET deposit_atomic='1' WHERE false`));check('API_STILL_CANNOT_WRITE_PROJECTIONS',true);
 const report={classification:'PASS_LOCAL',scope:'Real disposable PostgreSQL journal concurrency, restart, owner isolation and financial-authority boundary',checks:results,chainTransactions:0};
 if(process.env.SHOWSTAKE_PG_ARTIFACTS)await writeFile(join(process.env.SHOWSTAKE_PG_ARTIFACTS,'funding-db.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
} finally {await pool.end();await second.end();await admin.end();}
