# Mainnet CREATE user test

Updated 2026-11-14 Asia/Jakarta. Website: https://showstake.vercel.app/events/new.
Backend: https://srv1330754.hstgr.cloud. This release enables **event creation only**.
It does not accept mainnet USDC registrations or execute Rhea Earn.

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
