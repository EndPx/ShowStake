import { randomUUID } from 'node:crypto';
import { validateAccountIdShape } from '@showstake/domain';
import { base58Decode } from './identity.js';
import type { Pool } from 'pg';
import type { DeploymentAllowlist } from './config.js';
import { LINKED_CANDIDATE_HASH, LINKED_CODE_HASH, LINKED_POLICY } from './candidate.js';

const LEAF_HASH = 'CpnhymSeF785ZBVTaBZfW8ApsfMVUByNCrys8R2i8os';
const LEAF_SHA = '03076c4a9496e8ae1e6af68c791752d4a7220597942effd0c3a1839a252be9d2';
const FT = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const PROVIDER = 'contract.main.burrow.near';
const POLICY = 'showstake-native-usdc-rhea-review/1';
type Rpc = {rpc(method:string,params:unknown):Promise<unknown>};
export type AdoptedChild = {id:string; contractId:string; organizer:string; startHeight:number; factoryId:string; factoryCodeHash:string; proofBlockMs:number;leafHash:string;leafSha:string;leafPolicy:string;network:'mainnet'|'testnet';canonicalFt:string;providerAccount:string;providerKind:'RHEA_MAINNET'|'MOCK_TESTNET'};
const verifiedChildren = new WeakSet<AdoptedChild>();
const adoptedChildren = new WeakSet<AdoptedChild>();
const verifiedDeployments = new WeakSet<DeploymentAllowlist>();
export const isVerifiedFactoryDeployment = (d:DeploymentAllowlist):boolean => verifiedDeployments.has(d);
export type FactoryV3Profile={network:'mainnet'|'testnet';canonicalFt:string;providerAccount:string;providerKind:'RHEA_MAINNET'|'MOCK_TESTNET';factoryId:string;factoryCodeHash:string;leafHash:string;leafSha:string;schemaVersion:3;factoryPolicy:'showstake-factory-atomic-event/3';leafPolicy:'showstake-native-usdc-factory-rhea/3'|'showstake-native-usdc-event/1'};
export function validateFactoryV3Profile(p:FactoryV3Profile):void {
 const main=p?.network==='mainnet'&&p.canonicalFt===FT&&p.providerAccount===PROVIDER&&p.providerKind==='RHEA_MAINNET'&&p.leafPolicy==='showstake-native-usdc-factory-rhea/3'&&p.factoryId?.endsWith('.near');
 const test=p?.network==='testnet'&&p.providerKind==='MOCK_TESTNET'&&p.leafPolicy==='showstake-native-usdc-event/1'&&p.factoryId?.endsWith('.testnet')&&validateAccountIdShape(p.canonicalFt)&&p.canonicalFt.endsWith('.testnet')&&validateAccountIdShape(p.providerAccount)&&p.providerAccount.endsWith('.testnet')&&p.providerAccount!==p.canonicalFt&&p.providerAccount!==p.factoryId;
 if(!p||(!main&&!test)||!validateAccountIdShape(p.factoryId)||p.schemaVersion!==3||p.factoryPolicy!=='showstake-factory-atomic-event/3'||!/^[a-f0-9]{64}$/.test(p.leafSha)||p.leafSha==='0'.repeat(64)||base58Decode(p.factoryCodeHash).length!==32||p.factoryCodeHash==='11111111111111111111111111111111'||base58Decode(p.leafHash).length!==32||Buffer.from(base58Decode(p.leafHash)).toString('hex')!==p.leafSha)throw new Error('invalid reviewed factory profile');
}
export function deploymentForAdoptedChild(child:AdoptedChild):DeploymentAllowlist {if(!adoptedChildren.has(child))throw new Error('adopted factory proof required');const d:DeploymentAllowlist=Object.freeze({environment:child.network,network:child.network,contractId:child.contractId,ftContractId:child.canonicalFt,ftDecimals:6,codeHash:child.leafHash,wasmSha256:child.leafSha,organizer:child.organizer,policyVersion:child.leafPolicy,candidateProviderAccount:child.providerAccount,verifiedFactoryId:child.factoryId,startHeight:child.startHeight});verifiedDeployments.add(d);return d;}

const object = (v:unknown):Record<string,any> => {if(!v || typeof v!=='object' || Array.isArray(v)) throw new Error('invalid factory response');return v as Record<string,any>;};
const uint = (v:unknown):number => {if(typeof v!=='number' || !Number.isSafeInteger(v) || v<0) throw new Error('invalid factory integer');return v;};

