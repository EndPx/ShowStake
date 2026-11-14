import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, lstat, writeFile, link, unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { makeOriginCheck } from '../http/origin.js';
import { InMemoryRateLimiter, makeChallengeRateLimitHandler } from '../http/rate-limit.js';
import { sha256Hex } from '../lib/util.js';
import { okEnvelope } from '@showstake/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { Errors } from '../errors.js';
import { requireSession } from '../auth/middleware.js';
import type { Store } from '../store/types.js';
import { isUuid } from '../lib/util.js';
import { factoryAccessProfile } from '../lib/factory-profile.js';

const meta = (req: FastifyRequest, network: string | null, stale: boolean) => ({ requestId:req.id, observedAt:new Date().toISOString(), network, stale });
const staleAt = (iso: string, now: number, max: number) => { const t=Date.parse(iso); return !Number.isFinite(t) || now-t>max; };
function account(req: FastifyRequest): { accountId:string; network:string } {
  if (!req.auth?.accountId || !req.auth.network) throw Errors.forbidden('NEAR_BINDING_REQUIRED','a verified NEAR wallet binding is required');
  return {accountId:req.auth.accountId,network:req.auth.network};
}


type Token = {id:string; eventId:string; passId:string; chainPassId:string; owner:string; nonce:string; exp:number};
type Event = NonNullable<Awaited<ReturnType<Store['getEvent']>>>;
type Snapshot = {event:Record<string,unknown>; pass:Record<string,unknown>|null; blockMs:number; abi:string};
async function chainSnapshot(config:Config,event:Event,chainPassId?:string):Promise<Snapshot> {
  const factoryId = ['mainnet','testnet'].includes(event.network) && /^[a-f0-9]{16}\./.test(event.contractId) ? event.contractId.slice(17) : '';
  const factoryHash = factoryId ? config.accessFactoryCodeHashes[`${event.network}:${factoryId}`] : undefined;
  if (!config.accessContractAllowlist?.includes(`${event.network}:${event.contractId}`) && !factoryHash) throw Errors.unavailable('CONTRACT_NOT_ALLOWED','contract is not configured for authorization');
  const abi=factoryHash ? 'candidate-v1' : config.accessContractAbis[`${event.network}:${event.contractId}`];
  if (!['candidate-v1','legacy-v6','multievent-v1'].includes(abi ?? '')) throw Errors.unavailable('CONTRACT_ABI_NOT_CONFIGURED','contract ABI is not configured for authorization');
  const url=config.rpcUrls[event.network as keyof Config['rpcUrls']];
  if (!url) throw Errors.unavailable('CHAIN_UNAVAILABLE','final chain state unavailable');
  try {
    const post=async (body:object) => {const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)}); if(!r.ok) throw new Error('rpc'); return r.json();};
    const block=await post({jsonrpc:'2.0',id:'block',method:'block',params:{finality:'final'}}) as {result?:{header?:{hash?:string;timestamp_nanosec?:string}};error?:unknown};
    const header=block.result?.header; if(block.error || !header?.hash || typeof header.timestamp_nanosec!=='string' || !/^\d+$/.test(header.timestamp_nanosec)) throw new Error('invalid block');
    const blockMs=Number(BigInt(header.timestamp_nanosec)/1000000n); if(!Number.isSafeInteger(blockMs) || blockMs>Date.now()+5000 || Date.now()-blockMs>30000) throw new Error('stale block');
    if (abi === 'multievent-v1') {
      const pinned = config.accessContractCodeHashes[`${event.network}:${event.contractId}`];
      if (!pinned) throw new Error('multi-event code hash not pinned');
      const identity=await post({jsonrpc:'2.0',id:'identity',method:'query',params:{request_type:'view_account',block_id:header.hash,account_id:event.contractId}}) as {result?:{code_hash?:string;block_hash?:string};error?:unknown};
      if(identity.error || identity.result?.block_hash!==header.hash || identity.result.code_hash!==pinned) throw new Error('unreviewed multi-event code');
    } else if (event.network === 'mainnet' && !factoryHash) {
      const pinned = 'CpnhymSeF785ZBVTaBZfW8ApsfMVUByNCrys8R2i8os';
      if ((!factoryHash && event.contractId !== 'showstake-mainnet-escrow-endpx-2026.near' && config.accessContractCodeHashes[`mainnet:${event.contractId}`] !== pinned) || abi !== 'candidate-v1') throw new Error('unreviewed mainnet deployment');
      const identity=await post({jsonrpc:'2.0',id:'identity',method:'query',params:{request_type:'view_account',block_id:header.hash,account_id:event.contractId}}) as {result?:{code_hash?:string;block_hash?:string};error?:unknown};
      if(identity.error || identity.result?.block_hash!==header.hash || identity.result.code_hash!==pinned) throw new Error('unreviewed mainnet code');
    }
    const view=async(method:string,args:object):Promise<Record<string,unknown>>=>{
      const result=await post({jsonrpc:'2.0',id:'access',method:'query',params:{request_type:'call_function',block_id:header.hash,account_id:event.contractId,method_name:method,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')}}) as {result?:{result?:number[];block_hash?:string};error?:unknown};
      const body=result.result; if(result.error || !body || body.block_hash!==header.hash || !Array.isArray(body.result) || Date.now()-blockMs>30000) throw new Error('invalid result');
      const value:unknown=JSON.parse(Buffer.from(body.result).toString()); if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error('invalid view'); return value as Record<string,unknown>;
    };
    if (abi === 'multievent-v1') {
      const cfg=await view('get_config',{});
      if(cfg.policy_version!=='showstake-native-usdc-multievent/1' || cfg.network!==event.network) throw new Error('multi-event config mismatch');
    }
    let factoryOrganizer:string|null=null;
    if(factoryHash) {
      const query=async(accountId:string,params:object)=>{const r=await post({jsonrpc:'2.0',id:'factory',method:'query',params:{...params,block_id:header.hash,account_id:accountId}}) as {result?:Record<string,unknown>;error?:unknown};if(r.error || !r.result || r.result.block_hash!==header.hash) throw new Error('invalid factory query');return r.result;};
      const factoryView=async(method_name:string,args:object)=>{const r=await query(factoryId,{request_type:'call_function',method_name,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')});if(!Array.isArray(r.result)) throw new Error('factory view');const v:unknown=JSON.parse(Buffer.from(r.result as number[]).toString());if(!v || typeof v!=='object' || Array.isArray(v)) throw new Error('factory view');return v as Record<string,unknown>;};
      const [factoryAccount,keys,factoryConfig,child,leaf]=await Promise.all([query(factoryId,{request_type:'view_account'}),query(event.contractId,{request_type:'view_access_key_list'}),factoryView('get_config',{}),factoryView('get_child',{child_id:event.contractId}),view('get_config',{})]);
      const profile=factoryAccessProfile(factoryConfig,`${event.network}:${factoryId}`,config.accessFactoryProfiles);
      const ft=profile.canonicalFt??'17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
      const provider=profile.providerAccount??'contract.main.burrow.near',kind=profile.providerKind??'RHEA_MAINNET';
      const policy=profile.leafPolicy, sha=profile.leafSha256;
      const leafAccount=await query(event.contractId,{request_type:'view_account'});
      if(leafAccount.code_hash!==profile.leafCodeHash)throw Error('factory leaf code mismatch');
      if(factoryAccount.code_hash!==factoryHash || !Array.isArray(keys.keys) || keys.keys.length!==0 || factoryConfig.factory_account!==factoryId || factoryConfig.network!==event.network || factoryConfig.factory_policy_identity!==profile.factoryPolicy || factoryConfig.schema_version!==profile.schema || factoryConfig.canonical_ft!==ft || factoryConfig.provider_account!==provider || factoryConfig.provider_kind!==kind || factoryConfig.leaf_code_sha256!==sha || factoryConfig.leaf_policy_version!==policy || child.state!=='Ready' || child.child_id!==event.contractId || typeof child.organizer!=='string' || child.network!==event.network || child.canonical_ft!==ft || child.leaf_code_sha256!==sha || child.leaf_policy_version!==policy || leaf.organizer!==child.organizer || leaf.network!==event.network || leaf.canonical_ft!==ft || leaf.provider_account!==provider || leaf.provider_kind!==kind || leaf.policy_version!==policy) throw new Error('untrusted factory child');
      factoryOrganizer=child.organizer;
    }
    const [e,p]=await Promise.all([view('get_event',abi==='candidate-v1'?{}:{event_id:event.chainEventId}),chainPassId?view('get_pass',{pass_id:chainPassId}):Promise.resolve(null)]);
    if(factoryOrganizer && e.organizer!==factoryOrganizer) throw new Error('factory organizer mismatch');
    if(Date.now()-blockMs>30000) throw new Error('stale block'); return {event:e,pass:p,blockMs,abi:abi!};
  } catch {throw Errors.unavailable('CHAIN_UNAVAILABLE','final chain state unavailable');}
}
async function authorize(config:Config,event:Event,chainPassId:string,owner:string,mode:'checkin'|'content',organizer?:string):Promise<void> {
  const snapshot=await chainSnapshot(config,event,chainPassId); const e=snapshot.event, p=snapshot.pass!;
  if(e.event_id!==event.chainEventId || p.event_id!==event.chainEventId || p.pass_id!==chainPassId || p.owner!==owner || p.registration_status!=='Active') throw Errors.forbidden('PASS_NOT_ELIGIBLE','active on-chain pass ownership required');
  if(organizer && e.organizer!==organizer) throw Errors.forbidden('ORGANIZER_REQUIRED','on-chain organizer required');
  const checkinPhase=['candidate-v1','multievent-v1'].includes(snapshot.abi) ? e.phase==='RegistrationClosed' : e.state==='Published';
  const unmarked=['candidate-v1','multievent-v1'].includes(snapshot.abi) ? p.attendance_status==='Unmarked' : p.attendance_status==='NotMarked';
  const settled=['candidate-v1','multievent-v1'].includes(snapshot.abi) ? e.phase==='Settled' : e.state==='Settled';
  if(mode==='checkin' && (!checkinPhase || !unmarked || !Number.isSafeInteger(e.checkin_open) || !Number.isSafeInteger(e.checkin_close) || snapshot.blockMs<(e.checkin_open as number) || snapshot.blockMs>=(e.checkin_close as number))) throw Errors.forbidden('CHECKIN_NOT_ELIGIBLE','check-in requires an active unmarked pass');
  if(mode==='content' && (!settled || p.attendance_status!=='Attended')) throw Errors.forbidden('CONTENT_NOT_ELIGIBLE','settled event and attended pass required');
}
function signature(key:string, value:string):string {return createHmac('sha256',key).update(value).digest('base64url');}
function qrKey(config:Config):string {if(!config.qrHmacKey || Buffer.byteLength(config.qrHmacKey)<32) throw Errors.unavailable('QR_UNAVAILABLE','QR signing is not configured'); return config.qrHmacKey;}

export function registerPrivate(app: FastifyInstance, store: Store, config: Config): void {
  const auth = requireSession(store, config);
  const origin=makeOriginCheck(config);
  const rate=makeChallengeRateLimitHandler(new InMemoryRateLimiter(config.challengeRateLimit.maxPerWindow,config.challengeRateLimit.windowMs));
  app.post<{Params:{eventId:string};Body:{title:string;mimeType:string;contentBase64:string}}>('/v1/events/:eventId/content',{bodyLimit:720000,preHandler:[origin,rate,auth]},async(req,reply)=>{
    const a=account(req); const body=req.body;
    if(!isUuid(req.params.eventId) || !body || typeof body.title!=='string' || !body.title.trim() || Buffer.byteLength(body.title)>256 || typeof body.mimeType!=='string' || !['application/pdf','text/plain','image/png','image/jpeg'].includes(body.mimeType) || typeof body.contentBase64!=='string' || body.contentBase64.length===0 || body.contentBase64.length>699052 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.contentBase64)) throw Errors.invalid('INVALID_CONTENT','invalid content metadata or base64');
    const bytes=Buffer.from(body.contentBase64,'base64');
    if(bytes.length===0 || bytes.length>524288 || bytes.toString('base64')!==body.contentBase64) throw Errors.invalid('INVALID_CONTENT','content must be canonical base64 and at most 512 KiB');
    const event=await store.getEvent(req.params.eventId); if(!event || event.network!==a.network) throw Errors.notFound('event');
    const chain=await chainSnapshot(config,event);
    if(chain.event.event_id!==event.chainEventId || chain.event.organizer!==a.accountId) throw Errors.forbidden('ORGANIZER_REQUIRED','on-chain organizer required');
    if(!config.privateContentDir) throw Errors.unavailable('CONTENT_UNAVAILABLE','private content directory is not configured');
    const id=randomUUID(), objectKey=randomUUID(), tempKey=randomUUID()+'.tmp';
    try {
      const stat=await lstat(config.privateContentDir); if(stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('invalid directory');
      const base=await realpath(config.privateContentDir); const temp=resolve(base,tempKey), target=resolve(base,objectKey);
      try { await writeFile(temp,bytes,{flag:'wx',mode:0o600}); await link(temp,target); } finally { await unlink(temp).catch(()=>{}); }
    } catch { throw Errors.unavailable('CONTENT_UNAVAILABLE','private content unavailable'); }
    const publishedAt=await store.publishResource({id,eventId:event.id,objectKey,title:body.title,mimeType:body.mimeType,bytesSize:bytes.length});
    reply.header('Cache-Control','no-store').code(201);
    return reply.send(okEnvelope({id:sha256Hex(objectKey),title:body.title,mimeType:body.mimeType,bytesSize:bytes.length,publishedAt},meta(req,a.network,false)));
  });
  app.post<{Params:{eventId:string};Body:{passId:string}}>('/v1/events/:eventId/checkin/challenge',{preHandler:[origin,rate,auth]},async(req,reply)=>{
    const a=account(req); if(!isUuid(req.params.eventId) || !isUuid(req.body?.passId)) throw Errors.invalid('INVALID_INPUT','eventId and passId must be UUIDs');
    const key=qrKey(config); const event=await store.getEvent(req.params.eventId); if(!event || event.network!==a.network) throw Errors.notFound('event');
    const pass=await store.findPass(event.id,req.body.passId,a.accountId); if(!pass) throw Errors.forbidden('PASS_NOT_ELIGIBLE','pass unavailable');
    await authorize(config,event,pass.chainPassId,a.accountId,'checkin');
    const now=Date.now(); const data:Token={id:randomUUID(),eventId:event.id,passId:req.body.passId,chainPassId:pass.chainPassId,owner:a.accountId,nonce:randomBytes(32).toString('base64url'),exp:now+60000};
    await store.createQr({id:data.id,registrationId:pass.registrationId,nonceHash:sha256Hex(data.nonce),owner:data.owner,issuedAt:now,expiresAt:data.exp});
    const encoded=Buffer.from(JSON.stringify(data)).toString('base64url'); reply.header('Cache-Control','no-store');
    return reply.send(okEnvelope({token:encoded+'.'+signature(key,encoded),expiresAt:new Date(data.exp).toISOString()},meta(req,a.network,false)));
  });
  app.post<{Params:{eventId:string};Body:{token:string}}>('/v1/events/:eventId/checkin/scan',{preHandler:[origin,rate,auth]},async(req,reply)=>{
    const a=account(req); const key=qrKey(config); const token=req.body?.token;
    if(!isUuid(req.params.eventId) || typeof token!=='string' || token.length>4096) throw Errors.invalid('INVALID_QR','invalid QR token');
    const parts=token.split('.'); const expected=signature(key,parts[0]??''); const given=parts[1]??'';
    if(parts.length!==2 || Buffer.byteLength(given)!==Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(given),Buffer.from(expected))) throw Errors.invalid('INVALID_QR','invalid QR token');
    let data:Token; try {data=JSON.parse(Buffer.from(parts[0]!, 'base64url').toString()) as Token;} catch {throw Errors.invalid('INVALID_QR','invalid QR token');}
    if(data.eventId!==req.params.eventId || typeof data.exp!=='number' || data.exp<=Date.now() || !isUuid(data.id) || !isUuid(data.passId) || typeof data.owner!=='string' || typeof data.nonce!=='string' || typeof data.chainPassId!=='string') throw Errors.invalid('INVALID_QR','invalid or expired QR token');
    const event=await store.getEvent(data.eventId); if(!event || event.network!==a.network) throw Errors.notFound('event');
    await authorize(config,event,data.chainPassId,data.owner,'checkin',a.accountId);
    const requestId=randomUUID(); if(!await store.consumeQr({id:data.id,eventId:event.id,nonceHash:sha256Hex(data.nonce),owner:data.owner,organizer:a.accountId,requestId})) throw Errors.conflict('QR_CONSUMED_OR_EXPIRED','QR token already used or expired');
    reply.header('Cache-Control','no-store'); return reply.send(okEnvelope({requestId,passId:data.passId,ownerAccount:data.owner,state:'PROPOSED'},meta(req,a.network,false)));
  });
  app.get('/v1/me/passes', { preHandler: auth }, async (req, reply) => {
    const a=account(req); const items=await store.listPasses(a.accountId,a.network);
    return reply.send(okEnvelope({items},meta(req,a.network,items.some(x=>staleAt(x.observedAt,Date.now(),config.projectionFreshnessMs)))));
  });
  app.get('/v1/me/claims', { preHandler: auth }, async (req, reply) => {
    const a=account(req); const items=await store.listClaims(a.accountId,a.network);
    return reply.send(okEnvelope({items},meta(req,a.network,items.some(x=>staleAt(x.observedAt,Date.now(),config.projectionFreshnessMs)))));
  });
  app.get<{Params:{eventId:string}}>('/v1/events/:eventId/attendance', { preHandler: auth }, async (req, reply) => {
    if (!isUuid(req.params.eventId)) throw Errors.invalid('EVENT_ID_INVALID','eventId must be a UUID');
    const a=account(req); const items=await store.getAttendance(req.params.eventId,a.accountId,a.network);
    if (items===null) throw Errors.forbidden('ORGANIZER_REQUIRED','authenticated account is not the event organizer');
    const event=await store.getEvent(req.params.eventId); if(!event || event.network!==a.network) throw Errors.forbidden('ORGANIZER_REQUIRED','event unavailable');
    const chain=await chainSnapshot(config,event); const validPhase=['candidate-v1','multievent-v1'].includes(chain.abi) ? ['RegistrationOpen','RegistrationClosed','Cancelled','RefundOnly','AttendanceFinalized','Settled'].includes(String(chain.event.phase)) : ['Published','Cancelled','RefundOnly','AttendanceFinalized','Settling','Settled'].includes(String(chain.event.state)); if(chain.event.event_id!==event.chainEventId || chain.event.organizer!==a.accountId || !validPhase) throw Errors.forbidden('ORGANIZER_REQUIRED','valid on-chain event and organizer required');
    const stale=items.some(x=>staleAt(x.observedAt,Date.now(),config.projectionFreshnessMs));
    if (stale) throw Errors.unavailable('PROJECTION_STALE','attendance projection is stale or unavailable');
    return reply.send(okEnvelope({items},meta(req,a.network,false)));
  });
  app.get<{Params:{eventId:string}}>('/v1/events/:eventId/content', { preHandler: auth }, async (req) => {
    if (!isUuid(req.params.eventId)) throw Errors.invalid('EVENT_ID_INVALID','eventId must be a UUID');
    const a=account(req); const items=await store.getContentAccess(req.params.eventId,a.accountId,a.network);
    if (items===null) throw Errors.forbidden('CONTENT_NOT_ELIGIBLE','current owner, finalized attendance, and SETTLED state are required');
    if (items.some(x=>staleAt(x.observedAt,Date.now(),config.projectionFreshnessMs))) throw Errors.unavailable('PROJECTION_STALE','content authorization data is stale or unavailable');
    const event=await store.getEvent(req.params.eventId); if(!event || event.network!==a.network) throw Errors.notFound('event');
    const passes=await store.listPasses(a.accountId,a.network); const p=passes.find(x=>x.eventId===event.id);
    if(!p) throw Errors.forbidden('CONTENT_NOT_ELIGIBLE','pass required');
    const pass=await store.findPass(event.id,p.id,a.accountId); if(!pass) throw Errors.forbidden('CONTENT_NOT_ELIGIBLE','pass required');
    await authorize(config,event,pass.chainPassId,a.accountId,'content');
    return {data:{items:items.map((x)=>({id:sha256Hex(x.objectKey),title:x.title,mimeType:x.mimeType,publishedAt:x.publishedAt}))},meta:meta(req,a.network,false),error:null};
  });
  app.get<{Params:{eventId:string;index:string}}>('/v1/events/:eventId/content/:index',{preHandler:auth},async(req,reply)=>{
    const a=account(req); if(!isUuid(req.params.eventId) || !/^[a-f0-9]{64}$/.test(req.params.index)) throw Errors.invalid('INVALID_INPUT','invalid resource');
    const items=await store.getContentAccess(req.params.eventId,a.accountId,a.network); const event=await store.getEvent(req.params.eventId);
    if(!items || !event || event.network!==a.network) throw Errors.forbidden('CONTENT_NOT_ELIGIBLE','content unavailable');
    if(items.some(x=>staleAt(x.observedAt,Date.now(),config.projectionFreshnessMs))) throw Errors.unavailable('PROJECTION_STALE','content authorization data is stale or unavailable');
    const p=(await store.listPasses(a.accountId,a.network)).find(x=>x.eventId===event.id); const pass=p && await store.findPass(event.id,p.id,a.accountId);
    if(!pass) throw Errors.forbidden('CONTENT_NOT_ELIGIBLE','pass required'); await authorize(config,event,pass.chainPassId,a.accountId,'content');
    const item=items.find(x=>sha256Hex(x.objectKey)===req.params.index); if(!item) throw Errors.notFound('content');
    if(!config.privateContentDir) throw Errors.unavailable('CONTENT_UNAVAILABLE','private content directory is not configured');
    try {const base=await realpath(config.privateContentDir); const path=await realpath(resolve(base,item.objectKey)); const rel=relative(base,path); if(!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('invalid path'); const bytes=await readFile(path); reply.header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff').header('Content-Disposition','attachment').type('application/octet-stream'); return reply.send(bytes);} catch {throw Errors.unavailable('CONTENT_UNAVAILABLE','private content unavailable');}
  });
}
