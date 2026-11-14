const { createRequire } = require('node:module');
const { Pool } = createRequire('/opt/showstake-testnet/release/package.json')('pg');
if (process.getuid?.() !== 0 || !/^postgresql:\/\/showstake_operator:[0-9a-f]{64}@127\.0\.0\.1:55442\/showstake$/.test(process.env.DATABASE_URL || '')) throw Error('isolated operator URL required');
const pin = ['testnet','ss-fac-c1113232934.testnet','ENvY3jqpnMWnmQEBRjcvQkuJvELYMLkkqTC9wRBPjZ9J','CNuCzGqyU6Ypoz8qFtUvHKBESsEmppu4MW93WiZk6Au7','a90cc890fbda1d8e7166697551693de684a264b1a3bc86ff098f59371033514a','showstake-native-usdc-event/1','mockusdc.testnet',6,'ss-prov-b1113232402.testnet','MOCK_TESTNET',true];
(async () => {
 const pool = new Pool({connectionString:process.env.DATABASE_URL}); const client = await pool.connect();
 try {
  await client.query('BEGIN');
  await client.query(`INSERT INTO factory_deployment_allowlist(network,factory_account,factory_code_hash,leaf_code_hash,leaf_wasm_sha256,leaf_policy_version,canonical_ft,ft_decimals,provider_account,provider_kind,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (network,factory_account) DO NOTHING`,pin);
  const res = await client.query('SELECT network,factory_account,factory_code_hash,leaf_code_hash,leaf_wasm_sha256,leaf_policy_version,canonical_ft,ft_decimals,provider_account,provider_kind,enabled FROM factory_deployment_allowlist WHERE network=$1 AND factory_account=$2 FOR UPDATE',pin.slice(0,2));
  if (res.rowCount !== 1 || JSON.stringify(Object.values(res.rows[0])) !== JSON.stringify(pin)) throw Error('existing factory trust identity mismatch; no changes committed');
  await client.query('COMMIT'); console.log('Testnet factory trust row verified; no child or cursor created.');
 } catch(e) { await client.query('ROLLBACK'); throw e; } finally {client.release(); await pool.end();}
})().catch(e => { console.error('Factory seed failed:',e.message); process.exitCode=1; });
