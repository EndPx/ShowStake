import { isReviewedTestnetStatic, type DeploymentAllowlist } from './config.js';
import { isVerifiedFactoryDeployment } from './factory.js';
import type { CommitData, PublishRules } from './types.js';
import { validateAccountIdShape } from '@showstake/domain';

// This adapter is tied to the reviewed testnet candidate bytecode, not merely its self-reported ABI.
export const isMulti = (d: DeploymentAllowlist): boolean => (d.adapter === 'multievent-v1' && d.policyVersion === 'showstake-native-usdc-multievent/1') || (d.adapter === 'shared-yield-v2' && d.policyVersion === 'showstake-native-usdc-shared-yield/2');
export const CANDIDATE_HASH = 'de868ccb9d3dbf64409b392ba7e58a38678321bef803d1d0779a3d8abec791ae';
export const MAINNET_CANDIDATE_HASH = '03076c4a9496e8ae1e6af68c791752d4a7220597942effd0c3a1839a252be9d2';
export const LINKED_CANDIDATE_HASH='49a591ba26a4a23d05c01cc343779f1c66aa5da0384e3a663a37f4e5edb59b70';
export const LINKED_CODE_HASH='5xVC9cyZDeCJXpS8rhD4Hh3tNMBB4MNnvh5eYpW9y5Aw';
export const LINKED_POLICY='showstake-native-usdc-rhea-linked-withdraw-review/2';
const isFactoryChild=(d:DeploymentAllowlist)=>!!d.verifiedFactoryId&&/^[a-f0-9]{16}$/.test(d.contractId.slice(0,16))&&d.contractId===d.contractId.slice(0,16)+'.'+d.verifiedFactoryId;
export const isLinkedCandidate=(d:DeploymentAllowlist):boolean=>isVerifiedFactoryDeployment(d)&&d.policyVersion==='showstake-native-usdc-factory-rhea/3'&&d.environment==='mainnet'&&d.network==='mainnet'&&isFactoryChild(d)&&d.ftContractId==='17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'&&d.ftDecimals===6&&d.candidateProviderAccount==='contract.main.burrow.near'||d.environment==='mainnet'&&d.network==='mainnet'&&isFactoryChild(d)&&d.ftContractId==='17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'&&d.ftDecimals===6&&d.codeHash===LINKED_CODE_HASH&&d.wasmSha256===LINKED_CANDIDATE_HASH&&d.policyVersion===LINKED_POLICY&&d.candidateProviderAccount==='contract.main.burrow.near';
export const isMainnetCandidate = (d: DeploymentAllowlist): boolean => isLinkedCandidate(d)||(d.environment === 'mainnet' && d.network === 'mainnet' && (d.contractId === 'showstake-mainnet-escrow-endpx-2026.near' || isFactoryChild(d)) && d.ftContractId === '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1' && d.ftDecimals === 6 && d.codeHash === 'CpnhymSeF785ZBVTaBZfW8ApsfMVUByNCrys8R2i8os' && d.wasmSha256 === MAINNET_CANDIDATE_HASH && d.policyVersion === 'showstake-native-usdc-rhea-review/1' && d.candidateProviderAccount === 'contract.main.burrow.near');
export const isCandidate = (d: DeploymentAllowlist): boolean => (d.environment === 'testnet' && d.network === 'testnet' && ([CANDIDATE_HASH,MAINNET_CANDIDATE_HASH,LINKED_CANDIDATE_HASH].includes(d.wasmSha256) || isReviewedTestnetStatic(d) || (isVerifiedFactoryDeployment(d)&&isFactoryChild(d))) && d.policyVersion === 'showstake-native-usdc-event/1' && !!d.candidateProviderAccount && d.candidateProviderAccount.endsWith('.testnet') && d.ftContractId.endsWith('.testnet')) || isMainnetCandidate(d);
function obj(v: unknown, keys: string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('candidate view must be object');
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join('|') !== [...keys].sort().join('|')) throw new Error('candidate view fields differ from reviewed ABI');
  return o;
}
function str(v: unknown): string { if (typeof v !== 'string' || !v.length) throw new Error('candidate invalid string'); return v; }
function num(v: unknown): number { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error('candidate invalid integer'); return v; }
function atomic(v: unknown): string { const s = str(v); if (!/^(0|[1-9][0-9]*)$/.test(s) || BigInt(s) >= 1n << 128n) throw new Error('candidate invalid u128'); return s; }
function account(v: unknown): string { const s = str(v); if (!validateAccountIdShape(s)) throw new Error('candidate invalid account'); return s; }
const eventKeys = 'event_id title location rules_text phase earn_state earn_attempt earn_action_completed organizer canonical_ft policy_version deposit capacity reg_open reg_close checkin_open checkin_close cancel_cutoff finalize_deadline active_registrations total_registrations withdrawn_registrations rules_hash created_at accepted_principal redeemed_amount realized_yield yield_distributed'.split(' ');
const regKeys = 'registration_id pass_id participant beneficiary commitment_id amount sequence attendance registration_status attendance_status claim claim_amount claim_attempt'.split(' ');
const passKeys = 'pass_id event_id registration_id owner registration_status attendance_status policy_version'.split(' ');
export interface CandidateEvent { rules: PublishRules; title: string; location: string; rulesText: string; count: number; accepted: string; redeemed: string; realizedYield: string; allocatedYield: string; phase: string; earnState: string; multi: boolean; shared: boolean }
export function parseCandidateEvent(raw: unknown, d: DeploymentAllowlist): CandidateEvent | null {
  if (raw === null) return null;
  const v = obj(raw, eventKeys);
  // Later phases need separate receipt-driven payout reconciliation; stop before stale rights can be exposed.
  if (!['RegistrationOpen', 'RegistrationClosed', 'AttendanceFinalized', 'Settled', ...(isMainnetCandidate(d) || isMulti(d) || isVerifiedFactoryDeployment(d) || isReviewedTestnetStatic(d) ? ['Cancelled','RefundOnly'] : [])].includes(String(v.phase))) throw new Error(`candidate phase not supported: ${String(v.phase)}`);
  if (!['NotStarted','SupplyPending','Supplied','RedeemPending','Redeemed'].includes(String(v.earn_state))) throw new Error('candidate unknown earn state');
  if(v.phase==='Settled'&&v.earn_state!=='Redeemed')throw new Error('candidate settlement before redemption');
  num(v.earn_attempt); if (typeof v.earn_action_completed !== 'boolean') throw new Error('candidate invalid earn action');
  const title=str(v.title), location=str(v.location), rulesText=str(v.rules_text); num(v.created_at);
  if (Buffer.byteLength(title)>256 || Buffer.byteLength(location)>512 || Buffer.byteLength(rulesText)>8192) throw new Error('candidate metadata too large');
  for (const key of ['redeemed_amount','realized_yield','yield_distributed']) atomic(v[key]);
  if (!isMainnetCandidate(d) && !isMulti(d) && (v.realized_yield !== '0' || v.yield_distributed !== '0')) throw new Error('candidate yield unsupported by projection schema');
  const refundYield = d.adapter === 'shared-yield-v2' && ['Cancelled','RefundOnly'].includes(String(v.phase));
  if (v.phase === 'Settled' ? v.realized_yield !== v.yield_distributed : refundYield ? v.yield_distributed !== '0' && v.yield_distributed !== v.realized_yield : v.yield_distributed !== '0') throw new Error('candidate distributed yield mismatch');
  if (v.rules_hash !== '') throw new Error('candidate unexpected rules hash');
  const organizer = account(v.organizer), canonicalFt = account(v.canonical_ft), policyVersion = str(v.policy_version);
  if ((!isMulti(d) && organizer !== d.organizer) || canonicalFt !== d.ftContractId || policyVersion !== d.policyVersion) throw new Error('candidate identity mismatch');
  const count = num(v.total_registrations), capacity = num(v.capacity), deposit = atomic(v.deposit), accepted = atomic(v.accepted_principal);
  const realizedYield = atomic(v.realized_yield), allocatedYield=atomic(v.yield_distributed);
  if(BigInt(allocatedYield)>BigInt(realizedYield))throw new Error('candidate yield allocation exceeds realized');
  if (BigInt(accepted) + BigInt(realizedYield) >= 1n << 128n) throw new Error('candidate total exceeds u128');
  if (capacity < 1 || capacity > 200 || count > capacity || v.active_registrations !== count || v.withdrawn_registrations !== 0 || BigInt(accepted) !== BigInt(deposit) * BigInt(count) || deposit === '0') throw new Error('candidate count or principal mismatch');
  const regOpenMs = num(v.reg_open), regCloseMs = num(v.reg_close), cancelCutoffMs = num(v.cancel_cutoff), checkinOpenMs = num(v.checkin_open), checkinCloseMs = num(v.checkin_close), finalizeDeadlineMs = num(v.finalize_deadline);
  if (!(regOpenMs < regCloseMs && cancelCutoffMs === regCloseMs && regCloseMs <= checkinOpenMs && checkinOpenMs < checkinCloseMs && checkinCloseMs < finalizeDeadlineMs)) throw new Error('candidate invalid timing');
  return { multi: isMulti(d), shared: d.adapter === 'shared-yield-v2', title, location, rulesText, count, accepted, redeemed:atomic(v.redeemed_amount), realizedYield, allocatedYield, phase: String(v.phase), earnState: String(v.earn_state), rules: { eventId: str(v.event_id), organizer, canonicalFt, policyVersion, deposit, capacity, regOpenMs, regCloseMs, cancelCutoffMs, checkinOpenMs, checkinCloseMs, finalizeDeadlineMs, rulesHash: '' } };
}
export type CandidateRegistration = CommitData & { attendance: string; claim: string; claimAmount: string };
export function parseCandidateRegistration(raw: unknown, event: CandidateEvent, index: number): CandidateRegistration {
  const v = obj(raw, regKeys); const participant = account(v.participant), beneficiary = account(v.beneficiary);
  const attendance = str(v.attendance), claim = str(v.claim), claimAmount = atomic(v.claim_amount); num(v.claim_attempt);
  const final = event.phase === 'AttendanceFinalized' || event.phase === 'Settled';
  const refund = event.phase === 'Cancelled' || event.phase === 'RefundOnly';
  let refundMismatch=false;
  if(refund && event.shared){
    if(event.count===0)throw new Error('refund registration count invalid');
    const yieldAmount=BigInt(event.realizedYield), count=BigInt(event.count);
    const expected=(BigInt(event.rules.deposit)+yieldAmount/count+(BigInt(index)<yieldAmount%count?1n:0n)).toString();
    refundMismatch=claim==='None' ? claimAmount!=='0' : !['Claimable','Pending','Paid'].includes(claim) || claimAmount!==expected || (yieldAmount>0n && event.allocatedYield!==event.realizedYield);
  }else if(refund){refundMismatch=!['None','Claimable','Pending','Paid'].includes(claim) || (claimAmount !== '0' && claimAmount !== v.amount) || (['Pending','Paid'].includes(claim) && claimAmount !== v.amount);}
  if (participant !== beneficiary || num(v.sequence) !== index || v.registration_status !== 'Active' || !['Unmarked','Attended','NoShow'].includes(attendance) || v.attendance_status !== attendance || (final && attendance === 'Unmarked') || (!final && !refund && attendance === 'NoShow') || (!final && !refund && (claim !== 'None' || claimAmount !== '0')) || refundMismatch || (event.phase === 'AttendanceFinalized' && (claim !== (event.multi ? 'None' : 'Claimable') || claimAmount !== '0')) || (event.phase === 'Settled' && !(['Claimable','Pending','Paid'].includes(claim) || (event.shared && claim==='None' && claimAmount==='0')))) throw new Error('candidate registration state mismatch');
  const amount = atomic(v.amount); if (amount !== event.rules.deposit) throw new Error('candidate deposit mismatch');
  return { eventId: event.rules.eventId, registrationId: str(v.registration_id), passId: str(v.pass_id), participant, beneficiary, commitmentId: str(v.commitment_id), amount, eventSequence: index, attendance, claim, claimAmount };
}
export function validateCandidatePass(raw: unknown, r: CandidateRegistration, d: DeploymentAllowlist): void {
  const v = obj(raw, passKeys);
  if (v.pass_id !== r.passId || v.event_id !== r.eventId || v.registration_id !== r.registrationId || v.owner !== r.participant || v.registration_status !== 'Active' || v.attendance_status !== r.attendance || v.policy_version !== d.policyVersion) throw new Error('candidate pass mismatch');
}

