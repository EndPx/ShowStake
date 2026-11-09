// Runnable worker CLI (bounded). Resolves the allowlisted deployment, verifies
// live/DB identity, then ingests finalized blocks from the durable cursor with
// mandatory official-RPC canonical/finality verification.
//
//   pnpm --filter @showstake/worker build
//   pnpm --filter @showstake/worker start          # one bounded scan (testnet)
import { loadConfig } from './config.js';
import { makeBlockSource, makeCanonicalVerifier, makeLiveChain, runBoundedScan, workerConnectConfig } from './index.js';
import { createWorkerPool, WorkerStore, assertWorkerLeastPrivilege } from './store.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const verifier = makeCanonicalVerifier(cfg.rpcUrl);
  const pool = createWorkerPool(workerConnectConfig(cfg.databaseUrl) as import('pg').PoolConfig);
  try {
    await assertWorkerLeastPrivilege(pool);
    const store = new WorkerStore(pool, cfg.deployment, cfg.consumer, makeLiveChain(cfg.rpcUrl), verifier);
    const deployment = await store.resolveDeployment();
    await store.verifyLiveIdentity();
    // Exact-start gate on a fresh cursor; resume from cursor+1 otherwise.
    const nextHeight = await store.resolveStartHeight(deployment.id, deployment.startBlock);
    const result = await runBoundedScan({
      store,
      blockSource: makeBlockSource(cfg.neardataUrl),
      verifier,
      deploymentId: deployment.id,
      nextHeight,
      maxBlocks: cfg.maxBlocksPerRun,
      log: (m) => console.error(m),
    });
    console.log(JSON.stringify({ ok: true, network: cfg.nebula, contract: cfg.deployment.contractId, ...result }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('worker FATAL:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
