import assert from 'node:assert/strict';
import { buildApp } from '../dist/app.js';
import { MemoryStore } from '../dist/store/memory-store.js';
import { loadConfig } from '../dist/config.js';
const store=new MemoryStore(),now=new Date().toISOString();
const event=(id,network)=>({id,chainEventId:'same-event',network,contractId:`escrow.${network}`,organizerAccount:'host.near',assetContract:'token.near',state:'PUBLISHED',title:network,location:null,rulesText:null,depositAtomic:network==='mainnet'?'9007199254740993':'7',capacity:1,times:{regOpen:now,regClose:now,cancelCutoff:now,checkinOpen:now,checkinClose:now,finalizeDeadline:now},totals:{acceptedAtomic:'0',realizedYieldAtomic:'0',paidAtomic:'0',pendingAtomic:'0',liabilityAtomic:'0'},registeredCount:0,observedAt:now});
const main=event('00000000-0000-4000-8000-0000000000a1','mainnet'),test=event('00000000-0000-4000-8000-0000000000a2','testnet');store.seedEvent(test);store.seedEvent(main);
for(const [network,own,foreign] of [['mainnet',main,test],['testnet',test,main]]){
 const app=buildApp({store,config:loadConfig({AUTH_DOMAIN:'app.local',AUTH_NETWORK:network}),accessKeyVerifier:async()=>({ok:false,code:'RPC_ERROR'})});
 try{const list=await app.inject({url:'/v1/events'});assert.equal(list.statusCode,200);assert.equal(list.json().data.items.length,1);assert.equal(list.json().data.items[0].id,own.id);assert.equal(list.json().meta.network,network);
 for(const path of [`/v1/events/${foreign.id}`,`/v1/events/${foreign.id}/results`])assert.equal((await app.inject({url:path})).statusCode,404);
 for(const path of ['/v1/events/same-event','/v1/events/same-event/results']){const r=await app.inject({url:path});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().data.chainEventId,'same-event');if(path.endsWith('results'))assert.equal(r.json().data.eventId,own.id);else assert.equal(r.json().data.depositAtomic,own.depositAtomic);}
 }finally{await app.close();}
}
const second={...main,id:'00000000-0000-4000-8000-0000000000a3',contractId:'other.near'};store.seedEvent(second);
const uuidChain='00000000-0000-4000-8000-0000000000b1';
const special={...main,id:'00000000-0000-4000-8000-0000000000a4',chainEventId:uuidChain,contractId:'uuid.near'};store.seedEvent(special);
const shadow={...main,id:'00000000-0000-4000-8000-0000000000a5',chainEventId:main.id,contractId:'shadow.near'};store.seedEvent(shadow);
const app=buildApp({store,config:loadConfig({AUTH_DOMAIN:'app.local',AUTH_NETWORK:'mainnet'}),accessKeyVerifier:async()=>({ok:false,code:'RPC_ERROR'})});
try {
 for(const suffix of ['', '/results']){
  assert.equal((await app.inject({url:`/v1/events/same-event${suffix}`})).statusCode,404,'same-network ambiguity fails closed');
  for(const e of [main,second]){const r=await app.inject({url:`/v1/events/same-event${suffix}?contractId=${e.contractId}`});assert.equal(r.statusCode,200,r.body);assert.equal(suffix?r.json().data.eventId:r.json().data.id,e.id);}
  assert.equal((await app.inject({url:`/v1/events/same-event${suffix}?contractId=wrong.near`})).statusCode,404);
  const f=await app.inject({url:`/v1/events/${uuidChain}${suffix}`});assert.equal(f.statusCode,200,f.body);assert.equal(suffix?f.json().data.eventId:f.json().data.id,special.id);
  const db=await app.inject({url:`/v1/events/${main.id}${suffix}`});assert.equal(suffix?db.json().data.eventId:db.json().data.id,main.id);
  const exact=await app.inject({url:`/v1/events/${main.id}${suffix}?contractId=shadow.near`});assert.equal(suffix?exact.json().data.eventId:exact.json().data.id,shadow.id);
  assert.equal((await app.inject({url:`/v1/events/same-event${suffix}?contractId=BAD!`})).statusCode,422);
 }
}finally{await app.close();}
console.log('PASS_LOCAL public catalog, detail and results are fixed-network scoped');
