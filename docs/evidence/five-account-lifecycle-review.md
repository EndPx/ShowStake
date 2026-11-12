# Five-account native-USDC testnet increment

Status: PASS_TESTNET for this scenario; full browser/product acceptance remains open.

Reviewed source: `contracts/showstake/event-escrow-candidate/src.rs`.
Deployment: `ss-e2e-1113013557.testnet`; FT `mockusdc.testnet` (6 decimals).
Earn fixture: `ss-earn-1113013557.testnet`, explicitly `MOCK_TESTNET`, zero yield.
This fixture does not prove Rhea liquidity or mainnet supply/redeem.

Five separate testnet accounts deposited 2,000,000 atomic FT each and received
account-bound passes. Organizer marked registration sequences 1 and 3 attended.
The escrow supplied 10,000,000 to the fixture and reconciled the FT balance and
provider position after private async callbacks. After finalization, redemption
returned 10,000,000 to escrow. Settlement allocated 5,000,000 to each attendee
and zero to three no-shows. Both attendee claims finalized as Paid; each attendee
FT balance is 5,000,000. Escrow and provider balances/position are zero.

Read-only verification (does not broadcast):

```powershell
node scripts/verify-testnet-five-result.mjs docs/evidence/testnet-lifecycle-1113013557
```

Run result and final RPC-pinned observations: `testnet-lifecycle-1113013557/result.json`.
Actual final transaction outcomes are stored separately as `*.receipt.json`.

The initial runner stopped before claims because its donor-balance assertion
omitted 8 USDC transferred by the organizer to fund four test participants.
The assertion was corrected. Deposits/supply/redeem/settlement were not repeated;
only the two previously unsubmitted claims were sent. All transaction hashes are
preserved in `transactions.json`.

Codex reviewed the disjoint Terra changes and independently reran Rust unit
tests/build, read-only final receipts and actual balances. The tested contract
hash is recorded in EVENT_ESCROW_CANDIDATE_MANIFEST.json. No mainnet funds used.

Still open: browser wallet acceptance, create-event provisioning/factory,
candidate API/projection end-to-end, cancellation/timeout/failed-payout retry
testnet scenarios, max-capacity gas, and technically accepted Rhea integration.
Do not deploy this MOCK_TESTNET-only artifact to mainnet. The current bounded
test instance pays native storage from its own account; it has no fake prepaid
credit interface.
