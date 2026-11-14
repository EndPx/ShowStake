import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, lstat, writeFile, link, unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Store } from '../store/types.js';
import type { DirectStore } from '../store/direct-store.js';
import { requireSession } from '../auth/middleware.js';
import { makeOriginCheck } from '../http/origin.js';
import { InMemoryRateLimiter, makeChallengeRateLimitHandler } from '../http/rate-limit.js';
import { sha256Hex, isUuid } from '../lib/util.js';
import { Errors } from '../errors.js';
import { chainSnapshot } from './private.js';

type Params={eventId:string;resourceId:string};
type Token={id:string;network:string;contractId:string;eventId:string;passId:string;registrationId:string;owner:string;codeHash:string;nonce:string;exp:number};
const idOk=(s:unknown):s is string=>typeof s==='string' && s.length>0 && Buffer.byteLength(s)<=128;
const meta=(req:FastifyRequest,network:string)=>({requestId:req.id,observedAt:new Date().toISOString(),network,stale:false,source:'FINAL_CHAIN',authority:'FINAL_CHAIN'});
const envelope=(data:unknown,req:FastifyRequest,network:string)=>({data,meta:meta(req,network),error:null});
function fresh(blockMs:number){if(Date.now()-blockMs>30000)throw Errors.unavailable('CHAIN_UNAVAILABLE','final chain state is stale');}
const sig=(key:string,value:string)=>createHmac('sha256',key).update(value).digest('base64url');
function qrKey(config:Config):string {if(!config.qrHmacKey||Buffer.byteLength(config.qrHmacKey)<32)throw Errors.unavailable('QR_UNAVAILABLE','QR signing is not configured');return config.qrHmacKey;}
function actor(req:FastifyRequest) {if(!req.auth?.accountId||!req.auth.network)throw Errors.forbidden('NEAR_BINDING_REQUIRED','verified NEAR wallet required');return {account:req.auth.accountId,network:req.auth.network,userId:req.auth.userId};}
async function binding(store:Store,network:string,account:string,userId?:string) {const found=await store.getBinding('near',network,account);const b=found && await store.getBindingById(found.id);if(!b||b.id!==found?.id||b.namespace!=='near'||b.network!==network||b.accountId!==account||(userId && b.userId!==userId))throw Errors.forbidden('NEAR_BINDING_REQUIRED','verified NEAR wallet required');return b.id;}
function context(config:Config,network:string,contractId:unknown,eventId:unknown){
 if(!idOk(contractId)||!idOk(eventId))throw Errors.invalid('INVALID_INPUT','contract and event IDs are required');
 const k=`${network}:${contractId}`,profile=config.accessSharedYieldProfiles?.[k],hash=config.accessContractCodeHashes[k];
 if(!config.accessContractAllowlist?.includes(k)||config.accessContractAbis[k]!=='shared-yield-v2'||!profile||!hash)throw Errors.unavailable('DIRECT_ACCESS_UNAVAILABLE','reviewed direct profile unavailable');
 return {network,contractId,chainEventId:eventId,assetContract:profile.canonicalFt,hash};
}
async function snapshot(config:Config,ctx:ReturnType<typeof context>,passId?:string){return chainSnapshot(config,ctx,passId);}
function validatePass(s:Awaited<ReturnType<typeof snapshot>>,ctx:ReturnType<typeof context>,passId:string,owner:string,mode:'checkin'|'content'){
 const e=s.event,p=s.pass;if(!p||e.event_id!==ctx.chainEventId||p.event_id!==ctx.chainEventId||p.pass_id!==passId||p.owner!==owner||p.registration_status!=='Active'||p.policy_version!=='showstake-native-usdc-shared-yield/2'||!idOk(p.registration_id))throw Errors.forbidden('PASS_NOT_ELIGIBLE','active on-chain pass ownership required');
 if(mode==='checkin'&&(e.phase!=='RegistrationClosed'||p.attendance_status!=='Unmarked'||!Number.isSafeInteger(e.checkin_open)||!Number.isSafeInteger(e.checkin_close)||s.blockMs<(e.checkin_open as number)||s.blockMs>=(e.checkin_close as number)))throw Errors.forbidden('CHECKIN_NOT_ELIGIBLE','check-in window and unmarked pass required');
 if(mode==='content'&&(e.phase!=='Settled'||e.earn_state!=='Redeemed'||p.attendance_status!=='Attended'))throw Errors.forbidden('CONTENT_NOT_ELIGIBLE','settled event and attended pass required');
 return p.registration_id;
}
async function eventRef(ds:DirectStore,ctx:ReturnType<typeof context>){const ref=await ds.eventRef(ctx.network,ctx.contractId,ctx.chainEventId,ctx.assetContract,ctx.hash);if(!ref)throw Errors.unavailable('DIRECT_DEPLOYMENT_UNAVAILABLE','reviewed deployment not seeded');return ref;}
export function registerDirect(app:FastifyInstance,store:Store,config:Config,db?:DirectStore):void {
 const auth=requireSession(store,config),origin=makeOriginCheck(config),rate=makeChallengeRateLimitHandler(new InMemoryRateLimiter(config.challengeRateLimit.maxPerWindow,config.challengeRateLimit.windowMs));
 const dbRequired=()=>{if(!db)throw Errors.unavailable('DIRECT_ACCESS_UNAVAILABLE','direct store unavailable');return db;};
 app.post<{Params:Params;Body:{contractId:string;passId:string}}>('/v1/direct/events/:eventId/qr',{preHandler:[origin,rate,auth]},async(req,reply)=>{
  const a=actor(req),ctx=context(config,a.network,req.body?.contractId,req.params.eventId);if(!idOk(req.body?.passId))throw Errors.invalid('INVALID_INPUT','pass ID required');
  const key=qrKey(config),s=await snapshot(config,ctx,req.body.passId),registrationId=validatePass(s,ctx,req.body.passId,a.account,'checkin');
  const ds=dbRequired(),ref=await eventRef(ds,ctx),ownerBinding=await binding(store,a.network,a.account,a.userId),nonce=randomBytes(32).toString('base64url');
  const issued=await ds.issue({ref,binding:ownerBinding,nonceHash:sha256Hex(nonce),passId:req.body.passId,registrationId,codeHash:ctx.hash});
  fresh(s.blockMs);const expiresAt=Math.min(issued.expiresAt,Date.now()+60000);const token:Token={id:issued.id,network:a.network,contractId:ctx.contractId,eventId:ctx.chainEventId,passId:req.body.passId,registrationId,owner:a.account,codeHash:ctx.hash,nonce,exp:expiresAt};const data=Buffer.from(JSON.stringify(token)).toString('base64url');reply.header('Cache-Control','no-store');return envelope({token:data+'.'+sig(key,data),expiresAt:new Date(expiresAt).toISOString()},req,a.network);
 });
 app.post<{Params:Params;Body:{contractId:string;token:string}}>('/v1/direct/events/:eventId/checkin',{preHandler:[origin,rate,auth]},async(req,reply)=>{
  const a=actor(req),ctx=context(config,a.network,req.body?.contractId,req.params.eventId),key=qrKey(config),raw=req.body?.token;if(typeof raw!=='string'||raw.length>4096)throw Errors.invalid('INVALID_QR','invalid QR token');
  const parts=raw.split('.'),expected=sig(key,parts[0]??''),given=parts[1]??'';if(parts.length!==2||Buffer.byteLength(given)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(given),Buffer.from(expected)))throw Errors.invalid('INVALID_QR','invalid QR token');
  let t:Token;try{t=JSON.parse(Buffer.from(parts[0]!,'base64url').toString()) as Token;}catch{throw Errors.invalid('INVALID_QR','invalid QR token');}
  if(!t||!isUuid(t.id)||t.network!==a.network||t.contractId!==ctx.contractId||t.eventId!==ctx.chainEventId||t.codeHash!==ctx.hash||!idOk(t.passId)||!idOk(t.registrationId)||!idOk(t.owner)||typeof t.nonce!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(t.nonce)||!Number.isSafeInteger(t.exp)||t.exp<=Date.now())throw Errors.invalid('INVALID_QR','invalid or expired QR token');
  const s=await snapshot(config,ctx,t.passId);if(s.event.organizer!==a.account)throw Errors.forbidden('ORGANIZER_REQUIRED','on-chain organizer required');if(validatePass(s,ctx,t.passId,t.owner,'checkin')!==t.registrationId)throw Errors.forbidden('PASS_NOT_ELIGIBLE','registration mismatch');
  const ds=dbRequired(),ref=await eventRef(ds,ctx),ownerBinding=await binding(store,a.network,t.owner),organizerBinding=await binding(store,a.network,a.account,a.userId),requestId=randomUUID();
  if(!await ds.consume({id:t.id,ref,nonceHash:sha256Hex(t.nonce),passId:t.passId,registrationId:t.registrationId,codeHash:t.codeHash,ownerBinding,organizerBinding,requestId,authExpiresAt:s.blockMs+30000}))throw Errors.conflict('QR_CONSUMED_OR_EXPIRED','QR token already used or expired');
  reply.header('Cache-Control','no-store');return envelope({requestId,passId:t.passId,registrationId:t.registrationId,ownerAccount:t.owner,state:'PENDING_SIGNATURE'},req,a.network);
 });
 app.post<{Params:Params;Body:{contractId:string;title:string;mimeType:string;contentBase64:string}}>('/v1/direct/events/:eventId/content',{bodyLimit:720000,preHandler:[origin,rate,auth]},async(req,reply)=>{
  const a=actor(req),b=req.body,ctx=context(config,a.network,b?.contractId,req.params.eventId);
  if(typeof b?.title!=='string'||!b.title.trim()||Buffer.byteLength(b.title)>256||!['application/pdf','text/plain','image/png','image/jpeg'].includes(b.mimeType)||typeof b.contentBase64!=='string'||!b.contentBase64.length||b.contentBase64.length>699052||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b.contentBase64))throw Errors.invalid('INVALID_CONTENT','invalid content');
  const bytes=Buffer.from(b.contentBase64,'base64');if(!bytes.length||bytes.length>524288||bytes.toString('base64')!==b.contentBase64)throw Errors.invalid('INVALID_CONTENT','invalid content');
  const s=await snapshot(config,ctx);if(s.event.event_id!==ctx.chainEventId||s.event.organizer!==a.account)throw Errors.forbidden('ORGANIZER_REQUIRED','on-chain organizer required');
  const ds=dbRequired(),ref=await eventRef(ds,ctx),uploader=await binding(store,a.network,a.account,a.userId);if(!config.privateContentDir)throw Errors.unavailable('CONTENT_UNAVAILABLE','private content unavailable');
  fresh(s.blockMs);const id=randomUUID(),objectKey=randomUUID(),tempKey=randomUUID()+'.tmp';let target='';
  try{const st=await lstat(config.privateContentDir);if(st.isSymbolicLink()||!st.isDirectory())throw Error('directory');const base=await realpath(config.privateContentDir),temp=resolve(base,tempKey);target=resolve(base,objectKey);try{await writeFile(temp,bytes,{flag:'wx',mode:0o600});await link(temp,target);}finally{await unlink(temp).catch(()=>{});}}catch{throw Errors.unavailable('CONTENT_UNAVAILABLE','private content unavailable');}
  let resource;try{resource=await ds.add({ref,binding:uploader,id,objectKey,sha256:sha256Hex(bytes),title:b.title,mimeType:b.mimeType,bytesSize:bytes.length,authExpiresAt:s.blockMs+30000});}catch(e){await unlink(target).catch(()=>{});throw e;}
  reply.header('Cache-Control','no-store').code(201);return envelope({id:resource.id,title:resource.title,mimeType:resource.mimeType,bytesSize:resource.bytesSize,publishedAt:resource.publishedAt},req,a.network);
 });
 async function content(req:FastifyRequest<{Params:Params;Querystring:{contractId:string;passId:string}}>) {const a=actor(req),ctx=context(config,a.network,req.query.contractId,req.params.eventId);if(!idOk(req.query.passId))throw Errors.invalid('INVALID_INPUT','pass ID required');const s=await snapshot(config,ctx,req.query.passId);validatePass(s,ctx,req.query.passId,a.account,'content');const ds=dbRequired(),ref=await eventRef(ds,ctx);return {a,items:await ds.list(ref),blockMs:s.blockMs};}
 app.get<{Params:Params;Querystring:{contractId:string;passId:string}}>('/v1/direct/events/:eventId/content',{preHandler:auth},async(req,reply)=>{const {a,items,blockMs}=await content(req);fresh(blockMs);reply.header('Cache-Control','no-store');return envelope({items:items.map(({id,title,mimeType,publishedAt})=>({id,title,mimeType,publishedAt}))},req,a.network);});
 app.get<{Params:Params;Querystring:{contractId:string;passId:string}}>('/v1/direct/events/:eventId/content/:resourceId',{preHandler:auth},async(req,reply)=>{if(!isUuid(req.params.resourceId))throw Errors.invalid('INVALID_INPUT','invalid resource');const {items,blockMs}=await content(req);const item=items.find(x=>x.id===req.params.resourceId);if(!item)throw Errors.notFound('content');if(!config.privateContentDir)throw Errors.unavailable('CONTENT_UNAVAILABLE','private content unavailable');try{const root=await lstat(config.privateContentDir);if(root.isSymbolicLink()||!root.isDirectory())throw Error('directory');const base=await realpath(config.privateContentDir),path=await realpath(resolve(base,item.objectKey)),rel=relative(base,path);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('path');const bytes=await readFile(path);if(bytes.length!==item.bytesSize||sha256Hex(bytes)!==item.sha256)throw Error('integrity');fresh(blockMs);return reply.header('Cache-Control','private, no-store').header('X-ShowStake-Source','FINAL_CHAIN').header('X-ShowStake-Authority','FINAL_CHAIN').header('X-Content-Type-Options','nosniff').header('Content-Disposition','attachment').type('application/octet-stream').send(bytes);}catch{throw Errors.unavailable('CONTENT_UNAVAILABLE','private content unavailable');}});
}
