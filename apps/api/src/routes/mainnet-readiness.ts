import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { Errors } from '../errors.js';

const contract = 'showstake-mainnet-escrow-endpx-2026.near';
const hash = 'CpnhymSeF785ZBVTaBZfW8ApsfMVUByNCrys8R2i8os';
const sharedHash = 'EUA9Rm9RvU6SwDbkAsqosP9JCSD4qBRhe75p5PnapdyY';
const ft = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

export function registerMainnetReadiness(app: FastifyInstance, config: Config): void {
  app.get('/v1/mainnet/readiness', async (req, reply) => {
    const url = config.rpcUrls.mainnet;
    if (!url) throw Errors.unavailable('CHAIN_UNAVAILABLE', 'final mainnet state unavailable');
    try {
      const post = async (method: string, params: object): Promise<any> => {
        const r = await fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:'readiness',method,params}), signal:AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error('rpc'); const body: any = await r.json(); if (body.error || !body.result) throw new Error('rpc'); return body.result;
      };
      const b = await post('block', {finality:'final'}); const h = b.header;
      if (typeof h?.hash !== 'string' || !Number.isSafeInteger(h.height) || typeof h.timestamp_nanosec !== 'string' || !/^\d+$/.test(h.timestamp_nanosec)) throw new Error('header');
      const blockMs = Number(BigInt(h.timestamp_nanosec)/1000000n);
      if (!Number.isSafeInteger(blockMs) || blockMs > Date.now()+5000 || Date.now()-blockMs > 30000) throw new Error('stale');
      const query = async (params:object) => {const r=await post('query',{...params,block_id:h.hash,account_id:contract}); if(r.block_hash!==h.hash) throw new Error('wrong block'); return r;};
      const view = async (method_name:string,args:object={}) => {const r=await query({request_type:'call_function',method_name,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')}); if(!Array.isArray(r.result)) throw new Error('view'); return JSON.parse(Buffer.from(r.result).toString());};
      const [account, cfg] = await Promise.all([query({request_type:'view_account'}),view('get_config')]);
      if(account.code_hash===sharedHash) {
        if(cfg.network!=='mainnet'||cfg.policy_version!=='showstake-native-usdc-multievent/1'||cfg.canonical_ft!==ft||cfg.provider_account!=='contract.main.burrow.near'||cfg.provider_kind!=='RHEA_MAINNET'||cfg.token_symbol!=='USDC'||cfg.token_decimals!==6||cfg.provider_enabled!==false)throw new Error('shared identity');
        const events=await view('list_events',{from_index:0,limit:1});
        if(!Array.isArray(events)||events.length>1||Date.now()-blockMs>30000)throw new Error('shared event list');
        reply.header('Cache-Control','no-store');
        return reply.send({data:{contractId:contract,codeHash:sharedHash,contractMode:'MULTI_EVENT_CREATE',createReady:true,registrationEnabled:false,paused:true,principalCapAtomic:'0',eventPresent:events.length>0,providerStatus:'UNVERIFIED',signingAuthority:false},meta:{requestId:req.id,network:'mainnet',observedAt:new Date().toISOString(),blockHeight:h.height,blockHash:h.hash,blockTime:new Date(blockMs).toISOString(),finalized:true,stale:false},error:null});
      }
      const [control,event]=await Promise.all([view('get_rhea_control'),view('get_event')]);
      if(account.code_hash!==hash || cfg.network!=='mainnet' || cfg.policy_version!=='showstake-native-usdc-rhea-review/1' || cfg.canonical_ft!==ft || cfg.provider_account!=='contract.main.burrow.near' || cfg.provider_kind!=='RHEA_MAINNET' || typeof control.paused!=='boolean' || typeof control.principal_cap!=='string' || !/^(0|[1-9]\d*)$/.test(control.principal_cap) || BigInt(control.principal_cap)>=1n<<128n || (event !== null && (typeof event!=='object' || Array.isArray(event))) || Date.now()-blockMs>30000) throw new Error('identity');
      reply.header('Cache-Control','no-store');
      return reply.send({data:{contractId:contract,codeHash:hash,paused:control.paused,principalCapAtomic:control.principal_cap,eventPresent:event!==null,providerStatus:'UNVERIFIED',signingAuthority:false},meta:{requestId:req.id,network:'mainnet',observedAt:new Date().toISOString(),blockHeight:h.height,blockHash:h.hash,blockTime:new Date(blockMs).toISOString(),finalized:true,stale:false},error:null});
    } catch { throw Errors.unavailable('CHAIN_UNAVAILABLE', 'final mainnet state unavailable'); }
  });
}
