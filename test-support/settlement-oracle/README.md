# Local settlement oracle — README

**LABEL: LOCAL TEST ORACLE. Not a NEAR contract, not production settlement authority, not chain evidence, not a frozen ABI.**

This folder implements an independent, zero-network executable acceptance model for ShowStake v2 settlement/refund semantics. It exists to answer independently derived questions such as: *given exactly D per seat, N remaining registrations and A attendees, what must each account receive?* It never registers a real seat and never initiates a payout.

## Requirements

- Node.js **24.x** (uses the built-in `node:test` runner).
- No package installation, no dependencies, no network, no wallet, no credentials.
- Windows Git Bash, PowerShell, or any POSIX shell.

## Commands

Run everything and write the evidence JSON/TAP files (primary command, cross-platform):

```sh
cd <folder containing oracle/>
node oracle/scripts/run-oracle.mjs
```

The runner resolves the package root from its own location and the packet root by
explicit discovery (`docs/planning/showstake-v2` in the nearest ancestor), so it
still runs after the folder is copied from `.local/` into a tracked test-support
location. Override paths without editing code:

```sh
node oracle/scripts/run-oracle.mjs --packet-root /path/to/ShowStake --evidence-dir /tmp/oracle-evidence
# or:
SHOWSTAKE_PACKET_ROOT=/path/to/ShowStake SHOWSTAKE_ORACLE_EVIDENCE_DIR=/tmp/oracle-evidence   node oracle/scripts/run-oracle.mjs
```

Direct test run with the same built-in runner (POSIX/Git Bash glob):

```sh
node --test --test-reporter=spec oracle/test/*.test.mjs
```

Node 24 on Windows does not accept a bare directory as a test argument; if your shell does not expand `*`, use the runner above or list the `oracle/test/*.test.mjs` files explicitly.

Outputs (each invocation gets a unique run id; prior runs are never overwritten):

- `docs/evidence/settlement-oracle-runs/<runId>/result.json` — command, Node environment, exit code, pass/fail/skip counts, fixture/source/test hashes, packet hashes, acceptance levels, worker attribution, limits and OPEN_GATEs for that run only.
- `docs/evidence/settlement-oracle-runs/<runId>/result.tap.txt` — raw TAP log for that run.
- `docs/evidence/settlement-oracle-latest.json` — a pointer to the current run (including a failed one); it never rewrites prior run folders.
- The older fixed `settlement-oracle-results*.json` files, if present, are prior-delivery artifacts and are left untouched.

The runner is fail-closed for the current run: `PASS_LOCAL` requires exit 0, at least one test, zero failures/skips/todos, unchanged pinned packet hashes, an explicit packet root, and present README/traceability files. A failed run is written with `status: FAILED` under its own run id; it does not replace earlier evidence.

## Layout

```text
oracle/
  src/errors.mjs       typed oracle failures (oracle-local vocabulary)
  src/atomic.mjs       canonical base-10 u128 parsing + checked arithmetic
  src/policy.mjs       fixed policy, verbatim packet citations, OPEN_GATE register
  src/settlement.mjs   pure allocation + sum verification
  src/engine.mjs       stateful event/registration/claim/callback/isolation model
  src/index.mjs        public test-support API
  acceptance-map.mjs   acceptance-ID traceability (oracle coverage levels)
  TRACEABILITY.md      canonical acceptance matrix (relocatable; docs/evidence copy is legacy)
  fixtures/
    acceptance-vectors.json   independent expected settlement amounts (frozen)
    amount-edge-cases.json    malformed/boundary external amounts
    lifecycle-boundaries.json packet time-boundary vectors + chunk case
  test/*.test.mjs      node:test suites
  scripts/run-oracle.mjs runner + fail-closed evidence writer
```

## What is asserted

