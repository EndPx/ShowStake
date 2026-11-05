# Decisions and anti-hallucination gates

Prepared2026-11-06. Sources establish documented paths, not successful deployment in this workspace.

## Confirmed direction vs selected defaults

User direction: ShowStake, NEAR-centered commitment escrow, cross-chain participation, pass used for check-in and participant API, multiple login options. v2 selected behavior: nontransferable account-bound pass, as discussed; overrides earlier transferable v1.
Defaults:30s ownership freshness,60s QR/URL,200 capacity,zero platform/host fee,no yield,24h finalization timeout,two-step funding,one canonical FT,Inter/light warm theme. These are explicit implementation decisions; meaningful changes recorded by Codex and financial-right changes accepted by user before live customer deposits.

## OPEN_GATE register

| Gate | Evidence required | Owner / if blocked |
|---|---|---|
| G01 Privy NEAR | actual login/create or recover/sign/auth/deposit/claim,Google+email+MetaMask path | Codex reviews; independent UI fixtures allowed |
| G02 Native wallet | at least one tested NEAR Connect wallet/mobile return/signature | Executor probe; unsupported wallet not advertised |
| G03 Account recovery | same login returns same controlled account; no duplicate mint identity | Codex; block public enrollment if unstable |
| G04 Funding | exact token IDs,fees,recipient/refund,actual EVM/non-EVM->NEAR delivery | Executor; dry quote only is local capability evidence |
| G05 Canonical FT | contract/network/decimals/storage and audited provenance recorded | Codex; symbolic USDC never used as address |
| G06 Gas/storage | funding/sponsorship path and explicit costs | User budget if needed; no sponsor:true assumption |
| G07 Pass standard | custom API declared; compatibility tests; no unsupported NEP171/393 claim | Codex chooses implementation,behavior stays nontransferable |
| G08 Receipt index | provider finalized receipt/log capability,ordering,replay and loss recovery | Executor; polling final state fallback with documented coverage |
| G09 Max capacity gas |200 worst-case settlement and callback gas measured | Codex; implement chunked recovery if required |
| G10 Live resources | selected accounts,addresses,budget,hosting and publication authority | User exact action approval where absent |
| G11 Mainnet release | security,solvency,upgrade authority,rollback and policy accepted | Codex reports scope; no audited claim without audit |

## Primary sources checked

- Privy NEAR tutorial: https://docs.near.org/web3-apps/tutorials/privy — documents social/embedded signing paths; not proof of current app credentials or sponsorship.
- NEAR Connect: https://docs.near.org/tools/near-connect — native-wallet connector; actual wallet/version tested individually.
- Privy external wallet configuration: https://docs.privy.io/recipes/react/wallet-list-configurations — EVM/Solana connection configuration; not automatic NEAR account binding.
- NEAR NFT interface: https://docs.near.org/primitives/nft/standard — NEP171/177; permanently rejecting transfers is not automatically full standard compliance.
- SBT standard: https://github.com/near/NEPs/blob/master/neps/nep-0393.md — recovery/soul-transfer included; don't claim it merely by naming a pass soulbound.
- Intents quotes: https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote — current request schema and dry quote; reread before integrating.
- Intents request flow: https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/making-a-request — funding/status; app escrow receipt still independent.
- MetaMask NEAR Snap: https://snaps.metamask.io/snap/npm/near-snap/plugin/ — optional extension path.
- Snaps availability: https://support.metamask.io/configure/snaps/metamask-snaps-faq — verify mobile availability before offering.

## Forbidden claims

No claims that all chains work, Privy automatically sponsors NEAR, EVM signature proves arbitrary NEAR ownership, a source swap creates a seat, pass possession proves physical attendance, public-chain data is private, DB rows enforce escrow money, or nontransferable tokens prevent wallet sharing. No invented production addresses, transaction IDs, user testimonials, partner approvals or working endpoint capabilities.

## Evidence labels

PASS_LOCAL: fixture/sandbox. PASS_TESTNET: actual testnet outcome. PASS_LIVE: authorized real provider/mainnet outcome. BLOCKED_EXTERNAL: missing access/capability/authority. FAILED: observed violation. NOT_RUN: no execution. Mixed environments are PARTIAL_INTEGRATION, not full live lifecycle. Deadline arrival doesn't change these labels.
