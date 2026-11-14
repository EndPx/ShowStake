# ShowStake — judge's guide

ShowStake connects event registration to an exact USDC attendance commitment on NEAR. This guide separates the public mainnet interface from the recorded testnet financial run.

## Start here

1. Open [the mainnet event editor](https://showstake.vercel.app/events/new). Inspect the cover/theme controls, schedule, rules, commitment and capacity. This is a draft until a wallet transaction finalizes.
2. Open [Discover](https://showstake.vercel.app/discover) and [Events](https://showstake.vercel.app/events). Discover reads the shared contract; personal events require the matching wallet session. An empty catalog is not replaced with demo registrations.
3. Inspect [the shared mainnet account](https://nearblocks.io/address/showstake-mainnet-escrow-endpx-2026.near) and [V8 upgrade receipt](https://nearblocks.io/txns/5nL4htVAQREWW3e7UniPoE5n8bCbD9cJ72REMWjcqiZb). The [deployment report](evidence/shared-mainnet-upgrade-v8-20261114/result.json) identifies the artifact and scope.
4. Review [the testnet lifecycle report](evidence/testnet-shared-s1114151743/result.json). It contains the actual deposits, attendance, allocations, payouts and balance/accounting observations.

## Inspect the five-account result

The testnet root is `ss-shared-s1114151743.testnet`, policy `showstake-native-usdc-shared-yield/2`. It uses `mockusdc.testnet` and the explicitly zero-yield provider `ss-shared-earn-s1114151743.testnet`.

| Do this | See this |
| --- | --- |
| Read the report's `attendee` event and registrations. | Five commitments of `2000000` atomic Mock USDC, two attendees and three no-shows. |
| Inspect [settlement](https://testnet.nearblocks.io/txns/EY9DgtDgVwR6UiHZoduGQZdJLFKvSL4AX31VJYUhRQD2). | The event reaches its settled allocation after redemption. |
| Inspect [claim 1](https://testnet.nearblocks.io/txns/4t8CbduZtMTbe6uCUfr9e8C5HurH8PSqDuWbQTf5XV2X) and [claim 2](https://testnet.nearblocks.io/txns/2DQaWJTZDJErcAmSz4H1qsw3HL7b4T2XJunYe4dJokEC). | Each eligible attendee is paid `5000000` atomic units, or 5 Mock USDC. |
| Read the attended-event totals. | Accepted/paid `10000000`; pending and liability `0`; realized yield `0`. |
| Read the separate `cancelled` event. | Five principal refunds of `2000000` each, with no residual liability. |
| Inspect the report's known failure/retry records. | Provider and payout failures remain distinct from a successful final return. |

The full report contains 42 receipt graphs across two independent events. This is testnet execution, not a funded mainnet Rhea result.

## Inspect the implementation

- [Shared contract](../contracts/showstake/event-escrow-candidate/shared_yield.rs): creation, exact token receiver, registration/pass, attendance, provider operations, settlement and callback-bound claim.
- [Shared vault tests](../contracts/showstake/event-escrow-candidate/shared_vault_tests.rs): event isolation, accounting and recovery cases.
- [Frontend transaction boundary](../apps/web/src/lib/near/wallet.ts): explicit wallet dispatch and result tracking; hashes do not establish success.
- [Final receipt checks](../apps/web/src/lib/near/shared-receipt.ts): event-specific financial proof and post-receipt reconciliation.
- [Session/QR/content API](../apps/api): verified wallet identity and private-resource authorization.
- [Worker](../apps/worker): finalized canonical source validation, projection and cursor recovery.
- [Backend ERD](backend-erd.md): real PK/FK identity boundaries between deployments, events, registrations, passes and payouts.

## Reproduce local checks

Use Node24.18.x and pnpm10.21.x. From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm typecheck:web
pnpm build:web
pnpm verify:t08-frontend
pnpm verify:frontend-slice
pnpm verify:api
pnpm verify:worker
pnpm verify:openapi
```

The Rust shared-yield crate and native build prerequisites are described in the root README. Database and network suites are documented in the API/worker guides; do not substitute a superuser database connection for the application's restricted runtime roles.

## Read the claims with their environment

| Label | What it establishes |
| --- | --- |
| `PASS_LOCAL` | The named local build, test or Sandbox scope passed. |
| `PASS_TESTNET` | The named operation executed on NEAR testnet with the recorded assets. |
| `PASS_LIVE` | The report's explicit live scope, which may be hosting/read-only rather than a funded product cycle. |
| `BLOCKED_EXTERNAL`, `NOT_RUN`, `FAILED` | The gate is not being counted as passed. |

The current open gates are a complete funded mainnet user cycle, real Rhea supply/redemption and returned-USDC acceptance, funded 1Click delivery/recovery, and distinct long-window/history coverage checks. A provider balance, dry quote, QR proposal, database record, or UI screenshot cannot establish those outcomes.

Rhea is selected for the hackathon integration; it is not labelled technically accepted or independently audited. The pass is custom and account-bound, without a NEP-171/NEP-393 compliance claim. The contract remains upgradeable while its FullAccess key exists.