- **F01-F03** packet worked examples and additional exact rounding/remainder vectors.
- **F04** zero-attendee, cancellation and unfinalized-timeout full-principal refunds at exact block-time boundaries.
- **F05** finalized-before-deadline settlement after the deadline; terminal states never revert.
- **F06** pending claim reservation, private callback, exactly-once success/failure, duplicate click/replay safety.
- **F07** per-event and aggregate `accepted = paid + pending + liability` under seeded randomized sequences; no cross-event spending.
- **F08** one-shot vs chunked allocation equality, frozen cursor, idempotent replay, claims disabled during `SETTLING`, cancellation locked.
- **C01-C07, D02, D05 (local parts)** exact deposit/seat/pass relation, wrong token/amount/phase/duplicate returns, capacity 1..200, immutable participant/beneficiary/owner, withdrawal/rejoin, storage/plain-transfer non-entitlement, canonical u128 and JSON money strings.
- **E02/E03 (local parts)** multi-participant reconciliation and cancellation/timeout refunds on a labelled synthetic block-time clock; no onchain receipts.

## Policy sources (immutable packet)

The oracle does not invent split rules. `oracle/src/policy.mjs` pins verbatim citations and SHA-256 hashes of the read-only packet copies under `docs/planning/showstake-v2/`; `test/citations.test.mjs` fails if a quote disappears or a cited file changes.

Core rule (`01-PRODUCT.md`, "Settlement and refund"):

> A>0: pool=M*D, q=floor(pool/A), r=pool mod A. Order attendees by immutable registration sequence; first r get D+q+1, rest D+q. No-shows get0. A=0: all remaining registrants refund D. Withdrawn participants separately retain D credit.

Also pinned: zero fees; `capacity1..200`; `finalize_deadline=checkin_close+24h`; registration `open<=now<close`; withdrawal `now<cutoff`; check-in `open<=now<close`; finalization `checkin_close<=now<deadline`; late finalization denied; cancellation/refund-only full principal; claim receiver immutable beneficiary; exactly-once callbacks; per-event conservation; event isolation; u128 limit; D05; PASS_LOCAL evidence vocabulary.

## Unresolved gates (not guessed)

`oracle/src/policy.mjs` records `OG-01`..`OG-08` with the packet text, the unresolved question, the oracle's documented default and test vectors:

| Gate | Unresolved question |
|---|---|
| OG-01 | Whether `now == finalize_deadline` counts as "after deadline" for permissionless refund-only (`AT_OR_AFTER` default vs `AFTER` variant). |
| OG-02 | Contract error/chunking behavior when an additional deposit would push an event's aggregate past u128 (oracle rejects and returns it). |
| OG-03 | Whether cancel may relabel an already REFUND_ONLY event (economics identical: full principal). |
| OG-04 | Claim timing for withdrawn credit before event settlement (oracle allows immediately). |
| OG-05 | Late success callback for a FAILED, already-reclaimed payout (oracle rejects as stale). |
| OG-06 | Whether 200-seat settlement needs chunking and the exact gas bound (G09); gas is **not measured**. |
| OG-07 | Terminal event-state label for A=0 settlement (amounts explicit; label not named). |
| OG-08 | Limits on multiple payable claims for one beneficiary across distinct registrations. |

## What this README does **not** claim

- No NEAR contract test, WASM sandbox, testnet or mainnet execution.
- No real NEP-141 `ft_transfer_call`/callback receipts, storage deposit or gas measurement.
- No concurrency or cross-transaction race proof; the engine is single-threaded.
- No PostgreSQL migration/constraint/role evidence.
- No UI/API/browser integration.
- No proof that a pass prevents wallet sharing or proves physical presence.
- No production provider/model or CLI-readiness claim. Evidence separates the **Node execution environment** from **worker attribution**: the worker attribution is external/read-only (Orca session `sess_8132d973-be55-4805-83a6-fcb32ff1e54f`, persisted model_selection `new-provider/deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated/max`), while the workspace `.zcode` selector is labelled leftover setup and **not** execution evidence. Neither is inferred from the Node process.


Relocation proof: `docs/evidence/settlement-oracle-relocation/README.md` (package copied outside `.local`, explicit parent packet root, 105/105 PASS_LOCAL; deliberate failed run preserved the earlier PASS evidence).

See `oracle/TRACEABILITY.md` for the acceptance-ID matrix and the current `docs/evidence/settlement-oracle-runs/<runId>/result.json` for machine-readable evidence.
