// Packet policy constants, verbatim citations and unresolved-gate register.
//
// Every CITATIONS entry is checked by test/citations.test.mjs:
//   1. the quoted sentence must appear verbatim in the immutable packet copy;
//   2. the cited file's SHA-256 must equal the pinned snapshot hash.
// If the packet changes, the oracle fails loudly rather than drifting silently.
//
// The oracle is TEST SUPPORT. It is not a contract implementation, not an ABI
// decision, and not production settlement authority.

/** Pinned SHA-256 of the read-only packet copies this oracle cites. */
export const PINNED_PACKET_HASHES = Object.freeze({
  '01-PRODUCT.md': '322c20c615d35b3352fc9ee7d84fc629cdaa8d17c1f6e9621bad402189aed013',
  '02-ARCHITECTURE.md': '8cb2a31c485b72c060f7dd75da59a151c50093fece0c984afdd908af9f816f88',
  '03-DATABASE.md': '3a83f2dd63534d40fe3952063c31ff4db37e65e95466dc28834ebefaa0494b3f',
  '05-EXECUTION-AND-TESTS.md': '2ca7a6ad77da6bf19a1f52469ec5eb752b0e48607c51dc0789f92679f4a118b1',
  '06-DECISIONS-AND-SOURCES.md': '34f37ee9370c2856bd08c46ea3c21e43ec9c43018359ee665c37d25220d6fe2a',
  'schema.sql': '0e6afec55017ef15da3ab73f3a44ae23bca45c89856b268154a6cf45bc14c822',
});

/**
 * @typedef {{id:string, file:string, section:string, quote:string, use:string}} Citation
 * @type {readonly Citation[]}
 */
