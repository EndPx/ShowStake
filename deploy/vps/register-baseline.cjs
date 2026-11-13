// Operator-only: register an independently verified empty mainnet baseline.
// No chain transaction, signer, synthetic event or cursor advancement.
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const requireAtRelease = require('node:module').createRequire('/opt/showstake/current/package.json');
const { Pool } = requireAtRelease('pg');
const contract = 'showstake-mainnet-escrow-endpx-2026.near';
const token = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const codeHash = 'CpnhymSeF785ZBVTaBZfW8ApsfMVUByNCrys8R2i8os';
const tokenHash = 'DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q';
const organizer = 'dc634c505ee6b86a9b615ed7ebef7fff6a235c3406163d35d4f0e60c576a27b5';
async function rpc(method, params) {
  const response = await fetch('https://rpc.mainnet.near.org', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'showstake-baseline', method, params }), signal: AbortSignal.timeout(12000) });
  const body = await response.json();
  if (!response.ok || body.error || !body.result) throw Error('Official RPC unavailable');
  return body.result;
}
(async () => {
  if (process.getuid?.() !== 0 || !process.env.DATABASE_URL) throw Error('Operator environment required');
  const header = (await rpc('block', { finality: 'final' })).header;
  const stamp = Number(BigInt(header.timestamp_nanosec) / 1000000n);
  if (!Number.isSafeInteger(header.height) || !Number.isSafeInteger(stamp) || Date.now() - stamp > 30000 || stamp > Date.now() + 5000) throw Error('Stale final block');
  async function query(account_id, args) {
    const result = await rpc('query', { account_id, ...args, block_id: header.hash });
    if (result.block_hash !== header.hash || result.block_height !== header.height) throw Error('Pinned block mismatch');
    return result;
  }
  async function view(account, method_name, args = {}) {
    const result = await query(account, { request_type: 'call_function', method_name, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
    return JSON.parse(Buffer.from(result.result).toString());
  }
  const [account, ftAccount, config, control, event, balance, metadata] = await Promise.all([
    query(contract, { request_type: 'view_account' }), query(token, { request_type: 'view_account' }), view(contract, 'get_config'), view(contract, 'get_rhea_control'), view(contract, 'get_event'), view(token, 'ft_balance_of', { account_id: contract }), view(token, 'ft_metadata'),
  ]);
  if (account.code_hash !== codeHash || ftAccount.code_hash !== tokenHash || config.organizer !== organizer || config.network !== 'mainnet' || config.canonical_ft !== token || config.policy_version !== 'showstake-native-usdc-rhea-review/1' || config.provider_account !== 'contract.main.burrow.near' || config.provider_kind !== 'RHEA_MAINNET' || event !== null || balance !== '0' || control.paused !== true || control.principal_cap !== '0' || metadata.decimals !== 6 || metadata.symbol !== 'USDC' || Date.now() - stamp > 30000) throw Error('Empty paused identity gate failed');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  let deployment;
  try {
    await client.query('BEGIN');
    const existing = await client.query("SELECT id,environment,code_hash,ft_contract_id,ft_decimals,start_block::text FROM deployments WHERE network='mainnet' AND contract_id=$1 FOR UPDATE", [contract]);
    if (existing.rows.length) {
      deployment = existing.rows[0];
      if (deployment.environment !== 'mainnet' || deployment.code_hash !== codeHash || deployment.ft_contract_id !== token || deployment.ft_decimals !== 6 || BigInt(deployment.start_block) > BigInt(header.height)) throw Error('Existing deployment mismatch');
    } else {
      deployment = { id: randomUUID(), start_block: String(header.height) };
      await client.query("INSERT INTO deployments(id,environment,network,contract_id,ft_contract_id,ft_decimals,start_block,code_hash) VALUES($1,'mainnet','mainnet',$2,$3,6,$4,$5)", [deployment.id, contract, token, header.height, codeHash]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); await pool.end(); }
  const envPath = '/etc/showstake/worker.env';
  if (fs.lstatSync(envPath).isSymbolicLink()) throw Error('Worker environment symlink rejected');
  const env = fs.readFileSync(envPath, 'utf8');
  const old = env.match(/^WORKER_START_HEIGHT=(.*)$/m)?.[1];
  if (old !== 'REPLACE_WITH_APPROVED_BASELINE_HEIGHT' && old !== deployment.start_block) throw Error('Refusing to reset worker start height');
  fs.writeFileSync(envPath, env.replace(/^WORKER_START_HEIGHT=.*$/m, `WORKER_START_HEIGHT=${deployment.start_block}`));
  const result = { classification: 'PASS_LIVE', scope: 'Read-only empty paused mainnet baseline; operator deployment metadata only, no fabricated event/receipt/cursor', observedAt: new Date().toISOString(), block: { hash: header.hash, height: header.height }, contract, codeHash, canonicalFt: token, tokenCodeHash: tokenHash, decimals: 6, escrowAtomic: balance, event, paused: control.paused, principalCapAtomic: control.principal_cap, deploymentId: deployment.id, startHeight: Number(deployment.start_block), historicalScope: 'Verified empty baseline; earlier deployment receipts remain separate evidence', blockchainTransactions: 0 };
  fs.writeFileSync('/var/lib/showstake/chain-baseline.json', JSON.stringify(result, null, 2) + '\n', { mode: 0o644 });
  console.log(JSON.stringify({ baselineRegistered: true, height: header.height, startHeight: Number(deployment.start_block), event: null }));
})().catch(error => { console.error('Baseline registration failed:', error.message); process.exitCode = 1; });
