import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../dist/app.js';
import { MemoryStore } from '../dist/store/memory-store.js';
import { loadConfig } from '../dist/config.js';
import { makeKeypair, makeFakeResolver, signChallenge } from './fixtures.mjs';

const tmp=await mkdtemp(join(tmpdir(),'showstake-api-'));
const inside=join(tmp,'private'); await mkdir(inside); await writeFile(join(inside,'ok.txt'),'private data'); await writeFile(join(tmp,'outside.txt'),'outside secret');
let symlinkAvailable=true; try {await symlink(tmp,join(inside,'link'),'junction');} catch {symlinkAvailable=false;}
const participant=makeKeypair(), host=makeKeypair(), stranger=makeKeypair();
const id='00000000-0000-4000-8000-0000000000a1', passId='00000000-0000-4000-8000-0000000000b1';
const id2='00000000-0000-4000-8000-0000000000a2';
const now=new Date().toISOString(); const store=new MemoryStore();
store.seedEvent({id,chainEventId:'evt',network:'testnet',contractId:'escrow.testnet',organizerAccount:host.accountId,assetContract:'ft.testnet',state:'SETTLED',depositAtomic:'10',capacity:10,times:{regOpen:now,regClose:now,cancelCutoff:now,checkinOpen:now,checkinClose:now,finalizeDeadline:now},totals:{acceptedAtomic:'10',paidAtomic:'0',pendingAtomic:'0',liabilityAtomic:'10'},registeredCount:1,observedAt:now});
store.seedEvent({id:id2,chainEventId:'evt2',network:'testnet',contractId:'escrow.testnet',organizerAccount:stranger.accountId,assetContract:'ft.testnet',state:'SETTLED',depositAtomic:'10',capacity:10,times:{regOpen:now,regClose:now,cancelCutoff:now,checkinOpen:now,checkinClose:now,finalizeDeadline:now},totals:{acceptedAtomic:'0',paidAtomic:'0',pendingAtomic:'0',liabilityAtomic:'0'},registeredCount:0,observedAt:now});
store.seedAttendance(id2,[]);
store.seedPass({id:passId,eventId:id,ownerAccount:participant.accountId,registrationStatus:'ATTENDED',attendanceStatus:true,financialStatus:'CLAIMABLE',observedAt:now});
store.seedAttendance(id,[{registrationId:'r',participantAccount:participant.accountId,attendanceStatus:false,registrationStatus:'COMMITTED',payoutState:'NOT_CLAIMABLE',observedAt:now}]);
const resources=['ok.txt','../outside.txt','link/outside.txt'].map(objectKey=>({objectKey,title:objectKey,mimeType:'text/plain',publishedAt:now,observedAt:now})); store.seedContent(id,resources);
const key='0123456789abcdef0123456789abcdef';
const config=loadConfig({AUTH_DOMAIN:'app.local',AUTH_NETWORK:'testnet',COOKIE_SECURE:'false',ACCESS_CONTRACT_ALLOWLIST:'testnet:escrow.testnet',ACCESS_CONTRACT_ABIS:'testnet:escrow.testnet=candidate-v1',QR_HMAC_KEY:key,PRIVATE_CONTENT_DIR:inside,RATE_LIMIT_CHALLENGE_MAX:'1000'});
let multi=false, badCode=false, wrongPolicy=false;
let mode='checkin', stale=false, badFinal=false, unknown=false, noShow=false, wrongOrganizer=false, closed=false, blockCount=0;
const originalFetch=globalThis.fetch;
globalThis.fetch=async (_url,options)=>{const call=JSON.parse(options.body); let result;
  if(call.method==='block') {blockCount++; result={header:{hash:'final-hash',timestamp_nanosec:String(BigInt(Date.now()-(stale?31000:0))*1000000n)}};}
  else {const method=call.params.method_name; assert.equal(call.params.block_id,'final-hash'); if(call.params.request_type==='view_account') return new Response(JSON.stringify({result:{block_hash:'final-hash',code_hash:badCode?'wrong':'11111111111111111111111111111111'}}),{status:200}); const args=method?JSON.parse(Buffer.from(call.params.args_base64,'base64').toString()):{}; if(method==='get_event') { if(multi) assert(['evt','evt2'].includes(args.event_id)); else assert.deepEqual(args,{}); } if(method==='get_config') return new Response(JSON.stringify({result:{block_hash:'final-hash',result:[...Buffer.from(JSON.stringify({network:'testnet',policy_version:wrongPolicy?'wrong':'showstake-native-usdc-multievent/1'}))]}}),{status:200});
    const data=method==='get_event'?{event_id:multi?args.event_id:'evt',organizer:args.event_id==='evt2'?stranger.accountId:wrongOrganizer?stranger.accountId:host.accountId,phase:unknown?'FutureState':mode==='checkin'?'RegistrationClosed':'Settled',checkin_open:Date.now()-10000,checkin_close:Date.now()+(closed?-1000:60000)}:{event_id:'evt',pass_id:passId,owner:participant.accountId,registration_status:'Active',attendance_status:noShow?'NoShow':mode==='checkin'?'Unmarked':'Attended'};
    result={block_hash:badFinal?'different-hash':'final-hash',result:[...Buffer.from(JSON.stringify(data))]};
  } return new Response(JSON.stringify({jsonrpc:'2.0',id:call.id,result}),{status:200,headers:{'content-type':'application/json'}});
};
const app=buildApp({store,config,accessKeyVerifier:async q=>makeFakeResolver(q.accountId,q.publicKey,'testnet')(q)});
try {
  async function login(k){const c=(await app.inject({method:'POST',url:'/v1/auth/challenge',payload:{accountId:k.accountId,network:'testnet',domain:'app.local'}})).json().data; const r=await app.inject({method:'POST',url:'/v1/auth/verify',payload:{challengeId:c.challengeId,accountId:k.accountId,network:'testnet',domain:'app.local',nonce:c.nonce,publicKey:k.publicKey,signature:signChallenge(k.privateKey,{message:c.message,nonceHex:c.nonce,recipient:'app.local'})},headers:{origin:'http://app.local'}}); assert.equal(r.statusCode,200); return r.headers['set-cookie'].split(';')[0];}
  const pc=await login(participant), hc=await login(host), sc=await login(stranger);
  const challenge=()=>app.inject({method:'POST',url:`/v1/events/${id}/checkin/challenge`,headers:{cookie:pc,origin:'http://app.local'},payload:{passId}});
  const scan=(token,cookie=hc)=>app.inject({method:'POST',url:`/v1/events/${id}/checkin/scan`,headers:{cookie,origin:'http://app.local'},payload:{token}});
  const issued=await challenge(); assert.equal(issued.statusCode,200,issued.body); assert.equal(blockCount,1,'event and pass use one finalized snapshot'); const token=issued.json().data.token;
  assert.equal((await scan(token,sc)).statusCode,403,'organizer');
  const [payload,sig]=token.split('.'); assert.equal((await scan(payload+'.'+(sig[0]==='a'?'b':'a')+sig.slice(1))).statusCode,422,'forgery');
  const expired=JSON.parse(Buffer.from(payload,'base64url').toString()); expired.exp=Date.now()-1; const expiredPayload=Buffer.from(JSON.stringify(expired)).toString('base64url'); const expiredSig=createHmac('sha256',key).update(expiredPayload).digest('base64url'); assert.equal((await scan(expiredPayload+'.'+expiredSig)).statusCode,422,'expiry');
  const before=await store.getAttendance(id,host.accountId,'testnet'); const accepted=await scan(token); assert.equal(accepted.statusCode,200,accepted.body); assert.equal(accepted.json().data.state,'PROPOSED'); assert.deepEqual(await store.getAttendance(id,host.accountId,'testnet'),before,'scan changes no attendance'); assert.equal((await scan(token)).statusCode,409,'replay');
  config.accessContractAllowlist=[]; assert.equal((await challenge()).statusCode,503,'allowlist'); config.accessContractAllowlist=['testnet:escrow.testnet'];
  delete config.accessContractAbis['testnet:escrow.testnet']; assert.equal((await challenge()).statusCode,503,'ABI binding required'); config.accessContractAbis['testnet:escrow.testnet']='candidate-v1';
  stale=true; assert.equal((await challenge()).statusCode,503,'stale final block'); stale=false; badFinal=true; assert.equal((await challenge()).statusCode,503,'inconsistent final block'); badFinal=false; unknown=true; assert.equal((await challenge()).statusCode,403,'unknown state'); unknown=false; closed=true; assert.equal((await challenge()).statusCode,403,'closed check-in window'); closed=false;
  const attendance=()=>app.inject({method:'GET',url:`/v1/events/${id}/attendance`,headers:{cookie:hc}}); assert.equal((await attendance()).statusCode,200); wrongOrganizer=true; assert.equal((await attendance()).statusCode,403,'on-chain organizer overrides projection'); wrongOrganizer=false; unknown=true; assert.equal((await attendance()).statusCode,403,'unknown attendance event state'); unknown=false;
  multi=true; config.accessContractAbis['testnet:escrow.testnet']='multievent-v1'; config.accessContractCodeHashes['testnet:escrow.testnet']='11111111111111111111111111111111';
  assert.equal((await challenge()).statusCode,200,'multi-event event-specific view'); badCode=true; assert.equal((await challenge()).statusCode,503,'multi-event pinned code'); badCode=false; wrongPolicy=true; assert.equal((await challenge()).statusCode,503,'multi-event policy'); wrongPolicy=false; wrongOrganizer=true; assert.equal((await attendance()).statusCode,403,'multi-event organizer bound to event'); wrongOrganizer=false;
  assert.equal((await app.inject({method:'GET',url:`/v1/events/${id2}/attendance`,headers:{cookie:hc}})).statusCode,403,'organizer A cannot read event B');
  assert.equal((await app.inject({method:'GET',url:`/v1/events/${id2}/attendance`,headers:{cookie:sc}})).statusCode,200,'organizer B reads own event');
  mode='content'; const listing=await app.inject({method:'GET',url:`/v1/events/${id}/content`,headers:{cookie:pc}}); assert.equal(listing.statusCode,200,listing.body); const objectId=x=>createHash('sha256').update(x).digest('hex'); const get=x=>app.inject({method:'GET',url:`/v1/events/${id}/content/${objectId(x)}`,headers:{cookie:pc}});
  const ok=await get('ok.txt'); assert.equal(ok.statusCode,200); assert.equal(ok.body,'private data'); assert.equal((await get('../outside.txt')).statusCode,503,'traversal'); if(symlinkAvailable) assert.equal((await get('link/outside.txt')).statusCode,503,'symlink');
  noShow=true; assert.equal((await get('ok.txt')).statusCode,403,'no-show');
  noShow=false;
  const upload=(cookie,payload,origin='http://app.local')=>app.inject({method:'POST',url:`/v1/events/${id}/content`,headers:{cookie,origin},payload});
  const doc={title:'Agenda',mimeType:'text/plain',contentBase64:Buffer.from('private upload').toString('base64')};
  assert.equal((await upload(sc,doc)).statusCode,403,'wrong organizer');
  assert.equal((await upload(hc,doc,'http://evil.local')).statusCode,403,'origin');
  assert.equal((await upload(hc,{...doc,contentBase64:Buffer.alloc(524289).toString('base64')})).statusCode,422,'oversize');
  wrongOrganizer=true;assert.equal((await upload(hc,doc)).statusCode,403,'fresh on-chain organizer');wrongOrganizer=false;
  if(symlinkAvailable){config.privateContentDir=join(inside,'link');assert.equal((await upload(hc,doc)).statusCode,503,'symlink root');config.privateContentDir=inside;}
  const added=await upload(hc,doc);assert.equal(added.statusCode,201,added.body);const uploaded=added.json().data;assert.equal(uploaded.bytesSize,14);assert.match(uploaded.id,/^[0-9a-f]{64}$/);
  const read=await app.inject({method:'GET',url:`/v1/events/${id}/content/${uploaded.id}`,headers:{cookie:pc}});assert.equal(read.statusCode,200);assert.equal(read.body,'private upload');
  assert.equal((await app.inject({method:'GET',url:`/v1/events/${id}/content/${uploaded.id}`,headers:{cookie:sc}})).statusCode,403,'non-attendee read denied');
  const event=await store.getEvent(id);event.state='PUBLISHED';assert.equal((await app.inject({method:'GET',url:`/v1/events/${id}/content/${uploaded.id}`,headers:{cookie:pc}})).statusCode,403,'unsettled read denied');event.state='SETTLED';
  console.log(`verify-private-access: PASS_LOCAL QR, final RPC, content, traversal${symlinkAvailable?', symlink':'; symlink NOT_RUN (OS denied creation)'}`);
} finally {globalThis.fetch=originalFetch; await app.close(); await rm(tmp,{recursive:true,force:true});}
