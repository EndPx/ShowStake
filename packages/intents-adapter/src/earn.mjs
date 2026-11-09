import { isPositiveAtomic } from '../../domain/src/index.mjs';

const SWAP_TYPES = new Set(['EXACT_INPUT', 'EXACT_OUTPUT', 'FLEX_INPUT']);
const DELIVERY_TYPES = new Set(['DESTINATION_CHAIN', 'INTENTS']);
const required = (v, name) => { if (typeof v !== 'string' || v.length === 0) throw new TypeError(`${name} required`); };
const asset = (v, name) => required(v, name);
const iso = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));

/** Build a dry Earn deposit quote. Receipt tokens represent a DeFi position. */
export function buildEarnDepositQuote({ originAsset, receiptAsset, amount, recipient, recipientType = 'INTENTS', refundTo, refundType = 'ORIGIN_CHAIN', swapType = 'EXACT_INPUT', deadline }) {
  asset(originAsset, 'originAsset'); asset(receiptAsset, 'receiptAsset');
  if (!isPositiveAtomic(amount)) throw new TypeError('amount must be a positive canonical atomic string');
  if (!DELIVERY_TYPES.has(recipientType)) throw new TypeError('recipientType must be DESTINATION_CHAIN or INTENTS');
  required(recipient, 'recipient'); required(refundTo, 'refundTo');
  if (!SWAP_TYPES.has(swapType)) throw new TypeError('swapType must be an Earn-supported swap type');
  if (!iso(deadline)) throw new TypeError('deadline must be ISO');
  return { dry: true, swapType, slippageTolerance: 100, originAsset, destinationAsset: receiptAsset, amount, depositType: 'ORIGIN_CHAIN', recipient, recipientType, refundTo, refundType, deadline };
}

/** Build a dry Earn withdrawal quote from receipt shares back to factory. */
export function buildFactoryYieldRedeemQuote({ receiptAsset, payoutAsset, shareAmount, factoryAccount, refundTo = factoryAccount, deadline }) {
  asset(receiptAsset, 'receiptAsset'); asset(payoutAsset, 'payoutAsset');
  if (!isPositiveAtomic(shareAmount)) throw new TypeError('shareAmount must be a positive canonical atomic string');
  required(factoryAccount, 'factoryAccount'); required(refundTo, 'refundTo');
  if (!iso(deadline)) throw new TypeError('deadline must be ISO');
  return { dry: true, swapType: 'EXACT_INPUT', slippageTolerance: 100, originAsset: receiptAsset, destinationAsset: payoutAsset, amount: shareAmount, depositType: 'INTENTS', recipient: factoryAccount, recipientType: 'DESTINATION_CHAIN', refundTo, refundType: 'INTENTS', deadline };
}

/** The only balance eligible for factory yield deployment is idle balance. */
export function buildFactoryYieldPlan({ idleAsset, receiptAsset, amount, factoryAccount, factoryContractId }) {
  asset(idleAsset, 'idleAsset'); asset(receiptAsset, 'receiptAsset'); required(factoryAccount, 'factoryAccount'); required(factoryContractId, 'factoryContractId');
  if (!isPositiveAtomic(amount)) throw new TypeError('amount must be positive');
  return Object.freeze({ source: Object.freeze({ account: factoryAccount, asset: idleAsset, amount, class: 'IDLE_FACTORY_BALANCE' }), earn: Object.freeze({ receiptAsset, custody: 'factory-controlled-yield-vault', broadcast: false }), redeem: Object.freeze({ destination: factoryAccount, principalAndYield: true, broadcast: false }), eventEscrowFundsExcluded: true });
}