/** Read one bounded organizer page at one final block. No caller-supplied RPC URL or writes. */
export async function discoverFactoryChildren(rpc:Rpc, trust:{factoryId:string;factoryCodeHash:string;organizer?:string;fromIndex:number;mode?:'organizer'|'global';leafProfile?:'legacy'|'linked-v2'|'atomic-v3';v3?:FactoryV3Profile}):Promise<{children:AdoptedChild[];nextIndex:number|null;blockHash:string;blockHeight:number}> {
  const mode=trust.mode ?? 'organizer';
  const profile=trust.leafProfile ?? 'legacy';if(!['legacy','linked-v2','atomic-v3'].includes(profile)||((profile==='linked-v2'||profile==='atomic-v3')&&mode!=='global'))throw new Error('invalid leaf profile');
  if(profile==='atomic-v3'){if(!trust.v3)throw new Error('v3 profile required');validateFactoryV3Profile(trust.v3);if(trust.v3.factoryId!==trust.factoryId||trust.v3.factoryCodeHash!==trust.factoryCodeHash)throw new Error('v3 root mismatch');}const leafHash=profile==='atomic-v3'?trust.v3!.leafHash:profile==='linked-v2'?LINKED_CODE_HASH:LEAF_HASH,leafSha=profile==='atomic-v3'?trust.v3!.leafSha:profile==='linked-v2'?LINKED_CANDIDATE_HASH:LEAF_SHA,leafPolicy=profile==='atomic-v3'?trust.v3!.leafPolicy:profile==='linked-v2'?LINKED_POLICY:POLICY;
  const network=profile==='atomic-v3'?trust.v3!.network:'mainnet',canonicalFt=profile==='atomic-v3'?trust.v3!.canonicalFt:FT,providerAccount=profile==='atomic-v3'?trust.v3!.providerAccount:PROVIDER,providerKind=profile==='atomic-v3'?trust.v3!.providerKind:'RHEA_MAINNET';
  if (!validateAccountIdShape(trust.factoryId) || (mode==='organizer' && (!trust.organizer || !validateAccountIdShape(trust.organizer))) || (mode==='global' && trust.organizer!==undefined) || !trust.factoryId.endsWith(network==='mainnet'?'.near':'.testnet') || base58Decode(trust.factoryCodeHash).length!==32 || trust.factoryCodeHash==='11111111111111111111111111111111') throw new Error('invalid factory trust configuration');
  uint(trust.fromIndex);
  const b=object(await rpc.rpc('block',{finality:'final'})), header=object(b.header);
  if(typeof header.hash!=='string' || !header.hash || typeof header.timestamp_nanosec!=='string' || !/^\d+$/.test(header.timestamp_nanosec)) throw new Error('invalid final block');
  const blockMs=Number(BigInt(header.timestamp_nanosec)/1000000n);if(!Number.isSafeInteger(blockMs) || blockMs>Date.now()+5000 || Date.now()-blockMs>30000) throw new Error('stale final block');
  const blockHash=header.hash, blockHeight=uint(header.height);
  const query=async (account_id:string, params:Record<string,unknown>)=>{const result=object(await rpc.rpc('query',{...params,account_id,block_id:blockHash}));if(result.block_hash!==blockHash||result.block_height!==blockHeight) throw new Error('factory view block mismatch');return result;};
  const view=async(account:string,method_name:string,args:object)=>{const r=await query(account,{request_type:'call_function',method_name,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')});if(!Array.isArray(r.result)) throw new Error('invalid factory view');return JSON.parse(Buffer.from(r.result).toString());};
  const f=await query(trust.factoryId,{request_type:'view_account'});if(f.code_hash!==trust.factoryCodeHash) throw new Error('factory code mismatch');
  const cfg=object(await view(trust.factoryId,'get_config',{}));
  if(cfg.factory_account!==trust.factoryId || cfg.network!==network || cfg.canonical_ft!==canonicalFt || cfg.provider_account!==providerAccount || cfg.provider_kind!==providerKind || cfg.leaf_code_sha256!==leafSha || cfg.leaf_policy_version!==leafPolicy || cfg.factory_policy_identity!==(profile==='atomic-v3'?'showstake-factory-atomic-event/3':mode==='global'?'showstake-factory-d039-global-ready/2':'showstake-factory-d039/1') || cfg.schema_version!==(profile==='atomic-v3'?3:mode==='global'?2:1)) throw new Error('factory config mismatch');
  if(profile==='atomic-v3'&&cfg.atomic_event_initialization!==true)throw new Error('atomic factory initialization unavailable');
  const page=await view(trust.factoryId,mode==='global'?'list_all_children':'list_children',mode==='global'?{from_index:trust.fromIndex,limit:20}:{organizer:trust.organizer,from_index:trust.fromIndex,limit:20});
  if(!Array.isArray(page) || page.length>20) throw new Error('invalid child page');
  const children:AdoptedChild[]=[]; const seen=new Set<string>();
  for(const item of page) {
    const child=object(item); const organizer=child.organizer;if(typeof organizer!=='string'||!validateAccountIdShape(organizer)||(mode==='organizer'&&organizer!==trust.organizer)) throw new Error('foreign organizer');if(child.state!=='Ready'){if(mode==='global')throw new Error('non-ready child in global registry');continue;}
    const id=child.child_id, nonce=uint(child.request_nonce);
    if(typeof id!=='string' || !/^[a-f0-9]{16}\./.test(id) || !id.endsWith('.'+trust.factoryId) || !validateAccountIdShape(id) || seen.has(id)) throw new Error('invalid factory child'); seen.add(id);
    const [record,request,derived,account,keys,leaf]=await Promise.all([view(trust.factoryId,'get_child',{child_id:id}),view(trust.factoryId,'get_request',{organizer,request_nonce:nonce}),view(trust.factoryId,'get_child_id',{organizer,request_nonce:nonce}),query(id,{request_type:'view_account'}),query(id,{request_type:'view_access_key_list'}),view(id,'get_config',{})]);
    const c=object(record), r=object(request), l=object(leaf), startHeight=uint(r.created_block);
    for(const row of [child,c,r]) if(row.child_id!==id || row.organizer!==organizer || row.request_nonce!==nonce || row.state!=='Ready' || row.leaf_code_sha256!==leafSha || row.network!==network || row.canonical_ft!==canonicalFt || row.leaf_policy_version!==leafPolicy) throw new Error('factory child identity mismatch');
    if(derived!==id || startHeight>blockHeight || account.code_hash!==leafHash || !Array.isArray(keys.keys) || keys.keys.length!==0 || l.organizer!==organizer || l.network!==network || l.canonical_ft!==canonicalFt || l.policy_version!==leafPolicy || l.provider_account!==providerAccount || l.provider_kind!==providerKind) throw new Error('leaf identity mismatch');
    const verified=Object.freeze({id:randomUUID(),contractId:id,organizer,startHeight,factoryId:trust.factoryId,factoryCodeHash:trust.factoryCodeHash,proofBlockMs:blockMs,leafHash,leafSha,leafPolicy,network,canonicalFt,providerAccount,providerKind});verifiedChildren.add(verified);children.push(verified);
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
    const trusted=await client.query<{factory_code_hash:string;leaf_code_hash:string;leaf_wasm_sha256:string;leaf_policy_version:string;canonical_ft:string;ft_decimals:number;provider_account:string;provider_kind:string}>(`SELECT factory_code_hash,leaf_code_hash,leaf_wasm_sha256,leaf_policy_version,canonical_ft,ft_decimals,provider_account,provider_kind FROM factory_deployment_allowlist WHERE network=$1 AND factory_account=$2 AND enabled`,[child.network,child.factoryId]);
    const t=trusted.rows[0];if(!t || t.factory_code_hash!==child.factoryCodeHash || t.leaf_code_hash!==child.leafHash || t.leaf_wasm_sha256!==child.leafSha || t.leaf_policy_version!==child.leafPolicy || t.canonical_ft!==child.canonicalFt || t.ft_decimals!==6 || t.provider_account!==child.providerAccount || t.provider_kind!==child.providerKind) throw new Error('factory database trust mismatch');
    await client.query(`SELECT public.register_factory_child($1,$2,$3,$4,$5)`,[child.id,child.network,child.factoryId,child.contractId,child.startHeight]);
    const res=await client.query<{environment:string;ft_contract_id:string;ft_decimals:number;start_block:string;code_hash:string}>(`SELECT environment,ft_contract_id,ft_decimals,start_block::text,code_hash FROM deployments WHERE network=$1 AND contract_id=$2`,[child.network,child.contractId]);
    const row=res.rows[0]; if(!row || row.environment!==child.network || row.ft_contract_id!==child.canonicalFt || row.ft_decimals!==6 || row.start_block!==String(child.startHeight) || row.code_hash!==child.leafHash) throw new Error('existing deployment mismatch');
    await client.query('COMMIT');adoptedChildren.add(child);
  } catch(e) {await client.query('ROLLBACK');throw e;} finally {client.release();}
}
