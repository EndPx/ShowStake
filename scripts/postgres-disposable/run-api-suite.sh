#!/usr/bin/env bash
# ShowStake apps/api disposable-PostgreSQL acceptance (WSL / Linux).
#
# One-shot, isolated run for the API layer's DB acceptance:
#   * REPO derived from this script's directory (never a hardcoded absolute path).
#   * A pinned Linux Node (v24.18.0) is fetched into an OWNED per-run temp dir and
#     used to run the test over the per-run Unix socket (the Windows->WSL TCP
#     loopback is never used by the client).
#   * The cluster only binds 127.0.0.1 + the per-run Unix socket.
#   * Migrations are applied INSIDE the test (single-writer advisory lock), and a
#     worker-seeded projection + real challenge/session rows exercise the PgStore.
#   * Stop is PROVEN before the owned cluster dir is deleted (safe_cleanup guard).
#
# Classifier: PASS_LOCAL (generated keypair + fake resolver; no wallet proof).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/setup.sh"

REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"

NODE_VERSION="v24.18.0"
NODE_TARBALL="node-${NODE_VERSION}-linux-x64.tar.xz"
NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_TARBALL}"

SS_PORT="${SS_PORT:-}"
SS_DB1="${SS_DB1:-showstake_disposable}"
SS_SUPERUSER="${SS_SUPERUSER:-showstake}"

log() { printf '[showstake-api-pg] %s\n' "$*"; }
die() { printf '[showstake-api-pg] ERROR: %s\n' "$*" >&2; exit 1; }

write_pg_hba() {
  cat > "$1" <<EOF
local   all   all                         trust
host    all   all   127.0.0.1/32          trust
host    all   all   ::1/128               trust
EOF
}

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

stop_record() {
  if [ -n "${RUN_DATADIR:-}" ] && [ -d "$RUN_DATADIR" ] && [ -f "$RUN_DATADIR/postmaster.pid" ]; then
    if "$RUN_PGBIN/pg_ctl" -D "$RUN_DATADIR" -m fast -w stop >/dev/null 2>&1 \
       && pg_is_stopped "$RUN_PGBIN" "$RUN_DATADIR"; then
      RUN_STARTED=0
      return 0
    fi
    return 1
  fi
  return 0
}

RUN_ROOT=""; RUN_PGBIN=""; RUN_DATADIR=""; RUN_STARTED=0

run_api_suite() {
  local root canonical pgbin psql share datadir port node node_root suite_ok=1
  root="$(mktemp -d "${TMPDIR:-/tmp}/showstake-pg-test.XXXXXX")"
  node_root="$(mktemp -d "${TMPDIR:-/tmp}/showstake-api-node.XXXXXX")"
  canonical="$(readlink -f "$root")"
  datadir="$canonical/data"
  is_owned_test_root "$canonical" || die "mktemp dir failed ownership guard: $canonical"
  log "cluster root: $canonical"
  log "repo: $REPO"

  fetch_node "$node_root"
  node="$node_root/noderoot/bin/node"
  "$node" --version | grep -q "^${NODE_VERSION}" || die "pinned Node version mismatch (wanted ${NODE_VERSION})"

  port="$("$node" -e 'const net=require("net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});')"
  [ -n "$port" ] || die "could not pick a free loopback port"
  log "dynamic loopback port: $port"

  if ! pgbin="$(find_server_bindir)"; then
    log "no verified PostgreSQL server binaries; downloading official postgresql-18 into owned temp dir"
    download_extract "$canonical" postgresql-18
    pgbin="$canonical/extracted/usr/lib/postgresql/18/bin"
  fi
  for b in initdb pg_ctl postgres; do
    [ -x "$pgbin/$b" ] || die "server bindir lacks $b: $pgbin"
  done
  if command -v psql >/dev/null 2>&1; then
    psql="$(command -v psql)"
  else
    log "no client psql found; downloading postgresql-client-18 into owned temp dir"
    download_extract "$canonical" postgresql-client-18
    psql="$canonical/extracted/usr/lib/postgresql/18/bin/psql"
  fi
  [ -x "$psql" ] || die "no psql client available: $psql"

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

  local run_ts run_id artifacts
  run_ts="$(date -u +%Y%m%dT%H%M%SZ)"
  run_id="api-run-${run_ts}-$$"
  artifacts="$REPO/migrations/artifacts/$run_id"
  mkdir -p "$artifacts"
  log "run id: $run_id"
  log "artifact dir: $artifacts"

  export SHOWSTAKE_PG_SOCKET="$canonical/socket"
  export SHOWSTAKE_PG_PORT="$port"
  export SHOWSTAKE_PG_USER="$SS_SUPERUSER"
  export SHOWSTAKE_PG_DB1="$SS_DB1"
  export SHOWSTAKE_PG_ARTIFACTS="$artifacts"
  export SHOWSTAKE_PG_RUN_ID="$run_id"

  [ -d "$REPO/apps/api/node_modules" ] || die "apps/api node_modules missing (run: pnpm install first)"

  log "=== apps/api DB acceptance ==="
  if "$node" "$REPO/apps/api/test/verify-api-db.mjs" >"$artifacts/api-db.log" 2>&1; then
    log "api-db PASS"
  else
    log "api-db FAILED"; cat "$artifacts/api-db.log" >&2; suite_ok=0
  fi

  if stop_record; then log "server stop PROVEN"; else log "server stop NOT proven"; suite_ok=0; fi
  if safe_cleanup "$pgbin" "$canonical" "$datadir"; then log "cleanup complete"; else log "cleanup refused/retained (see log)"; suite_ok=0; fi
  EXPECTED_DELETE_ROOT=""

  case "$(basename "$node_root")" in
    showstake-api-node.*) rm -rf "$node_root" ;;
  esac

  log "suite complete"
  return $(( 1 - suite_ok ))
}

run_api_suite