import assert from 'node:assert/strict';
import { buildApp } from '../dist/app.js';
import { MemoryStore } from '../dist/store/memory-store.js';
import { loadConfig } from '../dist/config.js';
import { makeKeypair,makeFakeResolver,signChallenge } from './fixtures.mjs';
const kp=makeKeypair(),id='00000000-0000-4000-8000-0000000000a1',child='0123456789abcdef.factory.near',hash='CpnhymSeF785ZBVTaBZfW8ApsfMVUByNCrys8R2i8os',now=new Date().toISOString(),store=new MemoryStore();
store.seedEvent({id,chainEventId:'e',network:'mainnet',contractId:child,organizerAccount:kp.accountId,assetContract:'ft.near',state:'PUBLISHED',depositAtomic:'1',capacity:1,times:{regOpen:now,regClose:now,cancelCutoff:now,checkinOpen:now,checkinClose:now,finalizeDeadline:now},totals:{acceptedAtomic:'0',paidAtomic:'0',pendingAtomic:'0',liabilityAtomic:'0'},registeredCount:0,observedAt:now});
const config=loadConfig({AUTH_DOMAIN:'app.local',AUTH_NETWORK:'mainnet',COOKIE_SECURE:'false',ACCESS_CONTRACT_ALLOWLIST:`mainnet:${child}`,ACCESS_CONTRACT_ABIS:`mainnet:${child}=candidate-v1`});
let liveHash=hash, factoryState='Ready', keyed=false;const original=globalThis.fetch;
globalThis.fetch=async(_url,options)=>{const q=JSON.parse(options.body),p=q.params;let result;if(q.method==='block')result={header:{hash:'final',timestamp_nanosec:String(BigInt(Date.now())*1000000n)}};else if(p.request_type==='view_account')result={block_hash:'final',code_hash:liveHash};else if(p.request_type==='view_access_key_list')result={block_hash:'final',keys:keyed?[{}]:[]};else {const ft='17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',sha='03076c4a9496e8ae1e6af68c791752d4a7220597942effd0c3a1839a252be9d2',policy='showstake-native-usdc-rhea-review/1';let value;if(p.account_id==='factory.near' && p.method_name==='get_config') value={factory_account:'factory.near',network:'mainnet',factory_policy_identity:'showstake-factory-d039/1',schema_version:1,canonical_ft:ft,provider_account:'contract.main.burrow.near',provider_kind:'RHEA_MAINNET',leaf_code_sha256:sha,leaf_policy_version:policy};else if(p.method_name==='get_child')value={child_id:child,organizer:kp.accountId,state:factoryState,network:'mainnet',canonical_ft:ft,leaf_code_sha256:sha,leaf_policy_version:policy};else if(p.method_name==='get_config')value={organizer:kp.accountId,network:'mainnet',canonical_ft:ft,provider_account:'contract.main.burrow.near',provider_kind:'RHEA_MAINNET',policy_version:policy};else value={event_id:'e',organizer:kp.accountId,phase:'RegistrationClosed'};result={block_hash:'final',result:[...Buffer.from(JSON.stringify(value))]};}return new Response(JSON.stringify({result}),{status:200});};
const app=buildApp({store,config,accessKeyVerifier:async q=>makeFakeResolver(q.accountId,q.publicKey,'mainnet')(q)});
try {
 const c=(await app.inject({method:'POST',url:'/v1/auth/challenge',payload:{accountId:kp.accountId,network:'mainnet',domain:'app.local'}})).json().data;
 const v=await app.inject({method:'POST',url:'/v1/auth/verify',headers:{origin:'http://app.local'},payload:{challengeId:c.challengeId,accountId:kp.accountId,network:'mainnet',domain:'app.local',nonce:c.nonce,publicKey:kp.publicKey,signature:signChallenge(kp.privateKey,{message:c.message,nonceHex:c.nonce,recipient:'app.local'})}});assert.equal(v.statusCode,200);const cookie=v.headers['set-cookie'].split(';')[0];
 const read=()=>app.inject({method:'GET',url:`/v1/events/${id}/attendance`,headers:{cookie}});
 assert.equal((await read()).statusCode,503,'missing trusted code hash');
 config.accessContractCodeHashes[`mainnet:${child}`]=hash;assert.equal((await read()).statusCode,200,'explicitly allowlisted and pinned child');
 liveHash='wrong';assert.equal((await read()).statusCode,503,'changed on-chain code');
 config.accessContractAllowlist=[];assert.equal((await read()).statusCode,503,'allowlist required');
 liveHash=hash;config.accessFactoryCodeHashes['mainnet:factory.near']=hash;assert.equal((await read()).statusCode,200,'factory verified without per-child config');
 factoryState='Pending';assert.equal((await read()).statusCode,503,'pending child denied');factoryState='Ready';keyed=true;assert.equal((await read()).statusCode,503,'keyed child denied');keyed=false;
 config.accessFactoryCodeHashes['mainnet:factory.near']='different';assert.equal((await read()).statusCode,503,'foreign factory code denied');
 console.log('PASS_LOCAL mainnet private child explicit allowlist, pinned code and fresh block');
} finally {globalThis.fetch=original;await app.close();}
