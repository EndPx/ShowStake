# Funding capability checkpoint

Codex read-only provider review, 2026-11-07. No funded swap, wallet ownership proof, escrow deposit or registration occurred. The canonical production FT is not frozen by this checkpoint.

| Capability | Observed result | Boundary |
|---|---|---|
| Public supported-token catalog | HTTP200,216 entries; NEAR/Base/Solana USDC candidates with6decimals observed | Catalog is not a liquidity or executable-route guarantee |
| Base USDC -> NEAR USDC exact-output dry quote | HTTP201 unauthenticated; echoed dry=true and requested assets/recipient, amountOut5000000, no depositAddress | Uses PUBLIC DOCUMENTATION SAMPLE refund/recipient addresses, not user-owned wallets; no funds or swap initiation |
| Actual source/NEAR control, storage, delivery and signed escrow commit | NOT_RUN | Human wallet proof and scoped funded-route authorization required |
| Provider quote signature verification | NOT_RUN | A returned signature is not verification; integration must verify it before trust |
| Solana funded route | NOT_RUN | Catalog presence alone does not pass this route |

Evidence: funding-catalog-codex-review.json and funding-dry-quote-codex-review.json. PASS_LIVE in those records means a real public-provider HTTP response only; the swap request itself is explicitly a dry simulation. It is not a financial lifecycle pass.

The current official authentication page documents optional partner JWT and an additional0.25% fee for unauthenticated non-ANY_INPUT quotes, which differs from the historical0.2% hackathon note. Exact fees must come from current policy/quote, never be hardcoded into UI. Platform/organizer fee0 in ShowStake remains unchanged and is separate from external route cost. Schema reference labels X-API-Key required/recommended inconsistently; actual unauthenticated dry probe succeeded, so lack of a partner key is not a blanket blocker for this observed path.

Sources:
- https://docs.near-intents.org/llms.txt
- https://docs.near-intents.org/api-reference/oneclick/get-supported-tokens
- https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote
- https://docs.near-intents.org/integration/distribution-channels/1click-api/authentication

The product two-step rule is unchanged: supported funding goes to participant-controlled NEAR; a separate valid escrow FT deposit creates the seat/pass. No provider-assisted direct escrow deposit or experimental customRecipientMsg is introduced.
