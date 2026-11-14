import { isMulti, parseCandidateEvent, parseCandidateRegistration, validateCandidatePass } from './candidate.js';
import type { CandidateEvent, CandidateRegistration } from './candidate.js';
import type { DeploymentAllowlist } from './config.js';
import type { ShowStakeEvent } from './types.js';

const fields: Record<string, string[]> = {
  EventCreated:['event_id','organizer'], RegistrationClosed:['event_id'],
  RegistrationCommitted:['event_id','registration_id','pass_id','participant','beneficiary','commitment_id','amount','event_sequence'],
  AttendanceMarked:['event_id','registration_id','attended'], AttendanceFinalized:['event_id'],
  EventCancelled:['event_id'], RefundModeActivated:['event_id'], EventSettled:['event_id'],
  PayoutStarted:['event_id','registration_id','pass_id','attempt','amount'], PayoutSucceeded:['event_id','registration_id','pass_id','attempt','amount'], PayoutFailed:['event_id','registration_id','pass_id','attempt','amount'],
  RheaConfigured:['event_id','principal_cap','paused'],
};
const atomic = (v: unknown): bigint => { if(typeof v!=='string'||!/^(0|[1-9][0-9]*)$/.test(v)||BigInt(v)>=1n<<128n) throw new Error('multi-event invalid atomic value'); return BigInt(v); };
const object = (v: unknown): Record<string,unknown> => { if(!v||typeof v!=='object'||Array.isArray(v)) throw new Error('multi-event invalid object'); return v as Record<string,unknown>; };
export function parseMultiLogs(logs:string[]):ShowStakeEvent[] {
  const out:ShowStakeEvent[]=[];
  for(let i=0;i<logs.length;i++) {const raw=logs[i]!; if(!raw.startsWith('EVENT_JSON:')) continue;
    const x=object(JSON.parse(raw.slice(11))); if(x.standard!=='showstake') continue;
    if(x.version!=='1.0.0'||typeof x.event!=='string'||!fields[x.event]) throw new Error('unsupported multi-event log');
    const data=object(x.data), keys=fields[x.event]!;
    if(Object.keys(data).sort().join('|')!==[...keys].sort().join('|')) throw new Error('multi-event log fields mismatch');
    for(const [k,v] of Object.entries(data)) {if(['attended','paused'].includes(k)){if(typeof v!=='boolean')throw new Error('invalid log boolean');} else if(['attempt','event_sequence'].includes(k)){if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0)throw new Error('invalid log integer');} else if(['amount','principal_cap'].includes(k)){atomic(v);} else if(typeof v!=='string'||!v.length)throw new Error('invalid log identity');}
    out.push({logIndex:i,standard:'showstake',version:'1.0.0',event:x.event,data,raw});
  } return out;
}
export type MultiSnapshot = {event:CandidateEvent; registrations:CandidateRegistration[]; totals:Record<string,bigint>};
export async function readMultiSnapshot(d:DeploymentAllowlist, read:(method:string,args:unknown,account?:string)=>Promise<unknown>):Promise<MultiSnapshot[]> {
  if(!isMulti(d))throw new Error('multi-event profile not configured');
  const shared=d.adapter==='shared-yield-v2';
  const cfg=object(await read('get_config',{}));
  if(shared && cfg.schema_version!==2)throw new Error('shared yield schema mismatch');
  if(cfg.policy_version!==d.policyVersion||cfg.network!==d.network||cfg.canonical_ft!==d.ftContractId||cfg.provider_account!==d.candidateProviderAccount||cfg.provider_kind!==(d.network==='mainnet'?'RHEA_MAINNET':'MOCK_TESTNET')||cfg.token_decimals!==d.ftDecimals||cfg.token_symbol!=='USDC'||typeof cfg.token_name!=='string'||!cfg.token_name)throw new Error('multi-event config mismatch');
  const events:CandidateEvent[]=[];
  for(let from=0;;from+=50){const page=await read('list_events',{from_index:from,limit:50});if(!Array.isArray(page)||page.length>50)throw new Error('invalid event page');for(const item of page){const e=parseCandidateEvent(item,d);if(!e||events.some(x=>x.rules.eventId===e.rules.eventId))throw new Error('duplicate event'); const exact=parseCandidateEvent(await read('get_event',{event_id:e.rules.eventId}),d);if(!exact||JSON.stringify(exact)!==JSON.stringify(e))throw new Error('event view mismatch');events.push(e);}if(page.length<50)break;}
  const result:MultiSnapshot[]=[]; const sums:Record<string,bigint>={accepted_principal:0n,realized_yield:0n,allocated_yield:0n,paid:0n,pending:0n,liability:0n,reserved_cash:0n};
  for(const event of events){const registrations:CandidateRegistration[]=[];for(let from=0;from<event.count;from+=50){const page=await read('list_event_registrations',{event_id:event.rules.eventId,from,limit:50});if(!Array.isArray(page)||page.length!==Math.min(50,event.count-from))throw new Error('incomplete registration page');for(const item of page){const r=parseCandidateRegistration(item,event,registrations.length);validateCandidatePass(await read('get_pass',{pass_id:r.passId}),r,d);const single=await read('get_registration',{registration_id:r.registrationId});if(shared){const row=object(single);if(row.event_id!==event.rules.eventId)throw new Error('registration event mismatch');const {event_id: _eventId,...rest}=row;if(JSON.stringify(Object.entries(rest).sort(([a],[b])=>a.localeCompare(b)))!==JSON.stringify(Object.entries(object(item)).sort(([a],[b])=>a.localeCompare(b))))throw new Error('registration view mismatch');}else if(JSON.stringify(single)!==JSON.stringify(item))throw new Error('registration view mismatch');registrations.push(r);}}
    for(const key of ['registrationId','passId','participant','commitmentId'] as const)if(new Set(registrations.map(r=>r[key])).size!==registrations.length)throw new Error('duplicate registration');
    const raw=object(await read('get_event_totals',{event_id:event.rules.eventId})); if(shared&&Object.keys(raw).sort().join('|')!==['event_id',...Object.keys(sums)].sort().join('|'))throw new Error('event totals shape mismatch'); if(raw.event_id!==event.rules.eventId)throw new Error('totals event mismatch');const totals:Record<string,bigint>={};for(const k of Object.keys(sums)){totals[k]=atomic(raw[k]);sums[k]=sums[k]!+totals[k]!;}
    const paid=registrations.reduce((n,r)=>n+(r.claim==='Paid'?BigInt(r.claimAmount):0n),0n), pending=registrations.reduce((n,r)=>n+(r.claim==='Pending'?BigInt(r.claimAmount):0n),0n);
    if(totals.accepted_principal!==BigInt(event.accepted)||totals.realized_yield!==BigInt(event.realizedYield)||totals.allocated_yield!==BigInt(event.allocatedYield)||totals.paid!==paid||totals.pending!==pending||totals.liability!==BigInt(event.accepted)+BigInt(event.allocatedYield)-paid-pending)throw new Error('event ledger mismatch');
    if(event.phase==='Settled') {
      const pool=BigInt(event.accepted)+BigInt(event.allocatedYield);
      if(registrations.reduce((n,r)=>n+BigInt(r.claimAmount),0n)!==pool)throw new Error('settlement mismatch');
      if(shared){const attended=registrations.filter(r=>r.attendance==='Attended'), recipients=attended.length?attended:registrations;if(!recipients.length)throw new Error('settlement without registrations');const count=BigInt(recipients.length);for(const r of registrations){const i=recipients.indexOf(r), expected=i<0?0n:pool/count+(BigInt(i)<pool%count?1n:0n);if(BigInt(r.claimAmount)!==expected||(i<0&&r.claim!=='None')||(i>=0&&r.claim==='None'))throw new Error('settlement recipient mismatch');}}
    }
    result.push({event,registrations,totals});
  }
  if(shared) for(const key of ['registrationId','passId'] as const) { const ids=result.flatMap(x=>x.registrations.map(r=>r[key])); if(new Set(ids).size!==ids.length)throw new Error('cross-event duplicate registration'); }
  const global=object(await read('get_accounting',{}));for(const k of Object.keys(sums))if(atomic(global[k])!==sums[k])throw new Error('global ledger mismatch');
  let required=sums.reserved_cash!;
  if(shared){
    const vault=object(await read('get_vault',{}));
    if(Object.keys(vault).sort().join('|')!==['policy_version','schema_version','total_shares','strategy_cash','provider_shares','quarantined_provider_shares','provider_balance','operation','last_operation'].sort().join('|')||vault.policy_version!==d.policyVersion||vault.schema_version!==2||(vault.last_operation!==null&&typeof vault.last_operation!=='string'))throw new Error('vault identity mismatch');
    const totalShares=atomic(vault.total_shares), cash=atomic(vault.strategy_cash); const physicalShares=atomic(vault.provider_shares), quarantine=atomic(vault.quarantined_provider_shares); if(quarantine>physicalShares)throw new Error('vault quarantine exceeds provider shares'); atomic(vault.provider_balance);
    required+=cash;
    let shareSum=0n; const controls:Record<string,unknown>[]=[];
    for(const snap of result){
      const control=object(await read('get_rhea_control',{event_id:snap.event.rules.eventId}));
      if(Object.keys(control).sort().join('|')!==['paused','principal_cap','stage','event_shares','invested_principal','total_shares','strategy_cash','provider_balance','shortfall','last_operation','retry_after_block','pending','ambiguous'].sort().join('|')||typeof control.paused!=='boolean'||(control.last_operation!==null&&typeof control.last_operation!=='string'))throw new Error('vault control shape mismatch');
      const invested=atomic(control.invested_principal); if(invested>BigInt(snap.event.accepted))throw new Error('vault principal mismatch');
      if(atomic(control.total_shares)!==totalShares||atomic(control.strategy_cash)!==cash||typeof control.pending!=='boolean'||typeof control.ambiguous!=='boolean')throw new Error('vault control mismatch');
      const eventShares=atomic(control.event_shares); if((['NotStarted','SupplyPending','Redeemed'].includes(snap.event.earnState)&&eventShares!==0n)||(['Supplied','RedeemPending'].includes(snap.event.earnState)&&eventShares===0n))throw new Error('vault event shares mismatch');
      shareSum+=eventShares; atomic(control.shortfall); atomic(control.provider_balance); atomic(control.principal_cap);
      if(control.pending!==(vault.operation!==null)||atomic(control.provider_balance)!==atomic(vault.provider_balance))throw new Error('vault pending mismatch'); controls.push(control);
    }
    if(shareSum!==totalShares)throw new Error('vault shares mismatch');
    if(vault.operation===null){if(controls.some(c=>c.stage!==null||c.retry_after_block!==null||c.ambiguous!==false))throw new Error('vault idle control mismatch');if(global.global_operation!==null||result.some(x=>['SupplyPending','RedeemPending'].includes(x.event.earnState)))throw new Error('vault operation missing');}
    else {
      const op=object(vault.operation), keys=['event_id','attempt','kind','stage','baseline_ft','baseline_provider_shares','baseline_provider_value','amount','used','retry_after_block'];
      if(Object.keys(op).sort().join('|')!==keys.sort().join('|')||typeof op.event_id!=='string'||op.event_id!==global.global_operation||!Number.isSafeInteger(op.attempt)||(op.attempt as number)<0||!Number.isSafeInteger(op.retry_after_block)||(op.retry_after_block as number)<0||!['Supply','Redeem'].includes(String(op.kind))||!['Preparing','Dispatched','TerminalUsed','TerminalRefund','Ambiguous'].includes(String(op.stage)))throw new Error('vault operation invalid');
      for(const k of ['baseline_ft','baseline_provider_shares','baseline_provider_value','amount','used'])atomic(op[k]);
      if(controls.some(c=>c.stage!==op.stage||c.retry_after_block!==op.retry_after_block||c.ambiguous!==['Dispatched','Ambiguous'].includes(String(op.stage))))throw new Error('vault stage mismatch');
      const owner=result.find(x=>x.event.rules.eventId===op.event_id);
      if(!owner||owner.event.earnState!==(op.kind==='Supply'?'SupplyPending':'RedeemPending')||result.some(x=>x!==owner&&['SupplyPending','RedeemPending'].includes(x.event.earnState))||sums.pending!==0n)throw new Error('vault operation event mismatch');
      const amount=atomic(op.amount),used=atomic(op.used);
      if(op.stage==='Preparing' ? amount!==0n||used!==0n : amount===0n)throw new Error('vault operation amount mismatch');
      if(used>amount|| (op.stage==='TerminalUsed'&&op.kind==='Supply'&&used===0n) || (op.kind==='Redeem'&&used!==0n))throw new Error('vault operation used mismatch');
      if(op.kind==='Supply'&&['Dispatched','TerminalUsed','Ambiguous'].includes(String(op.stage))){const inFlight=op.stage==='TerminalUsed'?used:amount;if(inFlight>owner.totals.reserved_cash!)throw new Error('vault in-flight exceeds event reserve');required-=inFlight;}
    }
  }else if(global.global_operation!==null)throw new Error('provider operation unavailable pending proof');
  if(atomic(await read('ft_balance_of',{account_id:d.contractId},d.ftContractId))<required)throw new Error('aggregate reserved cash uncovered');
  return result;
}
