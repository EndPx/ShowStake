// No credential values, signatures or cookies are emitted by this check.
const fs = require('node:fs');
function env(file) { return Object.fromEntries(fs.readFileSync(file,'utf8').split(/\r?\n/).filter(x=>x&&!x.startsWith('#')).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)];})); }
(async()=>{
  const api = env('/etc/showstake/api.env'), worker = env('/etc/showstake/worker.env');
  const apiDb = await import('/opt/showstake/current/apps/api/dist/db.js');
  const workerDb = await import('/opt/showstake/current/apps/worker/dist/store.js');
  const apiPool = apiDb.createScopedPool({connectionString:api.DATABASE_URL,connectionTimeoutMillis:10000},'showstake_api');
  const workerPool = workerDb.createWorkerPool({connectionString:worker.DATABASE_URL,connectionTimeoutMillis:10000});
  try {
    await apiDb.assertRuntimeLeastPrivilege(apiPool,'showstake_api');
    await workerDb.assertWorkerLeastPrivilege(workerPool);
    const a=(await apiPool.query('SELECT current_user,session_user')).rows[0];
    const w=(await workerPool.query('SELECT current_user,session_user')).rows[0];
    const versions=(await apiPool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(x=>x.version);
    if(JSON.stringify(versions)!=='[1,2,3,4,5,6,7,8]')throw Error('Migration mismatch');
    const baseline=JSON.parse(fs.readFileSync('/var/lib/showstake/chain-baseline.json'));
    const cursors=(await workerPool.query('SELECT consumer,cursor_value,updated_at FROM worker_cursors WHERE deployment_id=$1',[baseline.deploymentId])).rows;
    const events=(await apiPool.query('SELECT count(*)::integer AS n FROM events_projection')).rows[0].n;
    const sessions=(await apiPool.query('SELECT count(*)::integer AS n FROM sessions')).rows[0].n;
    if(events!==0)throw Error('Unexpected event projection');
    const result={classification:'PASS_LIVE',scope:'VPS PostgreSQL and runtime identity; empty mainnet baseline only, no financial lifecycle',observedAt:new Date().toISOString(),apiRole:a,workerRole:w,leastPrivilege:true,migrations:versions,baseline,cursors,projectedEvents:events,sessionRows:sessions,financialTransactions:0};
    fs.writeFileSync('/var/lib/showstake/runtime-proof.json',JSON.stringify(result,null,2)+'\n',{mode:0o644});
    console.log(JSON.stringify({leastPrivilege:true,migrations:versions.length,events,cursor:cursors[0]?.cursor_value??null}));
  } finally { await apiPool.end();await workerPool.end(); }
})().catch(error=>{console.error('Runtime acceptance failed:',error.code||error.message);process.exitCode=1;});
