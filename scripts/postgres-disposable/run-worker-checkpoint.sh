#!/usr/bin/env bash
# ShowStake apps/worker LOCAL checkpoint dump/stop/restore/resume acceptance.
#
# Proves the active-proof recovery path WITHOUT any network/public RPC:
#   1. seed a disposable DB with batch A (publish..finalize), cursor 206;
#   2. pg_dump the OWNED DB data to a per-run artifact + sha256 + manifest;
#   3. PROVEN stop + cleanup (the cluster is deleted — cursor is NOT resumable
#      after cleanup, which is exactly why the dump is needed);
#   4. restore the dump into a NEW owned disposable DB and verify identity;
#   5. resume batch B (settle..payouts) and assert equality vs the uninterrupted
#      single-run projection;
#   6. a malformed dump and a wrong-deployment dump both fail closed (FAILED,
#      not resume-eligible; no event rights created).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/setup.sh"
source "$SCRIPT_DIR/worker-checkpoint-lib.sh"   # SAME helper path as run-worker-testnet-v6.sh

REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
NODE_VERSION="v24.18.0"; NODE_TARBALL="node-${NODE_VERSION}-linux-x64.tar.xz"; NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_TARBALL}"
SS_PORT="${SS_PORT:-}"; SS_DB1="${SS_DB1:-showstake_disposable}"; SS_SUPERUSER="${SS_SUPERUSER:-showstake}"

log() { printf '[showstake-checkpoint] %s\n' "$*"; }
die() { printf '[showstake-checkpoint] ERROR: %s\n' "$*" >&2; exit 1; }
write_pg_hba() { cat > "$1" <<EOF
local   all   all                         trust
host    all   all   127.0.0.1/32          trust
host    all   all   ::1/128               trust
EOF
}
fetch_node() {
  local root="$1"; mkdir -p "$root/noderoot"
  if [ -x "$root/noderoot/bin/node" ]; then return 0; fi
  log "fetching pinned Linux Node ${NODE_VERSION}"
  ( cd "$root" && curl -fsS -o node.tar.xz "$NODE_URL" ) || die "node download failed"
  tar -xJf "$root/node.tar.xz" -C "$root/noderoot" --strip-components=1 || die "node extract failed"
  rm -f "$root/node.tar.xz"
}

# Globals for the EXIT trap (mirrors setup.sh / run-worker-suite.sh).
RUN_ROOT=""; RUN_PGBIN=""; RUN_DATADIR=""; RUN_STARTED=0; NODE=""; PGBIN=""; PSQL=""; SHARE=""; PORT=""; SUITE_OK=1
CUR_SOCKET=""

stop_record() {
  if [ -n "$RUN_DATADIR" ] && [ -d "$RUN_DATADIR" ] && [ -f "$RUN_DATADIR/postmaster.pid" ]; then
    if "$RUN_PGBIN/pg_ctl" -D "$RUN_DATADIR" -m fast -w stop >/dev/null 2>&1 && pg_is_stopped "$RUN_PGBIN" "$RUN_DATADIR"; then RUN_STARTED=0; return 0; fi
    return 1
  fi
  return 0
}

# Stand up a fresh owned disposable cluster and export the socket/port env.
start_cluster() {
  local root="$1" canonical datadir
  canonical="$(readlink -f "$root")"; datadir="$canonical/data"
  is_owned_test_root "$canonical" || die "mktemp dir failed ownership guard: $canonical"
  RUN_ROOT="$canonical"; RUN_DATADIR="$datadir"; RUN_PGBIN="$PGBIN"; RUN_STARTED=0
  EXPECTED_DELETE_ROOT="$canonical"; trap stop_and_verify EXIT
  mkdir -p "$canonical/socket"
  "$PGBIN/initdb" -D "$datadir" -L "$SHARE" -U "$SS_SUPERUSER" --auth-local=trust --auth-host=trust --no-locale -E UTF8 > "$canonical/initdb.log"
  write_pg_hba "$datadir/pg_hba.conf"
  "$PGBIN/pg_ctl" -D "$datadir" -l "$canonical/server.log" -o "-k $canonical/socket -c listen_addresses='127.0.0.1' -p $PORT" -w start >/dev/null
  RUN_STARTED=1
  "$PSQL" -h "$canonical/socket" -p "$PORT" -U "$SS_SUPERUSER" -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $SS_DB1" >/dev/null
  CUR_SOCKET="$canonical/socket"
  export SHOWSTAKE_PG_SOCKET="$CUR_SOCKET" SHOWSTAKE_PG_PORT="$PORT" SHOWSTAKE_PG_USER="$SS_SUPERUSER" SHOWSTAKE_PG_DB1="$SS_DB1"
}

