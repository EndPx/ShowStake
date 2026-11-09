// Mainnet preparation only. No signer, key, or broadcast capability belongs here.
export const SHOWSTAKE_MAINNET_PREPARED = Object.freeze({
  environment: 'mainnet',
  oneClickBaseUrl: 'https://1click.chaindefuser.com',
  dryRunOnly: true,
  allowBroadcast: false,
  candidateCanonicalFundingAsset: Object.freeze({
    symbol: 'wNEAR',
    assetId: 'nep141:wrap.near',
    decimals: 24,
    status: 'CANDIDATE_UNFROZEN',
  }),
  fundingBalance: Object.freeze({
    custody: 'user-controlled-near-or-intents-balance',
    redeemable: true,
    lockPoint: 'valid-escrow-ft-transfer-call-pass-issued',
  }),
  factoryYieldVault: Object.freeze({
    custody: 'factory-controlled-yield-vault',
    redemptionDestination: 'factory',
    principalProtectedFor: 'idle-factory-balance-only',
    status: 'NOT_DEPLOYED',
  }),
  eventEscrow: Object.freeze({
    custody: 'showstake-event-escrow',
    redeemable: false,
    exitPolicy: 'cancellation-timeout-refund-settlement-claim',
  }),
  factory: Object.freeze({ contractId: null, registryId: null, status: 'NOT_DEPLOYED' }),
});

export function assertDryRunConfig(config = SHOWSTAKE_MAINNET_PREPARED) {
  if (config.environment !== 'mainnet') throw new Error('mainnet preparation requires environment=mainnet');
  if (config.dryRunOnly !== true || config.allowBroadcast !== false) throw new Error('mainnet preparation must remain dry-run-only');
  if (config.factory.contractId !== null || config.factory.registryId !== null) throw new Error('factory addresses are not frozen in preparation mode');
  return true;
}
