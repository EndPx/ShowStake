// Canonical FT path builder: direct FT transfer_call -> escrow registration/pass
// -> refund/claim, per NEP-141 + NEP-145 and ShowStake v2 product rules.
//
// This builds exact, typed call arguments and the storage preflight order. It
// does NOT broadcast anything, register anything, or claim funds (G05/G06 remain
// open: canonical token/network/storage IDs are not chosen until Codex freezes
// them). Amounts stay canonical u128 strings.

import { assertAtomic, toAtomicString } from '../../domain/src/index.mjs';

/**
 * ShowStake escrow commit message passed as `msg` to NEP-141 ft_transfer_call.
 * Provisional schema for Codex review (NOT frozen). The FT contract forwards it
 * to escrow::ft_on_transfer({sender_id, amount, msg}); the escrow contract must
 * revalidate amount/token/phase/commitment itself.
 *
 * @param {object} p
 * @param {string} p.eventId
 * @param {string} p.commitmentId   app-level idempotency/attempt identity
 * @returns {string} JSON string
 */
export function buildCommitMsg({ eventId, commitmentId }) {
  if (typeof eventId !== 'string' || eventId.length === 0) throw new TypeError('eventId required');
  if (typeof commitmentId !== 'string' || commitmentId.length === 0) throw new TypeError('commitmentId required');
  return JSON.stringify({ event_id: eventId, commitment_id: commitmentId });
}

/**
 * Build the exact `ft_transfer_call` invocation (NEP-141 deposit-call). The
 * callee is the FT contract; `receiver_id` is the escrow; `amount` is exact u128
 * string; caller attaches 1 yoctoⓃ for security.
 *
 * @param {object} p
 * @param {string} p.ftContractId       canonical allowlisted FT (deployment.ft_contract_id)
 * @param {string} p.escrowContractId   ShowStake escrow (deployment.contract_id)
 * @param {string} p.amount             exact deposit D, u128 base-10 string
 * @param {string} p.participantAccount NEAR account signing the call (pass owner/beneficiary)
 * @param {string} p.eventId
 * @param {string} p.commitmentId
 * @param {string} [p.memo]
 * @returns {{method:string, contractId:string, args:object, attachedDepositYocto:string, signerAccountId:string, msg:string}}
 */
export function buildFtTransferCall({ ftContractId, escrowContractId, amount, participantAccount, eventId, commitmentId, memo }) {
  // Normalize to a canonical u128 base-10 string at the trust boundary. This
  // rejects non-canonical inputs AND accepts bigint while never letting a bigint
  // flow into a JSON-serialized argument (bigint would throw on stringify).
  const amountStr = toAtomicString(amount);
  if (assertAtomic(amountStr) === 0n) throw new TypeError('deposit amount must be > 0');
  for (const [k, v] of Object.entries({ ftContractId, escrowContractId, participantAccount })) {
    if (typeof v !== 'string' || v.length === 0) throw new TypeError(`${k} required`);
  }
  const msg = buildCommitMsg({ eventId, commitmentId });
  const args = { receiver_id: escrowContractId, amount: amountStr, msg };
  if (memo !== undefined && memo !== null) args.memo = memo;
  return {
    method: 'ft_transfer_call',
    contractId: ftContractId,
    args,
    attachedDepositYocto: '1',
    signerAccountId: participantAccount,
    msg,
  };
}

/**
 * Ordered NEP-145 storage preflight (documented, never executed here): the
 * participant and escrow accounts must already be registered with the FT
 * contract and the escrow must hold storage for the pass/registration record,
 * or ft_transfer_call's ft_resolve_transfer will roll the transfer back.
 *
 * @param {object} p
 * @param {string} p.ftContractId
 * @param {string} p.escrowContractId
 * @param {string} p.participantAccount
 * @returns {{steps: {order:number, method:string, contractId:string, purpose:string, args:object}[]}}
 */
export function preflightStorageSteps({ ftContractId, escrowContractId, participantAccount }) {
  return {
    steps: [
      {
        order: 1, method: 'storage_balance_of', contractId: ftContractId,
        purpose: 'participant registered on FT (storage present)',
        args: { account_id: participantAccount },
      },
      {
        order: 2, method: 'storage_deposit', contractId: ftContractId,
        purpose: 'register participant on FT when step 1 returns null (attach storage_balance_bounds.min)',
        args: { account_id: participantAccount, registration_only: true },
      },
      {
        order: 3, method: 'storage_balance_of', contractId: ftContractId,
        purpose: 'escrow registered on FT as a receiver (else ft_on_transfer fails)',
        args: { account_id: escrowContractId },
      },
      {
        order: 4, method: 'storage_deposit', contractId: ftContractId,
        purpose: 'register escrow on FT when step 3 returns null',
        args: { account_id: escrowContractId, registration_only: true },
      },
      {
        order: 5, method: 'storage_deposit', contractId: escrowContractId,
        purpose: 'escrow storage for registration/pass record (contract-defined)',
        args: { account_id: participantAccount, registration_only: true },
      },
    ],
  };
}

/**
 * Post-commit note: the exact refund/claim path is contract settlement
 * (finalize -> allocate -> claim(registration) -> ft_transfer from escrow to
 * immutable beneficiary). This probe only binds the direct deposit leg; the
 * payout leg is T03/T04 contract scope, not claimed here.
 */
export const FT_LIFECYCLE_NOTE = Object.freeze([
  'participant signs ft_transfer_call on the canonical FT -> escrow (1 yocto attached).',
  'FT mints/transfers to escrow, calls escrow.ft_on_transfer({sender_id, amount, msg}).',
  'escrow validates token predecessor, exact amount D, unique(payer,commitment_id), event phase/capacity; mints account-bound pass in the same receipt.',
  'unused/invalid amount returned through ft_resolve_transfer (full amount on rejection).',
  'refund/claim happen later via escrow finalize/claim -> ft_transfer to immutable beneficiary (T03/T04).',
]);