run_worker_checkpoint() {
  local node_root node run_id artifacts dump manifest
  # --- one-time bin/node/lib/share setup (shared across both clusters) ---
  if ! PGBIN="$(find_server_bindir)"; then
    root_probe="$(mktemp -d "${TMPDIR:-/tmp}/showstake-pg-test.XXXXXX")"
    log "downloading postgresql-18 + client into $root_probe"
    download_extract "$root_probe" postgresql-18
    download_extract "$root_probe" postgresql-client-18
    PGBIN="$root_probe/extracted/usr/lib/postgresql/18/bin"
    fetch_runtime_libs "$root_probe"; export LD_LIBRARY_PATH="$root_probe/extracted/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    SHARE="$(find_share_dir "$PGBIN" "$root_probe")" || die "no share dir"
    PSQL="$root_probe/extracted/usr/lib/postgresql/18/bin/psql"
  else
    probe2="$(mktemp -d "${TMPDIR:-/tmp}/showstake-pg-test.XXXXXX")"
    fetch_runtime_libs "$probe2"
    export LD_LIBRARY_PATH="$probe2/extracted/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    SHARE="$(find_share_dir "$PGBIN" "$probe2")" || die "no share dir"
    PSQL="$(find_client_psql)" || { download_extract "$probe2" postgresql-client-18; PSQL="$probe2/extracted/usr/lib/postgresql/18/bin/psql"; }
  fi
  node_root="$(mktemp -d "${TMPDIR:-/tmp}/showstake-checkpoint-node.XXXXXX")"
  fetch_node "$node_root"; NODE="$node_root/noderoot/bin/node"
  PORT="$("$NODE" -e 'const net=require("net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});')"

  run_ts="$(date -u +%Y%m%dT%H%M%SZ)"; run_id="worker-checkpoint-run-${run_ts}-$$"
  artifacts="$REPO/migrations/artifacts/$run_id"; mkdir -p "$artifacts"
  export SHOWSTAKE_PG_ARTIFACTS="$artifacts" SHOWSTAKE_PG_RUN_ID="$run_id" SHOWSTAKE_PG_SERVICE_USER='showstake_worker_service'
  log "run id: $run_id"; log "artifact dir: $artifacts"
  [ -d "$REPO/apps/worker/node_modules" ] || die "apps/worker node_modules missing (pnpm install first)"

  # --- cluster A: seed batch A ---
  local rootA; rootA="$(mktemp -d "${TMPDIR:-/tmp}/showstake-pg-test.XXXXXX")"
  start_cluster "$rootA"
  log "=== batch A (seed) ==="
  if ! "$NODE" "$REPO/apps/worker/test/verify-worker-checkpoint.mjs" seed >"$artifacts/seed.log" 2>&1; then log "seed FAILED"; cat "$artifacts/seed.log" >&2; SUITE_OK=0; fi

  # --- dump the OWNED DB data BEFORE stop/cleanup (shared helper) ---
  dump="$artifacts/checkpoint-$run_id.dump"; manifest="$artifacts/checkpoint-$run_id-manifest.json"
  if ! dump_sha="$(ckpt_dump "$CUR_SOCKET" "$PORT" "$SS_DB1" "$artifacts" "$run_id" 'showstake-worker-checkpoint' 200)"; then
    log "checkpoint dump FAILED (classified FAILED, not resume-eligible)"; cat "$artifacts/pg_dump-$run_id.log" >&2; SUITE_OK=0; dump_sha=""
  else
    log "checkpoint dumped ($dump_sha) + manifest"
  fi

  # --- PROVEN stop + cleanup of cluster A (cursor now gone with it) ---
  if stop_record; then log "cluster A stop PROVEN"; else log "cluster A stop NOT proven"; SUITE_OK=0; fi
  if safe_cleanup "$PGBIN" "$rootA" "$RUN_DATADIR"; then log "cluster A cleanup complete"; else log "cluster A cleanup refused"; SUITE_OK=0; fi
  EXPECTED_DELETE_ROOT=""

  # --- cluster B: schema+roles, then restore data, then resume ---
  local rootB; rootB="$(mktemp -d "${TMPDIR:-/tmp}/showstake-pg-test.XXXXXX")"
  start_cluster "$rootB"
  log "=== prep + restore + resume ==="
  if ! "$NODE" "$REPO/apps/worker/test/verify-worker-checkpoint.mjs" prep >"$artifacts/prep.log" 2>&1; then log "prep FAILED"; cat "$artifacts/prep.log" >&2; SUITE_OK=0; fi
  if [ -n "$dump_sha" ]; then
    if ! ckpt_verify_and_restore "$dump" "$manifest" "$CUR_SOCKET" "$PORT" "$SS_DB1" 200 >"$artifacts/verify_restore.log" 2>&1; then
      log "checkpoint verify/restore FAILED (quarantined; FAILED, not resume-eligible)"; cat "$artifacts/verify_restore.log" >&2; SUITE_OK=0
    elif ! CKPT_MANIFEST="$manifest" "$NODE" "$REPO/apps/worker/test/verify-worker-checkpoint.mjs" resume >"$artifacts/resume.log" 2>&1; then
      log "resume FAILED"; cat "$artifacts/resume.log" >&2; SUITE_OK=0
    else
      log "resume PASS (two-batch == uninterrupted)"
    fi
  fi

  # --- malformed dump fails closed via the SAME helper (sha/verify mismatch) ---
  head -c 64 "$dump" > "$artifacts/corrupt.dump" 2>/dev/null || true
  if ckpt_verify_and_restore "$artifacts/corrupt.dump" "$manifest" "$CUR_SOCKET" "$PORT" "$SS_DB1" 200 >"$artifacts/corrupt_restore.log" 2>&1; then
    log "malformed dump UNEXPECTEDLY restored"; SUITE_OK=0
  else
    log "malformed dump fails closed (classified FAILED)"
  fi

  # --- wrong-deployment dump fails closed ---
  if ! "$NODE" "$REPO/apps/worker/test/verify-worker-checkpoint.mjs" wrongdeploy >"$artifacts/wrongdeploy.log" 2>&1; then log "wrongdeploy FAILED"; cat "$artifacts/wrongdeploy.log" >&2; SUITE_OK=0; else log "wrong-deployment restore fails closed (no event rights)"; fi

  # --- space-path pair parser regression (exercises the REAL runner's ckpt_latest
  #     restore branch; REPO/artifacts contain "Hackacton yang masih jalan") ---
  local late_mf late_dump
  mapfile -t ckpt_pair < <(ckpt_latest "$artifacts")
  late_mf="${ckpt_pair[0]:-}"; late_dump="${ckpt_pair[1]:-}"
  if [ -s "$late_mf" ] && [ -s "$late_dump" ] && [ "$late_mf" = "$manifest" ] && [ "$late_dump" = "$dump" ]; then
    log "ckpt_latest space-path parse OK"
  else
    log "ckpt_latest space-path parse FAILED (mf='$late_mf' dump='$late_dump')"; SUITE_OK=0
  fi

  if stop_record; then log "cluster B stop PROVEN"; else log "cluster B stop NOT proven"; SUITE_OK=0; fi
  if safe_cleanup "$PGBIN" "$rootB" "$RUN_DATADIR"; then log "cluster B cleanup complete"; else log "cluster B cleanup refused"; SUITE_OK=0; fi
  EXPECTED_DELETE_ROOT=""
  case "$(basename "$node_root")" in showstake-checkpoint-node.*) rm -rf "$node_root" ;; esac

  log "suite complete (SUITE_OK=$SUITE_OK)"
  return $(( 1 - SUITE_OK ))
}

run_worker_checkpoint