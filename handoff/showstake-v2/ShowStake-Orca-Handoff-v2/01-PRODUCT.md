# ShowStake v2 product contract

MUST is required behavior. DEFAULT is a design choice proposed by this packet. OPEN_GATE is an unresolved capability; agents must not invent its outcome.

## Product

Tagline: Stake your spot. Show up.
Host publishes event -> participant funds NEAR account -> commits fixed FT deposit -> receives account-bound pass -> host attests check-in -> attendance finalizes -> contract settles -> participant claims -> attendee content unlocks.

Audience: community meetups/workshops. Goal is meaningful attendance commitments; actual reduction in no-shows requires pilot evidence. No claim of proven impact yet.

v2 release includes social/email login, EVM-wallet login, native NEAR-wallet login, direct NEAR deposit, proven EVM/non-EVM source routes, pass display/QR, host management, timeout/cancellation refunds, settlement, native claims, protected content, responsive UI, recovery evidence. Targets for source routes: Base and Solana subject to actual asset/quote availability. "Supported chains" is the public phrase, never "every chain".

Excluded: yield, platform token, AI, trade copying, marketplace, sub-account per pass, pass sale/transfer, admin reassignment, QR physical-presence guarantee, arbitration, sponsored-gas guarantee. Optional outbound conversion after native claim is separate from release-critical escrow lifecycle; show only if verified.

## Rules fixed at publish

One canonical allowlisted FT per deployment; exact network/contract/decimals recorded. Event has fixed positive deposit D, capacity1..200, organizer NEAR account, asset, times, policy version and rules hash. Platform fee0, organizer fee0. All no-show funds go to attendees. Gas/storage/swap costs separate and not refunded by escrow.

Times in UTC ms: reg_open < reg_close <= cancel_cutoff <= checkin_open < checkin_close; finalize_deadline=checkin_close+24h. UI includes venue timezone. Registration allowed open<=now<close; voluntary withdrawal now<cutoff; check-in open<=now<close; host finalization checkin_close<=now<deadline. At deadline, late finalization denied. Contract block time controls eligibility.

Financial rules/times/organizer/capacity immutable from publish. Title/description/location changes are versioned; changes of date/location that materially affect attendance require cancellation/new event, not an unnoticed edit. Cover/text typo corrections may remain editable with visible history.

## Identity

Every registration binds one verified NEAR participant_account and immutable beneficiary to an event. App identity may have multiple login methods; it is not the owner field on the pass. One active registration per NEAR account/event. This is not one-human-one-seat proof. Multiple unrelated accounts can belong to one human.

Before paying, show the selected NEAR account as pass/refund owner. Confirm participant account once for the attempt; reject later silent changes. Relinking Google/MetaMask to an app user does not move onchain rights. Recovery of the same NEAR account through legitimate wallet recovery is separate from transferring pass to a new account. Lost account access has no admin redirect in v2; explain before commitment.

## Nontransferable pass

Mint in the same event-contract receipt that accepts commitment and registration. Unique token/pass ID per commitment. Immutable owner=participant_account. Reject all ordinary transfer/approval paths and admin reassignment; no collectible transfer after the event. Withdrawing/refunding changes entitlement, not historical owner. User burn deferred because it must not destroy financial rights.

Selected implementation: custom account-bound NFT-like event credential with documented ownership/metadata views. UI term Event Pass. DO NOT claim full NEP-171 or NEP-393 conformance without implementing and testing the respective specification. NEP-393 includes recovery/soul-transfer semantics; it is not a synonym for disabling transfers. Standards review is T02 gate. Custom compatibility views may include nft_token but supported functions must be enumerated honestly. No external wallet gallery guarantee; ShowStake must render pass itself.

Fields: pass_id,event_id,registration_id,owner,issued_at,registration_status,attendance_status,financial_status,policy_version. No QR secrets or names/emails in public metadata. A pass proves registration, not physical presence.

## Funding and commitment

Baseline two-step funding: source wallet -> NEAR Intents route -> participant-controlled NEAR account -> participant-signed ft_transfer_call to ShowStake escrow. Direct NEAR users skip routing. Distinguish funding from RSVP: seat is confirmed only by escrow receiving exact D and emitting RegistrationCommitted.

Quote binds funding_attempt_id, source chain/asset, exact destination asset, receiving NEAR account, source refund address, amount, fee, min output and expiry. Verify control of source/refund and NEAR beneficiary. Prefer verified exact-output route; otherwise show shortfall/top-up. No hidden backend custody. Provider supported tokens/quote/routing features verified, never guessed from a ticker.

