#!/usr/bin/env bash
# ShowStake T01 disposable-PostgreSQL suite (WSL / Linux).
#
# Fully isolated, reproducible acceptance run:
#   * REPO is derived from THIS script's directory (never a hardcoded absolute
#     checkout path), so the suite works from any clone/checkout — including one
#     whose path contains spaces.
#   * A pinned Linux Node (see NODE_VERSION) is fetched into the OWNED per-run
#     temp dir and used to run every test over the per-run Unix socket. The
#     Windows->WSL TCP loopback is never used by the client, removing the
#     ECONNREFUSED class entirely; the server still listens on 127.0.0.1 (loopback
#     only) so D01 can assert "loopback or socket only".
#   * The port is picked dynamically on 127.0.0.1 (no fixed-port collision); the
#     disposable cluster only ever binds 127.0.0.1 + the per-run socket.
#   * Every run gets a UNIQUE artifact directory and run id; the aggregate step
#     refuses missing/failed/stale/invalid phases even if old green files exist.
#   * A readiness probe (the ACTUAL node-pg client) runs BEFORE any test, with a
#     bounded deadline and a precise final error.
#   * Failed runs preserve their artifacts; deletion only after a PROVEN stop.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/setup.sh"

REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"   # derive from script directory, not an absolute path

NODE_VERSION="v24.18.0"
NODE_TARBALL="node-${NODE_VERSION}-linux-x64.tar.xz"
NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_TARBALL}"

SS_PORT="${SS_PORT:-}"   # empty => pick a free port dynamically
SS_DB1="${SS_DB1:-showstake_disposable}"
SS_DB2="${SS_DB2:-showstake_restore}"
SS_SUPERUSER="${SS_SUPERUSER:-showstake}"

log() { printf '[showstake-pg-suite] %s\n' "$*"; }
die() { printf '[showstake-pg-suite] ERROR: %s\n' "$*" >&2; exit 1; }

write_pg_hba() {
  cat > "$1" <<EOF
local   all   all                         trust
host    all   all   127.0.0.1/32          trust
host    all   all   ::1/128               trust
EOF
}

# Record explicit, machine-checked source hashes + environment for the run's
# evidence. Never a bare `git add`; it only hashes the exact DB/foundation files.
# The list is COMPREHENSIVE (all sources, bootstrap/verifier scripts, domain,
# api-contract, setup scripts and the lockfiles), so a broad provenance claim
# like "all sources havehed" is actually backed by a hash for every file the
# acceptance depends on — not just a subset.
write_source_manifest() {
  local artifacts="$1" node="$2" pgbin="$3" f h first=1
  local list
  list=(
    package.json pnpm-lock.yaml pnpm-workspace.yaml .gitattributes .env.example
    migrations/schema/0001_initial.sql migrations/schema/0002_roles_grants.sql
    migrations/runner.mjs migrations/cli.mjs migrations/verify-baseline.mjs
    migrations/README.md migrations/COMMIT-MANIFEST.md
    migrations/tests/run-t01.mjs migrations/tests/lib.mjs migrations/tests/aggregate.mjs
    migrations/tests/replay.mjs migrations/tests/fixtures.mjs migrations/tests/readiness.mjs
    packages/domain/package.json packages/domain/README.md packages/domain/verify.mjs
    packages/domain/src/index.mjs packages/domain/src/atomic.mjs packages/domain/src/account.mjs
    packages/domain/src/capability.mjs packages/domain/src/states.mjs packages/domain/src/envelope.mjs
    packages/api-contract/openapi.yaml packages/api-contract/routes.json packages/api-contract/README.md
    scripts/verify-openapi.mjs scripts/verify-t01-aggregate.mjs
    scripts/verify-bootstrap.mjs scripts/verify-packet.mjs scripts/run-packet-verifier.mjs
    scripts/postgres-disposable/run-suite.sh scripts/postgres-disposable/setup.sh
    scripts/postgres-disposable/setup.ps1 scripts/postgres-disposable/README.md
  )
  {
    printf '{\n "base_commit":"%s",\n "files":{\n' "${SHOWSTAKE_BASE_COMMIT:-unknown}"
    for f in "${list[@]}"; do
      h="$(sha256sum "$REPO/$f" 2>/dev/null | awk '{print $1}')"
      [ -n "$h" ] || h="MISSING"
      if [ "$first" = 1 ]; then first=0; else printf ',\n'; fi
      printf '   "%s":"%s"' "$f" "$h"
    done
    printf '\n },\n'
    printf ' "environment":{"node":"%s","pnpm":"%s","uname":"%s","postgres":"%s"}\n}\n' \
      "$("$node" --version 2>/dev/null || echo unknown)" \
      "$(pnpm --version 2>/dev/null || echo unknown)" \
      "$(uname -sr)" \
      "$("$pgbin/postgres" --version 2>/dev/null | head -1 || echo unknown)"
  } > "$artifacts/source-manifest.json"
}

