# ShowStake status
Updated: 2026-11-06 WIB. Target: 2026-11-14 23:59 WIB.

T00 IN_PROGRESS: packet read and preserved; empty Git foundation; executor cycle pending. B01 local inventory complete; no reference code copied. B02 NOT_RUN until actual result plus Codex review. B03 shared Keyfolio capacity acknowledged but allocation unknown: do not assume dedicated full capacity.
T01 IN_PROGRESS: foundation assigned to existing DeepSeek worker. Actual PostgreSQL 18.6 baseline apply passed locally (partial D01/D02/D05); versioned migrations/grants/concurrency/restore/replay remain NOT_RUN. Evidence: docs/evidence/t01-postgresql-baseline.json. First failed attempt retained. T02-T11 NOT_RUN. Do not freeze ABI until T02 evidence reviewed. No parallel implementation before schema/API freeze.

Runtime discovered: Orca 1.4.250 agent dsh -> dsh-tui ., DSH TUI 0.18.0, profile dsh-tui, provider gater, model deepseek-v4.1-flash-1017-v2, endpoint https://api.gater.ai.id/v1. Config selection is not execution proof.
Node v24.18.0; pnpm 10.21.0; Python 3.12 available. Docker CLI installed but Linux engine unavailable (named pipe missing). Baseline DDL applied on actual isolated PostgreSQL 18.6 in WSL; application migration acceptance remains incomplete.

G01-G11 OPEN_GATE; no real accounts/FT/routing/deposit/claim evidence. GitHub https://github.com/EndPx/ShowStake is PUBLIC by explicit user request. Reviewed/tested source push authorized. Deployment, paid services and real assets remain gated.

Capacity: one ShowStake executor at a time initially; Keyfolio capacity is unknown, not reserved. Schedule risk HIGH until wallet/signing and live route gates resolve. No scope cuts authorized.
Active dispatch ctx_e156747936ca, task task_9cacd2f5a0a7, run run_10280ea1a1d8. Same worker retained and observed executing with requested Flash model. T00 records executor result/review; foundation is T01. B02 pending result and Codex review. Next: review, test/fix, commit/push accepted work, then T02 promptly. No user continuation prompt required.
File ownership: Codex docs/status.md, docs/decisions.md, docs/evidence/bootstrap.json and baseline; executor only paths in bounded dispatch. No concurrent writer.
