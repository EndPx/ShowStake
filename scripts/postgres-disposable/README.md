# Disposable PostgreSQL (ShowStake-specific, isolated)

Preparatory setup for T01 schema/migration tests. **Schema application itself is T01.**
The baseline apply was performed separately by Codex (see
`docs/evidence/t01-postgresql-baseline.json`); this directory only provides the
disposable-instance tooling. Nothing here connects to an existing database
(Keyfolio / legacy CommitPass are explicitly out of scope).

## What these scripts are and are NOT

- `setup.sh run` — a **one-shot** disposable cluster test: verify or fetch real
  **server** binaries and their runtime libraries, `initdb` an owned temp cluster,
  start on a Unix socket only, run a health check, stop via a trap, and delete
  only after the stop is proven. Any failure retains the artifacts for inspection
  (never a blind `rm -rf`).
- `setup.sh selftest` — controlled fake-command safety tests (symlink refusal,
  wrong-name refusal, relative-path refusal, "delete only after proven stop").
  No PostgreSQL, no network.
- `setup.ps1` — **detect-only stub**. The earlier Docker lifecycle (create/remove a
  fixed-name container/volume/network, all-interfaces port, floating `postgres:16`)
  was **removed** as unsafe. It reports engine reachability and points to the WSL
  one-shot path; it performs no destructive Docker operations.

> Honest environment note: a clean WSL distro may ship only the PostgreSQL
> **client** binaries (`psql`, `pg_config`, ...) or none at all, and does **not**
> have `initdb`/`pg_ctl`/`postgres` or the runtime shared libraries (`libpq5`,
> `libicuNN`, `libnuma1`, `liburing2`) installed. The one-shot script therefore
> downloads the official `postgresql-18` apt package **and** those runtime library
> packages into an owned temp directory and extracts them with `dpkg-deb -x`, then
> exposes them via `LD_LIBRARY_PATH` (no sudo, no system install, no system service
> changes) — the same extraction approach Codex used for the baseline apply.

## Isolation rules (mandatory)

- Names are ShowStake-specific: superuser `showstake`, database `showstake_disposable`,
  temp dirs `showstake-pg-test.*` / `showstake-pg-selftest.*`.
- The cluster uses a private data dir and a Unix socket only (no TCP). If a port is
  used it is a ShowStake-only port (`55439` default), never the default 5432.
- Only the directory this tool created is removed, and only after `pg_ctl` proves
  the server stopped and the path passes the ownership guard (absolute, real dir,
  not a symlink, owned by the current user, correct namespace). Anything else is
  refused and retained.
- No `systemctl`, `service`, shared `/usr/lib` `initdb`, or connection to an
  existing database/service.

## Usage (WSL / Linux)

```sh
# 1. safety self-test (fast, no server, controlled fakes)
wsl bash scripts/postgres-disposable/setup.sh selftest

# 2. one-shot real server test (may download postgresql-18 into an owned temp dir)
wsl bash scripts/postgres-disposable/setup.sh run
```

`run` prints the cluster/socket path and the server version it connected to. It
stops the cluster on exit (trap) and removes the temp dir only after proving the
stop. If you want to keep artifacts set `SS_CLEANUP_ON_SUCCESS=0`; on any failure
artifacts are retained automatically so the failure can be inspected.

## Verification before trusting an instance

1. `run` prints a `showstake-pg-test.*` path and a `listen_addresses`/`version`
   row; confirm the path is under `/tmp` (or `$TMPDIR`) and owned by you.
2. Nothing here maps a TCP port on all interfaces; the socket is private to the
   run and the server uses `listen_addresses=''`.
3. Always let the trap stop the server; never kill it by hand and then delete a
   path that the ownership guard has not cleared.