No seat reservation during conversion. Full/closed/cancelled event after swap leaves funds in user NEAR wallet; show "Funds received; registration not completed" and allow later use or explicit return quote. Failed transfer_call validation returns unused FT through resolver; confirm its actual outcome. Do not instruct plain ft_transfer to escrow. Unsupported direct transfers cannot create entitlement; quarantine/explain and never count as event principal.

Funding state CREATED -> QUOTED -> SOURCE_PENDING -> SWAP_SETTLED -> READY_TO_COMMIT -> COMMIT_PENDING -> COMMITTED. EXPIRED/FAILED/PROVIDER_REFUNDED/ACTION_REQUIRED retained. Timeout after submission -> UNKNOWN with status lookup, never automatic second spend.

Registration validates token predecessor, exact amount, unique(payer,commitment_id), event phase, capacity, active-account uniqueness and prepaid storage. Invalid/replayed payments return full unused amount. Valid path changes state/mints atomically within this contract receipt. Native account activation, FT storage, NFT storage and gas must be preflighted separately. Sponsor is OPEN_GATE; no native MON/Privy-EVM sponsor config transplanted.

## Attendance

Session proves NEAR account control. API validates official pass, owner, event, registration status and phase before issuing short-lived QR. QR signed by backend: random nonce, event/pass/owner, issued_at, expires_at (60s), key_id. No PII. Host scanner session must bind to organizer account.

Scan validation atomically creates a pending check-in request. Only organizer wallet can sign mark_attendance; backend has no organizer full-access key. Scan alone is not confirmed attendance. Nonce cannot be reused by another request; retry same request may resume after failed/rejected host transaction, or issue a new challenge. Onchain duplicate mark is idempotent. Host may manually attest in window; record private reason. Host may correct within window; after close set frozen. Host finalizes actual contract set/count, not database-supplied totals.

Event financial state: PUBLISHED -> ATTENDANCE_FINALIZED -> SETTLED. PUBLISHED/ATTENDANCE_FINALIZED may CANCEL before settlement. At deadline, unfinalized PUBLISHED may become REFUND_ONLY permissionlessly. Financial phases immutable terminally; chain order determines races.

Organizer attestation is a disclosed trust assumption. QR is possession/challenge assistance. Host can lie; v2 has no automatic dispute adjudication. Timeout refunds address host inactivity, not dishonesty.

## Settlement and refund

N remaining nonwithdrawn registrations, A attendees, M=N-A, D common principal. A>0: pool=M*D, q=floor(pool/A), r=pool mod A. Order attendees by immutable registration sequence; first r get D+q+1, rest D+q. No-shows get0. A=0: all remaining registrants refund D. Withdrawn participants separately retain D credit.

Host cancels before settlement: all remaining participants principal refund, no reward. Anyone activates refund-only after deadline without finalization: same full-principal result. Already finalized before deadline can settle after deadline. No expiry/admin sweep of claims.

Settlement permissionless once finalized. Measure max200 gas; if one-call exceeds safe bound, chunk with frozen cursor and sum verification; claims disabled until allocation complete. Idempotent chunks. Cancellation cannot overwrite partially executed allocation; if chunking needed, enter SETTLING immutable state before chunks, disallow cancellation then, permit recovery continuation by anyone.

Voluntary withdrawal marks WITHDRAWN and frees seat once before cutoff, grants D claim; failed payout does not restore registration. May rejoin before close with new ID; old pass invalid for check-in. Old financial claim remains payable.

Claim receiver always immutable beneficiary. Reserve before async FT transfer; private callback finalizes or restores exactly once. One pending payout per registration. Incoming duplicate click/callback cannot pay twice. Failed FT storage requires user action, not loss of claim.

Invariant per event: accepted_principal = successful_payouts + pending_payouts + outstanding_liabilities. Include withdrawn registrations. Sum events covered by actual canonical FT balance, account for unexpected unsolicited funds separately. Native storage funds separate. No event may consume another event's liabilities.

Examples:20*5,000,000 units,16 attendees ->16*6,250,000=100,000,000. Five deposits10 units,3 attendees ->17,17,16. Six deposits10 with1 withdrawn and3 attendees among5 ->withdrawn10 plus17,17,16=60.

## API content rights

Public event routes require no pass. Auth login/purchase requires no preexisting pass. QR requires valid committed account-bound pass + time. Host routes require organizer authority, not participant pass. Attendee materials require current authenticated pass owner, attended=true, event SETTLED. Cancelled/withdrawn/no-show pass denied content. Claim rights derive from escrow allocation, not solely token possession.

Private files stored in private object storage; issue <=60s signed URLs after <=30s-old final contract ownership/status check. Already downloaded data cannot be recalled. No public IPFS URL described as gated content.
