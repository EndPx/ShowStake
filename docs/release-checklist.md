# ShowStake release checklist

This is the canonical release gate checklist referenced by the roadmap. Current authorization permits dedicated testnet accounts/faucet/local credential storage, deployment of Codex-reviewed builds and testnet-token transactions only. No mainnet signing, real-asset spending, paid resource or pilot/public-deposit authorization is implied. Never request private keys/seed phrases in chat.

## 1. TESTNET_ACCEPTED

- [ ] Reviewed product source and pinned commit/build/Wasm; relevant local tests reproducible.
- [ ] Dedicated testnet contract account and separate test participants; signer in restricted credential store outside repository; network/account/public keys/balance verified by RPC. Never use endpx.testnet or mainnet user keys.
- [ ] Canonical test FT, decimals and account/escrow FT storage verified; gas/storage estimates and observed cost recorded separately.
- [ ] Actual frontend/backend/wallet path: create event -> valid FT deposit -> registration -> non-transferable pass -> pending scan -> organizer-signed attendance -> finalization -> settlement -> claim.
- [ ] D036 voluntary withdrawal after commit denied without mutation; cancellation refund, timeout refund, zero attendees, deterministic remainder, duplicate claim denial, failed payout/retry, immutable beneficiary and per-event isolation proven. Existing local/Sandbox tests cover hard timing/callback cases with exact environment labels.
- [ ] Each required action links receipt, contract views, before/after balances and source/artifact; unknown outcomes reconciled before retry.
- [ ] API/session/worker projection recovery, public vs protected routes and frontend state/freshness verified; DB cannot authorize final attendance or payout.

## 2. MAINNET_PREPARED

- [ ] Freeze release commit, build tool versions, Cargo/npm locks, Wasm hash/size and review/test results. Record reproducibility limits.
- [ ] Select new mainnet contract account and signing route; canonical FT account/decimals/storage requirements verified from official sources + actual reads. Do not copy testnet identifiers, fixtures or credentials.
- [ ] Validate separate backend/RPC/event ingestion/database/domain/wallet configuration, CORS/cookies, secrets and monitoring; no cross-network data leakage. Named indexing provider chosen only when functionality/access is proven.
- [ ] Decide actual admin, upgrade, pause and key-management authority from implemented code: who can do what, recovery, rotation and irreversibility. Do not claim controls absent from code; financial rights/beneficiary cannot be reassigned.
- [ ] Propose event capacity, test/pilot participant limits and deposit/aggregate exposure caps, without changing v2 rights or dropping acceptance.
- [ ] Prepare bad deployment/runbook: stop new frontend submissions where supported, reconcile existing liabilities, retain receipts/cursors, exact upgrade/cancel/refund options and limits. No blind balance reset or redeploy over unknown state.

## 3. Concrete human authorization before mainnet action

For each unapproved action provide: purpose/action; network and signer/contract accounts; commit/Wasm hash; recipient and asset; maximum nominal and aggregate exposure; gas/storage estimate, basis and hard maximum; route fees/slippage if applicable; authority/key/upgrade changes; success verification and failure/recovery behavior. Ask only for missing permission. If values/artifact change materially, authorization must match the changed action. Account creation, deployment, deposits, route funding and pilot opening must not be conflated into one vague request.

## 4. MAINNET_DEPLOYED, deposits closed

- [ ] Execute only specifically authorized actions; record deployment receipt.
- [ ] Read installed code hash/config/authorized keys, canonical FT and all integration addresses back from mainnet.
- [ ] Keep public deposits/pilot unavailable. Deployment does not prove correct lifecycle or authorize public launch.

## 5. MAINNET_E2E_ACCEPTED with small authorized funds

- [ ] Direct NEAR canonical-FT deposit -> registration/pass.
- [ ] One verified supported EVM route and one verified supported non-EVM route -> participant-controlled mainnet NEAR account -> separate participant-signed escrow deposit -> registration/pass. No provider status as registration authority.
- [ ] Mainnet organizer attendance/finalize -> settle -> claim, plus cancellation/refund on separate test event.
- [ ] Same mainnet configuration/environment across all stages; mainnet swap never described as funding testnet escrow.
- [ ] Per-transaction receipts/views and token/native/route-cost reconciliation; timeout never triggers blind duplicate funding. Preserve failed/unknown attempts; verify provider quote signatures and recipient/asset bindings.
- [ ] All actions within approved nominal/gas/storage/fee/slippage caps; excess requires new approval. Remaining acceptance gaps explicitly block advancement.

## 6. PILOT_APPROVED

- [ ] Mainnet E2E accepted; propose participant count, per-deposit and aggregate exposure ceilings and organizer/event scope.
- [ ] Monitoring, incident ownership, user support and recovery active.
- [ ] Clearly disclose organizer-attested attendance, non-transferable pass/fixed beneficiary, gas/storage/swap costs, refunds, unsupported routes and product/recovery limits.
- [ ] Human separately approves opening limited pilot/public deposits and its exact limits. No approval inferred from planning, testnet deployment or mainnet E2E permission.

For each completed gate attach artifact/commit, environment, commands/action, receipt/evidence links, reviewer and unresolved limits in docs/status.md/evidence. Leave boxes unchecked without evidence. No additional runner/framework work unless a concrete active feature needs it.

Mainnet review candidate (2026-11-13): see docs/evidence/mainnet-review-release-20261113.json for exact artifact, account proposal, paused initialization, budgets and open gates. This is IMPLEMENTED_LOCAL, not MAINNET_DEPLOYED or provider TECHNICALLY_ACCEPTED. Stage1 proposal is contract creation plus atomic deploy-and-init with paused=true/cap=0/no event, maximum 2.55 NEAR and zero USDC. Never deploy and initialize in separate transactions; public new can otherwise be raced. Organizer-only preflight retries and pre-dispatch donation quarantine passed local regressions. Stage2 still requires final provider transfer provenance, unresolved detached-withdrawal recovery and actual returned-USDC liquidity evidence before funded acceptance. Signer local import/readback and public key matching passed; no blockchain transaction was signed or broadcast. Current funder 0.25 NEAR is below even the code storage requirement; funding and an exact spending limit remain missing.

2026-11-13 cost revision: stage1 proposal supersedes the earlier2.55NEAR cap with2.30NEAR contract funding plus0.02NEAR extra fee ceiling (2.32NEAR maximum), with initializer10Tgas. Exact reviewed Wasm unchanged. Actual local Sandbox atomic init passed and measured225503B/2.25503NEAR storage, paused/cap0/noevent; mainnet still NOT_RUN. Recheck live fees/storage/registration and stop on an exceeded basis; no provider/public funds. See docs/evidence/mainnet-storage-budget-20261113.json and docs/mainnet-deploy-plan.md.

2026-11-13 completed stage1 only: mainnet account creation plus atomic deploy/init accepted at final block224274113; onchain Wasm hash/config/FullAccess/paused cap0/noevent and native budget reconciled. Native fees0.0092553459773227NEAR, conservative funded-capital-plus-fees2.3092553459773227<2.32NEAR cap. See docs/evidence/mainnet-deploy-20261112T221125Z/result.json. No USDC, external provider call, event creation, cap increase, unpause, pilot or frontend mainnet transaction was performed. Rhea technical acceptance and the funded/full-browser gates stay open.