export const CITATIONS = Object.freeze([
  {
    id: 'CIT-SETTLE-FORMULA',
    file: '01-PRODUCT.md',
    section: 'Attendance / Settlement and refund',
    quote:
      'A>0: pool=M*D, q=floor(pool/A), r=pool mod A. Order attendees by immutable registration sequence; first r get D+q+1, rest D+q. No-shows get0. A=0: all remaining registrants refund D. Withdrawn participants separately retain D credit.',
    use: 'settlement.allocation and zero-attendee path',
  },
  {
    id: 'CIT-FEES-ZERO',
    file: '01-PRODUCT.md',
    section: 'Rules fixed at publish',
    quote: 'Platform fee0, organizer fee0. All no-show funds go to attendees.',
    use: 'no fee deduction; pool is entirely redistributed',
  },
  {
    id: 'CIT-CANCEL',
    file: '01-PRODUCT.md',
    section: 'Settlement and refund',
    quote: 'Host cancels before settlement: all remaining participants principal refund, no reward.',
    use: 'cancelEvent full-principal claims',
  },
  {
    id: 'CIT-REFUND-ONLY',
    file: '01-PRODUCT.md',
    section: 'Settlement and refund',
    quote: 'Anyone activates refund-only after deadline without finalization: same full-principal result.',
    use: 'activateTimeoutRefund full-principal claims',
  },
  {
    id: 'CIT-SETTLE-AFTER-DEADLINE',
    file: '01-PRODUCT.md',
    section: 'Settlement and refund',
    quote: 'Already finalized before deadline can settle after deadline.',
    use: 'settle permitted after finalize_deadline once ATTENDANCE_FINALIZED',
  },
  {
    id: 'CIT-NO-EXPIRY',
    file: '01-PRODUCT.md',
    section: 'Settlement and refund',
    quote: 'No expiry/admin sweep of claims.',
    use: 'claims never expire; no admin sweep op exists',
  },
  {
    id: 'CIT-SETTLE-PERMISSIONLESS',
    file: '01-PRODUCT.md',
    section: 'Settlement and refund',
    quote: 'Settlement permissionless once finalized.',
    use: 'settle actor is not restricted to organizer',
  },
  {
    id: 'CIT-CANCEL-CHUNK-LOCK',
    file: '01-PRODUCT.md',
    section: 'Settlement and refund',
    quote:
      'Cancellation cannot overwrite partially executed allocation; if chunking needed, enter SETTLING immutable state before chunks, disallow cancellation then, permit recovery continuation by anyone.',
    use: 'SETTLING state, CANCELLATION_LOCKED, permissionless chunk continuation',
  },
  {
    id: 'CIT-CHUNK-IDEMPOTENT',
    file: '01-PRODUCT.md',
    section: 'Settlement and refund',
    quote:
      'Measure max200 gas; if one-call exceeds safe bound, chunk with frozen cursor and sum verification; claims disabled until allocation complete. Idempotent chunks.',
    use: 'chunk cursor, idempotent replay, claims disabled until complete, sum verification',
  },
  {
    id: 'CIT-TIME-WINDOWS',
    file: '01-PRODUCT.md',
    section: 'Rules fixed at publish',
    quote:
      'Registration allowed open<=now<close; voluntary withdrawal now<cutoff; check-in open<=now<close; host finalization checkin_close<=now<deadline. At deadline, late finalization denied. Contract block time controls eligibility.',
    use: 'phase gates and exact boundary eligibility',
  },
  {
    id: 'CIT-FINALIZE-DEADLINE',
    file: '01-PRODUCT.md',
    section: 'Rules fixed at publish',
    quote: 'finalize_deadline=checkin_close+24h',
    use: 'fixed 24h finalization timeout',
  },
  {
    id: 'CIT-CAPACITY',
    file: '01-PRODUCT.md',
    section: 'Rules fixed at publish',
    quote: 'Event has fixed positive deposit D, capacity1..200',
    use: 'deposit > 0 and capacity bounds 1..200',
  },
  {
    id: 'CIT-IDENTITY-BIND',
    file: '01-PRODUCT.md',
    section: 'Identity',
    quote: 'Every registration binds one verified NEAR participant_account and immutable beneficiary to an event.',
    use: 'participant == beneficiary at commit; beneficiary immutable',
  },
  {
    id: 'CIT-ONE-ACTIVE',
    file: '01-PRODUCT.md',
    section: 'Identity',
    quote: 'One active registration per NEAR account/event.',
    use: 'duplicate active registration denial; withdrawal frees the seat',
  },
  {
    id: 'CIT-PASS-OWNER',
    file: '01-PRODUCT.md',
    section: 'Nontransferable pass',
    quote: 'Immutable owner=participant_account.',
    use: 'pass owner immutable and equal to participant',
  },
  {
    id: 'CIT-PASS-NO-TRANSFER',
    file: '01-PRODUCT.md',
    section: 'Nontransferable pass',
    quote: 'Reject all ordinary transfer/approval paths and admin reassignment; no collectible transfer after the event.',
    use: 'transfer/approve/admin reassignment rejections',
  },
  {
    id: 'CIT-WITHDRAW-ENTITLEMENT',
    file: '01-PRODUCT.md',
    section: 'Nontransferable pass',
    quote: 'Withdrawing/refunding changes entitlement, not historical owner.',
    use: 'withdrawn pass keeps historical owner; only entitlement/check-in changes',
  },
  {
    id: 'CIT-CLAIM-EXACTLY-ONCE',
    file: '01-PRODUCT.md',
    section: 'Settlement and refund',
    quote:
      'Claim receiver always immutable beneficiary. Reserve before async FT transfer; private callback finalizes or restores exactly once. One pending payout per registration. Incoming duplicate click/callback cannot pay twice.',
    use: 'claim reserve, pending state, private callback, exactly-once restore',
  },
  {
    id: 'CIT-CONSERVATION',
    file: '01-PRODUCT.md',
    section: 'Settlement and refund',
    quote: 'Invariant per event: accepted_principal = successful_payouts + pending_payouts + outstanding_liabilities.',
    use: 'per-event conservation assertion after every operation',
  },
  {
    id: 'CIT-ISOLATION',
    file: '01-PRODUCT.md',
    section: 'Settlement and refund',
    quote: "No event may consume another event's liabilities.",
    use: 'per-event ledgers and cross-event claim denial',
  },
  {
    id: 'CIT-WITHDRAW',
    file: '01-PRODUCT.md',
    section: 'Settlement and refund',
    quote:
      'Voluntary withdrawal marks WITHDRAWN and frees seat once before cutoff, grants D claim; failed payout does not restore registration.',
    use: 'withdrawal once, seat freed, D credit, failed payout leaves WITHDRAWN',
  },
  {
    id: 'CIT-REJOIN',
    file: '01-PRODUCT.md',
    section: 'Settlement and refund',
    quote:
      'May rejoin before close with new ID; old pass invalid for check-in. Old financial claim remains payable.',
    use: 'rejoin gets new registration/pass; old claim and pass separation',
  },
  {
    id: 'CIT-REFUND-ONLY-STATE',
    file: '01-PRODUCT.md',
    section: 'Attendance',
    quote: 'At deadline, unfinalized PUBLISHED may become REFUND_ONLY permissionlessly.',
    use: 'refund-only only from unfinalized PUBLISHED; permissionless actor',
  },
  {
    id: 'CIT-TERMINAL',
    file: '01-PRODUCT.md',
    section: 'Attendance',
    quote: 'Financial phases immutable terminally; chain order determines races.',
    use: 'terminal states cannot revert (cancel/refund-only/settled)',
  },
  {
    id: 'CIT-U128-DB',
    file: '03-DATABASE.md',
    section: 'PostgreSQL design',
    quote: 'PostgreSQL exact numeric atomic_amount is limited to u128',
    use: 'u128 ceiling for every amount',
  },
  {
    id: 'CIT-U128-CHECK',
    file: 'schema.sql',
    section: 'atomic_amount domain',
    quote: 'VALUE <= 340282366920938463463374607431768211455',
    use: 'canonical u128 maximum value',
  },
  {
    id: 'CIT-D05',
    file: '05-EXECUTION-AND-TESTS.md',
    section: 'Acceptance matrix',
    quote: 'Float/overflow/negative atomic values rejected',
    use: 'malformed/overflow/negative rejection tests',
  },
  {
    id: 'CIT-JSON-MONEY',
    file: '02-ARCHITECTURE.md',
    section: 'API contract',
    quote: 'JSON money strings',
    use: 'all public oracle views serialize amounts as base-10 strings',
  },
  {
    id: 'CIT-F01',
    file: '05-EXECUTION-AND-TESTS.md',
    section: 'Acceptance matrix',
    quote: '20 deposits5m,16 attendees ->each6.25m,total100m',
    use: 'F01 worked vector',
  },
  {
    id: 'CIT-F02',
    file: '05-EXECUTION-AND-TESTS.md',
    section: 'Acceptance matrix',
    quote: '5 deposits10,3 attendees ->17,17,16 ordered by registration,independent of claim order',
    use: 'F02 worked vector',
  },
  {
    id: 'CIT-F03',
    file: '05-EXECUTION-AND-TESTS.md',
    section: 'Acceptance matrix',
    quote: '6 deposits10,1withdrawal,3 attendees ->10 refund+17+17+16=60',
    use: 'F03 worked vector',
  },
  {
    id: 'CIT-EXAMPLE-5',
    file: '01-PRODUCT.md',
    section: 'Settlement and refund',
    quote: 'Five deposits10 units,3 attendees ->17,17,16.',
    use: 'packet settlement example',
  },
  {
    id: 'CIT-EXAMPLE-6',
    file: '01-PRODUCT.md',
    section: 'Settlement and refund',
    quote: 'Six deposits10 with1 withdrawn and3 attendees among5 ->withdrawn10 plus17,17,16=60.',
    use: 'packet withdrawn-credit example',
  },
  {
    id: 'CIT-EVIDENCE-LABELS',
    file: '06-DECISIONS-AND-SOURCES.md',
    section: 'Evidence labels',
    quote: 'PASS_LOCAL: fixture/sandbox.',
    use: 'result labelling vocabulary',
  },
]);

