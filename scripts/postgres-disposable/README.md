# Disposable PostgreSQL (ShowStake-specific, isolated)

Preparatory setup + full T01 acceptance suite for schema/migration tests.
**Schema application itself is T01.** Nothing here connects to an existing
database (Keyfolio / legacy CommitPass are explicitly out of scope).

## What these scripts are and are NOT

- `setup.sh run` — a **one-shot** disposable cluster test: verify or fetch real
  **server** binaries and their runtime libraries, `initdb` an owned temp cluster,
  start on a Unix socket only, run a health check, stop via a trap, and delete
  only after the stop is proven. Any failure retains the artifacts for inspection
  (never a blind `rm -rf`).
- `setup.sh selftest` — controlled fake-command safety tests (symlink refusal,
  wrong-name refusal, relative-path refusal, "delete only after proven stop").
  No PostgreSQL, no network.
- `run-suite.sh` — the **full D01–D06 acceptance suite** (the `pnpm verify:t01`
  entry point). It is portable: the repo path is derived from the script's own
  directory (never a hardcoded absolute checkout), a pinned Linux Node (`v24.18.0`)
  is fetched into the owned per-run temp dir and used to run every test over the
  per-run Unix socket (the Windows->WSL TCP loopback is never used by the client),
  the port is chosen dynamically on `127.0.0.1`, a readiness probe proves the actual
  node-pg client connects before any phase, and every run writes to a **unique**
  `migrations/artifacts/<runId>/` directory. Failed runs preserve their artifacts.
- `setup.ps1` — **detect-only stub**. The earlier Docker lifecycle was **removed**
  as unsafe; it performs no destructive Docker operations.

> Honest environment note: a clean WSL distro may ship only the PostgreSQL
> **client** binaries or none at all. The scripts therefore download the official
> `postgresql-18` apt package **and** its runtime library packages
> (`libpq5`, `libicuNN`, `libnuma1`, `liburing2`) into an owned temp directory and
> extract them with `dpkg-deb -x`, then expose them via `LD_LIBRARY_PATH` (no sudo,
> no system install, no system service changes).

## Isolation rules (mandatory)

- Names are ShowStake-specific: superuser `showstake`, databases
  `showstake_disposable` / `showstake_restore` (+ temporary `showstake_drift`,
  `showstake_d06`), temp dirs `showstake-pg-test.*` / `showstake-pg-selftest.*`.
- The cluster uses a private data dir, a per-run Unix socket, and listens on
  `127.0.0.1` (loopback only, never all-interfaces) on a dynamically chosen port.
- Only the directory this tool created is removed, and only after `pg_ctl` proves
  the server stopped and the path passes the ownership guard. Anything else is
  refused and retained.
- No `systemctl`, `service`, shared `/usr/lib` `initdb`, or connection to an
  existing database/service.

## Usage (WSL / Linux)

```sh
# 1. safety self-test (fast, no server, controlled fakes)
wsl bash scripts/postgres-disposable/setup.sh selftest

# 2. one-shot real server test (may download postgresql-18 into an owned temp dir)
wsl bash scripts/postgres-disposable/setup.sh run

# 3. full D01-D06 acceptance suite (from the repo root):
pnpm install --frozen-lockfile
pnpm verify:t01
```

## Verification before trusting an instance

1. `run-suite.sh` logs the per-run `migrations/artifacts/<runId>/` directory and
   the `readiness.log` proving the node-pg client connected via the Unix socket.
2. Nothing maps a TCP port on all interfaces; the client never crosses the
   Windows->WSL TCP loopback.
3. Always let the trap stop the server; never kill it by hand and then delete a
   path that the ownership guard has not cleared.