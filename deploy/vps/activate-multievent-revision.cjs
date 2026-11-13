// Operator-only activation of the verified empty legacy -> CREATE upgrade.
// No signer, wallet keys, asset transfers or blockchain write calls are used.
const fs=require('node:fs'),crypto=require('node:crypto');
const {Pool}=require('/opt/showstake/current/node_modules/pg');
const contract='showstake-mainnet-escrow-endpx-2026.near';
const codeHash='EUA9Rm9RvU6SwDbkAsqosP9JCSD4qBRhe75p5PnapdyY',oldHash='CpnhymSeF785ZBVTaBZfW8ApsfMVUByNCrys8R2i8os';
const wasm='c81cf3d7293c111fc29c930ac19f94d3c88cdcf4d7dcf70a73f73911c87999e7',policy='showstake-native-usdc-multievent/1';
const start=224402760,blockHash='EgDLaFEjAdotQT6RLm5yffUVoM2EjrWkfwpWrRdrmPp7',tx='Cpb4sh2B2ASAfLEQouz3sPq9DqN3JYsfJoiXxogqr3BJ';
const consumer='showstake-multievent-create-v1';
const env=p=>Object.fromEntries(fs.readFileSync(p,'utf8').split(/\r?\n/).filter(x=>x&&!x.startsWith('#')).map(x=>{const i=x.indexOf('=');return[x.slice(0,i),x.slice(i+1)];}));
const operator=env('/etc/showstake/operator.env'),pool=new Pool({connectionString:operator.DATABASE_URL,connectionTimeoutMillis:10000});
const assert=(x,m)=>{if(!x)throw Error(m);};
async function rpc(method,params){const r=await fetch('https://free.rpc.fastnear.com',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'activate-create-revision-read-only',method,params}),signal:AbortSignal.timeout(15000)});const b=await r.json();assert(r.ok&&!b.error&&b.result,'RPC unavailable');return b.result;}
async function verifyUpgradeBlock(){const q=await rpc('query',{request_type:'view_account',account_id:contract,block_id:blockHash});assert(q.code_hash===codeHash&&q.block_height===start&&q.block_hash===blockHash,'upgrade identity mismatch');const a=await rpc('query',{request_type:'call_function',account_id:contract,block_id:blockHash,method_name:'get_accounting',args_base64:'e30='});const v=JSON.parse(Buffer.from(a.result).toString());assert(a.block_hash===blockHash&&Object.entries(v).every(([k,n])=>k==='global_operation'?n===null:n==='0'),'nonempty upgrade witness');}
function setEnv(p,entries){const archive='/etc/showstake/revision-backups';fs.mkdirSync(archive,{recursive:true,mode:0o700});const backup=archive+'/'+p.split('/').pop()+'.'+Date.now();fs.copyFileSync(p,backup,fs.constants.COPYFILE_EXCL);fs.chmodSync(backup,0o600);let text=fs.readFileSync(p,'utf8');for(const[k,v]of Object.entries(entries)){const re=new RegExp('^'+k+'=.*$','m');text=re.test(text)?text.replace(re,k+'='+v):text.trimEnd()+'\n'+k+'='+v+'\n';}const temp=p+'.new-'+crypto.randomUUID();fs.writeFileSync(temp,text,{mode:0o600,flag:'wx'});fs.renameSync(temp,p);}
(async()=>{
 await verifyUpgradeBlock();
 const c=await pool.connect();let snapshot;
 try{await c.query('BEGIN');const row=(await c.query('SELECT * FROM deployments WHERE network=$1 AND contract_id=$2 FOR UPDATE',['mainnet',contract])).rows[0];assert(row,'deployment row missing');
  if(row.code_hash===codeHash&&Number(row.start_block)===start){const audit=(await c.query("SELECT details FROM audit_records WHERE action='DEPLOYMENT_REVISION_ACTIVATED' AND resource_id=$1 AND details->>'transactionHash'=$2 ORDER BY created_at DESC LIMIT 1",[row.id,tx])).rows[0];assert(audit,'activation audit missing');snapshot=audit.details;}
  else {assert(row.code_hash===oldHash,'unexpected prior deployment');const counts=(await c.query('SELECT (SELECT count(*)::int FROM events_projection WHERE deployment_id=$1) AS events,(SELECT count(*)::int FROM chain_events WHERE deployment_id=$1) AS receipts',[row.id])).rows[0];assert(counts.events===0&&counts.receipts===0,'legacy projection is not empty');const cursors=(await c.query('SELECT consumer,cursor_value,updated_at FROM worker_cursors WHERE deployment_id=$1',[row.id])).rows;
   snapshot={transactionHash:tx,oldDeployment:row,oldCursors:cursors,newRevision:{codeHash,wasmSha256:wasm,policy,startBlock:start,blockHash,consumer},reason:'Verified empty legacy revision retired; old cursor rows retained; new consumer starts at actual upgrade block'};
   await c.query('UPDATE deployments SET code_hash=$2,start_block=$3 WHERE id=$1',[row.id,codeHash,start]);
   await c.query('INSERT INTO audit_records(id,actor_account,action,resource_type,resource_id,request_id,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',[crypto.randomUUID(),contract,'DEPLOYMENT_REVISION_ACTIVATED','deployment',row.id,tx,JSON.stringify(snapshot)]);
  }
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 setEnv('/etc/showstake/worker.env',{WORKER_CODE_HASH:codeHash,WORKER_WASM_SHA256:wasm,WORKER_ORGANIZER:'',WORKER_POLICY_VERSION:policy,WORKER_ADAPTER:'multievent-v1',WORKER_START_HEIGHT:String(start),WORKER_CONSUMER:consumer});
 setEnv('/etc/showstake/api.env',{ACCESS_CONTRACT_ABIS:'mainnet:'+contract+'=multievent-v1',ACCESS_CONTRACT_CODE_HASHES:'mainnet:'+contract+'='+codeHash});
 const baselinePath='/var/lib/showstake/chain-baseline.json',baseline=JSON.parse(fs.readFileSync(baselinePath));const previous=baseline.previousRevision??baseline;
 fs.writeFileSync(baselinePath,JSON.stringify({...baseline,codeHash,wasmSha256:wasm,policyVersion:policy,startHeight:start,blockHash,consumer,upgradeTransaction:tx,previousRevision:previous},null,2)+'\n',{mode:0o644});
 fs.writeFileSync('/var/lib/showstake/multievent-revision-proof.json',JSON.stringify({classification:'PASS_LIVE',scope:'Operator metadata activation for verified CREATE revision; no chain transaction',observedAt:new Date().toISOString(),...snapshot,oldCursorDeleted:false,oldCursorReset:false},null,2)+'\n',{mode:0o644});
 console.log(JSON.stringify({classification:'PASS_LIVE',contract,codeHash,start,consumer,oldCursorPreserved:true}));
})().catch(e=>{console.error('Revision activation stopped: '+(e.code||e.name));process.exitCode=1;}).finally(()=>pool.end());