/**
 * Fixed numeric policy derived from the packet (not tunable by the oracle).
 * Values are bigint where money; small counts stay numbers.
 */
export const POLICY = Object.freeze({
  CAPACITY_MIN: 1,
  CAPACITY_MAX: 200,
  FT_DECIMALS_MIN: 0,
  FT_DECIMALS_MAX: 38,
  FINALIZE_TIMEOUT_MS: 24 * 60 * 60 * 1000,
  PLATFORM_FEE_ATOMIC: 0n,
  ORGANIZER_FEE_ATOMIC: 0n,
  /** First r attendees receive exactly one extra atomic unit. */
  REMAINDER_BONUS_ATOMIC: 1n,
  /** Default interpretation of "after deadline" for refund-only activation. See OG-01. */
  REFUND_ONLY_DEADLINE_MODE: 'AT_OR_AFTER',
});

/**
 * Transitions the packet states explicitly. Anything else is rejected by the
 * engine; genuinely unspecified cases are recorded in OPEN_GATES, not invented.
 */
export const EXPLICIT_EVENT_TRANSITIONS = Object.freeze({
  PUBLISHED: Object.freeze(['ATTENDANCE_FINALIZED', 'CANCELLED', 'REFUND_ONLY']),
  ATTENDANCE_FINALIZED: Object.freeze(['SETTLING', 'CANCELLED']),
  SETTLING: Object.freeze(['SETTLED']),
  SETTLED: Object.freeze([]),
  CANCELLED: Object.freeze([]),
  REFUND_ONLY: Object.freeze([]),
});

