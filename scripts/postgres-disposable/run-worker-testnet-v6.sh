#!/usr/bin/env bash
# ShowStake apps/worker READ-ONLY actual-testnet v6 settlement proof (WSL).
#
# Same disposable-PostgreSQL machinery as run-worker-testnet.sh, but the test
# exercises the accepted v6 settlement deployment (showstake-settle-endpx.testnet,
# f462ddcb…, showstake-v2-d036-settle/1) and projects the committed
# d036-settle-five lifecycle (publish/deposits/attendance/finalize/settle/payouts).
# No transactions, no funds, no secrets.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/setup.sh"
source "$SCRIPT_DIR/worker-checkpoint-lib.sh"   # dump/verify/restore (same helper path as local regression)

REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"

NODE_VERSION="v24.18.0"
NODE_TARBALL="node-${NODE_VERSION}-linux-x64.tar.xz"
NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_TARBALL}"

SS_PORT="${SS_PORT:-}"
SS_DB1="${SS_DB1:-showstake_disposable}"
SS_SUPERUSER="${SS_SUPERUSER:-showstake}"

log() { printf '[showstake-worker-testnet-v6] %s\n' "$*"; }
die() { printf '[showstake-worker-testnet-v6] ERROR: %s\n' "$*" >&2; exit 1; }

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

run_worker_testnet_v6() {
  local root canonical pgbin psql share datadir port node node_root suite_ok=1
  root="$(mktemp -d "${TMPDIR:-/tmp}/showstake-pg-test.XXXXXX")"
  node_root="$(mktemp -d "${TMPDIR:-/tmp}/showstake-worker-testnet-v6-node.XXXXXX")"
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
  run_id="worker-testnet-v6-run-${run_ts}-$$"
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

  [ -d "$REPO/apps/worker/node_modules" ] || die "apps/worker node_modules missing (run: pnpm install first)"

  # Shared-lib globals (the checkpoint helpers read these, not the local names).
  PGBIN="$pgbin"; PSQL="$psql"; NODE="$node"
  CKPT_DIR="$REPO/migrations/artifacts/worker-testnet-v6-checkpoint"

  log "=== apps/worker read-only v6 settlement testnet proof ==="
  # Resume a prior checkpoint if one exists (verify hash/source/config/deployment/cursor,
  # restore into this NEW/EMPTY owned DB, then let the proof resolveStartHeight).
  local ckpt_pair rest_manifest rest_dump
  mapfile -t ckpt_pair < <(ckpt_latest "$CKPT_DIR")
  rest_manifest="${ckpt_pair[0]:-}"; rest_dump="${ckpt_pair[1]:-}"
  if [ -n "$rest_manifest" ] && [ "$rest_dump" != "" ] && [ "${WORKER_CHECKPOINT_DISABLE_RESUME:-0}" != "1" ]; then
    log "resuming checkpoint: $rest_manifest"
    # schema+roles+deployment seed, then restore data, then full proof resumes.
    if "$node" "$REPO/apps/worker/test/verify-worker-testnet-v6.mjs" prep >"$artifacts/prep.log" 2>&1 \
       && ckpt_verify_and_restore "$rest_dump" "$rest_manifest" "$canonical/socket" "$port" "$SS_DB1" "${DEPLOYMENT_START_HEIGHT:-276712710}" >"$artifacts/verify_restore.log" 2>&1; then
      log "checkpoint verified + restored; resuming bounded scan"
    else
      log "checkpoint verify/restore FAILED (quarantined; falling back to fresh scan? NO — aborted)"; cat "$artifacts/verify_restore.log" >&2; die "checkpoint verify/restore failed (FAILED, not resume-eligible)"
    fi
  fi

  # Manifest identity is verified in the worker phase when resuming.
  export CKPT_MANIFEST="${rest_manifest:-}"
  if ! "$node" "$REPO/apps/worker/test/verify-worker-testnet-v6.mjs" >"$artifacts/worker-testnet-v6.log" 2>&1; then
    log "worker-testnet-v6 FAILED"; cat "$artifacts/worker-testnet-v6.log" >&2; suite_ok=0
    # Checkpoint BEFORE proven stop/cleanup (never overwrite: unique per run id).
    if ckpt_dump "$canonical/socket" "$port" "$SS_DB1" "$CKPT_DIR" "$run_id" 'showstake-worker-testnet-v6' "${DEPLOYMENT_START_HEIGHT:-276712710}" >"$artifacts/ckpt_dump.log" 2>&1; then
      log "checkpoint dumped for next resume"
    else
      log "checkpoint dump FAILED (classified FAILED, not resume-eligible)"; cat "$artifacts/ckpt_dump.log" >&2; suite_ok=0
    fi
  else
    log "worker-testnet-v6 PASS"
  fi

  if stop_record; then log "server stop PROVEN"; else log "server stop NOT proven"; suite_ok=0; fi
  if safe_cleanup "$pgbin" "$canonical" "$datadir"; then log "cleanup complete"; else log "cleanup refused/retained (see log)"; suite_ok=0; fi
  EXPECTED_DELETE_ROOT=""

  case "$(basename "$node_root")" in
    showstake-worker-testnet-v6-node.*) rm -rf "$node_root" ;;
  esac

  log "suite complete"
  return $(( 1 - suite_ok ))
}

run_worker_testnet_v6