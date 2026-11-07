# apps/web/onboarding-probe — T02 NEAR wallet/signing proof harness

A **minimal diagnostic browser harness** (not product UI) that imports the real
NEAR SDKs and exercises read-only + off-chain proof-of-control flows on **NEAR
testnet**. It exists to prove the wallet/signing acceptance (W01–W08 ledger,
G01–G08) far enough that a human can finish the one remaining, genuinely
external step: consenting in a real browser wallet.

The database, API contract, product design, and main web app are **not** touched
by this harness.

## What it actually does

| Candidate | Status | Path |
|---|---|---|
| **NEAR Connect** (native wallet) | **wired** | connect → read account → off-chain NEP-413 sign → verify through `near-api-js` `viewAccessKey` (FullAccess) resolver → disconnect/reconnect same-account comparison |
| **NEAR Auth** (social/email) | **prepared, not invoked** | exact testnet config + the on-chain `sign` action recorded; broadcasting is forbidden here (needs a funded relayer + human Auth0 approval) |

Real SDKs (pinned, verified against `docs.near.org` and npm on 2026-11-07):

- `@hot-labs/near-connect@0.12.0` (MIT) — `NearConnector`; `wallet.signMessage`
  returns an off-chain NEP-413 `{accountId, publicKey, signature}`.
- `near-api-js@7.4.0` ((MIT AND Apache-2.0)) — `JsonRpcProvider` (`viewAccount`,
  `viewAccessKey`) and `near-api-js/nep413` `verifyMessage` (canonical NEP-413
  signature + FullAccess key-ownership check in one call).

## Fail-closed posture (why this is not a config-only report)

Live authentication is **never** allowed to fall back to a local implicit-account
guess. The only acceptance path is the network-pinned `viewAccessKey`
(`FullAccess` required) plus the canonical NEP-413 signature check:

- RPC unavailable / account-not-found / key-not-found / non-FullAccess → **deny**.
- The implicit-account local check exists only in the Node fixture selftests
  (`scripts/verify-t02-*.mjs`) and is labeled fixture-only; it is never consulted
  by the browser harness's live `verifyChallenge` path.
- The signed message binds `domain/network/purpose/account/issued_at/expires_at/
  nonce`; TTL ≤ 5 min.

## Local startup / build

```sh
pnpm install                 # one-time (installs near-api-js, @hot-labs/near-connect, vite)

pnpm dev:t02-harness         # Vite dev server at http://127.0.0.1:5174
pnpm build:t02-harness       # production build -> apps/web/onboarding-probe/dist
pnpm verify:t02-harness      # SDK pin + capability + fail-closed fallback checks (Node, offline)
```

Then open the dev URL in a browser, select **NEAR Connect**, and step through
Connect → Read account → Sign NEP-413 challenge → Verify proof → Disconnect →
Reconnect. The session table records the same-account comparison.

## What is BLOCKED_EXTERNAL (precise, none fabricated)

- **Live wallet return / signature** (`W03`/`G02`): requires a browser + a human
  + a real NEAR wallet. Testnet-capable wallets in the NEAR Connect manifest
  include Meteor, Intear, Ledger, Nightly and other explicitly flagged entries.
  The current HOT Wallet and MyNearWallet entries do not declare `testnet: true`;
  NEAR Mobile declares `testnet: false`. The SDK excludes those entries on testnet.
  Flags are not live signing proof; see `docs/evidence/near-wallet-manifest-review.json`. No live signature was
  produced by the worker.
- **NEAR Auth login/sign** (`W01`/`G01`): its message signing is **on-chain**
  (`sign` transaction to `fast-auth.testnet`, gas `300000000000000`, deposit `1`
  yocto). The harness prepares these exact values but does not broadcast; doing
  so needs a funded relayer account + human Auth0 approval + scoped authorization.
- **EVM login → bound NEAR account** (`W02`/`E09`): neither NEAR Connect (native
  NEAR wallets) nor NEAR Auth (Auth0 only) has an EVM-wallet leg; Privy embedded NEAR and MetaMask NEAR Snap remain alternatives to evaluate;
  neither is accepted as the required EVM-login-to-bound-NEAR path by this harness.
- **Deposits / passes / funding**: out of scope and never simulated.

## Secrets

There are no secrets in this harness. The NEAR Auth `clientId` is the public
shared development credential published at `docs.auth.near.org/resources/testnet`.
A real `.env` stays git-ignored (see repo root `.gitignore`); never put a key in
the console, evidence, or dispatches.
## Accepted local scope

Codex accepted local adapter/security checks, build, and browser startup smoke only. No real wallet login/relogin/signature or backend session is proven. Run `pnpm verify:t02-adversarial` for 18 behavioral regressions, including deferred-promise stale completion. In-memory nonce state does not replace atomic server-side challenge consumption. Vite defaults to port 5174; use the URL it prints if that port is occupied.
