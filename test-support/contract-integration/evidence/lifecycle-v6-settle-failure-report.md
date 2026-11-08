# ShowStake v6 — settled redistribution payout-failure proof (supplemental)

- Task: `task_9f285f66a80f`, dispatch `ctx_12ed5877e0ef`
- Runtime: provider `new-provider`, model
  `deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated`, reasoning `max` from the
  current session model-usage metadata; the global `zai-api` / `GLM-5.3-Flash`
  selector was not used.
- Base commit: `9326694`
- Classification: **PASS_LOCAL only**; no testnet/live acceptance, no deploy.
- Manifest: `test-support/contract-integration/evidence/lifecycle-v6-settle-failure-manifest.json`

## The gap and the result

The existing failed-payout proof covered a cancellation/refund claim of exactly
`D` (100). It did not prove that a **settled redistribution amount greater than
`D`** survives a failed FT transfer. This supplemental proof uses a real
settled allocation of **17 from D10**:

1. Five normal canonical-FT `ft_transfer_call` deposits of 10 each
   (accepted principal 50); attendance pattern `T,F,T,T,F`.
2. Finalize, then permissionless settlement: the oracle-expected allocation is
   `17,0,17,16,0` and the on-chain claim for reg-0 is **17 Claimable**.
3. The beneficiary unregisters FT storage at zero balance, then claims. The FT
   transfer receipt fails; the private callback receipt succeeds.
4. The callback restores exactly **17**, not `D=10`: claim `Claimable`, amount
   17, paid_amount 0, no pending payout; totals `paid 0`, `pending 0`,
   `liability 50`; escrow and the contract FT balance 50; beneficiary balance 0.
5. FT storage is restored and the retry pays **17 exactly once**: claim `Paid`,
   paid_amount 17; totals `paid 17`, `pending 0`, `liability 33`; escrow and
   contract balance 33; beneficiary balance 17. Attempt 1 is `Failed`, attempt 2
   is `Succeeded`.
6. A participant-replayed private callback fails, a double claim after `Paid`
   fails, and the claim cannot create a second pending payout.

Product source did **not** change: `contracts/showstake/src/lib.rs` remains
`3b72b03b…` and the reviewed candidate Wasm remains
`f462ddcbb8b47ff03f4bea71c054cefe0d0a576b1346a0f9a55688c43307fd59`
(420,795 bytes). The fix is a focused unit regression plus a bounded
supplemental Sandbox case.

## Evidence

| Item | Value |
|---|---|
| Unit regression | `settlement_failed_payout_restores_allocated_share_not_principal`; **64/64** unit tests pass |
| Narrow Sandbox run | `20261108T014607Z-2373503-ae2e1e97`, `runner_case: settle-failure`, **103/103 checks**, 38 transactions |
| Failed claim | `CkVsgkpLTtFn3J8CG6skt5cegNYAhtuLHozLbRSAsB7r` — FT receipt failed, callback receipt succeeded |
| Stale private callback replayed by participant | `9mDjvR66NjYjue3W2GG5vLyxrqHNkGc74z9ZVdbzL2sb` — top-level failure |
| Storage unregister / restore | `51GVVFY8…` / `5385W9JE…` |
| Retry paid 17 once | `8qJez5BH7Y7YUfwz7MKAfo7JmQhvEtXUxiHhKQfPKbHi` — FT and callback receipts succeed |
| Double claim after paid | `EZWe39aQF1LiHvGmQRaujpbucxQNsz5TR173QW7WcJW` — top-level failure |
| Payout attempts | `pay-reg-0-1` Failed 17; `pay-reg-0-2` Succeeded 17 |
| Oracle | accepted module `61b92691…`, expected file `d4b8a1cd…`, scenario `settle-remainder`, payout 17 |
| Teardown | ownership verified, stopped proven, PGID 2373907, `remaining: []` |
| Run / result / teardown hashes | `0961a6a4…` / `a349761d…` / `63abf3b3…` |

Gas (receipt-level, real Sandbox): claim function 3.45 Tgas, failed FT receipt
1.56 Tgas, restoration callback 2.61 Tgas, retry FT receipt 1.86 Tgas, retry
callback 2.62 Tgas; settle at 5 registrations 5.92 Tgas; finalize 3.04 Tgas.

## Boundaries stated explicitly

- This narrow case uses **five normal canonical-FT `ft_transfer_call`
  deposits**. It has no bulk-funded synthetic registrations and no
  shortened-deadline patch.
- The preserved full 2,328-check run's capacity-200 settlement instance still
  uses **one real FT registration plus 199 bulk-funded synthetic
  canonical-FT receiver registrations**; those 199 deposits are not normal
  `ft_transfer_call` calls.
- The preserved full run's late-settlement leg shortens only the stored
  `finalize_deadline` to `checkin_close + 20s` via `sandbox_patch_state`, then
  crosses it with a real clock fast-forward; the real `+24h` derivation and
  exact boundary remain unit-tested.
- The failed transfer is forced by the beneficiary unregistering FT storage at
  zero balance, not by a mocked call.

## Preserved evidence

- Full v6 run `20261108T005435Z-1890976-5a5eacd9` (2,328/2,328) and its
  manifest/report/unit log are untouched.
- `latest.json` still points at the full run; this supplemental run has its own
  `latest-settle-failure.json` pointer.
- `fc49fb85…` (deployed), `d79ef24c…` (accepted v5), v1–v4 artifacts, the
  accepted settlement oracle source and all prior run folders are preserved.
- The full-run manifest records the source hashes used at that run; the
  current runner/wrapper/test hashes changed only by this supplemental
  test-only addition and are recorded in the supplemental manifest.

## Open gates

1. Codex acceptance of v6 with this supplemental 17-share failure proof.
2. Testnet deployment remains Codex-owned and NOT_RUN here; the v5 testnet
   instance remains valid.
3. Real 24-hour deadline remains PARTIAL (unit-tested plus a labelled shortened
   stored deadline with a real fast-forward).
4. API/worker projection schema remains unchanged.

No commit, push, deployment, key, real asset, paid service, or API/web/worker/
Node edit was made.
