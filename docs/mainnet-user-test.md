# Mainnet shared-event user test

Updated 2026-11-14 Asia/Jakarta. Website: https://showstake.vercel.app/events/new.
Backend: https://srv1330754.hstgr.cloud. The activated V8 release implements the complete event lifecycle. The user signs their own event, USDC and Rhea transactions. Mainnet funded lifecycle acceptance is separate from code activation.

## Current V8 deployment

- Account: `showstake-mainnet-escrow-endpx-2026.near`.
- Policy/schema: `showstake-native-usdc-shared-yield/2`, schema2.
- Canonical USDC on NEAR: `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`, 6 decimals.
- Rhea: `contract.main.burrow.near`, internal supplied-share position.
- Wasm SHA-256: `2fdc615b6427858b8a351b03343385052353ef1b466caad47d16a19c49e24c53`.
- Code hash: `4Dq4uEH2PE9FEB7n67d3r3fvHPUy5KAvjhgZ8q5sX4PU`.
- [Upgrade receipt](https://nearblocks.io/txns/5nL4htVAQREWW3e7UniPoE5n8bCbD9cJ72REMWjcqiZb), block224507548, fee0.002184618005035NEAR.
- [Final before/after and receipt evidence](evidence/shared-mainnet-upgrade-v8-20261114/).

One account hosts multiple events. Event creation pays its quoted storage reservation and gas; it does not deploy another Wasm. Native storage is not automatically refunded when an event finishes. Each wallet needs native NEAR for gas/storage; the amount reserved upfront may exceed the eventual burnt fee.

## Current website cycle — do X, see Y

1. Connect a NEAR mainnet wallet and sign its offchain NEP-413 login message. The organizer is the connected account; no nominated account or allowlist is required. Do not share private keys/seed phrases.
2. Fill event title/location/rules, USDC deposit, capacity and ordered registration/check-in windows. Allow enough time for all wallet approvals; avoid a check-in window of only a few minutes. Registration close is the shown cancellation cutoff; finalization deadline is24h after check-in closes. A valid commitment is final under D036: no voluntary withdrawal/rejoin.
3. Review rules, request the exact storage quote, sign **Publish event**, and **Verify receipt**. See the matching final event and follow its event link.
4. On **Organizer**, quote and approve shared-contract storage at canonical USDC and Rhea if missing. Review each native amount; these approvals are separate from participant token storage.
5. Each participant connects/signs in, opens **Registration actions**, and approves **Register my token storage** if needed. Enter a unique commitment ID and sign **Deposit and register**. This calls canonical USDC `ft_transfer_call` for the exact amount. Do not transfer USDC directly to the contract as a registration substitute.
6. **Verify final receipt**. See the final registration and onchain non-transferable pass. Pending, refunded or rejected deposits grant no seat. Record event/registration/pass IDs, account and hash.
7. After registration closes, organizer signs **Close registration**. Once check-in opens, sign **Supply provider**, verify its callbacks and see `Supplied`. The event's principal is now attributed to its own Rhea strategy shares.
8. Participant creates a short-lived check-in QR/token. Organizer submits it at **Check-in desk**, which produces only `PENDING_SIGNATURE`. Review the registration and separately sign **Mark attended** before check-in closes.
9. After check-in closes, sign **Finalize attendance** and verify `AttendanceFinalized`. Earn must already be `Supplied`; unmarked participants become no-shows.
10. Sign **Redeem provider**. Require final callbacks, `Redeemed`, actual returned USDC and the reconciled position. A displayed position or submitted hash is not redemption evidence.
11. Sign **Settle** and verify `Settled`. For five deposits of2USDC and two attendees, a zero-yield10USDC pool allocates5USDC to each attendee and0 to each no-show. Realized yield follows the contract's exact integer rounding. Zero-attendee settlement uses the refund allocation.
12. Each entitled beneficiary signs **Claim or refund**. Verify final payout/callback, `Paid`, wallet balance change, and remaining event liability. Failed FT transfers must restore the exact claim before a separate retry.
13. Organizer uploads materials; an authenticated attended pass can load/download them after settlement/redemption. A no-show or foreign pass is denied even if the resource URL is known.

For cancellation, sign **Cancel event** under its contract gate, redeem any supplied principal, then beneficiaries claim their refunds. Timeout refund uses the actual finalization deadline. Preserve saved attempts and known hashes after RPC timeouts; never blind-retry a deposit/provider action. Unknown/dispatched provider outcomes and shortfalls fail closed. Historical indexer429 is disclosed; direct FINAL_CHAIN reads do not claim cursor catch-up.

## Funding and verification status

**Funding** supports ETH on Base/Ethereum to canonical USDC in the connected participant's NEAR account. Review a fresh quote and its recipient/refund/fee details, then sign the source transfer once. Require final delivery before depositing into the event separately. Catalog/dry quote success is not funded delivery.

Code upgrade and byte equality are PASS_LIVE. The user's real mainnet cycle, returned-USDC liquidity and funded Intents delivery remain NOT_RUN until their receipts and balances are recorded. Rhea remains SELECTED_FOR_HACKATHON rather than TECHNICALLY_ACCEPTED solely from code activation.

Explorer source badge is separate from byte equality. The deployed NEP-330 view links the public repository but has `build_info:null`; the verifier request returned HTTP400 `No source metadata found`. No additional bytecode deployment is inferred solely to change that badge.

## Historical C81 CREATE-only guide

The sections below preserve the prior release and are superseded by the V8 guide above.

## Frozen contract

- Account: `showstake-mainnet-escrow-endpx-2026.near`.
- Policy: `showstake-native-usdc-multievent/1`.
- Wasm SHA-256: `c81cf3d7293c111fc29c930ac19f94d3c88cdcf4d7dcf70a73f73911c87999e7`.
- Code hash: `EUA9Rm9RvU6SwDbkAsqosP9JCSD4qBRhe75p5PnapdyY`.
- Size: 225667 bytes.
- Upgrade receipt: [Cpb4sh2B2ASAfLEQouz3sPq9DqN3JYsfJoiXxogqr3BJ](https://nearblocks.io/txns/Cpb4sh2B2ASAfLEQouz3sPq9DqN3JYsfJoiXxogqr3BJ).
- Actual upgrade fee: 0.0018191977271696 NEAR, below the approved 0.01-NEAR ceiling.
- No new account or factory was created. Existing native capital was reused.
- The user froze this release; no code edit or redeploy was performed afterward.
  The FullAccess deployment key remains in the local OS keychain; this is a release
  freeze, not a claim that upgrade authority was irreversibly removed.

## Do X, see Y

1. Open the website above and choose **Connect wallet**. Use a native NEAR mainnet
   wallet that supports the sign-in message and transaction approval.
2. Choose **Sign in** when requested. This is an offchain NEP-413 login message,
   not an asset transfer. The organizer is your connected account; no nominated
   organizer or account whitelist is required.
3. Enter title, location, rules, deposit amount in USDC, capacity, registration
   times and check-in times. Capacity defaults to5. Times use your browser's local
   timezone; finalization deadline is24h after check-in closes.
4. Press **Preview event rules**. See the atomic deposit and exact rules that will
   be sent. The USDC amount here is an event rule; no USDC moves during creation.
5. Press **Get storage quote**. See the live NEAR reservation for the exact rules
   and organizer, read with contract identity at one fresh final block.
6. Press **Publish event** and inspect the wallet's transaction. It calls
   `create_event` on the frozen shared contract, with the displayed NEAR quote.
   Approve it yourself. Contract code is not deployed again for each event.
7. Press **Verify receipt** when submission returns a hash. A hash or timer is not
   success: the page verifies the exact final transaction and matching onchain
   event rules/organizer before confirming.
8. Open **View the event**. It reads the event from the shared contract.
   Discover and Hosting in My Events also use verified contract reads so a stale
   indexer does not invent or hide creation authority.

The organizer's connected wallet needs native NEAR for the quoted reservation
and prepaid gas. The shared contract's existing balance does not pay a user's
create reservation automatically. A sample five-seat quote was approximately
0.228–0.229NEAR; it varies with metadata/account lengths. It is a conservative
reservation for event data and future participant records, not all gas or an
exact measurement of immediately consumed storage. This release does not provide
automatic withdrawal of unused native storage reservations.

## Rejected or interrupted wallet requests

The app saves the exact attempt before opening the wallet. A known hash is
restored after reload; an unknown hash remains recovery-only. Copy a hash from
your wallet if necessary, then verify that receipt. Do not blindly submit another
payment. Wrong signer, target, rules, code hash, quote, network or stale context
is rejected. If quote/rules change, obtain and review a new quote first.

No private key or seed phrase is needed in chat or in the website.

## Evidence and limits

[Mainnet upgrade and balance evidence](evidence/multievent-mainnet-upgrade-20261114/result.json)
is PASS_LIVE. [Frontend live preflight](evidence/multievent-mainnet-upgrade-20261114/frontend-readonly-ready.json)
is read-only; it submitted no create transaction.
[Actual legacy-Wasm migration and two-organizer CREATE](evidence/multievent-create-20261114/sandbox.json)
is PASS_LOCAL, not a public-chain create receipt.

Native wallet picker and browser form preview were checked publicly. A human
wallet-signed mainnet CREATE remains the user test above; no agent-created event
was authorized in the upgrade scope. Mainnet registration, pass issuance from
USDC, Rhea supply/redemption, settlement and claim are not accepted for this
frozen artifact. Their controls are visibly disabled. Concurrent Earn remains
required, with no single-active-event substitute.

Backend uses schema8 (25 PK tables,40 validated FKs). New code revision starts
at the verified upgrade block224402760 with a distinct consumer; the old cursor
is retained. Indexing is catch-up work, not financial authority. API/session
restart/replay/logout proof is separate from onchain settlement.

## Clarified release gate (2026-11-14)

The user clarified that the final contract freeze is conditional on full lifecycle E2E acceptance. This CREATE-only deployment is an intermediate release, not full-product acceptance. Reusing the existing contract account for a reviewed upgrade/migration is preferred over creating a second funded platform account. A factory model still creates separate event child accounts; shared multi-event storage does not. No further mainnet transaction is authorized or performed by this clarification alone.
