# ShowStake v2 — authoritative agent handoff

Prepared 2026-11-06. Target: 14 November 2026 23:59 Asia/Jakarta. This is an internal delivery target, not an assurance of completion.

## Authority and read order

This packet replaces ShowStake v1 completely. Do not combine v1 transfer requirements with this version. Latest explicit user instructions prevail. Documents below are the only proposed implementation baseline:

1. `01-PRODUCT.md`: product behavior, immutable rules, money, pass.
2. `02-ARCHITECTURE.md`: identity, boundaries, API, security, deployment.
3. `03-DATABASE.md` and `schema.sql`: database model and candidate PostgreSQL DDL.
4. `04-DESIGN-SYSTEM.md` and `tokens.css`: UI specification and tokens.
5. `05-EXECUTION-AND-TESTS.md`: tasks, acceptance, Codex/DeepSeek protocol.
6. `06-DECISIONS-AND-SOURCES.md`: fixed decisions, defaults, external gates and evidence.

Explicit user direction: ShowStake is a NEAR-centered event commitment product inspired by CommitPass/ShowOrSow, accepting funding from supported chains, using an account-bound pass for participant APIs/check-in; social/email and wallet login supported. Nontransferable pass is the selected v2 baseline following discussion, not a claim an SBT deployment already exists.

This packet is design and handoff, not deployed software. Library versions, provider routes, mainnet addresses, sponsorship and contract standard compatibility must be verified. SQL is candidate DDL; parser validation is not a database migration/integration test. Design tokens are specified colors; contrast validation is not full WCAG certification.

## Startup in Orca

Codex coordinates and reviews; actual DeepSeek executes bounded implementation tasks. Inspect target repo and dirty files first. If destination is absent, ask for it. Do not modify Keyfolio or legacy CommitPass services. Inspect reusable code and licensing before copying. Record actual runtime/model identity and verify one worker task/result/review loop through installed Orca instructions. No substitute model silently labeled DeepSeek.

Copy packet into `docs/planning/showstake-v2/`. Create `docs/status.md`, `docs/decisions.md`, `docs/evidence/`. Preserve prior planning for history but mark superseded. Verify package versions and freeze API/schema before concurrent work. Start T00 then T01/T02. Advance independent local work when live access is blocked.

Sending this packet with an instruction to build authorizes local implementation, dependencies, tests and reviewed local commits. It does not grant real-asset spending, mainnet deployment, remote publication/push, paid resources, provider outreach or submission. Existing explicit authorizations remain valid within their scope. Prepare exact reviewable action before requesting missing authority.

## Paste to Codex

Read this entire ShowStake v2 packet. It supersedes v1. Act as coordinator, architect and acceptance reviewer; implement through actual DeepSeek workers in Orca. Inspect the repo, verify executor readiness, freeze interfaces, then execute T00–T11 in dependency order. Keep nontransferable participant identity, canonical escrow accounting and onchain/offchain authority unchanged. Never treat Privy login as proof of control of any arbitrary NEAR account, swap success as RSVP confirmation, or SQL attendance as financial authority. Resolve OPEN_GATE with evidence. Continue independent local tasks during blockers. Target November14 23:59 WIB, report capacity shared with Keyfolio and any deadline risk. Final claims must distinguish local, testnet, live and partial integration.

## Changed from v1

- Removed all participant/NFT financial transfer and resale paths, including post-event collectible transfers.
- Added explicit Privy social/email/EVM login versus native NEAR wallet identity binding.
- MetaMask NEAR Snap is optional research, not required onboarding.
- Added enforceable backend ownership checks, database privileges, projection/recovery rules.
- Added detailed design tokens, component states, routes and responsive behavior.
- Zero fees, no yield, max200 registrations, full refund fallback retained as planning defaults.
