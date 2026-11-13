# Mainnet shared-contract CREATE upgrade

Status: EXECUTED_PASS_LIVE after explicit user approval. Transaction `Cpb4sh2B2ASAfLEQouz3sPq9DqN3JYsfJoiXxogqr3BJ` finalized at block224402760. Actual fee0.0018191977271696NEAR; no top-up, new account, USDC transfer or Rhea call. Receipt and before/after evidence: `evidence/multievent-mainnet-upgrade-20261114/`. The approved upgrade transaction and its artifact are immutable historical evidence; do not resend that transaction. On 2026-11-14 the user clarified that product freeze means after successful full E2E, not freezing this CREATE-only intermediate release. Further reviewed implementation and upgrade planning may continue; a new mainnet transaction still needs its own concrete reviewed scope and authorization.

Reuse `showstake-mainnet-escrow-endpx-2026.near`; create no new account or factory. Preserve its native balance and existing OS-keychain FullAccess key. Replace the empty single-event implementation with the reviewed multi-event CREATE implementation in one atomic deploy + private `migrate_empty_legacy` call.

| Field | Exact scope |
| --- | --- |
| Network | NEAR mainnet |
| Signer / fee payer | `showstake-mainnet-escrow-endpx-2026.near` itself |
| Old code hash | `CpnhymSeF785ZBVTaBZfW8ApsfMVUByNCrys8R2i8os` |
| New Wasm | `test-support/contract-integration/wasm/showstake-multievent-create-v2.wasm` |
| New SHA-256 | `c81cf3d7293c111fc29c930ac19f94d3c88cdcf4d7dcf70a73f73911c87999e7` |
| New code hash | `EUA9Rm9RvU6SwDbkAsqosP9JCSD4qBRhe75p5PnapdyY` |
| New code size | 225667 bytes |
| Policy | `showstake-native-usdc-multievent/1` |
| Initializer | private `migrate_empty_legacy({})`, 10 Tgas, attached deposit0 |
| Additional account funding | **0 NEAR** |
| Maximum total transaction fee | **0.01 NEAR**, from existing contract balance |
| Agent-created event / USDC / Rhea transfer | **Not included** |

Immediately before signing, require the old code hash and expected FullAccess public key, no event, paused/cap0/Idle, all Rhea shares/baselines0, USDC balance0 and provider position null. Capture final block, full old public state and native balance. Verify artifact SHA/code hash again, protocol storage price1e19 yocto/byte and gas price at most1e8 yocto/gas. Abort on a mismatch. The migration itself rejects nonempty or incompatible legacy state.

Exact command, only after this scope is explicitly approved and the checks above pass:

```powershell
near --quiet contract deploy showstake-mainnet-escrow-endpx-2026.near use-file test-support/contract-integration/wasm/showstake-multievent-create-v2.wasm with-init-call migrate_empty_legacy json-args '{}' prepaid-gas '10 Tgas' attached-deposit '0 NEAR' network-config mainnet sign-with-keychain send
```

Local proof: actual frozen03076 Wasm initialized first, then migrated with the new Wasm, followed by two different organizers creating independent events on the same contract. Duplicate ID, foreign organizer cancellation and resetting nonempty migrated state were rejected. Source unit tests: multi10, linked26 and default5 PASS_LOCAL. This is migration/CREATE proof, not Earn acceptance.

Measured Sandbox post-migration storage:226193 bytes (2.26193NEAR at the inspected storage price), and migration gas18387853528714. Last public contract balance:2.298189927568376NEAR, enough without a top-up under this scope. Mainnet fees remain bounded by0.01NEAR and actual final fees are recorded afterward. Storage quote for a sample five-seat event was0.22804NEAR, separate from gas and paid by the connected organizer when that user signs create_event. Every event quote must be refreshed from the final contract; this plan does not pay it.

After migration, verify new code/config, empty event list and zero accounting. Enable only public wallet-signed CREATE in the frontend, with exact quote, signer/event/context binding and final-receipt readback. Any connected organizer can create; no global organizer allowlist. Registration/Earn/mainnet USDC remain disabled by the contract's explicit provider gate. Concurrent Earn remains a required subsequent capability, not a single-active-event fallback.

Retire the old empty deployment revision operationally. Preserve its cursor/evidence, record the new verified upgrade block and code hash, and use a distinct worker consumer starting at that revision. Do not relabel a skipped historical scan as caught up. Rollback requires inspecting the actual state; never reinstall the legacy layout after events have been created.
