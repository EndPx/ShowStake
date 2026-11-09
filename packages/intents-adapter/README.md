# packages/intents-adapter — NEAR Intents adapter

This is the mainnet-preparation boundary for NEAR Intents 1Click, Earn receipt
tokens and the NEP-141 ShowStake escrow deposit leg. It is **dry-run only**:
no signer, API key, deposit-address persistence, transaction broadcast, factory
call, or real asset movement is implemented here.

## Correct product boundary

The factory has two separate balances:

1. **Idle factory balance** — factory-controlled funds that may be placed into a
   third-party DeFi/yield position through NEAR Intents Earn. Redeeming the
   receipt tokens sends principal plus the realized yield back to the factory.
2. **Event escrow balance** — funds already committed to a ShowStake event. These
   are excluded from the yield vault and follow cancellation, timeout, settlement
   and claim rules. They are not an anytime-redeemable DeFi position.

Earn uses the same 1Click quote flow as swaps: a payment asset becomes a receipt
token on deposit, and the receipt token becomes a payout asset on withdrawal.
Receipt-token assets must be resolved from `/v0/tokens`; availability and
liquidity can change. Third-party protocols own the yield and do not guarantee
APY or principal.

The adapter marks every receipt position as a separate factory yield position.
A receipt on Base (or any other non-NEAR chain) is not ShowStake EventEscrow
custody and cannot authorize registration, attendance, refunds, or payouts.
Event escrow principal remains outside the yield plan.

## Local usage

```sh
node packages/intents-adapter/src/cli.mjs --offline
node packages/intents-adapter/src/cli.mjs
node --test packages/intents-adapter/test/earn.test.mjs
```

`src/mainnet-config.mjs` freezes `dryRunOnly: true`, `allowBroadcast: false`,
and leaves factory/registry addresses unset. `src/earn.mjs` builds dry Earn
deposit/withdraw quotes and a factory-yield plan without sending funds.

## Limits

- NEAR Intents has no testnet; funded swaps are a separate mainnet authorization.
- The public catalog is read-only and may prove current asset metadata only;
  catalog presence does not prove liquidity or route availability. A dry quote
  has no deposit address and does not move funds. Auth, provider routing limits,
  and current fees must be observed at use time.
- A successful Intents swap does not create a ShowStake registration or pass.
- Factory yield is currently a reviewed interface/configuration boundary, not a
  deployed vault or accepted DeFi integration.
- Event escrow funds must never be included in the factory yield vault.
