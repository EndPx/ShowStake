import { discoverFactoryChildren, adoptFactoryChild } from './factory.js';
import { NearRpcClient } from './source.js';
import { makeBlockSource, makeCanonicalVerifier, makeLiveChain, runBoundedScan, workerConnectConfig } from './index.js';
import { createWorkerPool, WorkerStore, assertWorkerLeastPrivilege } from './store.js';
import type { DeploymentAllowlist } from './config.js';

async function main():Promise<void> {
  const factoryId=process.env.WORKER_FACTORY_ID ?? '', factoryCodeHash=process.env.WORKER_FACTORY_CODE_HASH ?? '', organizer=process.env.WORKER_FACTORY_ORGANIZER ?? '';
  const fromRaw=process.env.WORKER_FACTORY_FROM_INDEX ?? '0', maxRaw=process.env.WORKER_MAX_BLOCKS_PER_RUN ?? '1000';
  if(!factoryId || !factoryCodeHash || !organizer || !/^\d+$/.test(fromRaw) || !/^\d+$/.test(maxRaw)) throw new Error('factory id, accepted factory code hash, organizer, and bounded indices required');
  const fromIndex=Number(fromRaw), maxBlocks=Number(maxRaw);if(!Number.isSafeInteger(fromIndex) || !Number.isSafeInteger(maxBlocks) || maxBlocks<1 || maxBlocks>1000) throw new Error('invalid scan bounds');
  const rpcUrl='https://rpc.mainnet.near.org';
  const watch=process.argv.slice(2).includes('--watch'), interval=Number(process.env.WORKER_WATCH_INTERVAL_MS ?? '15000');
  if(!Number.isSafeInteger(interval) || interval<5000 || interval>300000) throw new Error('invalid watch interval');
  const pool=createWorkerPool(workerConnectConfig(process.env.DATABASE_URL ?? null) as import('pg').PoolConfig);
  try {
    await assertWorkerLeastPrivilege(pool);
    let pageIndex=fromIndex;
    do {
    try {
    const proof=await discoverFactoryChildren(new NearRpcClient(rpcUrl),{factoryId,factoryCodeHash,organizer,fromIndex:pageIndex});
    const results=[];
    for(const child of proof.children) await adoptFactoryChild(pool,child);
    for(const child of proof.children) {
      const dep:DeploymentAllowlist={environment:'mainnet',network:'mainnet',contractId:child.contractId,ftContractId:'17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',ftDecimals:6,codeHash:'CpnhymSeF785ZBVTaBZfW8ApsfMVUByNCrys8R2i8os',wasmSha256:'03076c4a9496e8ae1e6af68c791752d4a7220597942effd0c3a1839a252be9d2',organizer,policyVersion:'showstake-native-usdc-rhea-review/1',candidateProviderAccount:'contract.main.burrow.near',verifiedFactoryId:factoryId,startHeight:child.startHeight};
      const verifier=makeCanonicalVerifier(rpcUrl), store=new WorkerStore(pool,dep,process.env.WORKER_CONSUMER || 'showstake-worker',makeLiveChain(rpcUrl),verifier);
      const deployment=await store.resolveDeployment();await store.verifyLiveIdentity();
      const nextHeight=await store.resolveStartHeight(deployment.id,deployment.startBlock);
      const scan=await runBoundedScan({store,blockSource:makeBlockSource('https://mainnet.neardata.xyz'),verifier,deploymentId:deployment.id,nextHeight,maxBlocks});
      results.push({contractId:child.contractId,startHeight:child.startHeight,scan});
    }
    console.log(JSON.stringify({finalizedBlockHash:proof.blockHash,finalizedBlockHeight:proof.blockHeight,nextIndex:proof.nextIndex,results},null,2));
    pageIndex=proof.nextIndex ?? fromIndex;
    } catch(e) {if(!watch) throw e;console.error('factory worker cycle failed:',e instanceof Error?e.message:String(e));}
    if(watch) await new Promise(resolve=>setTimeout(resolve,interval));
    } while(watch);
  } finally {await pool.end();}
}
main().catch(e=>{console.error('factory worker FATAL:',e instanceof Error?e.message:String(e));process.exitCode=1;});
