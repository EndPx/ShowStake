// Runnable worker CLI (bounded). Resolves the allowlisted deployment, verifies
// live/DB identity, then ingests finalized blocks from the durable cursor with
// mandatory official-RPC canonical/finality verification.
//
//   pnpm --filter @showstake/worker build
//   pnpm --filter @showstake/worker start          # one bounded scan (testnet)
import { loadConfig, loadFactoryConfig } from './config.js';
import { makeBlockSource, makeCanonicalVerifier, makeLiveChain, runBoundedScan, runWorkerCycles, workerConnectConfig } from './index.js';
import { runFactoryCycle } from './factory-worker.js';
import { createWorkerPool, WorkerStore, assertWorkerLeastPrivilege } from './store.js';

async function main(): Promise<void> {
  const factoryMode=process.env.WORKER_MODE==='factory';if(process.env.WORKER_MODE&&process.env.WORKER_MODE!=='factory'&&process.env.WORKER_MODE!=='single')throw new Error('unknown WORKER_MODE');
  const factoryCfg=factoryMode?loadFactoryConfig():null;const cfg=factoryMode?null:loadConfig();
  const args=process.argv.slice(2);if(args.some(a=>a!=='--watch'&&a!=='--once') || (args.includes('--watch')&&args.includes('--once')))throw new Error('use --watch or --once');
  const watch=args.includes('--watch'),interval=Number(process.env.WORKER_WATCH_INTERVAL_MS ?? '5000');
  if(!Number.isSafeInteger(interval)||interval<5000||interval>300000)throw new Error('WORKER_WATCH_INTERVAL_MS must be 5000..300000');
  let stopping=false,wake:(()=>void)|null=null;
  const stop=()=>{stopping=true;wake?.();};process.on('SIGINT',stop);process.on('SIGTERM',stop);
  const pool = createWorkerPool(workerConnectConfig((factoryCfg??cfg)!.databaseUrl) as import('pg').PoolConfig);
  try {
    await assertWorkerLeastPrivilege(pool);
    if(factoryCfg){let page=factoryCfg.fromIndex;await runWorkerCycles(async()=>{const result=await runFactoryCycle(pool,factoryCfg,page);page=result.nextIndex??0;console.log(JSON.stringify({ok:result.results.every(x=>x.scan!==null),mode:'factory',...result}));if(result.results.some(x=>x.scan===null))throw new Error('one or more child scans failed; cursors remain durable');return result.nextIndex!==null||result.results.some(x=>(x.scan?.blocksIngested??0)>0);},watch,()=>stopping,()=>new Promise<void>(resolve=>{const timer=setTimeout(()=>{wake=null;resolve();},interval);wake=()=>{clearTimeout(timer);wake=null;resolve();};}),message=>console.error('factory worker cycle failed:',message));return;}
    if(!cfg)throw new Error('single config missing');const verifier=makeCanonicalVerifier(cfg.rpcUrl),blockSource=makeBlockSource(cfg.neardataUrl);
    const store = new WorkerStore(pool, cfg.deployment, cfg.consumer, makeLiveChain(cfg.rpcUrl), verifier);
    await runWorkerCycles(async()=>{
    const deployment = await store.resolveDeployment();
    await store.verifyLiveIdentity();
    const nextHeight = await store.resolveStartHeight(deployment.id, deployment.startBlock);
    const result = await runBoundedScan({
      store,
      blockSource,
      verifier,
      deploymentId: deployment.id,
      nextHeight,
      maxBlocks: cfg.maxBlocksPerRun,
      prefetchNext:true,
      sourceAvailabilityBound:true,
      log: (m) => console.error(m),
    });
    console.log(JSON.stringify({ ok: true, network: cfg.nebula, contract: cfg.deployment.contractId, ...result }, null, 2));
    return result.blocksIngested>0;
    },watch,()=>stopping,()=>new Promise<void>(resolve=>{const timer=setTimeout(()=>{wake=null;resolve();},interval);wake=()=>{clearTimeout(timer);wake=null;resolve();};}),message=>console.error('worker cycle failed:',message));
  } finally {
    process.off('SIGINT',stop);process.off('SIGTERM',stop);
    await pool.end();
  }
}

main().catch((e) => {
  console.error('worker FATAL:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
