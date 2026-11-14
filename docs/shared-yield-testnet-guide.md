# Shared-contract ShowStake testnet candidate

The selected architecture is one ShowStake account with separate event IDs. Creating an event stores another event record; it does not deploy another Wasm or create another contract account. Each event has its own organizer, registrations, beneficiary records, principal, strategy shares, cash reserve and claims.

## Deployment and evidence

- Network: NEAR testnet.
- Shared contract: `ss-shared-s1114151743.testnet`.
- Canonical test token: `mockusdc.testnet`, Mock USDC, 6 decimals. This is not mainnet Circle USDC.
- Provider: `ss-shared-earn-s1114151743.testnet`, explicitly a zero-yield testnet mock.
- Policy: `showstake-native-usdc-shared-yield/2`, schema 2.
- Optimized Wasm SHA-256: `2fdc615b6427858b8a351b03343385052353ef1b466caad47d16a19c49e24c53`.
- Code hash: `4Dq4uEH2PE9FEB7n67d3r3fvHPUy5KAvjhgZ8q5sX4PU`.
- Deployment transaction: `9tyBF1NutawyvXGoe36wjKDRdcZyZHnFR7afbFjbWw7U`, initialized at block `277631359`.

`docs/evidence/testnet-shared-s1114151743` contains the final deployment identity and the direct five-account testnet lifecycle run. `docs/evidence/shared-yield-v8-20261114` contains the source hash manifest, 20 Rust unit tests, Sandbox receipt graphs, public Rhea Wasm experiment, and old-C81 migration experiment. A local Rhea Wasm experiment does not prove live withdrawal liquidity. Browser acceptance is recorded separately after the deployed frontend flow is exercised.

## Website steps

Use the testnet preview at `https://showstake-testnet.vercel.app`. Connect a NEAR **testnet** wallet with testnet NEAR for gas/storage and Mock USDC for registration. A mainnet wallet or real USDC does not fund this candidate.

1. Open **New event**, enter title, location, rules, deposit amount, capacity and ordered registration/check-in times. Review the event rules, request the exact storage quote, and sign `create_event` on the shared account. Wait for the final receipt before following the event link.
2. As another testnet account, open that event. If token storage is missing, approve its separate canonical-token storage transaction. Enter a unique commitment ID, approve the exact `ft_transfer_call`, and verify the final receipt. The event page reads registration and the non-transferable pass from the contract.
3. After registration closes, the organizer signs **Close registration**, then **Supply**. Check-in requires an active pass. The participant creates a short-lived QR/token; the organizer submits it at the check-in desk. That only creates `PENDING_SIGNATURE`. The organizer must separately sign `mark_attendance` and verify its final receipt.
4. After check-in closes, sign **Finalize attendance**, **Redeem**, and **Settle** in sequence, verifying each final receipt and callback. Two attendees in a five-person event with deposits of 2 Mock USDC each receive 5 Mock USDC each when realized yield is zero. No-shows receive zero in that scenario.
5. Each beneficiary signs their own claim. The app verifies the payout receipt and fresh registration state. A failed FT transfer restores the same claim for a separate retry; an unknown transaction outcome must be reconciled before another attempt.
6. For cancellation, the organizer cancels the event; if it has a supplied position, redeem it before refunds. Every beneficiary claims their own principal plus any deterministically allocated realized yield. Timeout refund becomes available at the contract's finalization deadline.
7. Organizer materials are stored privately. Download authorization reads final contract state and requires the connected participant's active, attended pass and a settled/redeemed event. A QR, pending check-in proposal, no-show pass or stale database row does not authorize content or payment.

No voluntary withdrawal or rejoin is included: D036 makes the accepted registration commitment final. Organizer cancellation, timeout and zero-attendee refund paths remain available under their contract gates.

## Authority and operational limits

The API's `FINAL_CHAIN` direct access mode can authorize QR proposals and content from a fresh pinned final block while the historical indexer is unavailable. It does not claim a complete historical projection or advance a worker cursor. The raw-block endpoint's HTTP 429 remains an external indexing limitation. A projection is never financial authority.

Multiple events may own supplied positions concurrently. Provider operations use one shared mutex to bind asynchronous callbacks. Unknown/dispatched provider outcomes and shortfalls fail closed; the current contract has no public partial-withdrawal method. These liveness limits must be understood before a mainnet release.

The full real 24-hour timeout is not replaced by the shortened Sandbox registration/check-in schedule. Any timeout experiment must record its actual clock and deadline.

Mainnet `showstake-mainnet-escrow-endpx-2026.near` remains the older CREATE-only C81 release. This testnet candidate does not authorize a mainnet upgrade, native top-up, user USDC transfer or funded Rhea operation. The user signs their own reviewed mainnet Rhea micro-test. Rhea remains `SELECTED_FOR_HACKATHON`; it is not `TECHNICALLY_ACCEPTED` until the live provider and withdrawal acceptance gates pass.
