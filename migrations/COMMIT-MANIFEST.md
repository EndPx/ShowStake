# T01 database increment — commit manifest

Codex decides the actual commit scope and authorizes any push. **No worker commit or
push.** This file only groups the working-tree paths so the review can commit the
accepted database increment without a blanket `git add`, and names what must
remain excluded. Historical failure evidence in `.local/` is preserved and must
never be deleted.

## 1. Database increment (this deliverable)

The self-contained, runnable database work. `pnpm verify:t01-static` (static) and
`pnpm verify:t01` (real PostgreSQL) are independent of wallet/intents/UI code.

```text
.gitattributes                        # *.sql/*.mjs/*.json/*.yaml/*.md ... text eol=lf — REQUIRED so a fresh default-Windows-Git clone checks out schema.sql LF (hash integrity proof: docs/evidence/t01-fresh-clone-lf-proof.json)
package.json                          # DB/foundation-only scripts (verify:t01-static/openapi/t01-aggregate/domain/baseline/bootstrap/packet/migrations); NO wallet/intents/t02 root commands
pnpm-lock.yaml                        # DB/foundation importers only (root + packages/domain); wallet/intents importers and borsh removed
pnpm-workspace.yaml                   # module layout (already untracked)
migrations/schema/0001_initial.sql    # baseline-derived (verbatim; verify-baseline.mjs proves it)
migrations/schema/0002_roles_grants.sql
migrations/runner.mjs                 # bootstrap under lock, stale refusal, TEMP revoke, lock release on error
migrations/cli.mjs
migrations/verify-baseline.mjs
migrations/tests/run-t01.mjs          # D01-D06 + finalize; socket-first client; D04 canonical Product01 accounting
migrations/tests/lib.mjs
migrations/tests/aggregate.mjs        # fail-closed phase + orchestration aggregation; static/checksum fault injection
migrations/tests/replay.mjs           # D04: rebuild projection from chain_events (accepted incl. withdrawn; pending=0; liability=accepted)
migrations/tests/fixtures.mjs
migrations/tests/readiness.mjs
migrations/README.md
migrations/COMMIT-MANIFEST.md
packages/domain/package.json
packages/domain/README.md
packages/domain/src/*.mjs             # atomic/account/capability/states/envelope/index
packages/domain/verify.mjs
packages/api-contract/openapi.yaml    # 19 routes = full 02-ARCHITECTURE API table + /auth/privy, /events/drafts, /events/{eventId}/publish-intent; Money u128; bodies/idempotency/errors
packages/api-contract/routes.json     # explicit reviewed route inventory (derives the OpenAPI route check; no hardcoded count)
packages/api-contract/README.md
scripts/verify-openapi.mjs            # pinned OpenAPI validation + $ref + route inventory (from routes.json) + semantic u128
scripts/verify-t01-aggregate.mjs
scripts/postgres-disposable/run-suite.sh   # portable, socket-first, dynamic port, unique artifacts, source manifest + full orchestration result
scripts/postgres-disposable/README.md
docs/evidence/t01-migration-db.json   # evidence (JSON record incl. source hashes + base commit + orchestration stages)
docs/evidence/t01-migration-db.md
docs/evidence/t01-fresh-clone-lf-proof.json  # fresh-clone LF/attributes proof (method + positive/negative control)
```

`scripts/postgres-disposable/setup.sh` is already tracked and carries the earlier
Codex-reviewed safety fixes (`selftest`, proven-stop deletion guards); it is a
hard prerequisite of `run-suite.sh` and must ship with the accepted tooling.

## 2. Exclude from commit (runtime + historical)

```text
migrations/artifacts/**              # per-run output (old fixed-path files superseded; new run-<id>/ dirs)
.local/**                             # preserved failed-run archives + worker returns (never delete)
```

Each full run writes to a unique `migrations/artifacts/<runId>/`; failed runs are
preserved there and a later run can never overwrite them.

## 3. Foundation files `pnpm verify` needs (separate scope, still untracked)

`pnpm verify` (bootstrap) checks toolchain pins plus the presence of these
frameworkless README/script placeholders. They are not part of the database
logic but a fresh clone needs them for `pnpm verify` to pass. `.gitattributes`
is also committed in §1 (it is a hard prerequisite for the LF hash integrity,
not just a bootstrap presence check). These READMEs are proposition-less
placeholders only — no product/implementation claims.

```text
.env.example
apps/web/README.md  apps/api/README.md  apps/worker/README.md
packages/domain/README.md  packages/api-contract/README.md
packages/wallet-adapter/README.md  packages/intents-adapter/README.md  packages/ui/README.md
contracts/showstake/README.md
scripts/verify-packet.mjs  scripts/verify-bootstrap.mjs  scripts/run-packet-verifier.mjs
scripts/postgres-disposable/README.md  scripts/postgres-disposable/setup.ps1
```

## 4. Explicitly unaccepted / out of scope (do NOT commit as this increment)

```text
apps/web/onboarding-probe/**          # browser-harness probe (wallet assignment, unaccepted)
contracts/**                          # Rust crate (not part of the DB increment)
packages/wallet-adapter/** (code)     # unaccepted wallet/signing probe
packages/intents-adapter/** (code)
packages/ui/**
scripts/verify-t02-regressions.mjs    # T02 scripts (reference unaccepted wallet source)
scripts/verify-t02-review-gaps.mjs
docs/onboarding-capabilities.md       # modified in working tree — wallet/onboarding (not DB)
docs/evidence/t01-foundation-fixes.{json,md}  # prior foundation-fix evidence (separate review)
docs/evidence/t02-*                   # T02 evidence (separate assignment)
```

## 5. Root commands removed until separate wallet/intents source acceptance

The root `package.json` no longer advertises wallet/intents/T02 commands, and
`pnpm-lock.yaml` no longer lists the `packages/wallet-adapter` /
`packages/intents-adapter` importers (nor the `borsh` dev-only dependency), so a
DB/foundation checkout installs with `pnpm install --frozen-lockfile` without
requiring the unaccepted wallet/intents source. The prior commands are NOT
deleted and are preserved in their local code/manifests; they are re-enabled from
the root only when the wallet/intents increment is separately accepted:

```text
# unavailable at the ROOT until wallet/intents source acceptance:
#   pnpm verify:wallet        -> node packages/wallet-adapter/src/cli.mjs
#   pnpm verify:intents       -> node packages/intents-adapter/src/cli.mjs --offline
#   pnpm verify:intents:live  -> node packages/intents-adapter/src/cli.mjs
#   pnpm verify:nep413-official    -> node packages/wallet-adapter/verify-nep413-official.mjs
#   pnpm verify:t02-regressions    -> node scripts/verify-t02-regressions.mjs
#   pnpm verify:t02-review-gaps    -> node scripts/verify-t02-review-gaps.mjs
#   pnpm verify:t02 / verify:t02-onboarding -> the composed wallet/intents gate
# (above .mjs files still exist in the working tree and are NOT part of this DB commit)
```

No frontend/figcraft/zcode change, no wallet change, no `docs/status.md` /
`docs/decisions.md` / `AGENTS.md` / baseline edit, and no `.local/` deletion are
part of this increment.