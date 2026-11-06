# ShowStake working agreement
Read docs/planning/showstake-v2/00-START-HERE.md and the packet in order before implementation. v2 is authoritative.
Codex coordinates, freezes interfaces, reviews and accepts. DeepSeek Harness through Orca implements. One writer per checkout. Do not commit implementation before Codex review.
Never modify Keyfolio or legacy CommitPass. No v1 transfer/resale/admin reassignment. All money is exact atomic strings/bigint; NEAR contract alone authorizes registration, attendance finality and payouts.
Never expose secrets in logs, evidence or dispatches. No deployment, paid resources, real assets or push without scoped user authorization. GitHub repository creation is authorized; visibility initially private. Local dependencies and tests are authorized.
Record tests as PASS_LOCAL, PASS_TESTNET, PASS_LIVE, BLOCKED_EXTERNAL, FAILED or NOT_RUN. A fixture never proves a live gate.

For material integration choices, apply NEAR ecosystem first (docs/decisions.md D012-D013): evaluate NEAR candidates by proven features, networks/wallets, auth/signing/recovery, access permissions, fund authority/security, cost/reliability/integration time; record sources and experiments in a capability matrix. Do not add integrations without a function. Onboarding is reopened: NEAR Auth and HOT/NEAR Connect first, Privy alternative. Preserve working paths until replacement PoC passes; never reduce required login paths or acceptance criteria.
Later explicit user authorization makes EndPx/ShowStake public and permits push of Codex-reviewed/tested work; deployment, paid resources and real assets remain separately gated.

User-authorized parallel design executor: ZCode via Orca, Cloud Near/deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated, isolated .local/zcode-figcraft. DeepSeek Harness/GATER remains main database implementer. ZCode must not write main source/migrations/lockfile. Codex reviews rendered editable FigCraft artifacts before integration.
