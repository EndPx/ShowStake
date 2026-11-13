import { randomUUID } from 'node:crypto';
import { validateAccountIdShape } from '@showstake/domain';
import { base58Decode } from './identity.js';
import type { Pool } from 'pg';

const LEAF_HASH = 'CpnhymSeF785ZBVTaBZfW8ApsfMVUByNCrys8R2i8os';
const LEAF_SHA = '03076c4a9496e8ae1e6af68c791752d4a7220597942effd0c3a1839a252be9d2';
const FT = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const PROVIDER = 'contract.main.burrow.near';
const POLICY = 'showstake-native-usdc-rhea-review/1';
type Rpc = {rpc(method:string,params:unknown):Promise<unknown>};
export type AdoptedChild = {id:string; contractId:string; organizer:string; startHeight:number; factoryId:string; factoryCodeHash:string; proofBlockMs:number};
const verifiedChildren = new WeakSet<AdoptedChild>();
const object = (v:unknown):Record<string,any> => {if(!v || typeof v!=='object' || Array.isArray(v)) throw new Error('invalid factory response');return v as Record<string,any>;};
const uint = (v:unknown):number => {if(typeof v!=='number' || !Number.isSafeInteger(v) || v<0) throw new Error('invalid factory integer');return v;};

/** Read one bounded organizer page at one final block. No caller-supplied RPC URL or writes. */
export async function discoverFactoryChildren(rpc:Rpc, trust:{factoryId:string;factoryCodeHash:string;organizer:string;fromIndex:number}):Promise<{children:AdoptedChild[];nextIndex:number|null;blockHash:string;blockHeight:number}> {
  if (!validateAccountIdShape(trust.factoryId) || !validateAccountIdShape(trust.organizer) || !trust.factoryId.endsWith('.near') || base58Decode(trust.factoryCodeHash).length!==32) throw new Error('invalid factory trust configuration');
  uint(trust.fromIndex);
  const b=object(await rpc.rpc('block',{finality:'final'})), header=object(b.header);
  if(typeof header.hash!=='string' || !header.hash || typeof header.timestamp_nanosec!=='string' || !/^\d+$/.test(header.timestamp_nanosec)) throw new Error('invalid final block');
  const blockMs=Number(BigInt(header.timestamp_nanosec)/1000000n);if(!Number.isSafeInteger(blockMs) || blockMs>Date.now()+5000 || Date.now()-blockMs>30000) throw new Error('stale final block');
  const blockHash=header.hash, blockHeight=uint(header.height);
  const query=async (account_id:string, params:Record<string,unknown>)=>{const result=object(await rpc.rpc('query',{...params,account_id,block_id:blockHash}));if(result.block_hash!==blockHash) throw new Error('factory view block mismatch');return result;};
  const view=async(account:string,method_name:string,args:object)=>{const r=await query(account,{request_type:'call_function',method_name,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')});if(!Array.isArray(r.result)) throw new Error('invalid factory view');return JSON.parse(Buffer.from(r.result).toString());};
  const f=await query(trust.factoryId,{request_type:'view_account'});if(f.code_hash!==trust.factoryCodeHash) throw new Error('factory code mismatch');
  const cfg=object(await view(trust.factoryId,'get_config',{}));
  if(cfg.factory_account!==trust.factoryId || cfg.network!=='mainnet' || cfg.canonical_ft!==FT || cfg.provider_account!==PROVIDER || cfg.provider_kind!=='RHEA_MAINNET' || cfg.leaf_code_sha256!==LEAF_SHA || cfg.leaf_policy_version!==POLICY || cfg.factory_policy_identity!=='showstake-factory-d039/1' || cfg.schema_version!==1) throw new Error('factory config mismatch');
  const page=await view(trust.factoryId,'list_children',{organizer:trust.organizer,from_index:trust.fromIndex,limit:20});
  if(!Array.isArray(page) || page.length>20) throw new Error('invalid child page');
  const children:AdoptedChild[]=[]; const seen=new Set<string>();
  for(const item of page) {
    const child=object(item); if(child.organizer!==trust.organizer) throw new Error('foreign organizer'); if(child.state!=='Ready') continue;
    const id=child.child_id, nonce=uint(child.request_nonce);
    if(typeof id!=='string' || !/^[a-f0-9]{16}\./.test(id) || !id.endsWith('.'+trust.factoryId) || !validateAccountIdShape(id) || seen.has(id)) throw new Error('invalid factory child'); seen.add(id);
    const [record,request,derived,account,keys,leaf]=await Promise.all([view(trust.factoryId,'get_child',{child_id:id}),view(trust.factoryId,'get_request',{organizer:trust.organizer,request_nonce:nonce}),view(trust.factoryId,'get_child_id',{organizer:trust.organizer,request_nonce:nonce}),query(id,{request_type:'view_account'}),query(id,{request_type:'view_access_key_list'}),view(id,'get_config',{})]);
    const c=object(record), r=object(request), l=object(leaf), startHeight=uint(r.created_block);
    for(const row of [child,c,r]) if(row.child_id!==id || row.organizer!==trust.organizer || row.request_nonce!==nonce || row.state!=='Ready' || row.leaf_code_sha256!==LEAF_SHA || row.network!=='mainnet' || row.canonical_ft!==FT || row.leaf_policy_version!==POLICY) throw new Error('factory child identity mismatch');
    if(derived!==id || startHeight>blockHeight || account.code_hash!==LEAF_HASH || !Array.isArray(keys.keys) || keys.keys.length!==0 || l.organizer!==trust.organizer || l.network!=='mainnet' || l.canonical_ft!==FT || l.policy_version!==POLICY || l.provider_account!==PROVIDER || l.provider_kind!=='RHEA_MAINNET') throw new Error('leaf identity mismatch');
    const verified=Object.freeze({id:randomUUID(),contractId:id,organizer:trust.organizer,startHeight,factoryId:trust.factoryId,factoryCodeHash:trust.factoryCodeHash,proofBlockMs:blockMs});verifiedChildren.add(verified);children.push(verified);
  }
  if(Date.now()-blockMs>30000) throw new Error('stale final block');
  return {children,nextIndex:page.length===20?trust.fromIndex+20:null,blockHash,blockHeight};
}

/** Persist only a previously validated page. Existing rows must match exactly. */
export async function adoptFactoryChild(pool:Pool, child:AdoptedChild):Promise<void> {
  if(!verifiedChildren.has(child) || Date.now()-child.proofBlockMs>30000) throw new Error('fresh factory proof required');
  const client=await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const trusted=await client.query<{factory_code_hash:string;leaf_code_hash:string;leaf_wasm_sha256:string;leaf_policy_version:string;canonical_ft:string;ft_decimals:number;provider_account:string;provider_kind:string}>(`SELECT factory_code_hash,leaf_code_hash,leaf_wasm_sha256,leaf_policy_version,canonical_ft,ft_decimals,provider_account,provider_kind FROM factory_deployment_allowlist WHERE network='mainnet' AND factory_account=$1 AND enabled`,[child.factoryId]);
    const t=trusted.rows[0];if(!t || t.factory_code_hash!==child.factoryCodeHash || t.leaf_code_hash!==LEAF_HASH || t.leaf_wasm_sha256!==LEAF_SHA || t.leaf_policy_version!==POLICY || t.canonical_ft!==FT || t.ft_decimals!==6 || t.provider_account!==PROVIDER || t.provider_kind!=='RHEA_MAINNET') throw new Error('factory database trust mismatch');
    await client.query(`SELECT public.register_factory_child($1,'mainnet',$2,$3,$4)`,[child.id,child.factoryId,child.contractId,child.startHeight]);
    const res=await client.query<{environment:string;ft_contract_id:string;ft_decimals:number;start_block:string;code_hash:string}>(`SELECT environment,ft_contract_id,ft_decimals,start_block::text,code_hash FROM deployments WHERE network='mainnet' AND contract_id=$1`,[child.contractId]);
    const row=res.rows[0]; if(!row || row.environment!=='mainnet' || row.ft_contract_id!==FT || row.ft_decimals!==6 || row.start_block!==String(child.startHeight) || row.code_hash!==LEAF_HASH) throw new Error('existing deployment mismatch');
    await client.query('COMMIT');
  } catch(e) {await client.query('ROLLBACK');throw e;} finally {client.release();}
}
