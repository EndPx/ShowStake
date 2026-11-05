# T00 executor proof & reproducible local foundation

- Task: bounded T00 foundation (pnpm workspace + module layout + verification scripts +
  disposable-PostgreSQL preparation). Note: per Codex reclassification in the run
  mailbox, foundation/schema/interface/PostgreSQL deliverables are labeled **T01**;
  these file names keep the `t00` prefix only because the bounded dispatch's
  allowed-writes list specified exactly `docs/evidence/t00-executor.md` and
  `docs/evidence/t00-validation.json`.
- Classifier (foundation): **PASS_LOCAL**. Live/external gates not exercised.
- Base commit (dispatch): `0d0ccfd9885b4eb367ef9256defca96fd31009ae`.
- HEAD at finish: `32527312b764271bdf2ffc0a68e1a597785e5947` — advanced by Codex
  during the run with a docs-only commit ("docs: record public authorization and
  PostgreSQL baseline execution", adding `docs/evidence/t01-postgresql-baseline*.json`
  and committing `docs/dispatches/t00-executor.txt`). The implementer made no commit.

## Files changed (all new; no tracked baseline file was modified)

- Root: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.gitattributes`, `.env.example`.
- Module placeholders: `apps/{web,api,worker}/README.md`,
  `packages/{domain,api-contract,wallet-adapter,intents-adapter,ui}/README.md`,
  `contracts/showstake/README.md`.
- Scripts: `scripts/verify-packet.mjs`, `scripts/verify-bootstrap.mjs`,
  `scripts/run-packet-verifier.mjs`, `scripts/postgres-disposable/{README.md,setup.sh,setup.ps1}`.
- Evidence: `docs/evidence/t00-executor.md`, `docs/evidence/t00-validation.json`.

`git diff` of tracked files is empty (no baseline docs, AGENTS.md, README.md,
docs/status.md, docs/decisions.md, or planning packet modified). Byte integrity of the
11 planning-packet files was re-verified against `docs/evidence/bootstrap.json`.

## Environment

- Host: Windows (ShowStake checkout). Node `v24.18.0`. pnpm `10.21.0` (exact pin).
  Python `3.12.10` (`python`) and `3.13.0` (`py`). Docker CLI `29.4.3`, engine
  **down** (named pipe `dockerDesktopLinuxEngine` missing). WSL Ubuntu-24.04 provides
  PostgreSQL 18 binaries (used by Codex for the baseline apply).
- Pins: `packageManager: pnpm@10.21.0`; `engines.node: ">=24.18.0 <25"` (satisfied by
  installed v24.18.0); workspace `apps/*` + `packages/*`. No runtime dependencies added
  (bloat avoided); `pnpm-lock.yaml` is a minimal zero-dependency lockfile.

## Runtime / model identity (sanitized — no secrets, no env dumps)

- Agent: `dsh` (backendId from `~/.dsh-tui/last-run.json`); launcher `dsh 0.2.1-rc.5`;
  profile `dsh-tui` (`@deepseek-harness-tui/dsh-tui 0.18.0`).
- Composed config (`~/.dsh/profiles/dsh-tui/cordis.patch.yml`) selects
  `provider: gater`, `model: deepseek-v4.1-flash-1017-v2`,
  `baseURL: https://api.gater.ai.id/v1`, key via env var name `GATER_API_KEY`
  (value never read or printed). No fallback provider/model used.

## Verification (expected vs observed)

| Step | Command | Expected | Observed | Exit |
|---|---|---|---|---|
| Packet integrity (read-only) | `node scripts/verify-packet.mjs` | 11 files match `bootstrap.json` hashes | 11/11 OK, no drift | 0 |
| Bootstrap | `node scripts/verify-bootstrap.mjs` | node≥24.18.0<25, pnpm==10.21.0, pins + 17 files present | PASS | 0 |
| Packet verifier (temp copy) | `node scripts/run-packet-verifier.mjs` | verifier runs on temp copy; baseline VALIDATION.json byte-identical | verifier exit 0; baseline preserved | 0 |
| Lockfile | `pnpm install --lockfile-only` | minimal lockfile, pnpm v10.21.0 | `lockfileVersion 9.0`, root only | 0 |

The baseline verifier (`verify_packet.py`) mutates `VALIDATION.json`; it was run only on
a temporary copy. The baseline `VALIDATION.json` sha256 stayed
`c3394d37fb4ebb7dd6729d5159d3666dd1690dcaeedded9a582d17c794d448fb` (unchanged). The
temporary run reported `sql_syntax_parser: NOT_RUN (pglast unavailable)` because pglast
isn't installed in this environment; its static checks (9 files, 65 unique acceptance
tests, 22 tables, all contrast pairs) still passed.

## Money policy

Baseline `schema.sql` uses the `atomic_amount` `numeric` domain with
`CHECK(VALUE = trunc(VALUE) AND VALUE >= 0 AND VALUE <= u128 max)` — no `float`/`double`/
`real` columns. This matches the "no floats / exact atomic strings/bigint" workspace rule;
no changes were made to it.

## PostgreSQL (T01 scope; not applied here)

- Disposable setup artifacts provided: `scripts/postgres-disposable/` (WSL cluster plus
  Docker Desktop path), ShowStake-specific names (`showstake`, `showstake-pg-*`,
  port 5632, Unix-socket-only default), teardown removes only what it created.
- **BLOCKED_EXTERNAL** for the Docker path: engine daemon down (named pipe missing);
  Docker Desktop intentionally NOT started for this task.
- Basline apply is Codex's T01 evidence (`docs/evidence/t01-postgresql-baseline.json`,
  22 tables, partial D01/D02/D05). The implementer did not claim schema migration passed.

## Limits and blockers

- T01–T11 not implemented; no ABI/API frozen; no app/provider code; no live readiness.
- No dependency, deployment, push, paid resource, transaction, or real asset done.
- No git commit by this worker (changes left for Codex review → tests → commit).
- B02 (DeepSeek dispatch reviewed by Codex) and T00 acceptance are Codex's to record.