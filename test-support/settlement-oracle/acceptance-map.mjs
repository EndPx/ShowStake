// Acceptance traceability for the local test oracle.
//
// Levels here describe ORACLE-MODEL coverage only:
//   PASS_LOCAL     behaviour is modelled and independently asserted locally
//   PARTIAL_LOCAL  part of the requirement is modelled; the rest needs the
//                  real contract/DB/concurrency/gas run
//   NOT_RUN        no local oracle evidence at all
//
// Every entry still needs real NEAR contract tests before it can be called
// contract acceptance. This file is not a release acceptance record.

export const ACCEPTANCE_MAP = Object.freeze([
  {
    id: 'C01',
    requirement: 'Exact canonical FT deposit accepted once with registration/pass in the same contract receipt.',
    level: 'PARTIAL_LOCAL',
    tests: [
      'oracle/test/identity-boundaries.test.mjs > exact canonical FT deposit creates registration and pass atomically in one result (C01)',
      'oracle/test/acceptance.test.mjs > every frozen acceptance vector settles end-to-end',
    ],
    citations: ['CIT-IDENTITY-BIND', 'CIT-PASS-OWNER'],
    limits: ['No real NEP-141 receipt; the oracle returns one atomic call result, not chain evidence.'],
  },
  {
    id: 'C02',
    requirement: 'Wrong amount/token/phase/duplicate commitment returned without seat or pass.',
    level: 'PASS_LOCAL',
    tests: [
      'oracle/test/identity-boundaries.test.mjs > wrong token, wrong amount, zero and malformed amounts are returned without a seat',
      'oracle/test/identity-boundaries.test.mjs > every malformed fixture amount is rejected by commitDeposit',
      'oracle/test/identity-boundaries.test.mjs > duplicate commitment replay grants no second seat',
      'oracle/test/identity-boundaries.test.mjs > registration phase closed and cancelled/full events reject with full return',
    ],
    citations: ['CIT-CAPACITY', 'CIT-ONE-ACTIVE'],
    limits: ['Validated as a single-threaded atomic call.'],
  },
  {
    id: 'C03',
    requirement: 'Capacity 1..200 and one active account/event enforced under concurrency.',
    level: 'PARTIAL_LOCAL',
    tests: [
      'oracle/test/publish.test.mjs > publish accepts capacity boundaries 1 and 200',
      'oracle/test/identity-boundaries.test.mjs > capacity 1 and 200 boundaries are exact (C03)',
      'oracle/test/identity-boundaries.test.mjs > duplicate active registration is denied; withdrawn account may rejoin',
      'oracle/test/refunds.test.mjs > withdrawal frees the seat once',
    ],
    citations: ['CIT-CAPACITY', 'CIT-ONE-ACTIVE'],
    limits: ['Sequential model only; simultaneous transactions/races are NOT_RUN.'],
  },
  {
    id: 'C04',
    requirement: 'owner=participant=beneficiary immutable; ordinary transfer/approval/admin reassign rejected.',
    level: 'PASS_LOCAL',
    tests: [
      'oracle/test/identity-boundaries.test.mjs > pass is account-bound: ordinary transfer, approval and admin reassignment are rejected (C04)',
      'oracle/test/identity-boundaries.test.mjs > beneficiary must equal the verified participant account at commit',
      'oracle/test/claims.test.mjs > claim receiver is the immutable beneficiary; relinking a login moves no rights',
    ],
    citations: ['CIT-PASS-OWNER', 'CIT-PASS-NO-TRANSFER', 'CIT-IDENTITY-BIND'],
    limits: ['Custom pass model, not NEP-171/NEP-393 conformance evidence.'],
  },
  {
    id: 'C05',
    requirement: 'Withdraw before cutoff frees seat once, creates credit; old pass invalid for check-in.',
    level: 'PASS_LOCAL',
    tests: [
      'oracle/test/refunds.test.mjs > withdrawal frees the seat once, invalidates the old pass, and grants a D claim (C05)',
      'oracle/test/refunds.test.mjs > failed payout never restores a withdrawn registration',
    ],
    citations: ['CIT-WITHDRAW', 'CIT-WITHDRAW-ENTITLEMENT', 'CIT-TIME-WINDOWS'],
    limits: ['Cutoff boundary is exercised from the packet time rule.'],
  },
  {
    id: 'C06',
    requirement: 'Rejoin new commitment keeps old refund separate; no duplicate active registration.',
    level: 'PASS_LOCAL',
    tests: [
      'oracle/test/refunds.test.mjs > rejoin creates a new registration/pass and keeps the old claim separate (C06)',
      'oracle/test/claims.test.mjs > claim order does not change per-registration F02 amounts',
    ],
    citations: ['CIT-REJOIN', 'CIT-ONE-ACTIVE'],
    limits: ['Multiple claims for one beneficiary are recorded as OG-08.'],
  },
  {
    id: 'C07',
    requirement: 'Storage failure/unexpected plain transfer cannot fabricate entitlement.',
    level: 'PARTIAL_LOCAL',
    tests: [
      'oracle/test/identity-boundaries.test.mjs > storage preflight failure and plain ft_transfer fabricate no entitlement (C07)',
    ],
    citations: ['CIT-IDENTITY-BIND', 'CIT-CAPACITY'],
    limits: ['Real FT storage/gas behaviour and resolver refund outcome are NOT_RUN.'],
  },
  {
    id: 'D02',
    requirement: 'FK/unique active registration/identity conflict/idempotency checks.',
    level: 'PARTIAL_LOCAL',
    tests: [
      'oracle/test/identity-boundaries.test.mjs > duplicate commitment replay grants no second seat',
      'oracle/test/identity-boundaries.test.mjs > duplicate active registration is denied',
      'oracle/test/identity-boundaries.test.mjs > beneficiary must equal the verified participant account at commit',
    ],
    citations: ['CIT-ONE-ACTIVE', 'CIT-IDENTITY-BIND'],
    limits: ['PostgreSQL constraints/FKs are NOT_RUN here; this is oracle state only.'],
  },
  {
    id: 'D05',
    requirement: 'Float/overflow/negative atomic values rejected; JSON money strings.',
    level: 'PARTIAL_LOCAL',
    tests: [
      'oracle/test/atomic.test.mjs > canonical u128: every fixture-invalid value is rejected (D05)',
      'oracle/test/atomic.test.mjs > checked addition rejects u128 overflow',
      'oracle/test/publish.test.mjs > event views serialize every money field as a decimal string',
      'oracle/test/identity-boundaries.test.mjs > u128 max deposit is accepted once; a second deposit overflows the aggregate and is returned (OG-02)',
      'oracle/test/differential.test.mjs > differential: oracle canonical-u128 classification matches the read-only domain reference',
    ],
    citations: ['CIT-U128-DB', 'CIT-U128-CHECK', 'CIT-D05', 'CIT-JSON-MONEY'],
    limits: ['TypeScript/API JSON serialization and DB domain apply are NOT_RUN; oracle views are strings.'],
  },
  {
    id: 'F01',
    requirement: '20 deposits 5m, 16 attendees -> each 6.25m, total 100m.',
    level: 'PASS_LOCAL',
    tests: [
      'oracle/test/allocation.test.mjs > packet worked examples F01-F03',
      'oracle/test/acceptance.test.mjs > F01: 20 deposits of 5,000,000 with 16 attendees',
    ],
    citations: ['CIT-SETTLE-FORMULA', 'CIT-F01'],
    limits: [],
  },
  {
    id: 'F02',
    requirement: '5 deposits 10, 3 attendees -> 17,17,16 ordered by registration, independent of claim order.',
    level: 'PASS_LOCAL',
    tests: [
      'oracle/test/allocation.test.mjs > allocation is independent of input array order and claim order',
      'oracle/test/acceptance.test.mjs > F02: 5 deposits of 10 with 3 attendees allocate 17,17,16',
      'oracle/test/claims.test.mjs > claim order does not change per-registration F02 amounts',
    ],
    citations: ['CIT-SETTLE-FORMULA', 'CIT-F02', 'CIT-EXAMPLE-5'],
    limits: [],
  },
  {
    id: 'F03',
    requirement: '6 deposits 10, 1 withdrawal, 3 attendees -> 10 refund + 17 + 17 + 16 = 60.',
    level: 'PASS_LOCAL',
    tests: [
      'oracle/test/acceptance.test.mjs > F03: 6 deposits, 1 withdrawal, 3 attendees',
      'oracle/test/allocation.test.mjs > all frozen acceptance vectors match independently expected payouts',
    ],
    citations: ['CIT-SETTLE-FORMULA', 'CIT-F03', 'CIT-EXAMPLE-6', 'CIT-WITHDRAW'],
    limits: [],
  },
  {
    id: 'F04',
    requirement: 'Zero attendees/cancellation/unfinalized timeout return full principal at exact boundary times.',
    level: 'PASS_LOCAL',
    tests: [
      'oracle/test/refunds.test.mjs > zero-attendee settlement refunds every remaining registrant',
      'oracle/test/refunds.test.mjs > cancellation refunds full principal exactly once',
      'oracle/test/refunds.test.mjs > timeout refund-only is permissionless',
      'oracle/test/lifecycle.test.mjs > packet phase-boundary vectors',
      'oracle/test/acceptance.test.mjs > F04',
    ],
    citations: ['CIT-SETTLE-FORMULA', 'CIT-CANCEL', 'CIT-REFUND-ONLY', 'CIT-TIME-WINDOWS'],
    limits: ['Refund-only exact-deadline interpretation is OG-01.'],
  },
  {
    id: 'F05',
    requirement: 'Already finalized before deadline can settle later; cancelled/refund-only cannot revert.',
    level: 'PASS_LOCAL',
    tests: [
      'oracle/test/lifecycle.test.mjs > already finalized before deadline can settle after deadline (F05)',
      'oracle/test/acceptance.test.mjs > F05',
      'oracle/test/lifecycle.test.mjs > late finalization at the deadline is denied',
    ],
    citations: ['CIT-SETTLE-AFTER-DEADLINE', 'CIT-REFUND-ONLY-STATE', 'CIT-TERMINAL'],
    limits: [],
  },
  {
    id: 'F06',
    requirement: 'Async failed payout restores credit once; callback self-only; repeated click/replay safe.',
    level: 'PASS_LOCAL',
    tests: [
      'oracle/test/claims.test.mjs > failed payout restores the credit exactly once',
      'oracle/test/claims.test.mjs > private callback is self-only and success pays exactly once',
      'oracle/test/adversarial-regressions.test.mjs > cross-event payout id collision keeps both pending payouts addressable (CROSS_EVENT_PAYOUT_ID_COLLISION)',
      'oracle/test/conservation.test.mjs > per-event invariant holds after every randomized operation (F07)',
    ],
    citations: ['CIT-CLAIM-EXACTLY-ONCE'],
    limits: ['Stale-success handling after failure+reclaim is OG-05.'],
  },
  {
    id: 'F07',
    requirement: 'Per-event and aggregate conservation under randomized state sequences; no cross-event spending.',
    level: 'PASS_LOCAL',
    tests: [
      'oracle/test/conservation.test.mjs > per-event invariant holds after every randomized operation (F07)',
      'oracle/test/conservation.test.mjs > no event may consume another event\'s liabilities (CIT-ISOLATION)',
      'oracle/test/conservation.test.mjs > accepted principal equals paid + pending + liability through the full phase sequence',
    ],
    citations: ['CIT-CONSERVATION', 'CIT-ISOLATION'],
    limits: ['Single-threaded randomized model; real chain ordering/replay is NOT_RUN.'],
  },
  {
    id: 'F08',
    requirement: 'Max capacity gas measured; chunking resumable/frozen/no early claims.',
    level: 'PARTIAL_LOCAL',
    tests: [
      'oracle/test/claims.test.mjs > chunked settlement disables claims, locks cancellation, is idempotent and resumes (F08)',
      'oracle/test/adversarial-regressions.test.mjs > settle with chunkSize 0 is rejected before any event mutation (REJECTED_SETTLEMENT_MUTATES_STATE)',
      'oracle/test/acceptance.test.mjs > F08: chunked allocation equals one-shot allocation',
      'oracle/test/identity-boundaries.test.mjs > max capacity at the u128 aggregate ceiling settles and pays exactly',
    ],
    citations: ['CIT-CHUNK-IDEMPOTENT', 'CIT-CANCEL-CHUNK-LOCK', 'CIT-CAPACITY'],
    limits: ['Gas is NOT measured; whether chunking is required remains G09/OG-06 OPEN_GATE.'],
  },
  {
    id: 'E02',
    requirement: 'At least 3 participants cover attended/no-show; receipts and independent balances reconcile.',
    level: 'PARTIAL_LOCAL',
    tests: [
      'oracle/test/acceptance.test.mjs > every frozen acceptance vector settles end-to-end to its independent expected amounts',
      'oracle/test/conservation.test.mjs > per-event invariant holds after every randomized operation (F07)',
    ],
    citations: ['CIT-CONSERVATION', 'CIT-ISOLATION'],
    limits: ['No real receipts or onchain balances; reconciliation is oracle-ledger local.'],
  },
  {
    id: 'E03',
    requirement: 'Cancellation and timeout refund scenarios proven; synthetic clock labeled local.',
    level: 'PARTIAL_LOCAL',
    tests: [
      'oracle/test/refunds.test.mjs > cancellation refunds full principal exactly once',
      'oracle/test/refunds.test.mjs > timeout refund-only is permissionless',
      'oracle/test/lifecycle.test.mjs > packet phase-boundary vectors',
    ],
    citations: ['CIT-CANCEL', 'CIT-REFUND-ONLY', 'CIT-TIME-WINDOWS'],
    limits: ['Caller-supplied synthetic block-time ms; no chain clock, UI or receipts.'],
  },
]);

export const NOT_RUN = Object.freeze([
  'NEAR contract T03 escrow/pass tests (Rust/WASM sandbox)',
  'NEAR contract T04 settlement/payout tests',
  'Real NEP-141 ft_transfer_call / ft_on_transfer / payout callback receipts',
  'Max-200 settlement gas measurement (G09)',
  'Concurrent transactions, cross-contract races and chain ordering',
  'PostgreSQL migrations, constraints, grants and projection replay (T01)',
  'Testnet deployment/transactions',
  'Mainnet/live funds, wallets, storage deposits and provider routes',
  'Browser/UI/API integration',
]);
