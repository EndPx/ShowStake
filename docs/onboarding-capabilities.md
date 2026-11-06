# Onboarding capability evaluation

Decision D012-D013, 2026-11-06. NEAR ecosystem first. Provisional recommendation: probe NEAR Auth for social/email and HOT/NEAR Connect for native wallet first. Privy remains an external alternative. No production onboarding provider accepted, no working path removed. EVM login with proven control of a bound NEAR account remains required. Packet is preserved; later user direction reopens provider selection only.

## Initial capability matrix

DOCUMENTED below is a research level, not PASS_TESTNET/PASS_LIVE. NOT_RUN means no actual login or signing experiment. No claims about provider reliability from marketing metrics.

| Requirement | NEAR Auth | HOT / NEAR Connect | Privy alternative |
|---|---|---|---|
| Real function | Social/email login -> NEAR account and transaction signer | Existing NEAR wallet connection and signature requests | Social/email/EVM authentication plus separate embedded NEAR signer |
| Features and networks | Official docs show mainnet and testnet, Auth0-backed Google/Apple/email/passkey; testnet shared client documented [S1,S2] | Official NEAR docs describe wallet sign-in, optional message signing and transactions [S3]; inspect exact package/manifest/network per wallet | Previous executor documented extended-chains NEAR path [S4]; current SDK still needs independent verification |
| Wallet coverage / EVM requirement | EVM login path to same controlled NEAR account NOT_RUN/unknown; social docs alone do not satisfy it | Wallet coverage documented includes HOT, Meteor, Nightly and WalletConnect [S3]. EVM authentication does not automatically prove NEAR account control | Candidate EVM authentication plus embedded NEAR; no authenticated ShowStake session tested |
| Signing and account control | JWT guard + MPC signing described [S1]. Message proof compatibility, current key/account relation and attached-deposit/meta-transaction behavior NOT_RUN | Named-account NEP413 proof requires final RPC key membership and permission; actual connector/mobile return NOT_RUN | Local Ed25519 fixtures only; not actual Privy signing |
| Relogin / recovery | Deterministic identity-derived key documented [S1]; logout/relogin/same actual account and recovery failure modes NOT_RUN | Existing wallet account/recovery stays wallet-specific; switching wallet/account must not move pass. Relogin/mobile NOT_RUN | Same-account recovery NOT_RUN; retained candidate |
| Access / permission | Shared testnet client config published [S2]; local callback origins must be checked. Mainnet needs approved app credentials [S1]. No access application/outreach sent | Package/manifest and selected wallet requirements must be inspected; no API key requirement inferred from connector name | ShowStake app ID and configured origins absent from reported probe; do not borrow another project credentials |
| Fund authority / security | Guard, issuer, MPC, relayer and upgrade dependencies must be traced; documentation's noncustodial claim not independently audited here | Participant wallet signs financial actions; API/worker cannot own participant or organizer keys. Dynamic wallet manifest is a trust boundary | Separate NEAR key proof required; EVM-only session never grants pass/claim authority |
| Costs | Relayer sponsorship described [S1], not verified free service; actual API limits, storage, relayer/MPC costs NOT_RUN | Wallet gas/storage costs remain; no universal sponsorship claim | Actual tier/billing/sponsorship costs NOT_RUN |
| Reliability / integration time | No measured login/signing latency or uptime. Callback + signing compatibility + mainnet approval are schedule risks | No measured wallet/mobile reliability. Candidate SDK import/build and message signature tests required | Existing local probes reduce research effort only; no measured auth reliability or production integration |
| Experiment results | Official pages read 2026-11-06; local harness/login NOT_RUN | Official page/repository followed 2026-11-06; connector PoC NOT_RUN | 11 local security regression checks, 16 wallet CLI cases pass per executor/Codex rerun; no vendor session; remaining review gaps below |
| Decision | First candidate for social/email PoC | First candidate for native-wallet PoC; determine HOT Connect vs NEAR Connect package/version identity, do not duplicate them | Retain; concrete fallback if NEAR Auth cannot satisfy required flow/access in time, with equal PoC bar |

## Experiments and acceptance

- Codex reran `pnpm verify:t02-regressions` (11 denials), `pnpm verify`, wallet/intents offline CLIs, frozen-lockfile install and WSL PostgreSQL safety selftest: exit 0. Evidence: docs/evidence/t02-codex-review-round2.json. These are PASS_LOCAL only; no login/recovery demonstrated.
- Prior PostgreSQL baseline DDL apply remains partial T01. Latest worker health check is not migration/grants/restore acceptance.
- 1Click GET catalog HTTP200 and 215 entries is executor-reported read-only evidence, no route delivery. Its dry quote used placeholder assets and returned HTTP400; that cannot establish an API-key gate. Correct body, catalog IDs, error body and official auth semantics must be evaluated before requesting access.
- Review gaps remain: resolver permission/freshness fields not enforced by current wrapper, linking user/session context absent, SDK interoperability for custom NEP413 not independently proven. Unaccepted partial code stays local.

For every candidate: compile exact pinned SDK; verify callback/login/logout/relogin yields same controlled NEAR account; sign a fresh challenge verified server-side; test account/network switch, expiry/replay/identity conflict. Then authorized same-environment FT deposit -> pass -> refund/claim. EVM login path remains separately mandatory. Preserve existing adapters until replacement passes. Failure or missing access becomes a specific BLOCKED_EXTERNAL, not scope reduction. No production selection until these proofs.

## Official sources checked 2026-11-06

- S1: [NEAR Auth documentation](https://docs.auth.near.org/) and [quickstart](https://docs.auth.near.org/home/quickstart). SDKs, auth model, deterministic key, mainnet approval.
- S2: [NEAR Auth testnet resources](https://docs.auth.near.org/resources/testnet). Shared development client and published contracts. These are documented config, not verified deployments in ShowStake.
- S3: [NEAR Connect documentation](https://docs.near.org/tools/near-connect), linked [connector repository](https://github.com/azbang/near-connect), and [NEAR wallet-selector repository](https://github.com/near/wallet-selector) recommending HOT Connect migration. Package naming/version compatibility needs SDK inspection.
- S4: [NEAR Privy tutorial](https://docs.near.org/web3-apps/tutorials/privy), previously inspected by executor. Current ShowStake auth remains untested.

## Independent work

Continue isolated PostgreSQL migrations/grants/constraint/concurrency/restore tests and exact-money domain/interface work after review. UI components independent of provider may proceed under frozen interfaces and explicit ownership. Contract authority, pass nontransferability, immutable beneficiary, funding vs registration and scan vs final attendance rules unchanged. Do not wait for full UI to prove core integration.
