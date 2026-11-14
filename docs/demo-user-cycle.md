# Mainnet demo rehearsal: fund, register, attend, claim

This is a user-signed rehearsal plan. It is not evidence that the mainnet cycle has completed. Record actual final receipts and balances as each step runs. No transaction in this plan is signed by the coding agent.

## Cast and event

- Organizer: a NEAR mainnet account connected through a NEAR wallet.
- Participant A: the guest shown in the video, with a separate NEAR mainnet account and a MetaMask source account on Base.
- Participant B: a distinct account registered before filming, deliberately left unchecked-in.
- Capacity: **2**; commitment: **100000 atomic USDC = 0.1 USDC per participant**.
- Use registration and check-in windows that allow both registrations to finalize before registration closes. Preserve the contract's required ordering; do not set registration and check-in to identical windows.
- Organizer and guest each need native NEAR for their own storage/transaction costs. Base payments need Base ETH for gas. Use the website's current quotes; event storage depends on the submitted rules and capacity.

MetaMask as the Base payment source is separate from the NEAR wallet that owns the pass. The NEAR Connect selector also exposes an EVM-on-NEAR integration; its declined connection screen is not a successful NEAR login. For this rehearsal use an already functioning NEAR account/wallet for the recipient and connect MetaMask directly inside payment options.

## Funding amount is separate from event commitment

The [recorded dry inspection](evidence/base-usdc-dry-20261115.json) found that an exact-output target of 0.1 USDC was below the provider's bridge minimum. A target of 1 USDC returned a dry quote for 1.008826 Base USDC, excluding source gas. These are expired observations, not an executable price or a fixed minimum. Request a fresh preview before approving.

Fund enough for the quote and gas; deposit exactly 0.1 USDC into this event. Any remaining USDC stays in the participant's NEAR wallet. Funding alone must not create a seat or pass.

## Rehearsal and recording order

| Step | Action | Evidence to save |
| --- | --- | --- |
| 1 | Organizer publishes the two-seat event; B registers before filming. | Creation/deposit hashes, contract event ID, B's onchain registration, canonical token ID. |
| 2 | A opens the event, connects a NEAR recipient wallet and signs in. | Matching account/network and session; event rules visible. |
| 3 | In payment options A selects **USDC · Base**, connects the EVM wallet, reviews a fresh conversion and signs the source transfer. | Source USDC and ETH before/after, source transaction hash, quote identity, destination NEAR account. |
| 4 | Wait for the conversion and verify returned destination balance. | Provider status plus actual native NEAR USDC balance increase; no pass yet. |
| 5 | A approves required FT storage and signs the **0.1 USDC** event deposit. | Final receiver receipt, exact USDC debit, exactly one registration and account-bound pass. |
| 6 | After registration closes, organizer runs the event's available supply/setup actions and reconciles their final receipts. | Attributed event position and callback state; a supply receipt alone does not establish withdrawal liquidity. |
| 7 | A opens the pass QR. Organizer scans it, reviews the pending request and signs attendance. Leave B unchecked-in. | Pending proposal followed by final `mark_attendance` receipt; A attended, B not attended. |
| 8 | After check-in closes, organizer finalizes attendance, requests redemption/reconciliation as permitted by the state, then settles. | Final attendance, actual returned USDC, closed/reduced position, event settlement and allocation. |
| 9 | A signs claim and waits for the final payout callback. | Claim/payout receipts, A's USDC increase, event paid/pending/liability totals. |
| 10 | A opens eligible materials. Check B is denied. | Eligibility reads and content authorization; no public fallback. |

For a pool with no fees, loss or realized yield, **0.1 + 0.1 = 0.2 USDC** is allocated to the sole attendee: 0.1 principal returned plus 0.1 no-show allocation. This is **0.1 USDC net gain**, not 0.2 profit. Display the actual settled claim from the contract. Additional realized yield, shortfall or policy outcomes must follow the recorded state.

## Two-minute story after the rehearsal passes

| Approximate screen time | Screen and narration |
| --- | --- |
| 0–12 s | Open the real event. “Two guests commit ten cents each. One guest is already registered. I'll join from another chain.” |
| 12–40 s | Show Base USDC, the conversion preview, user approval, source receipt and actual NEAR USDC arrival. “I fund my NEAR wallet through NEAR Intents. My seat is still unregistered.” |
| 40–60 s | Deposit 0.1 USDC and show the final pass. “This separate USDC deposit reserves my seat and creates my account-bound pass.” |
| 60–80 s | QR scan, pending proposal, organizer approval and final attendance. “A scan proposes check-in. The organizer signs the onchain attendance record.” |
| 80–105 s | Show attendance finalization, redemption and settlement receipts. “Only one guest attended. The contract settles the reconciled event funds.” |
| 105–120 s | Show the actual claim, wallet balance change and eligible materials. Explain principal versus no-show reward using the final amounts. |

Waiting periods may be cut with an explicit elapsed-time caption. Keep the same event and account identities across cuts. Do not replace pending/failed provider operations with successful frames, fabricate balances or imply instant DeFi yield. If redemption has not returned USDC, record the pending result and do not narrate a completed payout.

## Recovery

If MetaMask reports an existing request, open the extension and approve or reject that request yourself before reconnecting. Do not repeatedly open new requests. For an unresolved source transfer, use the saved funding attempt and source hash to reconcile; do not send again blindly. If a NEAR transaction has no hash, inspect wallet history and the saved event/registration before retrying. A known failed payout may be retried only after the contract restores its claimable amount.

Save a sanitized run report containing network, event/contract/token IDs, role account IDs, timestamps, final transaction/receipt hashes, atomic balances before/after, quote fees, position changes and remaining liabilities. Never include session cookies, authorization headers, keys or seed phrases. Keep this mainnet run separate from the existing Mock USDC testnet evidence.
