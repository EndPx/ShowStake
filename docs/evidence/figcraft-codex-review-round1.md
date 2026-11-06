# Codex FigCraft review, round 1

Classification: PASS_LOCAL for existence/render inspection only; design acceptance REVISIONS_REQUIRED (review verdict, not a test classifier). Codex visually inspected all 16 PNGs from isolated ZCode delivery. Product UI integration remains gated.

The cream/forest/burnt-orange palette, editorial covers and money hierarchy fit the supplied tokens. Pass and settlement screens distinguish registration, attendance and payout. The result fixture conserves 45 = 40 attendee allocations + 5 withdrawn refund; no paid payout is implied in its totals.

Required corrections:
1. Funding frame depicts Base Sepolia -> NEAR Testnet through NEAR Intents. D016 records no Intents testnet. A fixture label does not make an unsupported route valid. Use an explicitly conceptual mainnet candidate with network/asset/fees unverified, no successful receipts, approval counts or delivery times; separate direct NEAR testnet escrow flow. Do not invent supported routes or exact fees.
2. Testnet sample owners/organizers use .near names; align native testnet examples with .testnet and keep examples explicitly synthetic, without claiming existence/control. Social-login verification requires a separate NEAR ownership proof; do not show Verified merely because Google login occurred.
3. Organizer roster offers Claim on a withdrawn participant row. Organizer must have no participant claim action; replace with read-only refund status/details and immutable beneficiary information. Participant signs own claim.
4. Discovery desktop hero CTA backgrounds are cut off flat at bottom in 01a. Re-render with full 44+px control bounds and rounded corners. Mobile pass expiry label nearly touches Refresh QR; allow wrapping/spacing and adequate touch target.
5. Calendar consistency: Nov 25 2026 is Wednesday, Nov 30 Monday, Dec 5 Saturday. Correct weekday labels in all relevant frames and do not mislabel registration close as cancellation cutoff.
6. Before final product UI approval complete minimum host create/edit, scanner pending -> organizer signed confirmation, pass list, and critical mobile signin/binding/funding/refund screens. Other remaining pages may be a subsequent explicit design milestone, not silently dropped. All unproven wallet checkout steps remain provisional. Static designs do not prove keyboard/zoom/camera behavior.

Live desktop: earlier Codex attached inspect_ui succeeded on the saved file; worker later found no listener. Current independent inspection also found no 47800 listener. These are time-specific observations; neither establishes continuous worker attachment. Restart desktop in persistent Orca-managed terminal and require worker attach/read before useful revisions. Human viewing cannot be inferred from a bridge response.
