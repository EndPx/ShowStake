# ShowStake status
Updated: 2026-11-06 WIB. Target: 2026-11-14 23:59 WIB.

T00 PASS_LOCAL: B01 target inventory and preserved baseline; B02 actual DeepSeek dispatch/result independently reviewed by Codex (docs/evidence/t00-codex-review.json); B03 shared Keyfolio capacity risk acknowledged, allocation still unknown. No reference code copied. Executor proof is complete; no live product integration implied.
T01 IN_PROGRESS: foundation assigned to existing DeepSeek worker. Actual PostgreSQL 18.6 baseline apply passed locally (partial D01/D02/D05); versioned migrations/grants/concurrency/restore/replay remain NOT_RUN. Evidence: docs/evidence/t01-postgresql-baseline.json. First failed attempt retained. T02-T11 NOT_RUN. Do not freeze ABI until T02 evidence reviewed. No parallel implementation before schema/API freeze.

Runtime discovered: Orca 1.4.250 agent dsh -> dsh-tui ., DSH TUI 0.18.0, profile dsh-tui, provider gater, model deepseek-v4.1-flash-1017-v2, endpoint https://api.gater.ai.id/v1. Config selection is not execution proof.
Node v24.18.0; pnpm 10.21.0; Python 3.12 available. Docker CLI installed but Linux engine unavailable (named pipe missing). Baseline DDL applied on actual isolated PostgreSQL 18.6 in WSL; application migration acceptance remains incomplete.

G01-G11 OPEN_GATE; no real accounts/FT/routing/deposit/claim evidence. GitHub https://github.com/EndPx/ShowStake is PUBLIC by explicit user request. Reviewed/tested source push authorized. Deployment, paid services and real assets remain gated.

Capacity: one ShowStake executor at a time initially; Keyfolio capacity is unknown, not reserved. Schedule risk HIGH until wallet/signing and live route gates resolve. No scope cuts authorized.
Dispatch ctx_e156747936ca returned succeeded. Codex read all 22 new files, ran pnpm verify, temporary packet verifier and frozen-lockfile install, and tested drift/missing-file rejection on a temporary copy. B02 accepted. Foundation remains untracked pending fixes to PostgreSQL setup/teardown safety; do not push it yet. T02 IN_PROGRESS via follow-up ctx_889b3c4a7838, task task_7ea6236ac784, same run. Spec: docs/dispatches/t02-probes-and-t01-fixes.txt. Priority wallet/signing/account recovery, direct FT lifecycle capability, then Intents funding; also bounded T01 safety fixes. No user continuation prompt required. One writer per checkout; no parallel implementation until schema/API freeze.
T02 interruption: dispatch ctx_889b3c4a7838 remains open after an errored turn. GATER returned HTTP 403 ip_limit_reached (2 bound IPs maximum). No provider/model switch, retry, stop, abandonment or reset performed. User must release obsolete IP binding through their GATER bot /unbind or admin, then notify Codex. Never request the API key in chat.

Codex partial review: built-in wallet/intents fixture CLIs and pnpm verification exit 0, but independent adversarial tests FAILED: foreign key can claim a named account when proof.accountId repeats the claim; NaN timestamps accepted. Evidence docs/evidence/t02-interrupted-review.json. No authenticated login, account recovery, chain deposit or funded swap accepted. No interface frozen.

T01 helper fixes remain incomplete: Linux stop check treats all pg_ctl errors as stopped and lacks a run ownership marker/canonical deletion boundary; do not run cleanup. Docker lifecycle removed in partial changes, but not accepted yet. All worker implementation remains untracked and excluded from push. Lockfile/workspace compatibility acceptance pending after complete report.

Next after provider recovery: inspect dispatch/worktree, deliver review defects to the same open dispatch through Orca send, resume T02 plus T01 fixes; do not create duplicate writer or new task silently. Local review/evidence continues independently where useful.

File ownership: Codex docs/status.md, docs/decisions.md, docs/evidence/bootstrap.json and review evidence; executor only paths in bounded dispatch. No concurrent writer.
