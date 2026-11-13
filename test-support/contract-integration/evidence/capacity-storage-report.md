# Capacity and organizer storage funding — local Sandbox

**PASS_LOCAL only.** Frozen candidate leaf SHA-256 `03076c4a9496e8ae1e6af68c791752d4a7220597942effd0c3a1839a252be9d2`; FT fixture `d1c7d009a2c49bee5ad4997fe7e3114899fa667a06876fb6e435d9a72fffb195`; zero-yield MockEarn `f780dcf30e3e23b236f842770be08ba1a763d99e9df702b56c4a1874b7a2b1d9`. Full evidence: `runs/capacity-storage-20261112T231630Z-213263/harness.log` and `teardown.json`. A prior 200-deposit run ended before finalization because its time fast-forward did not advance far enough and is not lifecycle evidence.

The 200 distinct accounts were locally bootstrapped; FT registration and funding used normal FT actions. Every accepted registration was a real `ft_transfer_call` of `2000000` token atomics; `accepted_principal` was `400000000`. No financial contract state was patched. The event ID and commitment IDs were 128 bytes, account IDs 64 bytes, title 256 bytes, location 512 bytes, and rules text 8192 bytes. One native `Transfer` plus `create_event` was executed in the same organizer-signed transaction. The full run's escrow had 30 NEAR bootstrap plus 5 NEAR top-up; it did not model a factory-funded child balance.

| Point | Account storage bytes | Growth since event creation |
| --- | ---: | ---: |
| Deployed before event | 225396 | — |
| Event created | 234680 | 0 |
| 1 accepted | 236948 | 2268 |
| 5 accepted | 246020 | 11340 |
| 200 accepted | 690890 | 456210 |

At the measured `10^19` yoctoNEAR per storage byte, the final 690890 bytes require **6.9089 NEAR**; compared with the observed factory funding of 2.2625 NEAR, the difference is **4.6464 NEAR**, before operational headroom. The account identifiers and stored Borsh values have bounded lengths in this scenario; growing registration/pass sequence digits change the per-entry amount, so the first-entry 2268 bytes cannot simply be multiplied by 200. The 456210-byte total is the measured 200-entry baseline for these maximum-length inputs, not a proof that every future state or different config fits. A product quote should use checked integer arithmetic, current storage_byte_cost, actual account balance/storage, separately bounded metadata, capacity and a safety reserve; it must not assume this observation covers later features or protocol changes.

MockEarn supply and redemption reached their expected states and returned principal with zero yield. `finalize_attendance` burned **135.160925007347 Tgas**; `settle` burned **112.893114938299 Tgas**, each with 300 Tgas prepaid. All 200 attendees were unmarked and became no-shows, so these measurements cover that branch only; they do not prove every attendance/yield distribution pattern. Sandbox account setup and time fast-forward are local test scaffolding, and this does not prove Rhea behavior.

Separate top-up run `runs/capacity-storage-20261112T231553Z-200494/` bootstrapped the leaf, then drained native funds so its pre-batch balance was `2298148528736196600000000` yoctoNEAR (about 2.29815 NEAR). An organizer transaction containing `Transfer` of 5 NEAR followed by `create_event` succeeded, using **3.055696287928 Tgas**, and created the same maximum-sized metadata. Its deployed storage was 225396 bytes and event storage 234680 bytes. This account was near, but not identical to, the factory's 2.2625 NEAR child funding. Both runs have supervisor teardown confirmation and no public-network transactions.
