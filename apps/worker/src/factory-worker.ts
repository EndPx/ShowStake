import type {Pool} from 'pg';
import {discoverFactoryChildren,adoptFactoryChild,deploymentForAdoptedChild,validateFactoryV3Profile,type FactoryV3Profile,type AdoptedChild} from './factory.js';
import {NearRpcClient,HttpError,BlockNotFoundError,RpcError} from './source.js';
import {makeBlockSource,makeCanonicalVerifier,makeLiveChain,runBoundedScan} from './index.js';
import {sharedFactorySources} from './factory-cache.js';
import {WorkerStore} from './store.js';
/** Logs only typed status and URL origin; never the provider path, query, credentials or raw error. */
export function safeFactoryError(error:unknown,rpcUrl:string):{errorType:string;httpStatus?:number;providerOrigin?:string;rpcMethod?:string}{
 const result:{errorType:string;httpStatus?:number;providerOrigin?:string;rpcMethod?:string}={errorType:error instanceof HttpError?'HttpError':error instanceof BlockNotFoundError?'BlockNotFoundError':error instanceof RpcError?'RpcError':'Error'};
 const rawUrl=error instanceof HttpError||error instanceof BlockNotFoundError?error.url:error instanceof RpcError?rpcUrl:undefined;
 if(error instanceof HttpError&&Number.isInteger(error.status)&&error.status>=100&&error.status<=599)result.httpStatus=error.status;
 if(error instanceof BlockNotFoundError)result.httpStatus=404;
 if(error instanceof RpcError&&['block','query'].includes(error.method))result.rpcMethod=error.method;
 if(rawUrl){try{const u=new URL(rawUrl);if(u.protocol==='https:'||u.protocol==='http:')result.providerOrigin=u.origin;}catch{/* Unknown origin stays omitted. */}}
 return result;
}
export type FactoryWorkerConfig={profile:FactoryV3Profile;rpcUrl:string;neardataUrl:string;consumer:string;maxBlocksPerRun:number;childBlocks?:number;childConcurrency?:number};
/** One bounded public page and bounded, cursor-resuming scan for every child on it. */
export async function runFactoryCycle(pool:Pool,cfg:FactoryWorkerConfig,fromIndex:number, test?:{rpc:{rpc(method:string,params:unknown):Promise<unknown>};scan:(child:AdoptedChild,d:import('./config.js').DeploymentAllowlist,maxBlocks:number)=>Promise<import('./index.js').ScanResult>}){
 validateFactoryV3Profile(cfg.profile);if(!Number.isSafeInteger(fromIndex)||fromIndex<0)throw new Error('invalid factory page index');
 const rpc=test?.rpc??new NearRpcClient(cfg.rpcUrl), proof=await discoverFactoryChildren(rpc,{factoryId:cfg.profile.factoryId,factoryCodeHash:cfg.profile.factoryCodeHash,mode:'global',leafProfile:'atomic-v3',v3:cfg.profile,fromIndex});
 // Prove/adopt the whole page before scanning so page index never advances on failure.
 for(const child of proof.children)await adoptFactoryChild(pool,child);
 const childBlocks=Math.min(cfg.maxBlocksPerRun,cfg.childBlocks??8);if(!Number.isSafeInteger(childBlocks)||childBlocks<1||childBlocks>64)throw new Error('invalid child scan bound');const shared=sharedFactorySources(makeBlockSource(cfg.neardataUrl),makeCanonicalVerifier(cfg.rpcUrl)),blockSource=shared.source,verifier=shared.canonical,live=makeLiveChain(cfg.rpcUrl),results=[];
 async function scanChild(child:AdoptedChild){const started=Date.now();try{const d=deploymentForAdoptedChild(child);let scan;if(test)scan=await test.scan(child,d,childBlocks);else {const store=new WorkerStore(pool,d,cfg.consumer,live,verifier),deployment=await store.resolveDeployment();await store.verifyLiveIdentity();const nextHeight=await store.resolveStartHeight(deployment.id,deployment.startBlock);scan=await runBoundedScan({store,blockSource,verifier,deploymentId:deployment.id,nextHeight,maxBlocks:childBlocks,prefetchNext:true,sourceAvailabilityBound:true});}const result={contractId:child.contractId,startHeight:child.startHeight,scan};console.error(JSON.stringify({kind:'factory_child_scan',contractId:child.contractId,startHeight:scan.startHeight,endHeight:scan.endHeight,blocksIngested:scan.blocksIngested,elapsedMs:Date.now()-started}));return result;}catch(e){console.error(JSON.stringify({kind:'factory_child_error',contractId:child.contractId,...safeFactoryError(e,cfg.rpcUrl),elapsedMs:Date.now()-started}));return {contractId:child.contractId,startHeight:child.startHeight,scan:null};}}
 const concurrency=cfg.childConcurrency??3;if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>3)throw new Error('invalid child concurrency');
 for(let index=0;index<proof.children.length;index+=concurrency)results.push(...await Promise.all(proof.children.slice(index,index+concurrency).map(scanChild)));
 return {blockHash:proof.blockHash,blockHeight:proof.blockHeight,nextIndex:proof.nextIndex,results};
}
