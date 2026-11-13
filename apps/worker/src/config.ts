// Worker configuration. Fixed server-side policy; no secrets live here.
//
// Fail-closed: the worker refuses to start unless the network/deployment
// allowlist is explicit and consistent with the database `deployments` row and
// the live chain identity (see store.verifyDeploymentIdentity). No inferred
// network, deployment, token, or start height is ever accepted.

export interface DeploymentAllowlist {
  environment: 'testnet' | 'mainnet' | 'local';
  network: string;
  contractId: string;
  ftContractId: string;
  ftDecimals: number;
  /** base58 NEAR account code hash (from RPC `code_hash`). */
  codeHash: string;
  /** hex sha256 of the deployed Wasm (independent cross-check of codeHash). */
  wasmSha256: string;
  /** immutable event organizer (from `new(organizer, ...)`). */
  organizer: string;
  /** immutable policy version (from `new(..., policy_version)`). */
  policyVersion: string;
  /** explicit start height (must be >= deployments.start_block). */
  startHeight: number;
  /** Explicit mock provider identity for the reviewed candidate adapter. */
  candidateProviderAccount?: string;
  adapter?: 'multievent-v1';
  /** Set only by the final-chain factory discovery path, never from an environment variable. */
  verifiedFactoryId?: string;
}

export interface WorkerConfig {
  nebula: 'testnet' | 'mainnet';
  /** NEAR JSON-RPC base URL (views, hash->height, account code hash). */
  rpcUrl: string;
  /** FASTNEAR NEAR Data base URL. */
  neardataUrl: string;
  /** worker_cursors.consumer value. */
  consumer: string;
  /** hard bound: max blocks ingested per single run (bounded runnable worker). */
  maxBlocksPerRun: number;
  /** Deployment allowlist (exactly one from config). */
  deployment: DeploymentAllowlist;
  /** optional PostgreSQL connection string (fallback when no SHOWSTAKE_PG_SOCKET). */
  databaseUrl: string | null;
}

export const WORKER_DB_ROLE = 'showstake_worker';

const N = (v: string | undefined, d: number): number => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return d;
  return Math.floor(n);
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const network = env.WORKER_NETWORK ?? '';
  if (network !== 'testnet' && network !== 'mainnet') {
    throw new Error(`WORKER_NETWORK must be testnet or mainnet; got ${JSON.stringify(network)}`);
  }
  const environment = env.WORKER_ENVIRONMENT ?? '';
  if (environment !== network) {
    throw new Error(`WORKER_ENVIRONMENT must match WORKER_NETWORK; got ${JSON.stringify(environment)}`);
  }
  const contractId = env.WORKER_CONTRACT_ID ?? '';
  const ftContractId = env.WORKER_FT_CONTRACT_ID ?? '';
  const codeHash = env.WORKER_CODE_HASH ?? '';
  const wasmSha256 = env.WORKER_WASM_SHA256 ?? '';
  const organizer = env.WORKER_ORGANIZER ?? '';
  const policyVersion = env.WORKER_POLICY_VERSION ?? '';
  const candidateProviderAccount = env.WORKER_CANDIDATE_PROVIDER_ACCOUNT ?? '';
  if (['showstake-native-usdc-event/1','showstake-native-usdc-rhea-review/1','showstake-native-usdc-rhea-linked-withdraw-review/2'].includes(policyVersion) && !candidateProviderAccount) throw new Error('WORKER_CANDIDATE_PROVIDER_ACCOUNT is required');
  if (!contractId) throw new Error('WORKER_CONTRACT_ID is required (allowlisted event contract)');
  if (!ftContractId) throw new Error('WORKER_FT_CONTRACT_ID is required (canonical FT)');
  if (!codeHash) throw new Error('WORKER_CODE_HASH is required (base58 contract code hash)');
  if (!wasmSha256) throw new Error('WORKER_WASM_SHA256 is required (hex wasm sha256)');
  if (!organizer && policyVersion !== 'showstake-native-usdc-multievent/1') throw new Error('WORKER_ORGANIZER is required (immutable event organizer)');
  if (!policyVersion) throw new Error('WORKER_POLICY_VERSION is required (immutable policy version)');

  if (policyVersion === 'showstake-native-usdc-multievent/1' && (env.WORKER_ADAPTER !== 'multievent-v1' || !candidateProviderAccount)) throw new Error('multi-event adapter and provider must be explicitly configured');
  if (env.WORKER_ADAPTER && env.WORKER_ADAPTER !== 'multievent-v1') throw new Error('unknown worker adapter');
  if (env.WORKER_ADAPTER === 'multievent-v1' && policyVersion !== 'showstake-native-usdc-multievent/1') throw new Error('multi-event policy mismatch');
  const ftDecimalsRaw = env.WORKER_FT_DECIMALS ?? '';
  if (!/^[0-9]+$/.test(ftDecimalsRaw)) throw new Error('WORKER_FT_DECIMALS is required (0..38)');
  const ftDecimals = Number(ftDecimalsRaw);
  if (!Number.isInteger(ftDecimals) || ftDecimals < 0 || ftDecimals > 38) {
    throw new Error(`WORKER_FT_DECIMALS must be 0..38; got ${ftDecimalsRaw}`);
  }
  const startHeightRaw = env.WORKER_START_HEIGHT ?? '';
  if (!/^[0-9]+$/.test(startHeightRaw)) throw new Error('WORKER_START_HEIGHT is required (>= deployments.start_block)');
  const startHeight = Number(startHeightRaw);
  if (!Number.isSafeInteger(startHeight) || startHeight < 0) {
    throw new Error(`WORKER_START_HEIGHT must be a non-negative safe integer; got ${startHeightRaw}`);
  }

  if (network === 'mainnet' && env.WORKER_ADAPTER !== 'multievent-v1' && (contractId !== 'showstake-mainnet-escrow-endpx-2026.near' || ftContractId !== '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1' || ftDecimals !== 6 || codeHash !== 'CpnhymSeF785ZBVTaBZfW8ApsfMVUByNCrys8R2i8os' || wasmSha256 !== '03076c4a9496e8ae1e6af68c791752d4a7220597942effd0c3a1839a252be9d2' || policyVersion !== 'showstake-native-usdc-rhea-review/1' || candidateProviderAccount !== 'contract.main.burrow.near')) throw new Error('unreviewed mainnet deployment');
  return {
    nebula: network,
    rpcUrl: env.WORKER_RPC_URL || `https://rpc.${network}.near.org`,
    neardataUrl: env.WORKER_NEARDATA_URL || `https://${network}.neardata.xyz`,
    consumer: env.WORKER_CONSUMER || 'showstake-worker',
    maxBlocksPerRun: N(env.WORKER_MAX_BLOCKS_PER_RUN, 1000),
    deployment: {
      environment,
      network,
      contractId,
      ftContractId,
      ftDecimals,
      codeHash,
      wasmSha256,
      organizer,
      policyVersion,
      startHeight,
      candidateProviderAccount: candidateProviderAccount || undefined,
      adapter: env.WORKER_ADAPTER === 'multievent-v1' ? 'multievent-v1' : undefined,
    },
    databaseUrl: env.DATABASE_URL ?? null,
  };
}
