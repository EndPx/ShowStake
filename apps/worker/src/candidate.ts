import type { DeploymentAllowlist } from './config.js';
import type { CommitData, PublishRules } from './types.js';
import { validateAccountIdShape } from '@showstake/domain';

// This adapter is tied to the reviewed testnet candidate bytecode, not merely its self-reported ABI.
export const CANDIDATE_HASH = 'de868ccb9d3dbf64409b392ba7e58a38678321bef803d1d0779a3d8abec791ae';
export const isCandidate = (d: DeploymentAllowlist): boolean => d.environment === 'testnet' && d.wasmSha256 === CANDIDATE_HASH && d.policyVersion === 'showstake-native-usdc-event/1';
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
export interface CandidateEvent { rules: PublishRules; count: number; accepted: string; phase: string; earnState: string }
export function parseCandidateEvent(raw: unknown, d: DeploymentAllowlist): CandidateEvent | null {
  if (raw === null) return null;
  const v = obj(raw, eventKeys);
  // Later phases need separate receipt-driven payout reconciliation; stop before stale rights can be exposed.
  if (!['RegistrationOpen', 'RegistrationClosed', 'AttendanceFinalized', 'Settled'].includes(String(v.phase))) throw new Error(`candidate phase not supported: ${String(v.phase)}`);
  if (!['NotStarted','SupplyPending','Supplied','RedeemPending','Redeemed'].includes(String(v.earn_state))) throw new Error('candidate unknown earn state');
  num(v.earn_attempt); if (typeof v.earn_action_completed !== 'boolean') throw new Error('candidate invalid earn action');
  str(v.title); str(v.location); str(v.rules_text); num(v.created_at);
  for (const key of ['redeemed_amount','realized_yield','yield_distributed']) atomic(v[key]);
  if (v.realized_yield !== '0' || v.yield_distributed !== '0') throw new Error('candidate yield unsupported by projection schema');
  if (v.rules_hash !== '') throw new Error('candidate unexpected rules hash');
  const organizer = account(v.organizer), canonicalFt = account(v.canonical_ft), policyVersion = str(v.policy_version);
  if (organizer !== d.organizer || canonicalFt !== d.ftContractId || policyVersion !== d.policyVersion) throw new Error('candidate identity mismatch');
  const count = num(v.total_registrations), capacity = num(v.capacity), deposit = atomic(v.deposit), accepted = atomic(v.accepted_principal);
  if (capacity < 1 || capacity > 200 || count > capacity || v.active_registrations !== count || v.withdrawn_registrations !== 0 || BigInt(accepted) !== BigInt(deposit) * BigInt(count) || deposit === '0') throw new Error('candidate count or principal mismatch');
  const regOpenMs = num(v.reg_open), regCloseMs = num(v.reg_close), cancelCutoffMs = num(v.cancel_cutoff), checkinOpenMs = num(v.checkin_open), checkinCloseMs = num(v.checkin_close), finalizeDeadlineMs = num(v.finalize_deadline);
  if (!(regOpenMs < regCloseMs && cancelCutoffMs === regCloseMs && regCloseMs <= checkinOpenMs && checkinOpenMs < checkinCloseMs && checkinCloseMs < finalizeDeadlineMs)) throw new Error('candidate invalid timing');
  return { count, accepted, phase: String(v.phase), earnState: String(v.earn_state), rules: { eventId: str(v.event_id), organizer, canonicalFt, policyVersion, deposit, capacity, regOpenMs, regCloseMs, cancelCutoffMs, checkinOpenMs, checkinCloseMs, finalizeDeadlineMs, rulesHash: '' } };
}
export type CandidateRegistration = CommitData & { attendance: string; claim: string; claimAmount: string };
export function parseCandidateRegistration(raw: unknown, event: CandidateEvent, index: number): CandidateRegistration {
  const v = obj(raw, regKeys); const participant = account(v.participant), beneficiary = account(v.beneficiary);
  const attendance = str(v.attendance), claim = str(v.claim), claimAmount = atomic(v.claim_amount); num(v.claim_attempt);
  const final = event.phase === 'AttendanceFinalized' || event.phase === 'Settled';
  if (participant !== beneficiary || num(v.sequence) !== index || v.registration_status !== 'Active' || !['Unmarked','Attended','NoShow'].includes(attendance) || v.attendance_status !== attendance || (final && attendance === 'Unmarked') || (!final && attendance === 'NoShow') || (!final && (claim !== 'None' || claimAmount !== '0')) || (event.phase === 'AttendanceFinalized' && (claim !== 'Claimable' || claimAmount !== '0')) || (event.phase === 'Settled' && !['Claimable','Pending','Paid'].includes(claim))) throw new Error('candidate registration state mismatch');
  const amount = atomic(v.amount); if (amount !== event.rules.deposit) throw new Error('candidate deposit mismatch');
  return { eventId: event.rules.eventId, registrationId: str(v.registration_id), passId: str(v.pass_id), participant, beneficiary, commitmentId: str(v.commitment_id), amount, eventSequence: index, attendance, claim, claimAmount };
}
export function validateCandidatePass(raw: unknown, r: CandidateRegistration, d: DeploymentAllowlist): void {
  const v = obj(raw, passKeys);
  if (v.pass_id !== r.passId || v.event_id !== r.eventId || v.registration_id !== r.registrationId || v.owner !== r.participant || v.registration_status !== 'Active' || v.attendance_status !== r.attendance || v.policy_version !== d.policyVersion) throw new Error('candidate pass mismatch');
}

export function validateCandidateConfig(raw: unknown, d: DeploymentAllowlist): string {
  const v = obj(raw, 'organizer canonical_ft network policy_version provider_account provider_kind'.split(' '));
  const provider = account(v.provider_account);
  if (!d.candidateProviderAccount || provider !== d.candidateProviderAccount || v.provider_kind !== 'MOCK_TESTNET' || v.organizer !== d.organizer || v.canonical_ft !== d.ftContractId || v.network !== d.network || v.policy_version !== d.policyVersion || provider === d.contractId || provider === d.ftContractId) throw new Error('candidate provider identity mismatch');
  return provider;
}
export function validateCandidateCoverage(event: CandidateEvent, registrations: CandidateRegistration[], balanceRaw: unknown, positionRaw: unknown): void {
  const balance = BigInt(atomic(balanceRaw)), position = BigInt(atomic(positionRaw));
  const paidOrPending = registrations.reduce((sum, r) => sum + (r.claim === 'Paid' || r.claim === 'Pending' ? BigInt(r.claimAmount) : 0n), 0n);
  const outstanding = BigInt(event.accepted) - paidOrPending;
  if (outstanding < 0n) throw new Error('candidate negative outstanding principal');
  if (event.earnState === 'NotStarted' && balance < outstanding) throw new Error('candidate escrow balance below outstanding principal');
  if (event.earnState === 'Supplied' && position < outstanding) throw new Error('candidate provider position below outstanding principal');
  if (event.earnState === 'Redeemed' && balance < outstanding) throw new Error('candidate redeemed escrow balance below outstanding principal');
}
