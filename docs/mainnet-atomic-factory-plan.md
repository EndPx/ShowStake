# Reviewed candidate: reuse the existing mainnet account as an event factory

Status: PREPARED, NOT AUTHORIZED OR EXECUTED. The earlier 0.01 NEAR approval funded transaction `Cpb4sh2B2ASAfLEQouz3sPq9DqN3JYsfJoiXxogqr3BJ` and is already consumed. This is a separate proposed transaction. Current production remains the intermediate CREATE-only implementation.

| Item | Exact proposed scope |
| --- | --- |
| Network | NEAR mainnet |
| Signer / receiver / fee payer | `showstake-mainnet-escrow-endpx-2026.near` |
| Required old code hash | `EUA9Rm9RvU6SwDbkAsqosP9JCSD4qBRhe75p5PnapdyY` |
| Candidate Wasm | `test-support/contract-integration/wasm/showstake-factory-atomic-event-v1.wasm` |
| Candidate SHA-256 | `c6c5a8daa5dcb0ab020b910299e2df9c4d5a6f262a46203f37b4759624e4f391` |
| Candidate code hash | `ENvY3jqpnMWnmQEBRjcvQkuJvELYMLkkqTC9wRBPjZ9J` |
| Bytes | 219832 |
| Private initializer, verified against source | `migrate_empty_multievent({})` |
| Function prepaid gas | 10 Tgas |
| Attached native deposit / top-up / new platform account | 0 / none / none |
| Maximum total native transaction debit | 0.01 NEAR from the existing account |
| USDC, Rhea supply, organizer event creation | Excluded from this upgrade scope |

The factory creates one keyless child escrow per event. Each child has its own account-level Rhea position, so two events can earn concurrently without sharing a pooled provider position. Public organizers sign and fund their own event provisioning transactions. They do not receive a FullAccess key for the child.

The leaf is pinned to SHA-256 `a90cc890fbda1d8e7166697551693de684a264b1a3bc86ff098f59371033514a`, code hash `CNuCzGqyU6Ypoz8qFtUvHKBESsEmppu4MW93WiZk6Au7`, 241187 bytes. Mainnet identity is native Circle NEAR USDC, contract `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`, 6 decimals, and Rhea `contract.main.burrow.near`, policy `showstake-native-usdc-factory-rhea/3`.

## Cost to an organizer

The observed five-seat browser event quoted **2.64218 NEAR**: contract/config 2.42481, rules 0.00543, participant storage reserve 0.2048 and registry 0.00714. This is an exact quote for those testnet rules, not a fixed mainnet price. The website must obtain a fresh mainnet quote before a wallet signs. Gas and FT/provider storage registration are additional, and USDC commitments are separate.

Most of that native amount reserves storage in the child; it is not all burned gas. The current leaf has no general native-storage-surplus withdrawal or account-deletion path. Do not promise that organizers can automatically reclaim unused native funding after settlement. Existing platform storage funding does not pay for a new event child.

## Preconditions and acceptance

Before any mainnet execution, independently recheck a fresh final block: the exact old code/public key; no events or registrations; zero accepted/paid/pending/liability/reserved cash and no global operation; USDC balance zero; Rhea position null; mainnet token/provider identities unchanged; native balance and current gas/storage prices sufficient for the full bounded debit. Abort on drift. The synchronous migration checks its exact reachable old state; the operator separately checks balances in other contracts.

The read-only checkpoint at block 224454143 observed old C81 code, an empty event list, USDC 0, null Rhea position and 2.2963707298412064 NEAR. That observation expires as an execution preflight and must be refreshed.

An atomic deploy plus private migration rejects incompatible/nonempty state. Actual old-Wasm-to-candidate migration was proven in Sandbox, including retention of old code and event when a nonempty migration fails; that is PASS_LOCAL, not a mainnet deployment receipt. Public Rhea Wasm was exercised in Sandbox with mock USDC and isolated concurrent events. Mainnet funded provider withdrawal and full product acceptance remain open.

The execution command below is a proposal only:

```powershell
near --quiet contract deploy showstake-mainnet-escrow-endpx-2026.near use-file test-support/contract-integration/wasm/showstake-factory-atomic-event-v1.wasm with-init-call migrate_empty_multievent json-args '{}' prepaid-gas '10 Tgas' attached-deposit '0 NEAR' network-config mainnet sign-with-keychain send
```

After authorization, write an attempt marker before signing, submit once, preserve any returned hash, and reconcile the full final receipt graph. Never retry an unknown transaction. Verify factory schema 3, policy, token/provider and leaf pins; install its API/worker allowlist only after that verification. Do not roll back to the old state layout after children or requests exist.

Rhea remains SELECTED_FOR_HACKATHON. Do not mark it TECHNICALLY_ACCEPTED or expose participant principal to an accepted release merely because a quote, local mock, sponsor listing, or receipt position exists. The separate reviewed treasury microtest in `evidence/rhea-microtest-plan-20261113.md` is still unsigned; actual USDC supply and return, provider authority/source/audit relationship and final integration review are separate gates.