# Write the per-run orchestration result consumed by `finalize` (the fail-closed
# aggregator). Every required stage is recorded with its exit code; a missing or
# non-zero stage fails full acceptance.
write_orchestrator() {
  local artifacts="$1"
  cat > "$artifacts/orchestrator.json" <<EOF
{
  "run_id": "$SHOWSTAKE_PG_RUN_ID",
  "mode": "full",
  "base_commit": "${SHOWSTAKE_BASE_COMMIT:-unknown}",
  "stages": {
    "static-domain":   {"exit": $st_domain},
    "static-baseline": {"exit": $st_baseline},
    "static-aggregate":{"exit": $st_aggregate},
    "static-openapi":  {"exit": $st_openapi},
    "readiness":       {"exit": $st_readiness},
    "cli-status":      {"exit": $st_cli},
    "pg_dump":         {"exit": $st_dump},
    "pg_restore":      {"exit": $st_restore},
    "stop":            {"exit": $st_stop},
    "cleanup":         {"exit": $st_cleanup}
  },
  "dump": {"pg_dump": $st_dump, "pg_restore": $st_restore}
}
EOF
}

# Stop the disposable server and report whether the stop is PROVEN. Unlike the
# shared setup.sh stop_and_verify (which hard-exits on a failure so an unmanaged
# server can never leak), this variant RETURNS so the run can record the stop
# result before finalize. The EXIT trap still hard-exits via setup.sh's guard.
stop_record() {
  if [ -n "$RUN_DATADIR" ] && [ -d "$RUN_DATADIR" ] && [ -f "$RUN_DATADIR/postmaster.pid" ]; then
    if "$RUN_PGBIN/pg_ctl" -D "$RUN_DATADIR" -m fast -w stop >/dev/null 2>&1 \
       && pg_is_stopped "$RUN_PGBIN" "$RUN_DATADIR"; then
      RUN_STARTED=0
      return 0
    fi
    return 1
  fi
  return 0   # nothing to stop -> already stopped
}

# Fetch the pinned Linux Node into the OWNED per-run dir (no system install).
fetch_node() {
  local root="$1"
  mkdir -p "$root/noderoot"
  if [ -x "$root/noderoot/bin/node" ]; then return 0; fi
  log "fetching pinned Linux Node ${NODE_VERSION} into owned temp dir"
  ( cd "$root" && curl -fsS -o node.tar.xz "$NODE_URL" ) || die "download failed: $NODE_URL"
  tar -xJf "$root/node.tar.xz" -C "$root/noderoot" --strip-components=1 || die "extract failed: $NODE_TARBALL"
  rm -f "$root/node.tar.xz"
  [ -x "$root/noderoot/bin/node" ] || die "extracted Node lacks bin/node"
}

