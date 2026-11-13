import assert from 'node:assert/strict';
import { PgStore } from '../dist/store/pg-store.js';
import { MemoryStore } from '../dist/store/memory-store.js';
const now=new Date(), rows=[{id:'pre',event_id:'event',beneficiary_account:'alice.near',principal_atomic:'1000000',claim_atomic:'0',payout_state:'NOT_CLAIMABLE',observed_at:now},{id:'noshow',event_id:'event',beneficiary_account:'alice.near',principal_atomic:'1000000',claim_atomic:'0',payout_state:'ZERO',observed_at:now},{id:'winner',event_id:'event',beneficiary_account:'alice.near',principal_atomic:'1000000',claim_atomic:'1000003',payout_state:'CLAIMABLE',observed_at:now}];
const pg=new PgStore({query:async()=>({rows})}), projected=await pg.listClaims('alice.near','mainnet');assert.deepEqual(projected.map(x=>x.bonusAtomic),['0','0','3']);assert.deepEqual(projected.map(x=>x.principalAtomic),['1000000','1000000','1000000']);assert.deepEqual(projected.map(x=>x.claimAtomic),['0','0','1000003']);
const memory=new MemoryStore();memory.seedEvent({id:'event',network:'mainnet',times:{regOpen:now.toISOString()},totals:{}});for(const x of projected)memory.seedClaim({...x,bonusAtomic:'999'});assert.deepEqual((await memory.listClaims('alice.near','mainnet')).map(x=>x.bonusAtomic),['0','0','3']);
console.log('PASS_LOCAL claim bonus preserves unsigned values for pre-settlement and no-show');
