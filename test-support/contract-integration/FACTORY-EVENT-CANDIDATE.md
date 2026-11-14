# Factory event candidate: local runner manifest

Status: PASS_LOCAL for the v4 build, actual-Rhea-Wasm Sandbox, capacity and
old-state migration proofs; PASS_TESTNET for Mock USDC/MockEarn provisioning
and settlement. Mainnet funded Rhea withdrawal and full product acceptance
remain open. See `../../docs/evidence/atomic-factory-20261114/acceptance.json`
and `../../docs/testnet-factory-user-test.md`. Do not reuse historical hashes.

The factory is 219832 bytes, SHA-256
`c6c5a8daa5dcb0ab020b910299e2df9c4d5a6f262a46203f37b4759624e4f391`;
the leaf is 241187 bytes, SHA-256
`a90cc890fbda1d8e7166697551693de684a264b1a3bc86ff098f59371033514a`.
Schema 3 provisions `new_with_event` atomically. The empty-root migration is
`migrate_empty_multievent({})`.

Source inputs:

- `contracts/showstake/event-escrow-candidate/{Cargo.toml,Cargo.lock,lib.rs,src.rs,rhea_adapter.rs}`
- `contracts/factory/{Cargo.toml,Cargo.lock,src/lib.rs,tests/test_factory.rs}`
- `test-support/contract-integration/runner/{Cargo.toml,Cargo.lock,src/bin/factory_event_rhea_cycle.rs,src/bin/factory_event_mock_cycle.rs,src/bin/factory_event_migration.rs}`
- Existing reviewed local mock FT Wasm and separately captured public Rhea Wasm.

Build the linked leaf with `factory-event` first using the approved pinned Rust
and Binaryen environment. Hash the exact final Wasm bytes. Compile the factory
with `factory-event` and set `SHOWSTAKE_LEAF_WASM_LEN` to those bytes' decimal
length and `SHOWSTAKE_LEAF_SHA256` to their lowercase hexadecimal SHA-256.
Run leaf unit tests with `--features factory-event`, factory tests both without
features and with `--features factory-event`, then build both Wasm candidates.
Run the existing `showstake-product-runner` binary `factory_event_rhea_cycle`
with `FACTORY_WASM`, `LINKED_WASM`, `FT_WASM`, `RHEA_WASM` pointing to those
local artifacts. Preserve complete output and hashes under a new evidence path;
never overwrite earlier historical artifacts. Only a successful run earns
`PASS_LOCAL`; failed, blocked, or omitted checks retain their respective labels.

Run `factory_event_mock_cycle` with `MOCK_EARN_WASM` in place of `RHEA_WASM`
to exercise the testnet-shaped configuration against the existing MockEarn
fixture; this remains Sandbox evidence, not a testnet deployment.

For actual old-layout migration, independently verify MULTI_WASM against
`c81cf3d7293c111fc29c930ac19f94d3c88cdcf4d7dcf70a73f73911c87999e7`,
then run `factory_event_migration` with MULTI_WASM and FACTORY_WASM. It tests
empty and nonempty old-Wasm states; external FT/provider balances are not
queried by the migration and must be checked separately before a real upgrade.

Set EVIDENCE_DIR to a writable parent directory for the Rhea and migration
runners. Each invocation makes a unique subdirectory and records sanitized raw
transaction/receipt graphs plus balance and state snapshots. Review these for
secret exposure before promoting them into evidence.

The Rhea runner checks two distinct organizers and keyless children using the public
Rhea Wasm against synthetic Sandbox state and mock USDC. It tests concurrent
positions, invalid amounts/callers/duplicates, two 5 USDC payouts from five 2
USDC commitments, cancellation refunds, and a payout callback failure/retry.
External balances and provider positions require separate current-chain checks
before any migration. A missing redemption callback remains an explicit manual
reconciliation gate: the contract does not redispatch an unknown operation.

The candidate Cargo manifests configure cargo-near reproducible builds and the
repository URL. The image tag/digest were copied from the mock-earn manifest;
the coordinator matched the public registry digest, but has not established a
fresh image-based reproducible build or explorer verification.
Reproducibility is NOT established until a clean, committed source
snapshot is built and compared; factory inputs are explicit build environment
parameters, which SourceScan/Nearblocks do not currently support for automatic
verification according to the official cargo-near documentation.