run_suite() {
  local root canonical pgbin psql share datadir suite_ok=1 node port
  local node_root
  # st_* are INTENTIONALLY global so write_orchestrator() can read them.
  st_domain=1; st_baseline=1; st_aggregate=1; st_openapi=1
  st_readiness=1; st_cli=1; st_dump=1; st_restore=1; st_stop=1; st_cleanup=1
  root="$(mktemp -d "${TMPDIR:-/tmp}/showstake-pg-test.XXXXXX")"
  # The pinned Node lives in its OWN temp dir (not the cluster dir) so it survives
  # the proven-stop cluster cleanup and can run the finalize aggregation.
  node_root="$(mktemp -d "${TMPDIR:-/tmp}/showstake-node.XXXXXX")"
  canonical="$(readlink -f "$root")"
  datadir="$canonical/data"
  is_owned_test_root "$canonical" || die "mktemp dir failed ownership guard: $canonical"
  log "suite cluster root: $canonical"
  log "repo: $REPO"

  fetch_node "$node_root"
  node="$node_root/noderoot/bin/node"
  "$node" --version | grep -q "^${NODE_VERSION}" || die "pinned Node version mismatch (wanted ${NODE_VERSION})"

  # Pick a free port on the loopback interface only (no fixed-port collision).
  port="$("$node" -e 'const net=require("net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});')"
  [ -n "$port" ] || die "could not pick a free loopback port"
  log "dynamic loopback port: $port"

  if ! pgbin="$(find_server_bindir)"; then
    log "no verified PostgreSQL server binaries; downloading official postgresql-18 into owned temp dir"
    download_extract "$canonical" postgresql-18
    pgbin="$canonical/extracted/usr/lib/postgresql/18/bin"
  fi
  log "server bindir: $pgbin"
  for b in initdb pg_ctl postgres; do
    [ -x "$pgbin/$b" ] || die "server bindir lacks $b: $pgbin"
  done

  # Client tools (psql + pg_dump/pg_restore) ship in the CLIENT package. When the
  # client package is extracted into the owned tree it lands in the same
  # usr/lib/postgresql/18/bin directory, so pgbin == clientbin in the common
  # no-system-postgres case; otherwise the client bindir is resolved separately.
  local clientbin
  if psql="$(find_client_psql)"; then
    clientbin="$(dirname "$psql")"
  else
    log "no client psql found; downloading postgresql-client-18 into owned temp dir"
    download_extract "$canonical" postgresql-client-18
    clientbin="$canonical/extracted/usr/lib/postgresql/18/bin"
    psql="$clientbin/psql"
  fi
  for b in psql pg_dump pg_restore; do
    [ -x "$clientbin/$b" ] || die "client bindir lacks $b: $clientbin"
  done

  fetch_runtime_libs "$canonical"
  export LD_LIBRARY_PATH="$canonical/extracted/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  share="$(find_share_dir "$pgbin" "$canonical")" || die "no PostgreSQL share directory; set SS_PG_SHARE"
  log "share dir: $share"

  RUN_ROOT="$canonical"; RUN_PGBIN="$pgbin"; RUN_DATADIR="$datadir"; RUN_STARTED=0
  EXPECTED_DELETE_ROOT="$canonical"
  trap stop_and_verify EXIT

  mkdir -p "$canonical/socket"
  "$pgbin/initdb" -D "$datadir" -L "$share" -U "$SS_SUPERUSER" \
    --auth-local=trust --auth-host=trust --no-locale -E UTF8 > "$canonical/initdb.log"
  write_pg_hba "$datadir/pg_hba.conf"

  "$pgbin/pg_ctl" -D "$datadir" -l "$canonical/server.log" \
    -o "-k $canonical/socket -c listen_addresses='127.0.0.1' -p $port" -w start >/dev/null
  RUN_STARTED=1

  "$psql" -h "$canonical/socket" -p "$port" -U "$SS_SUPERUSER" -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE $SS_DB1" >/dev/null
  "$psql" -h "$canonical/socket" -p "$port" -U "$SS_SUPERUSER" -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE $SS_DB2" >/dev/null

  # Every run gets a fresh, unique artifact dir + run id (never a fixed path).
  local run_ts run_id artifacts
  run_ts="$(date -u +%Y%m%dT%H%M%SZ)"
  run_id="run-${run_ts}-$$"
  artifacts="$REPO/migrations/artifacts/$run_id"
  mkdir -p "$artifacts"
  log "run id: $run_id"
  log "artifact dir: $artifacts"

  # A stale GIT_CONFIG_* pair inherited across WSL breaks `git` (and would corrupt
  # the base-commit derivation); clear it before any git call.
  unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_KEY_1 GIT_CONFIG_VALUE_0 GIT_CONFIG_VALUE_1 2>/dev/null || true

  export SHOWSTAKE_PG_SOCKET="$canonical/socket"
  export SHOWSTAKE_PG_PORT="$port"
  export SHOWSTAKE_PG_USER="$SS_SUPERUSER"
  export SHOWSTAKE_PG_DB1="$SS_DB1"
  export SHOWSTAKE_PG_DB2="$SS_DB2"
  export SHOWSTAKE_PG_ARTIFACTS="$artifacts"
  export SHOWSTAKE_PG_RUN_ID="$run_id"
  export SHOWSTAKE_BASE_COMMIT="${SHOWSTAKE_BASE_COMMIT:-$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)}"

  # Explicit source hashes + environment (the aggregate records these verbatim).
  write_source_manifest "$artifacts" "$node" "$pgbin"

  RUN_T01="$REPO/migrations/tests/run-t01.mjs"
  MIG_CLI="$REPO/migrations/cli.mjs"
  [ -d "$REPO/node_modules" ] || die "node_modules not found under $REPO (run: pnpm install --frozen-lockfile first)"

  # Stage defaults are set at the top of run_suite; here only the helper follows.
  run_node() {
    local name="$1"; shift
    log "=== $name ==="
    if "$node" "$@" >"$artifacts/$name.log" 2>&1; then
      log "$name PASS"
    else
      log "$name FAILED"; cat "$artifacts/$name.log" >&2; suite_ok=0
    fi
    return 0
  }

  # Static checks first (no DB needed) so their failures are visible immediately,
  # and each result is recorded in the orchestration result the aggregator reads.
  if "$node" "$REPO/packages/domain/verify.mjs" >"$artifacts/static-domain.log" 2>&1; then
    log "static-domain PASS"; st_domain=0
  else
    log "static-domain FAILED"; cat "$artifacts/static-domain.log" >&2; suite_ok=0
  fi
  if "$node" "$REPO/migrations/verify-baseline.mjs" >"$artifacts/static-baseline.log" 2>&1; then
    log "static-baseline PASS"; st_baseline=0
  else
    log "static-baseline FAILED"; cat "$artifacts/static-baseline.log" >&2; suite_ok=0
  fi
  if "$node" "$REPO/scripts/verify-t01-aggregate.mjs" >"$artifacts/static-aggregate.log" 2>&1; then
    log "static-aggregate PASS"; st_aggregate=0
  else
    log "static-aggregate FAILED"; cat "$artifacts/static-aggregate.log" >&2; suite_ok=0
  fi
  if "$node" "$REPO/scripts/verify-openapi.mjs" >"$artifacts/static-openapi.log" 2>&1; then
    log "static-openapi PASS"; st_openapi=0
  else
    log "static-openapi FAILED"; cat "$artifacts/static-openapi.log" >&2; suite_ok=0
  fi

  # Readiness: the ACTUAL node-pg client must connect before any phase. On failure
  # the DB phases are skipped (their phase files stay missing) and the run still
  # finalizes with FAILED — never a misleading PASS_LOCAL.
  log "=== readiness (node-pg over Unix socket) ==="
  if "$node" "$REPO/migrations/tests/readiness.mjs" --deadline-ms 30000 --interval-ms 500 \
       >"$artifacts/readiness.log" 2>&1; then
    log "readiness PASS"; st_readiness=0; cat "$artifacts/readiness.log"
  else
    log "readiness FAILED"; cat "$artifacts/readiness.log" >&2; st_readiness=1; suite_ok=0
  fi

  if [ "$st_readiness" = 0 ]; then
    run_node d01 "$RUN_T01" d01
    log "=== migrations CLI status (READ-ONLY, no bootstrap) ==="
    if "$node" "$MIG_CLI" status >"$artifacts/cli-status.log" 2>&1; then
      log "cli status PASS"; st_cli=0
    else
      log "cli status FAILED"; cat "$artifacts/cli-status.log" >&2; st_cli=1; suite_ok=0
    fi
    run_node d02 "$RUN_T01" d02
    run_node d03 "$RUN_T01" d03
    run_node d04-fixtures "$RUN_T01" d04-fixtures

    log "=== pg_dump DB1 -> pg_restore DB2 (same cluster, Unix socket) ==="
    local dump="$canonical/d1.dump" pdump=0 prestore=0
    if "$clientbin/pg_dump" -h "$canonical/socket" -p "$port" -U "$SS_SUPERUSER" -d "$SS_DB1" -Fc -f "$dump" >"$artifacts/d04-pgdump.log" 2>&1; then
      log "pg_dump exit 0"; st_dump=0; pdump=0
    else
      log "pg_dump FAILED"; cat "$artifacts/d04-pgdump.log" >&2; st_dump=1; pdump=1; suite_ok=0
    fi
    if [ "$pdump" = 0 ]; then
      if "$clientbin/pg_restore" -h "$canonical/socket" -p "$port" -U "$SS_SUPERUSER" -d "$SS_DB2" --no-owner --no-privileges "$dump" >"$artifacts/d04-pgrestore.log" 2>&1; then
        log "pg_restore exit 0"; st_restore=0; prestore=0
      else
        log "pg_restore FAILED"; cat "$artifacts/d04-pgrestore.log" >&2; st_restore=1; prestore=1; suite_ok=0
      fi
    else
      prestore=1
    fi
    printf '{"pg_dump":%s,"pg_restore":%s}\n' "$st_dump" "$st_restore" > "$artifacts/d04-dump-restore.json"

    run_node d04-verify "$RUN_T01" d04-verify
    run_node d05 "$RUN_T01" d05
    run_node d06 "$RUN_T01" d06
  fi

  # Stop + cleanup BEFORE finalize so the summary can record their results.
  if stop_record; then st_stop=0; log "server stop PROVEN"; else st_stop=1; suite_ok=0; log "server stop NOT proven"; fi
  if safe_cleanup "$pgbin" "$canonical" "$datadir"; then st_cleanup=0; log "cleanup complete"; else st_cleanup=1; suite_ok=0; log "cleanup refused/retained (see log)"; fi
  EXPECTED_DELETE_ROOT=""

  # Write the orchestration result, then finalize (the fail-closed aggregator
  # reads phases + orchestration and settles PASS_LOCAL / FAILED / NOT_RUN).
  # The pinned Node still exists (its own temp dir) so finalize can run AFTER the
  # cluster cleanup above.
  write_orchestrator "$artifacts"
  run_node finalize "$RUN_T01" finalize

  # Remove the pinned-Node scratch dir (downloaded binaries only; no database,
  # no server). Guarded to the per-run mktemp namespace.
  case "$(basename "$node_root")" in
    showstake-node.*) rm -rf "$node_root" ;;
  esac

  log "suite complete"
  return $(( 1 - suite_ok ))  # suite_ok: 1=all pass -> exit 0; 0=any fail -> exit 1
}

run_suite