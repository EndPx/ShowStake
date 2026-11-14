// Read-only by default. Broadcast requires --execute and a scoped operator approval file.
import {readFile} from 'node:fs/promises';
import {createRpcAdapter} from './rpc-adapter.mjs';
import {runOnce} from './runtime.mjs';
import {planCandidateAction} from './index.mjs';
const [configPath,journalPath,approvalPath,mode]=process.argv.slice(2);if(!configPath||!journalPath)throw Error('usage: node run.mjs config.json journal.json [approval.json --execute]');
const config=JSON.parse(await readFile(configPath,'utf8'));const approval=approvalPath?JSON.parse(await readFile(approvalPath,'utf8')):null;const adapter=createRpcAdapter({...config,approval});
if(mode!=='--execute'){const s=await adapter.snapshot(config.contractId);const call=planCandidateAction(s,s.blockTimeMs);console.log(JSON.stringify({status:'DRY_PLAN',call}));}else{if(!approval)throw Error('operator approval file required');const result=await runOnce({journalPath,adapter,config:{...config,approval}});console.log(JSON.stringify({status:result.status,operationId:result.operation?.id??null}));}
