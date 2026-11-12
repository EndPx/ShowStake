# Mainnet deployment proposal

Status: **PREPARED_LOCAL / NOT_DEPLOYED**. This proposal covers an empty, paused
contract only. It does not authorize USDC deposits, provider calls or a public pilot.

The reviewed artifact and initialization are pinned in
[release manifest](evidence/mainnet-review-release-20261113.json) and
[init arguments](evidence/mainnet-init-args-20261113.json).

- Network: NEAR mainnet.
- Proposed contract: `showstake-mainnet-escrow-endpx-2026.near`; recheck availability before account creation.
- Funder/organizer: `dc634c505ee6b86a9b615ed7ebef7fff6a235c3406163d35d4f0e60c576a27b5`.
- Native balance observed at final block 224257963: `0.25 NEAR`.
- Wasm: `test-support/contract-integration/wasm/showstake-mainnet-review.wasm`.
- SHA-256: `03076c4a9496e8ae1e6af68c791752d4a7220597942effd0c3a1839a252be9d2`.
- Size: 224,939 bytes. Code-only storage balance requirement: `2.24939 NEAR` at the inspected protocol configuration. This is reserved storage balance, not the gas fee.
- Proposed account funding: `2.30 NEAR`; maximum total native spend: `2.32 NEAR`, including up to `0.02 NEAR` for transaction fees. Stop rather than exceed the limit.
- USDC spend: **zero**. Provider calls: **none**. No event is created.
- Suggested funder balance: `2.50 NEAR`, requiring a `2.25 NEAR` top-up from the observed balance. A transfer into the account does not itself authorize spending.

## Build and review

Run `scripts/build-mainnet-review.sh` under the existing WSL Ubuntu environment.
The script uses Rust 1.99.1, locked offline dependencies, Binaryen 120 and WABT.
Existing tool location is configurable through `SHOWSTAKE_WASM_TOOLS`.
It runs 18 feature tests and five default tests before building and validating Wasm.
This host build is not a claim of container-reproducible source verification.

Codex and an independent Terra reviewer accepted this candidate only for the
proposed empty paused deployment. Rhea is **SELECTED_FOR_HACKATHON**, not
**TECHNICALLY_ACCEPTED**. The funded route still needs final provider transfer
provenance, withdrawal failure recovery and actual returned-USDC evidence.

## Commands prepared for separate scoped authorization

These commands are documented for review and **have not been executed**. The
funder key is in the local OS credential store; no private key is passed in a
command, environment variable, evidence file or chat.

Create a separate contract account instead of replacing the shared funder account:

```powershell
near account create-account fund-myself showstake-mainnet-escrow-endpx-2026.near '2.30 NEAR' autogenerate-new-keypair save-to-keychain sign-as dc634c505ee6b86a9b615ed7ebef7fff6a235c3406163d35d4f0e60c576a27b5 network-config mainnet sign-with-keychain send
```

Deploy and initialize in **one atomic action batch**. Never send a standalone
deployment followed by a later initialization: `new` is public before initialization.

```powershell
near contract deploy showstake-mainnet-escrow-endpx-2026.near use-file test-support/contract-integration/wasm/showstake-mainnet-review.wasm with-init-call new file-args docs/evidence/mainnet-init-args-20261113.json prepaid-gas '10 Tgas' attached-deposit '0 NEAR' network-config mainnet sign-with-keychain send
```

## Final receipt acceptance and recovery

After each authorized transaction, save the hash and FINAL receipt before proceeding.
Fetch deployed code at a final block and verify its bytes against the exact SHA-256.
Read `get_config`, `get_rhea_control`, and `get_event` at that same final block:
mainnet, canonical Circle USDC with six decimals, fixed organizer/provider,
policy `showstake-native-usdc-rhea-review/1`, `paused=true`, `principal_cap=0`, no event.
Verify the new account key, remaining native balance, gas and storage consumption.
No cap increase or unpause belongs to this proposal.

If account creation succeeds but deploy/init fails, retain the new account and its
key and inspect the final outcome. Retry only a known failed action after checking
code/state and the remaining budget. A missing hash or timeout is unresolved;
query the transaction instead of blindly creating or deploying again. If deploy/init
succeeds with unexpected configuration, stop while empty and do not fund USDC.

The frontend still defaults to testnet and rejects mainnet transactions until an
accepted deployment is explicitly configured. The five-person testnet results at
`http://localhost:3010/events/five-two-attendees/results` use Mock USDC and MockEarn;
they do not prove Rhea withdrawal liquidity.

The proposed account name was corrected to `.near` after live protocol inspection
reported a top-level minimum length of 65 and registrar-only root registration.
The earlier bare root name is superseded; `.near` availability was checked at final
block 224261600. CLI help parsing is not account creation or registrar acceptance.

## Lower budget measured on 2026-11-13

The same reviewed 224939-byte Wasm was actually deployed and initialized in a local
NEAR Sandbox with 2.30 NEAR and a 10 Tgas function-call allowance. Post-init storage
was 225503 bytes (2.25503 NEAR at 1e19 yocto/byte), paused/cap0/noevent verified.
See [local runtime evidence](evidence/mainnet-storage-budget-20261113.json).
Total transaction-plus-receipt gas includes deployment overhead outside that
function-call allowance. A larger 300 Tgas allowance failed with smaller funding
in the earlier local attempt; do not mistake prepaid reserve for the burned fee.

The revised 2.32 NEAR cap is a proposal for empty deployment only. Recheck mainnet
gas price at most 100000000 yocto/gas and storage at 1e19 yocto/byte; stop and
recalculate if either basis increases. Account registration/routing, account name
and protocol differences remain mainnet gates. No mainnet result is inferred
from this local experiment. Event state, provider registration and later activity
need additional funding beyond this empty deployment. No USDC/provider/public
deposits are enabled by this revision.

Six compiler/optimizer variants were measured on identical source. The best saved
only306 bytes (0.00306 NEAR of code storage), so the reviewed Wasm was retained.
The meaningful budget reduction comes from measured initial storage and a smaller
initializer gas allowance, preserving all lifecycle features and tests.
