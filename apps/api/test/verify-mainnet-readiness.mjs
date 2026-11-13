import assert from 'node:assert/strict';
import { buildApp } from '../dist/app.js';
import { MemoryStore } from '../dist/store/memory-store.js';
import { loadConfig } from '../dist/config.js';

const hash='CpnhymSeF785ZBVTaBZfW8ApsfMVUByNCrys8R2i8os';
const ft='17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
let wrong=false, stale=false;
const original=globalThis.fetch;
globalThis.fetch=async (_url,options)=>{
 const body=JSON.parse(options.body); let result;
 if(body.method==='block') result={header:{hash:'final',height:123,timestamp_nanosec:String(BigInt(Date.now()-(stale?31000:0))*1000000n)}};
 else if(body.params.request_type==='view_account') result={block_hash:'final',code_hash:wrong?'bad':hash};
 else {const values={get_config:{network:'mainnet',policy_version:'showstake-native-usdc-rhea-review/1',canonical_ft:ft,provider_account:'contract.main.burrow.near',provider_kind:'RHEA_MAINNET'},get_rhea_control:{paused:true,principal_cap:'0'},get_event:null}; result={block_hash:'final',result:[...Buffer.from(JSON.stringify(values[body.params.method_name]))]};}
 return {ok:true,json:async()=>({result})};
};
const app=buildApp({store:new MemoryStore(),config:loadConfig({AUTH_DOMAIN:'app.local',AUTH_NETWORK:'mainnet'}),accessKeyVerifier:async()=>({ok:false,code:'RPC_ERROR'})});
try {
 let r=await app.inject({method:'GET',url:'/v1/mainnet/readiness'}); assert.equal(r.statusCode,200);let body=r.json();assert.equal(body.data.paused,true);assert.equal(body.data.principalCapAtomic,'0');assert.equal(body.data.eventPresent,false);assert.equal(body.data.providerStatus,'UNVERIFIED');assert.equal(body.meta.finalized,true);
 wrong=true;r=await app.inject({method:'GET',url:'/v1/mainnet/readiness'});assert.equal(r.statusCode,503);wrong=false;stale=true;r=await app.inject({method:'GET',url:'/v1/mainnet/readiness'});assert.equal(r.statusCode,503);
 console.log('PASS_LOCAL mainnet readiness finalized block, pinned identity, stale and code mismatch');
} finally {globalThis.fetch=original;await app.close();}
