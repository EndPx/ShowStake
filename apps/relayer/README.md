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

## Bounded lifecycle runner (local verification only)

`node run.mjs <config.json> <journal.json>` performs a read-only plan. The RPC adapter reads event, control, contract configuration and account code at the same finalized block; the provider code hash and canonical USDC identity are pinned. The runner uses the linked child-contract ABI and never marks or finalizes attendance. Source fixtures are local evidence only.

Execution additionally requires `node run.mjs <config.json> <journal.json> <approval.json> --execute`. The approval file binds network, contract, code hash, event, signer, methods, expiry, call count, gas, gas-price ceiling and native budget, and separately records provider acceptance. The runtime stores a reservation before invoking an injected signer and only advances after a matching final receipt graph and later finalized state. An unknown submission blocks retries. A crashed process can leave a `.lock` file; inspect the process and journal before manual recovery. The file journal is single-host only.

The optional near-cli-rs signer uses a dedicated, finite-allowance function-call access key. Operator configuration supplies absolute `nearExecutable` and `keyFilePath`; the key file must be outside the workspace, owned by the Linux service user, and inaccessible to group and other users. The approval must also bind `signerPublicKey`, receiver, allowed zero-deposit methods and native budget. Before signing, the adapter rechecks the public key and its on-chain `FunctionCall` permission at the same finalized block as the deployment state, rejects unlimited or excessive allowance and wider methods, and rechecks gas price. Final transaction reconciliation matches the approved public key. The file path, but never key material, is passed to near-cli with `shell: false`.

The operator must provision and independently review the dedicated restricted key outside this workflow. Never copy a full-access key or seed phrase into chat or this repository. Allowance is charged at gas buy price and later refunded; a restrictive allowance can make a valid call fail. The budget assumes that the approved access key is not deleted/recreated with a replenished allowance or used concurrently by an untracked signer. An operator approval file is not itself evidence of provider acceptance. These tests use synthetic keys and mock RPC/CLI output; no real key, signature, funded run, or actual near-cli transaction has been used.
