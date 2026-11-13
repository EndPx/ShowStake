# Local factory review report

Candidate source uses caller-supplied, length-and-hash-pinned leaf bytes and explicit mainnet/testnet provider identity. Failed or mismatched recovery probes remain Pending. Child funding refunds use a claim and private receipt callback; an uncertain in-flight transfer is not retried automatically. Exact attached quote and zero-deposit replay avoid untracked excess-refund promises.

PASS_LOCAL: WSL Ubuntu cargo +1.99.1 test --locked --offline --test test_factory, 25 tests. Tests use a mocked VM, not chain receipts. Oversized callbacks remain unresolved and do not authorize refund or retry.

NOT_RUN: mainnet factory deployment, selected browser wallet approval of the large code payload, callback-loss recovery and provider-funded calls. Factory FullAccess remains a trust boundary. Keyless children are immutable and retain the pinned leaf's unresolved Rhea provenance/recovery limitations; provisioning does not authorize USDC funding.

PASS_LOCAL current-source Sandbox: `factory-smoke-20261112T231835Z-243524`; both network configurations reached Ready at 120 Tgas with matching parent/child policy. Optimized factory 197066 bytes, SHA-256 `4beb7acfa2cc1eb226ff37210e957c6f5f98fa504c7c435caf8aa5d77c410904`; pinned leaf 224939 bytes, SHA-256 `03076c4a9496e8ae1e6af68c791752d4a7220597942effd0c3a1839a252be9d2`. Mainnet-label child storage 225374 bytes; registry growth 572 bytes; quote 2268220000000000000000000 yoctoNEAR. Code hash/keylessness/pause/cap0/noevent verified. Synthetic preexisting child produced claimable funding, then native Paid and duplicate denial. Teardown reports ownership_verified/proven_stopped true, remaining empty. Earlier evidence predates the policy correction and is preserved as historical evidence.

The retained optimized artifact is under the local WSL cache, not a deployable mainnet release attachment. Fresh copying/build and portable clean-checkout rerun are BLOCKED_EXTERNAL after C: exhausted physical space and Ubuntu entered emergency_ro. `result.json` in this probe is supervisor text; receipt evidence is in `harness.log`. These filenames do not imply public-chain transactions.
