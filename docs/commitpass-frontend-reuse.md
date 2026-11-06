# CommitPass frontend reuse for ShowStake

Human direction on 2026-11-07: reuse CommitPass as the frontend foundation, inspect first, retain suitable layout/components/interactions, implement only in ShowStake. This supersedes a greenfield FigCraft redesign. Existing editable drafts and exports must be preserved; FigCraft now specifies necessary deltas and missing screens. Independent wallet, database and contract work continues.

Reference repository (read only): `D:/Belajar/Hackacton/Hackacton yang masih jalan/CommitPass Monad`. Baseline: `542273df306a7e5887f1dfcabf1383e78930f579`. Its frontend has 94 tracked files; local changes observed are outside apps/web. Selected committed blobs and working-tree correspondence are recorded in `docs/evidence/commitpass-frontend-inspection.json`. Use `git show <baseline>:<path>` for provenance-pinned reuse; never bulk-copy a working tree.

## Stack and source coverage

Next App Router 15.5.26, React/ReactDOM 19.1.9, TypeScript, CSS, pnpm10.21.0, GSAP3.15.0/@gsap/react2.1.2, lucide-react1.48.0, Temporal polyfill0.5.1, qrcode1.5.4, QR scanner2.4.0/ZXing0.2.1. These are observed source manifest versions, not a new recommendation or security audit. Privy3.45.0 and viem2.56.9 belong to the old EVM integration and are not inherited as ShowStake's provider choice. No Tailwind/shadcn rewrite is warranted.

Routes include landing `/`, `/signin`, `/discover`, `/events`, `/events/new`, `/events/[vault]`, `/events/[vault]/manage`, `/profile`; replace vault addressing with ShowStake event identifiers. Server routes proxy session/profile/media/events and local funding; do not copy their service targets. Components cover landing poster/scroll reveal/walkthrough, shell, discovery/list/card/states, event detail, editor/location/cover, appearance, pass/QR, host management/scanner/roster, account/settings/preferences and amount/return presentation.

## Reuse map

| Classification | Source | ShowStake treatment |
|---|---|---|
| Direct after dependency check | lib/display-time.ts; event-list-states.tsx; editor-dialog.tsx patterns | Preserve formatting, accessible status and dialog mechanics. Branding/labels may need small changes. |
| Adapt | landing hero/poster/reveal/walkthrough; CSS shell/discovery/editor/manage/lists; event-location; event-period-tabs | Keep composition, breakpoints, interaction and layout. Apply ShowStake packet tokens and branding; retain reduced motion. External maps/links require normal URL review. |
| Adapt | discover-events/event-list-card/event-detail/create-event/managed-event-editor | Retain view/editor layout; replace EVM-shaped types, draft rules and validation with ShowStake domain/OpenAPI. Remove yield/fee/automation assumptions. |
| Adapt | event-pass/guest-qr-scanner/host-tools/host-management/event-vault-card | Preserve pass, camera and roster presentation; introduce non-transferable owner/beneficiary, pending scan versus organizer-signed attendance and NEAR payout states. No organizer participant-claim control. |
| Replace integration | auth provider/privy-sign-in/account-context/platform-runtime; lib/chain/runtime-network/gas-sponsorship; use-event-state | NEAR-first auth candidates and separately verified account ownership; no EVM wallet equals NEAR proof. NEAR state reader and signer. No Monad chain, ABI, allowance/approve, address lowercasing or sponsorship assumptions. |
| Replace integration | server-api, app/api/*, local-runtime/faucet, shared network/deployments/ABI, media Cloudinary transform | Use ShowStake service contracts only. No legacy API/Envio/CRE, Anvil local fund endpoint, uploads, deployed IDs or private provider configuration. Upload remains unavailable until supported. |
| Missing | NEAR binding/relogin/recovery state; separate funding and escrow commit; withdrawal refund-credit; callback pending/failed/retry; gated attendee content | Add/adapt only these needed states following current wallet/contract evidence. Funding checkout remains provisional; Intents has no testnet route. |

## Responsive/design inspection

CommitPass DESIGN.md specifies warm editorial layout, DM Sans/DM Serif, 1160px content, 600/900/1200 breakpoints, 48px controls and native scrolling. Source includes responsive CSS, focus-visible and prefers-reduced-motion. Preserve suitable structure and motion mechanisms; ShowStake's packet tokens (including Inter/type/radius/color) remain authoritative except a later explicit decision. No browser responsive/keyboard/camera claim is made by this read-only inspection.

## Trust-model changes are mandatory

Old use-event-state reads Solidity factory/vault fields such as depositedToYield, protocolRevenue and automation schedule; do not map these to NEAR by renaming. Old RSVP uses ERC20 allowance/approve and Privy sendTransaction; ShowStake registration occurs only after a valid NEAR escrow deposit. Old check-ins POST to an API and combine indexed attended with local checked state; ShowStake API scan remains pending until organizer-signed onchain acceptance. Old settlement copy describes CRE frozen-snapshot/yield; ShowStake has no yield and uses its NEAR settlement/finalization rules. Money stays exact atomic strings/bigint; preserve unknown=Unavailable.

## License, assets and provenance

No project LICENSE/COPYING/NOTICE is tracked at the baseline. Human explicitly authorized reuse; this does not grant a blanket external permissive license. Record origin/commit/blob hash for every adapted/copied file and disclose reuse in README, rather than presenting it all as new hackathon code. Dependency licenses remain applicable and should be retained via package metadata/notice inventory. public/brand README records generated GPT Image assets; DESIGN.md cites visual references and ShowOrSow influence. Do not automatically import the CommitPass logo, generated assets, externally hosted Cloudinary manifests, remote media URLs or font binaries. Prefer CSS/native poster artwork or approved local assets with documented origin. Never copy secrets, environment files, database contents, credentials, service/deployment configuration or old private endpoints.

## Next bounded implementation

Main DeepSeek writer first finishes its current wallet-harness checkpoint, then adapts the existing frontend shell and chain-independent views in ShowStake. Reuse selected baseline blobs only, build/typecheck locally, render mobile/desktop and keep disconnected actions honestly unavailable. ZCode design worker inspects the same baseline and revises only deltas/missing states. No second writer in apps/web. Preserve the previous FigCraft draft as an archive, not a competing replacement frontend. Review -> relevant tests -> commit -> push remains required.
