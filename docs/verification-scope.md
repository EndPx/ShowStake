# Verification commands and acceptance boundaries

Recorded by Codex on 2026-11-06 from the current root package.json and script sources. Worker implementation is still partly untracked and unaccepted. Commands below describe local working-tree checks; they are not a claim that a fresh remote checkout contains the full implementation. Reconcile this table whenever a command changes.

| Command | What it actually checks now | What exit 0 does not prove |
|---|---|---|
| `pnpm verify` | Node/pnpm version and declared pins, workspace patterns, presence of 17 foundation files, then SHA-256 integrity of 11 planning files | Application build, actual migration, database permissions, wallet login, signing, escrow execution |
| `pnpm verify:packet` | Read-only planning file hashes against bootstrap.json | SQL execution or app correctness |
| `pnpm verify:packet-verifier` | Supplied Python packet verifier on temporary copy: packet structure, acceptance ID uniqueness, contrast pairs, SQL declarations; parser only if installed | PostgreSQL migration, rendered UI accessibility or any live feature |
| `pnpm verify:t02` | Local 11 regression cases, 29 resolver/context checks, five Borsh encoding/hash comparisons, wallet cryptographic fixtures, offline Intents validators/builders | T02 completion, real provider wallet session, account recovery, native wallet return, funded route, actual deposit/pass/refund |
| `pnpm verify:t02-regressions` | Denials for earlier auth defects using generated local signatures | Real wallet compatibility, production nonce storage or session issuance |
| `pnpm verify:t02-review-gaps` | Local resolver metadata/permission/freshness and linking-context cases | RPC availability/finality in actual use, production auth integration |
| `pnpm verify:nep413-official` | Custom payload bytes/hash compared with borsh@2.0.0 using declared NEP413 schema | Actual near-api-js signer or wallet interoperability; comparison is independent serialization, not complete SDK integration |
| `pnpm verify:wallet` | Generated Ed25519 fixtures and expected denials/capability labels | Google/email/EVM/NEAR wallet login or signing |
| `pnpm verify:intents` | Offline quote/status schema, identity and FT-call builder fixtures | Route support, quote availability, fund delivery or registration |
| `pnpm verify:intents:live` | Offline checks plus public catalog/dry-quote requests, with per-request results | A zero process exit is not proof all network probes passed; inspect each classifier/status/body. No funded swap or delivery proof |
| `pnpm install --frozen-lockfile --ignore-scripts` | Dependency graph compatible with lockfile, without lifecycle scripts | Build success, security audit or any feature acceptance |
| `node apps/web/onboarding-probe/config.mjs --selftest` | Public configuration constants present and shaped | Browser SDK imported/built, login/callback/relogin or signing PoC |
| WSL `scripts/postgres-disposable/setup.sh selftest` | Controlled fake-command safety guards | A real server or migration |
| WSL `scripts/postgres-disposable/setup.sh run` | Real isolated PostgreSQL server start, health query, stop and guarded disposal | Migration application, grants, constraint coverage, concurrency, backup/restore or projection replay |

## Pending acceptance

- D01-D06: the original baseline applied on a real PostgreSQL server with a subset of atomic/FK/rollback checks; server tooling also passed. Versioned migration, full constraints/uniqueness, privileges, concurrent transactions and restore/replay are not yet accepted. New database evidence must map each ID to actual commands, expected/observed results and gaps.
- W01-W03: authenticated login/signing/relogin and native wallet/mobile return not accepted.
- W04/W08: local linking/context tests are supporting evidence only; full application linking, identity conflict and account-switch behavior not accepted.
- W05: canonical FT/network/storage/gas execution not accepted. W06: funded EVM and non-EVM delivery not accepted. W07: custom pass intent documented; implemented contract/interface tests pending.
- C01-C07/F01-F08: no accepted contract deposit/pass/withdraw/refund/settlement/claim lifecycle yet.
- U01-U06: design and actual browser UI acceptance pending; FigCraft renders do not prove functionality.

Only Codex review plus requirement-specific evidence changes acceptance. Script names, aggregate green output and fixture coverage cannot close a live gate. Use PASS_LOCAL, PASS_TESTNET, PASS_LIVE, BLOCKED_EXTERNAL, FAILED or NOT_RUN per test and retain historical failures.
