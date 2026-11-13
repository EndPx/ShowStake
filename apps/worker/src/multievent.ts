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
  const cfg=object(await read('get_config',{}));
  if(cfg.policy_version!==d.policyVersion||cfg.network!==d.network||cfg.canonical_ft!==d.ftContractId||cfg.provider_account!==d.candidateProviderAccount||cfg.provider_kind!==(d.network==='mainnet'?'RHEA_MAINNET':'MOCK_TESTNET')||cfg.token_decimals!==d.ftDecimals||cfg.token_symbol!=='USDC'||typeof cfg.token_name!=='string'||!cfg.token_name)throw new Error('multi-event config mismatch');
  const events:CandidateEvent[]=[];
  for(let from=0;;from+=50){const page=await read('list_events',{from_index:from,limit:50});if(!Array.isArray(page)||page.length>50)throw new Error('invalid event page');for(const item of page){const e=parseCandidateEvent(item,d);if(!e||events.some(x=>x.rules.eventId===e.rules.eventId))throw new Error('duplicate event'); const exact=parseCandidateEvent(await read('get_event',{event_id:e.rules.eventId}),d);if(!exact||JSON.stringify(exact)!==JSON.stringify(e))throw new Error('event view mismatch');events.push(e);}if(page.length<50)break;}
  const result:MultiSnapshot[]=[]; const sums:Record<string,bigint>={accepted_principal:0n,realized_yield:0n,allocated_yield:0n,paid:0n,pending:0n,liability:0n,reserved_cash:0n};
  for(const event of events){const registrations:CandidateRegistration[]=[];for(let from=0;from<event.count;from+=50){const page=await read('list_event_registrations',{event_id:event.rules.eventId,from,limit:50});if(!Array.isArray(page)||page.length!==Math.min(50,event.count-from))throw new Error('incomplete registration page');for(const item of page){const r=parseCandidateRegistration(item,event,registrations.length);validateCandidatePass(await read('get_pass',{pass_id:r.passId}),r,d);const single=await read('get_registration',{registration_id:r.registrationId});if(JSON.stringify(single)!==JSON.stringify(item))throw new Error('registration view mismatch');registrations.push(r);}}
    for(const key of ['registrationId','passId','participant','commitmentId'] as const)if(new Set(registrations.map(r=>r[key])).size!==registrations.length)throw new Error('duplicate registration');
    const raw=object(await read('get_event_totals',{event_id:event.rules.eventId})); if(raw.event_id!==event.rules.eventId)throw new Error('totals event mismatch');const totals:Record<string,bigint>={};for(const k of Object.keys(sums)){totals[k]=atomic(raw[k]);sums[k]=sums[k]!+totals[k]!;}
    const paid=registrations.reduce((n,r)=>n+(r.claim==='Paid'?BigInt(r.claimAmount):0n),0n), pending=registrations.reduce((n,r)=>n+(r.claim==='Pending'?BigInt(r.claimAmount):0n),0n);
    if(totals.accepted_principal!==BigInt(event.accepted)||totals.realized_yield!==BigInt(event.realizedYield)||totals.allocated_yield!==BigInt(event.allocatedYield)||totals.paid!==paid||totals.pending!==pending||totals.liability!==BigInt(event.accepted)+BigInt(event.allocatedYield)-paid-pending)throw new Error('event ledger mismatch');
    if(event.phase==='Settled'&&registrations.reduce((n,r)=>n+BigInt(r.claimAmount),0n)!==BigInt(event.accepted)+BigInt(event.allocatedYield))throw new Error('settlement mismatch');result.push({event,registrations,totals});
  }
  const global=object(await read('get_accounting',{}));for(const k of Object.keys(sums))if(atomic(global[k])!==sums[k])throw new Error('global ledger mismatch');
  if(global.global_operation!==null)throw new Error('provider operation unavailable pending proof');
  if(atomic(await read('ft_balance_of',{account_id:d.contractId},d.ftContractId))<sums.reserved_cash!)throw new Error('aggregate reserved cash uncovered');
  return result;
}
