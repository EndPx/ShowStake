# ShowStake bounded relayer planner

This package is a local, dry-run-first automation planner for the accepted ShowStake v6 lifecycle. It proposes permissionless event actions after checking local time and observed state; the NEAR contract remains authoritative for timestamps, state, callbacks, balances, and payout rights.

The package does not contain a signer, RPC client, provider address, ABI, code hash, or receipt-token assumption. A Rhea configuration is accepted only when `verified: true` and all of `network`, `usdcAccount`, `lendingAccount`, `codeHash`, `abiRevision`, `receiptAsset`, `methods.supply`, and `methods.redeem` are supplied by an independently reviewed source. The repository's Rhea evidence is `CANDIDATE_EXTERNAL`, so no live configuration is included.

## Local verification

```sh
pnpm --dir apps/relayer test
```

The test suite is `PASS_LOCAL` evidence only. It covers early and late time gates, duplicate attempts, stale callbacks, bounded failed retries/backoff, event isolation, redemption-before-settlement, and dry-run no-broadcast. It does not prove a testnet or mainnet transaction, provider ABI, liquidity, or contract compatibility.

## Planner boundary

`RelayerPlanner.plan(eventId, nowMs)` emits at most one action per event per call. Each proposal carries `eventId`, `action`, `attempt`, and an idempotency key of the form `event/action/attempt`. `applyReceipt` accepts only the current pending key and attempt; old or cross-event receipts are rejected. Failed attempts return to a retryable state until `maxAttempts`, with exponential backoff capped by `maxBackoffMs`.

`execute` is dry-run by default and never calls a broadcaster in that mode. Non-dry execution requires an explicitly injected broadcaster and is still only an automation sender; contract checks must reject invalid or duplicate calls.
