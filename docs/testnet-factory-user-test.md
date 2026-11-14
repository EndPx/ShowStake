# Test the atomic factory on NEAR testnet

Open https://showstake-testnet.vercel.app. The stable alias currently points to review deployment `dpl_6HRf5s7xFGpJTgdJ7sQj4HboegCm`. The preview uses **NEAR testnet, Mock USDC and zero-yield MockEarn**; it is a review deployment and its currently displayed features are not proof of mainnet availability. You need a supported NEAR testnet wallet with testnet NEAR for fees and sufficient Mock USDC. The app must show its testnet network label. Use only testnet tokens.

1. Connect the testnet wallet and, if prompted for check-in, sign the NEP-413 sign-in request. A wallet connection alone is not a check-in session.
2. Open **Create event**. Enter the title, location, rules, registration and check-in times, capacity and a fixed deposit. Review the factory quote and storage cost. Approve the wallet request only after checking the displayed network, contract and amount. A final receipt and child/event readback should confirm creation; a wallet return alone is not success.
3. Open the organizer desk at `/host/events/{eventId}?contract={childAccount}`. Use **Refresh final contract state**, **Check token storage** and **Check provider storage**; approve any exact storage registration needed before deposits. Then a participant opens the event, approves their own token registration if required and commits the exact deposit. A successful final receipt should produce one account-bound pass. The same participant cannot obtain a second active pass for that event.
4. Once registration closes, use **Close registration**, verify its receipt, then **Supply to mock provider** and verify again. During the check-in window, the participant requests a short-lived QR/token and the organizer uses the check-in desk. This creates a proposal: **Mark attended** still requires the organizer's onchain signature and a final receipt. Do this before check-in closes.
5. After check-in closes, use **Finalize attendance**, **Redeem provider funds**, then **Settle event**, reconciling each final receipt before the next action. An eligible participant can claim only when the contract confirms the claim is available. Check the final transfer receipt and resulting claim state. The current raw-block source limit can block QR/projection steps; those remain unaccepted.
6. For cancellation or a missed finalization deadline, use the applicable cancel/timeout flow and check the principal refund claim. Voluntary withdrawal after a valid commitment is not available under D036.

**Current limits:** the indexer has adopted three children but is catching up; its raw-block source `https://testnet.neardata.xyz` returned HTTP 429. Event discovery, pass lists and QR/check-in can be stale or unavailable. Do not assume a missing projection means an onchain action failed; inspect its final receipt and contract state before retrying. A mixed browser/CLI test reached final `Paid` state for two browser claims after browser finalization, redemption and settlement. Four deposits, closing, supply and attendance marks used CLI support; this is not an entirely browser-operated lifecycle. QR and gated-content flows remain unaccepted. Hidden-page screenshots were blank and do not establish visual acceptance. Final receipt graphs and balance snapshots are in `docs/evidence/atomic-factory-20261114/browser/result.json`.

Known current mixed-run event: `event-a1a1186ab3f448438aac847234371f1e` on `77a5e2b3a93df516.ss-fac-c1113232934.testnet`. Its test activity is separate from a fresh event you create. Testnet evidence: `docs/evidence/testnet-factory-c1113232934/result.json`; local contract evidence: `docs/evidence/atomic-factory-20261114/`.

## Build locally

From the repository root, use Node 24.18.x and pnpm 10.21.x:

```sh
pnpm install --frozen-lockfile
pnpm typecheck:web
pnpm build:web
pnpm build:api
pnpm --filter @showstake/worker build
```

These commands build local code; they do not deploy the preview, configure a wallet, fund an account, or establish provider or browser acceptance. Contract candidate build inputs and local Sandbox runners are described in `test-support/contract-integration/FACTORY-EVENT-CANDIDATE.md`; its historical initial status is superseded by the evidence report. A reproducible NEP-330 build and automatic explorer verification are not yet proven.