/**
 * Unresolved packet semantics. Each entry supplies test vectors/notes rather
 * than an invented assumption. The oracle picks the documented DEFAULT for
 * executable tests, but the gate remains open for Codex/contract authority.
 */
export const OPEN_GATES = Object.freeze([
  {
    id: 'OG-01',
    title: 'Refund-only exact-deadline boundary',
    packet: '"Anyone activates refund-only after deadline" and finalization is allowed for checkin_close<=now<deadline.',
    unresolved: 'Whether now == finalize_deadline satisfies "after deadline" (>=) or requires >.',
    oracleDefault: "POLICY.REFUND_ONLY_DEADLINE_MODE = 'AT_OR_AFTER' (now >= deadline).",
    vectors: ['refund-only at deadline-1 denied', 'at deadline allowed by default', 'alternative AFTER mode denies exactly at deadline'],
  },
  {
    id: 'OG-02',
    title: 'Aggregate u128 overflow policy',
    packet: 'D05 requires overflow rejection; each amount is u128; settlement sums multiple deposits.',
    unresolved: 'The contract error code/chunking behaviour when accepted_principal + D > 2^128-1 is not specified.',
    oracleDefault: 'Reject a deposit that would push accepted_principal past u128; return it in full; never wrap.',
    vectors: ['D=2^128-1 single deposit accepted', 'second deposit overflows aggregate and is returned'],
  },
  {
    id: 'OG-03',
    title: 'Cancellation after REFUND_ONLY',
    packet: 'REFUND_ONLY is permissionless at timeout; PUBLISHED/ATTENDANCE_FINALIZED may cancel before settlement; phases are terminally immutable.',
    unresolved: 'Whether cancel_event may relabel an already REFUND_ONLY event; economic result is identical (full principal).',
    oracleDefault: 'REFUND_ONLY is terminal; cancel is denied; vectors record the identical full-principal amounts either way.',
    vectors: ['cancel after refund-only denied', 'refund-only full-principal allocation'],
  },
  {
    id: 'OG-04',
    title: 'Claim timing for withdrawn credit',
    packet: '"grants D claim" on withdrawal, but claim window state gating is not explicit.',
    unresolved: 'Whether the withdrawn D claim is payable before the event settles/finalizes.',
    oracleDefault: 'Withdrawn claim is CLAIMABLE immediately and remains payable through cancellation/refund-only.',
    vectors: ['claim withdrawn credit while event PUBLISHED', 'claim after cancel'],
  },
  {
    id: 'OG-05',
    title: 'Stale success callback after failure + reclaim',
    packet: '"private callback finalizes or restores exactly once"; one pending payout per registration.',
    unresolved: 'Behaviour when a success callback for an already-FAILED payout arrives after the credit was restored and re-claimed.',
    oracleDefault: 'Callbacks are keyed by payout_id and only a PENDING payout can transition; any later callback is CALLBACK_STALE with no effect.',
    vectors: ['p1 FAILED -> reclaim p2 -> late p1 SUCCEEDED is stale and does not pay twice'],
  },
  {
    id: 'OG-06',
    title: 'Chunking necessity and gas bound',
    packet: 'Measure max200 gas; chunk if one call exceeds a safe bound (G09 OPEN_GATE).',
    unresolved: 'Whether 200-registration settlement fits one call; exact gas threshold.',
    oracleDefault: 'No gas claim. Both one-shot and chunked paths are modelled; only semantics are tested.',
    vectors: ['one-shot == chunked allocation', 'idempotent chunk replay', 'claims disabled during SETTLING', 'cancel locked during SETTLING'],
  },
  {
    id: 'OG-07',
    title: 'A=0 terminal event-state label',
    packet: 'A=0: all remaining registrants refund D.',
    unresolved: 'Whether A=0 settlement ends in SETTLED (vs REFUND_ONLY) is not named; amounts are explicit.',
    oracleDefault: 'An ATTENDANCE_FINALIZED event with A=0 settles to SETTLED with full-principal claims.',
    vectors: ['A=0 allocation equals D per remaining registrant', 'A=0 claims sum to N*D'],
  },
  {
    id: 'OG-08',
    title: 'Multiple payable claims for one beneficiary account',
    packet: 'Rejoin creates a new registration; old financial claim remains payable.',
    unresolved: 'Whether overlapping claims for one beneficiary across distinct registrations are paginated/limited.',
    oracleDefault: 'Distinct registrations have distinct claims; both are independently payable; duplicate clicks on one registration are denied.',
    vectors: ['old + new rejoin claims both paid', 'same-claim duplicate denied'],
  },
]);
