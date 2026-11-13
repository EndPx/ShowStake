# Mainnet user test handoff

Updated 2026-11-13. This is a staged review build, not acceptance of funded event Earn. The mainnet account `showstake-mainnet-escrow-endpx-2026.near` is deployed with code hash `CpnhymSeF785ZBVTaBZfW8ApsfMVUByNCrys8R2i8os`, paused, cap zero and no event at the stage-1 verification. No participant USDC or provider calls were authorized or executed in stage 1.

## Local website review

From the repository, run `pnpm install --frozen-lockfile`, then `powershell -ExecutionPolicy Bypass -File scripts/start-mainnet-preview.ps1 -Build`. This foreground preview uses mainnet read-only configuration on `http://127.0.0.1:3012`, with the API expected on `http://127.0.0.1:3002`. The launcher never reads keys, signs or broadcasts. The final mainnet build passed locally; automatic tool approval rejected agent-started frontend serving, so the human must start it for browser verification. C: must first have usable physical free space; Ubuntu currently needs host filesystem recovery before final DB tests.

1. Open `/events/new`: inspect the allocated existing escrow and organizer identity. New factory creation is a separate, undeployed candidate and is not needed for the first allocated-account review.
2. Connect a native NEAR mainnet wallet. The immutable organizer is `dc634c505ee6b86a9b615ed7ebef7fff6a235c3406163d35d4f0e60c576a27b5`; confirm the wallet account before attempting organizer actions. A near.com internal EVM identity is not automatically this native NEAR signer. Share only the public account ID when coordinating setup.
3. Inspect `/earn`: Rhea identity, USDC asset, storage, position and balances are read-only. Transaction controls remain locked because no scoped approval is installed. A displayed position or successful supply is not withdrawal acceptance.
4. Inspect `/funding`: quotes are DRY; only supported catalog assets are offered, recipient is the participant's NEAR account, and swap completion never creates an escrow registration. No live source-chain transfer is accepted yet.
5. Event URLs preserve `?contract=<escrow-account>` so identical event IDs on different contracts cannot cross-bind API/pass/claim actions. Actual event registration, pass, host check-in, results and protected-content pages require a created, finalized event; the empty paused account has none.

The API requires a restricted PostgreSQL role and a server-side NEP-413 configuration. Never put operator DB credentials, signing keys, cookies or signatures in a browser/public environment. The preview launcher is not a production hosting deployment. Production HTTPS, a durable database, worker supervision and a chosen browser wallet acceptance remain release gates.

## Separate treasury test to review before signing

The reviewable Rhea sequence is 1 USDC supply, partial withdrawal up to 0.5 USDC, then full withdrawal of the remaining position. See `evidence/rhea-microtest-plan-20261113.md` for exact provider/token identities and arguments. The application budget is 0.22 NEAR for storage and prepaid gas at the approved ceiling. This is not an authorization, funding request, guaranteed fee or protocol-enforced spending limit. A dedicated treasury account, expiry, approval ID, plan hash and exact operations must match in the API approval file, frontend plan and wallet scope. All defaults remain disabled. The user signs each transaction; no private key or seed phrase is requested in chat.

The server journal durably reserves a step before the wallet opens. An existing reservation or unknown outcome is recovery-only. A hash may be attached once, and completion requires canonical final receipt graph plus historical/current balance and position reconciliation. Browser storage is only a hash hint. Clearing it does not grant another supply or withdrawal. A failed/ambiguous withdrawal does not justify blind retry.

## Remaining contract gate

The current Rhea event candidate cannot be accepted solely from a successful treasury round trip. Rhea `execute` may return before detached FT transfer completion; the current leaf cannot bind return provenance for a particular redeem attempt and has unresolved ambiguous/callback-loss recovery. See `src.rs` around `reconcile_earn`, `on_rhea_snapshot` and `on_rhea_action`. Source review requires a provider-semantic fix and failure proof before any event principal is enabled. Do not unpause the deployed account to bypass this gate. No upgraded source, mainnet upgrade or participant funding is authorized by this handoff.

## Evidence labels

Stage-1 account creation/deploy/init: PASS_LIVE, empty/paused only (`evidence/mainnet-deploy-20261112T221125Z/`). Offchain mainnet challenge/session/replay/revoke: PASS_LIVE (`evidence/mainnet-auth-live-20261113.json`), no blockchain spending. Five users × 2 Mock USDC, two attendees receiving 5 each, failed payout/restoration/retry and cancellation refund: PASS_LOCAL current-leaf Sandbox (`../test-support/contract-integration/evidence/runs/claim-failure-20261113T002255Z-339675/`). Prior public testnet lifecycle evidence remains separate. Rhea actual supply/USDC return and funded browser lifecycle: NOT_RUN. PostgreSQL final migrations 0006/0007 acceptance: BLOCKED_EXTERNAL by host storage; earlier DB results are not final-source acceptance.
