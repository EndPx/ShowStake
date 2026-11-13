import type { FunctionCallAction } from './actions.ts';

/** Populated only after the shared contract and its deployed code are reviewed. */
export interface MultiEventRelease {
  network: 'mainnet' | 'testnet'; contract: string; codeHash: string;
  canonicalFt: string; policy: string;
}
export const MULTI_EVENT_RELEASE: MultiEventRelease | null = Object.freeze({
  network:'mainnet',
  contract:'showstake-mainnet-escrow-endpx-2026.near',
  codeHash:'EUA9Rm9RvU6SwDbkAsqosP9JCSD4qBRhe75p5PnapdyY',
  canonicalFt:'17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  policy:'showstake-native-usdc-multievent/1',
});
export interface MultiEventView {
  event_id: string; organizer: string; canonical_ft: string; policy_version: string;
  phase: string; earn_state: string; deposit: string; reg_open: number; reg_close: number;
  checkin_open: number; checkin_close: number; finalize_deadline: number;
}
export interface MultiRegistration { registration_id: string; event_id: string; beneficiary: string; claim: string; claim_amount: string; amount: string; attendance?: string }
const atomic = (x: unknown): x is string => typeof x === 'string' && /^(0|[1-9][0-9]*)$/.test(x) && BigInt(x) < 2n ** 128n;
const id = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(x);
const call = (methodName: string, args: Record<string, unknown>, deposit = '0'): FunctionCallAction => ({type:'FunctionCall',params:{methodName,args,gas:'300000000000000',deposit}});

export function multiEventIdentity(release: MultiEventRelease | null, observed: {network:string;contract:string;codeHash:string;canonicalFt:string;policy:string}, event?: MultiEventView): boolean {
  return !!release && (release.network!=='mainnet' || release.canonicalFt==='17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1') && !!release.contract && !!release.codeHash && !!release.canonicalFt && !!release.policy && release.network===observed.network && release.contract===observed.contract && release.codeHash===observed.codeHash && release.canonicalFt===observed.canonicalFt && release.policy===observed.policy && (!event || id(event.event_id) && !!event.organizer && event.canonical_ft===release.canonicalFt && event.policy_version===release.policy);
}

/** Build only the event-scoped ABI; authorization and final-block preflight are separate. */
export function multiEventAction(method: string, eventId: string, registrationId?: string, attended?: boolean): FunctionCallAction {
  if (!id(eventId)) throw Error('Invalid event ID');
  if (method==='mark_attendance') { if(!id(registrationId)||typeof attended!=='boolean') throw Error('Invalid attendance'); return call(method,{registration_id:registrationId,attended}); }
  if (method==='claim') { if(!id(registrationId)) throw Error('Invalid registration'); return call(method,{registration_id:registrationId},'1'); }
  if (['close_registration','trigger_earn_supply','reconcile_earn','finalize_attendance','trigger_earn_redeem','settle','cancel_event','activate_timeout_refund'].includes(method)) return call(method,{event_id:eventId});
  throw Error('Unsupported multi-event action');
}
export function multiEventTransfer(contract: string, event: MultiEventView, commitmentId: string): FunctionCallAction {
  if (!contract || !id(event.event_id) || !/^[A-Za-z0-9_-]{1,64}$/.test(commitmentId) || !atomic(event.deposit) || event.deposit==='0') throw Error('Invalid transfer');
  return call('ft_transfer_call',{receiver_id:contract,amount:event.deposit,msg:JSON.stringify({version:1,event_id:event.event_id,commitment_id:commitmentId})},'1');
}
/** Fail closed for pooled provider operations until its release is accepted. */
export function multiEventAllowed(method:string,event:MultiEventView,account:string,now:number,registration?:MultiRegistration):boolean {
  if(!id(event.event_id)||!account||!Number.isSafeInteger(now))return false;
  if(method==='claim') return !!registration && registration.event_id===event.event_id && registration.beneficiary===account && (event.phase==='Settled' ? registration.claim==='Claimable' && atomic(registration.claim_amount) && registration.claim_amount!=='0' : ['Cancelled','RefundOnly'].includes(event.phase) && ['NotStarted','Redeemed'].includes(event.earn_state) && ['None','Claimable'].includes(registration.claim) && atomic(registration.amount) && registration.amount!=='0');
  if(method==='activate_timeout_refund')return ['RegistrationOpen','RegistrationClosed'].includes(event.phase)&&now>=event.finalize_deadline;
  if(account!==event.organizer)return false;
  if(method==='mark_attendance')return !!registration && registration.event_id===event.event_id && event.phase==='RegistrationClosed' && now>=event.checkin_open && now<event.checkin_close;
  if(method==='close_registration')return event.phase==='RegistrationOpen'&&now>=event.reg_close;
  if(method==='cancel_event')return ['RegistrationOpen','RegistrationClosed','AttendanceFinalized'].includes(event.phase);
  if(method==='finalize_attendance')return event.phase==='RegistrationClosed'&&event.earn_state==='Supplied'&&now>=event.checkin_close&&now<event.finalize_deadline;
  if(method==='settle')return event.phase==='AttendanceFinalized'&&event.earn_state==='Redeemed';
  return false;
}