/** Validate every pass against its registration using bounded independent pinned reads. */
export async function validateCandidatePasses(registrations:CandidateRegistration[],read:(passId:string)=>Promise<unknown>,d:DeploymentAllowlist):Promise<void>{
 for(let offset=0;offset<registrations.length;offset+=8){const group=registrations.slice(offset,offset+8);const passes=await Promise.all(group.map(r=>read(r.passId)));for(let i=0;i<group.length;i++)validateCandidatePass(passes[i],group[i]!,d);}
}
export function validateCandidateConfig(raw: unknown, d: DeploymentAllowlist): string {
  const v = obj(raw, 'organizer canonical_ft network policy_version provider_account provider_kind'.split(' '));
  const provider = account(v.provider_account);
  if (!d.candidateProviderAccount || provider !== d.candidateProviderAccount || v.provider_kind !== (isMainnetCandidate(d) ? 'RHEA_MAINNET' : 'MOCK_TESTNET') || v.organizer !== d.organizer || v.canonical_ft !== d.ftContractId || v.network !== d.network || v.policy_version !== d.policyVersion || provider === d.contractId || provider === d.ftContractId) throw new Error('candidate provider identity mismatch');
  return provider;
}
export function validateCandidateCoverage(event: CandidateEvent, registrations: CandidateRegistration[], balanceRaw: unknown, positionRaw: unknown): void {
  const balance = BigInt(atomic(balanceRaw)), position = BigInt(atomic(positionRaw));
  const paidOrPending = registrations.reduce((sum, r) => sum + (r.claim === 'Paid' || r.claim === 'Pending' ? BigInt(r.claimAmount) : 0n), 0n);
  const outstanding = BigInt(event.accepted) + BigInt(event.allocatedYield) - paidOrPending;
  if (outstanding < 0n) throw new Error('candidate negative outstanding principal');
  if (event.earnState === 'NotStarted' && balance < outstanding) throw new Error('candidate escrow balance below outstanding principal');
  if (event.earnState === 'Supplied' && position < outstanding) throw new Error('candidate provider position below outstanding principal');
  if (event.earnState === 'Redeemed' && balance < outstanding + BigInt(event.realizedYield) - BigInt(event.allocatedYield)) throw new Error('candidate redeemed escrow balance below outstanding principal and unallocated yield');
}

