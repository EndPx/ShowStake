# Fixture provenance — independent expected values

**Label: LOCAL TEST ORACLE FIXTURES. No chain evidence.**

These JSON files freeze *expected* results. They were not produced by calling the oracle implementation under test. The acceptance vectors were derived with a standalone closed-form calculator outside `oracle/src`, then spot-checked by hand against the packet's own worked examples; the lifecycle and amount fixtures were written from the packet time/money rules.

## Packet anchors

- `01-PRODUCT.md` §Settlement and refund:
  `A>0: pool=M*D, q=floor(pool/A), r=pool mod A. Order attendees by immutable registration sequence; first r get D+q+1, rest D+q. No-shows get0. A=0: all remaining registrants refund D. Withdrawn participants separately retain D credit.`
- `01-PRODUCT.md` §Rules fixed at publish: `capacity1..200`, positive fixed D, zero fees, exact time ordering, `finalize_deadline=checkin_close+24h`.
- `03-DATABASE.md` / `schema.sql`: u128 ceiling and JSON money strings.
- `05-EXECUTION-AND-TESTS.md`: F01-F08, C01-C07, D02, D05, E02/E03 acceptance IDs.

## Manual checks recorded

- **F01**: N=20, A=16, D=5,000,000 → M=4, pool=20,000,000, q=1,250,000, r=0 → 16×6,250,000 = 100,000,000.
- **F02**: N=5, A=3, D=10, attendees at sequences 0,2,3 → M=2, pool=20, q=6, r=2 → seq0=17, seq2=17, seq3=16; seq1/seq4=0; total 50.
- **F03**: same plus withdrawn seq5 → withdrawn 10 + 17 + 17 + 16 = 60.
- **max capacity**: N=200, A=199, D=1,000,000 → M=1, pool=1,000,000, q=5,025, r=25 → first 25 attendees 1,005,026; next 174 attendees 1,005,025; no-show 0; total 200,000,000.
- **rounding-seven-three**: N=7, A=3, D=2, attendees seq1,4,6 → M=4, pool=8, q=2, r=2 → 5,5,4; total 14.
- **unit single attendee**: N=200, A=1, D=1, attendee seq199 → M=199, pool=199, q=199, r=0 → 200; others 0; total 200.
- **A=0 convention**: the packet defines `pool` only for A>0. For A=0 the fixture records `pool="0"`, `q="0"`, `r="0"` and refunds D per remaining registrant; withdrawn credit remains separate.

## Rules for changing fixtures

1. Re-derive by hand or with an independent tool, not by importing `oracle/src/settlement.mjs`.
2. State the packet section used for every new vector.
3. Keep the fixture static; never regenerate it inside a test at runtime.
4. A changed fixture requires a deliberate new oracle result, because the fixture SHA-256 is recorded in `docs/evidence/settlement-oracle-results.json`.
