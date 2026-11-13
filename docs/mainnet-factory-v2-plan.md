# Mainnet global registry deployment plan

Status: READY_FOR_SCOPED_AUTHORIZATION. No transaction from this plan has been signed or broadcast.

This creates the public factory/registry needed for any organizer to provision a separate keyless EventEscrow. It does not supply Rhea, accept participant USDC, create an event, or technically accept the provider. The existing manual escrow is preserved.

| Field | Exact value |
| --- | --- |
| Network | NEAR mainnet |
| Payer | `dc634c505ee6b86a9b615ed7ebef7fff6a235c3406163d35d4f0e60c576a27b5` |
| New account | `showstake-factory-endpx-2026.near` |
| Factory artifact | `test-support/contract-integration/wasm/showstake-factory-global-v3.wasm` |
| Artifact bytes | 200691 |
| SHA-256 | `3819343c5024a4e6f290d8d45cc31c71f18ab35302e9b1783823fc3038ddf742` |
| NEAR code hash | `4mz84GLed1QuLke1kdggZMBwm1YhWaXhr9WiixAF9JJ5` |
| Factory schema/policy | 2 / `showstake-factory-d039-global-ready/2` |
| Pinned EventEscrow artifact | `showstake-linked-withdraw-candidate-v3.wasm` |
| Leaf SHA-256 / bytes | `49a591ba26a4a23d05c01cc343779f1c66aa5da0384e3a663a37f4e5edb59b70` / 235060 |
| Leaf NEAR code hash | `5xVC9cyZDeCJXpS8rhD4Hh3tNMBB4MNnvh5eYpW9y5Aw` |
| Account funding | 2.05 NEAR |
| Maximum additional transaction fees | 0.03 NEAR |
| Maximum payer debit for this plan | **2.08 NEAR** |

The reviewed initializer is:

```json
{
  "canonical_ft": "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "network": "mainnet",
  "policy_version": "showstake-native-usdc-rhea-linked-withdraw-review/2",
  "provider_account": "contract.main.burrow.near",
  "provider_kind": "RHEA_MAINNET"
}
```

Before signing, refresh final account availability, payer spendable balance, protocol storage price and gas price; verify local artifact hashes again. The read-only budget observation at block 224329273 found the target absent and payer balance 0.303054317868679672426612 NEAR. At that observation the deficit against the ceiling was 1.776945682131320327573388 NEAR; a 1.8-NEAR top-up would cover it. Funding alone does not authorize a transaction.

Create the account with a dedicated deployment key kept in the local OS keychain. Then atomically deploy and initialize, with no opportunity for third-party initialization. Save final receipts, actual fee, payer/account balances, code hash, config and access-key inventory. If account creation finalizes but deploy fails, inspect the account and exact receipt; retry only the reviewed deploy after proving no initialization occurred. Never repeat account creation blindly or overwrite an unknown contract.

After final deployment, verify schema, immutable canonical USDC/provider/leaf identity, empty registry, no USDC funding and no children. The factory account's deployment key is upgrade authority; keep it outside the repository and VPS. Factory children are keyless. Any factory code upgrade invalidates frontend/worker code-hash trust until separately reviewed.

Acceptance before this plan: 26 linked-leaf unit tests, 18 legacy unit tests, 5 default unit tests, storage-budget test, 29 factory unit tests, and real local Sandbox provisioning for two organizers with successful refund of failed child funding. The actual public Rhea Wasm was also exercised in a separate clean Sandbox with five 2-Mock-USDC deposits, a controlled failed withdrawal and retry, and two 5-USDC payouts. These are PASS_LOCAL, not mainnet liquidity evidence.

Organizer-paid child provisioning is a separate wallet approval. The measured local quote for `organizer.sandbox` was 2.37037 NEAR, including child code/storage funding and registry storage; the live quote must be read for the actual organizer and factory. This collateral is separate from event USDC, FT/provider storage registration and transaction gas. This plan does not debit it.

Rhea remains SELECTED_FOR_HACKATHON, with technical acceptance pending actual funded mainnet return of USDC and the unresolved deployment/source/audit authority evidence. Public participant funding and event principal supply remain gated until their specific acceptance and spend scope are approved. No borrow, collateral, leverage or external signer is installed by this plan.