/** Observational coverage only; provider code, liquidity and terminal receipts are not accepted here. */
export function validateLinkedCoverage(event:CandidateEvent,registrations:CandidateRegistration[],balanceRaw:unknown,positionRaw:unknown,assetRaw:unknown,contractId:string,tokenId:string):void {
  const balance=BigInt(atomic(balanceRaw));
  const paid=registrations.reduce((sum,r)=>sum+(r.claim==='Paid'||r.claim==='Pending'?BigInt(r.claimAmount):0n),0n);
  const owed=BigInt(event.accepted)+BigInt(event.allocatedYield)-paid;if(owed<0n)throw new Error('candidate negative outstanding principal');
  if(event.earnState==='NotStarted'||event.earnState==='Redeemed'){validateCandidateCoverage(event,registrations,balanceRaw,'0');return;}
  if(!['Supplied','RedeemPending'].includes(event.earnState))return;
  if(!assetRaw||typeof assetRaw!=='object'||Array.isArray(assetRaw))throw new Error('linked asset invalid');const asset=assetRaw as Record<string,unknown>, config=asset.config as Record<string,unknown>;
  if(asset.token_id!==tokenId||!config||typeof config!=='object'||config.extra_decimals!==12)throw new Error('linked asset identity mismatch');
  const p=positionRaw as Record<string,unknown>;if(!p||typeof p!=='object'||Array.isArray(p)||p.account_id!==contractId||!Array.isArray(p.supplied)||!Array.isArray(p.borrowed)||!Array.isArray(p.collateral)||p.borrowed.length||p.collateral.length||p.supplied.length>1)throw new Error('linked position invalid');
  for(const key of ['positions','margin_positions','margin_debt'])if(p[key]!=null&&(!Array.isArray(p[key])||(p[key] as unknown[]).length))throw new Error('linked unsupported exposure');
  let internal=0n;if(p.supplied.length){const x=p.supplied[0] as Record<string,unknown>;if(!x||typeof x!=='object'||x.token_id!==tokenId)throw new Error('linked supplied token mismatch');const shares=BigInt(atomic(x.shares));internal=BigInt(atomic(x.balance));if((shares===0n)!==(internal===0n))throw new Error('linked inconsistent position');}
  if(balance<BigInt(event.redeemed)||balance*1000000000000n+internal<owed*1000000000000n)throw new Error('linked observed coverage insufficient');
}
