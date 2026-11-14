# One-account shared-yield mainnet activation

Status: **EXECUTED_PASS_LIVE**, after the user funded the exact 0.60NEAR top-up and explicitly said "sudah nih, lanjut gass". New transaction `5nL4htVAQREWW3e7UniPoE5n8bCbD9cJ72REMWjcqiZb` finalized at block224507548; actual fee0.002184618005035NEAR. No new account, event, USDC transfer or provider supply/redeem was performed. [Final receipt and before/after](evidence/shared-mainnet-upgrade-v8-20261114/). The old C81 approval and transaction remain separate historical evidence. Never resend this upgrade; the submission marker is FINALIZED.

The user's selected product is one ShowStake contract with many event records. Every organizer connects their own wallet, pays the event's quoted native-NEAR storage/gas, and creates an event on the existing account. There is no organizer allowlist and no per-event Wasm deployment.

| Item | Exact proposed scope |
|---|---|
| Network | NEAR mainnet |
| Existing account / signer / fee payer | `showstake-mainnet-escrow-endpx-2026.near` |
| Current code hash | `EUA9Rm9RvU6SwDbkAsqosP9JCSD4qBRhe75p5PnapdyY` |
| New policy / schema | `showstake-native-usdc-shared-yield/2`, schema 2 |
| New Wasm | `test-support/contract-integration/wasm/showstake-shared-yield-v2.wasm` |
| SHA-256 | `2fdc615b6427858b8a351b03343385052353ef1b466caad47d16a19c49e24c53` |
| Code hash / size | `4Dq4uEH2PE9FEB7n67d3r3fvHPUy5KAvjhgZ8q5sX4PU`, 276035 bytes |
| Atomic transaction | Deploy Wasm + private `migrate_empty_create({})`, attached 10 Tgas, attached native deposit 0 |
| Native top-up | User sends **0.60 NEAR** to the existing contract before execution; no new account and no agent transfer from another project |
| Maximum upgrade transaction fee | **0.01 NEAR** from the contract balance |
| Canonical token | Circle native NEAR USDC, 6 decimals, `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` |
| Provider | Rhea `contract.main.burrow.near`; observed code hash `6Nek1MZ8cwJJ2xMQAUWup9V5AToYS9rkTxJfwo6BCpFa` |
| Agent USDC / supply / redeem / event creation | **None**; the user signs their own product trial |

The top-up funds additional code/state storage and native headroom; it is not a 0.60 NEAR gas burn. The latest pinned read had 2.2963707298412064 NEAR on the contract, no events, no USDC and no Rhea position. V8 empty migration used 276695 bytes in Sandbox, equivalent to 2.76695 NEAR at the inspected storage price. The exact-balance Sandbox control also passed with a 0.50 NEAR top-up; 0.60 is proposed for headroom rather than relying on its narrow transient storage margin. Preserve both successful and failed budget experiments with their actual pre-upgrade balances.

## Evidence reviewed before activation

V8: 20 unit tests, reproducible optimized build, two-event Sandbox runs using both MockEarn and the public Rhea Wasm, empty-C81 migration and nonempty rejection, and the real testnet 42-receipt lifecycle. Five deposits of 2 Mock USDC paid two attendees 5 each; cancellation paid five refunds of 2; provider and payout retry were verified. A separate capacity-200 Sandbox fixture measured finalize and settle below 300 Tgas; its synthetic registrations are explicitly labelled. These do not prove live Rhea withdrawal liquidity or a mainnet browser cycle.

Frontend source has connected-wallet create/deposit/pass/check-in/finalize/redeem/settle/claim, exact provider/token storage approvals, current-session funding recovery and receipt-based status. Mainnet shared-yield pin remains inactive until the new deployment is verified. Rhea is `SELECTED_FOR_HACKATHON`; a self-signed trial does not become `TECHNICALLY_ACCEPTED` until USDC returns and all technical gates pass.

## Execution and abort gates

1. Record a fresh final mainnet snapshot. Require the old C81 code, expected existing FullAccess key, empty event list, zero accepted/paid/pending/liability/reserved cash, no global operation, zero USDC and no Rhea position. Require the observed provider code hash, canonical token decimals and unchanged network configuration.
2. Rehash local Wasm; require the exact hash and size above. Require protocol storage price `10000000000000000000` yoctoNEAR/byte and gas price at most `100000000` yoctoNEAR/gas. Calculate a conservative pre-sign fee assessment from that block's actual transaction fee schedule, both actions, Wasm bytes, initializer gas and receipt/refund overhead; abort if it exceeds 0.01 NEAR. The checked mainnet snapshot gave 0.0093954734266208 NEAR including the helper's 2x margin. This is an operational assessment, not an EVM-style protocol-enforced max-fee field; prices can change after preflight. Recheck funded native balance before signing. The migration itself rejects nonempty or incompatible state.
3. Submit the atomic deploy+migration **once** after explicit scoped approval. Preserve its attempt marker before dispatch and known hash before receipt polling. An unknown outcome is read-only reconciliation, never permission to resend.
4. Verify final receipt, deployment digest, initializer, every action outcome, native fee ceiling, actual onchain Wasm, code hash, schema/policy, empty accounting/vault and unchanged access key. No USDC or provider action is part of the upgrade.
5. Apply reviewed backend migrations 0010/0011 with backup and rollback. Keep the old C81 deployment row and its two cursors. Insert a new revision with the exact V8 hash and actual upgrade block; use a new worker consumer. Never rewrite the old cursor to simulate catch-up.
6. Pin the confirmed mainnet release in the frontend and direct API, build, push the reviewed GitHub commit and deploy Vercel. Verify the public mainnet website and backend identity before presenting the user trial.

`node scripts/activate-shared-mainnet.mjs` performs **read-only preparation by default**. Signing additionally requires `--execute --authorization <local-audit-record.json>`. The local approval record is not a source of permission: Codex may create it only after reading the user's explicit approval of this exact scope. Current preparation reports a 0.60 NEAR funding deficit and does not create a submission marker or transaction. Never run the old C81 upgrade script to apply V8.

## User-signed cycle after activation

Connect a NEAR mainnet wallet. Create a small event, review its quoted native storage and gas, and sign. The organizer separately approves storage for the shared contract at canonical USDC and Rhea if needed; current read-only minima were 0.00125 and 0.10 NEAR respectively, but the website must re-quote before signing. A participant approves their own USDC storage if needed and deposits the event's exact USDC amount. Registration/pass is confirmed on chain. Organizer closes registration, supplies Rhea, marks attendance only after check-in, finalizes after the window, redeems, settles and beneficiaries claim. Every operation has a separate wallet approval and final receipt check.

For funding, the supported initial routes are ETH on Base or Ethereum to native NEAR USDC in the connected participant's NEAR account. Current dry quotes for 5 USDC returned HTTP 201 and passed validation. The user reviews a fresh funded quote and signs the source-chain transfer; a swap never creates registration or a pass. Unsupported chains/tokens remain unavailable. No funded swap or live delivery is claimed here.

Rhea withdrawal liquidity has not been proven on mainnet. Provider ambiguity or shortfall blocks the affected strategy workflow; there is no public partial-withdrawal method. Concurrent event ownership is supported while provider transactions are serialized, and claims require final redemption. The mainnet trial must record USDC before/after, position, provider receipts, fee and final returned USDC. Do not describe this as an audited or proven production financial service.
