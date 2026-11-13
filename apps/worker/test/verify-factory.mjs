import assert from 'node:assert/strict';
import { discoverFactoryChildren } from '../dist/factory.js';
const hash='CpnhymSeF785ZBVTaBZfW8ApsfMVUByNCrys8R2i8os', sha='03076c4a9496e8ae1e6af68c791752d4a7220597942effd0c3a1839a252be9d2', ft='17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', policy='showstake-native-usdc-rhea-review/1';
const trust={factoryId:'factory.near',factoryCodeHash:hash,organizer:'host.near',fromIndex:0}, child='0123456789abcdef.factory.near';
const common={child_id:child,organizer:trust.organizer,request_nonce:1,state:'Ready',leaf_code_sha256:sha,canonical_ft:ft,network:'mainnet',leaf_policy_version:policy};
let error='';
const rpc={async rpc(method,p){
 if(method==='block')return {header:{hash:'h',height:120,timestamp_nanosec:String(BigInt(Date.now()-(error==='stale'?31000:0))*1000000n)}};
 assert.equal(p.block_id,'h'); let result;
 if(p.request_type==='view_account') result={code_hash:error==='wrongcode'&&p.account_id===child?'bad':error==='foreignfactory'&&p.account_id===trust.factoryId?'bad':hash};
 else if(p.request_type==='view_access_key_list') result={keys:error==='keys'?[{}]:[]};
 else {let v;switch(p.method_name){case 'get_config':v=p.account_id===trust.factoryId?{factory_account:trust.factoryId,network:'mainnet',canonical_ft:ft,provider_account:'contract.main.burrow.near',provider_kind:'RHEA_MAINNET',leaf_code_sha256:sha,leaf_policy_version:policy,factory_policy_identity:'showstake-factory-d039/1',schema_version:1}:{organizer:error==='owner'?'other.near':trust.organizer,network:'mainnet',canonical_ft:ft,provider_account:'contract.main.burrow.near',provider_kind:'RHEA_MAINNET',policy_version:policy};break;case 'list_children':v=[common];break;case 'get_child':v=common;break;case 'get_request':v={...common,created_block:100};break;case 'get_child_id':v=child;break;default:throw Error(p.method_name);} result={result:[...Buffer.from(JSON.stringify(v))]};}
 return {...result,block_hash:'h',block_height:120};
}};
const found=await discoverFactoryChildren(rpc,trust);assert.equal(found.children[0].contractId,child);assert.equal(found.children[0].startHeight,100);assert.equal(found.blockHeight,120);
for(const kind of ['foreignfactory','wrongcode','keys','owner','stale']) {error=kind;await assert.rejects(()=>discoverFactoryChildren(rpc,trust));}
console.log('PASS_LOCAL factory final-pinned registry, code, keyless leaf and organizer checks');
