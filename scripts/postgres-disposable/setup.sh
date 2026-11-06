#!/usr/bin/env bash
# ShowStake disposable PostgreSQL ONE-SHOT test (WSL / Linux).
#
# Replaces the earlier lifecycle (persistent state file + teardown `rm -rf`).
# That design was rejected because: teardown ignored stop failures, the state
# marker could name a non-owned/symlink path, repeated setup overwrote state,
# and pg_config selected a client-only install while the README claimed a server.
#
# This script is a single bounded test run, never a long-lived service manager:
#   1. verify or fetch REAL server binaries (initdb + pg_ctl + postgres all
#      present) — the official postgresql-18 apt package is downloaded into an
#      OWNED temp directory and extracted with dpkg-deb -x, no sudo, no system
#      install, no system service change;
#   2. initdb in that owned temp dir with an EXPLICIT -L share directory;
#   3. start with a Unix socket only (listen_addresses=''), ShowStake port;
#   4. run a minimal health check; and
#   5. stop via a trap. Deletion happens ONLY after the stop is PROVEN and the
#      path matches the exact per-run canonical marker. On any failure the
#      artifacts are RETAINED for inspection (never rm -rf blind).
#
# Safety invariants (Codex-reviewed):
#   * `pg_is_stopped` distinguishes a PROVEN stop (pg_ctl status exit 3) from an
#     error/unknown exit (1/2/4/…); those are never treated as "stopped".
#   * Deletion requires the exact per-run canonical path marker
#     (EXPECTED_DELETE_ROOT), an owned non-symlinked namespace, and a proven stop.
#   * The EXIT trap is installed before initdb/start and stops any server whose
#     postmaster.pid exists — including a start that failed AFTER the postmaster
#     began — so no unmanaged server can leak.
#
# Usage:
#   scripts/postgres-disposable/setup.sh selftest   # controlled safety-guard tests (no Postgres/network)
#   scripts/postgres-disposable/setup.sh run        # one-shot real server test
set -euo pipefail

SS_PORT="${SS_PORT:-55439}"
SS_DB="${SS_DB:-showstake_disposable}"
SS_SUPERUSER="${SS_SUPERUSER:-showstake}"
# 1 = remove the temp dir after a PROVEN stop only on success; 0 = always retain.
SS_CLEANUP_ON_SUCCESS="${SS_CLEANUP_ON_SUCCESS:-1}"
# Optional overrides (kept out of PATH guessing): SS_PG_BINDIR, SS_PG_SHARE, SS_PSQL.
# Test-only hook: SS_OWNER_UID overrides the "owned by uid" check (selftest).

log() { printf '[showstake-pg] %s\n' "$*"; }
die() { printf '[showstake-pg] ERROR: %s\n' "$*" >&2; exit 1; }

###############################################################################
# Safety guards (also exercised by `selftest`).
###############################################################################

# A disposable root is SAFE to delete only when: absolute, a real directory, no
# symlink component (resolved canonical path == input), owned by the current
# user, and matching the ShowStake namespace. basename+uid alone is NOT enough.
is_owned_test_root() {
  local p="${1:-}" canon
  [ -n "$p" ] || return 1
  case "$p" in /*) ;; *) return 1 ;; esac                   # absolute
  [ -d "$p" ] || return 1
  [ ! -L "$p" ] || return 1                                 # refuse final-component symlink
  canon="$(readlink -f "$p" 2>/dev/null || true)"
  [ -n "$canon" ] || return 1
  [ "$canon" = "$p" ] || return 1                           # refuse any symlink component / .. escape
  [ "$(stat -c '%u' "$p" 2>/dev/null || echo -1)" = "${SS_OWNER_UID:-$(id -u)}" ] || return 1
  case "$(basename "$p")" in showstake-pg-test.*|showstake-pg-selftest.*) ;; *) return 1 ;; esac
  return 0
}

# Only accept a directory that contains the actual server binaries. A client-only
# install (pg_config/psql but no initdb/pg_ctl/postgres) is NOT a server.
find_server_bindir() {
  local d
  if [ -n "${SS_PG_BINDIR:-}" ]; then
    d="$SS_PG_BINDIR"
    if [ -x "$d/initdb" ] && [ -x "$d/pg_ctl" ] && [ -x "$d/postgres" ]; then
      printf '%s\n' "$d"; return 0
    fi
  fi
  for d in /usr/lib/postgresql/*/bin; do
    if [ -x "$d/initdb" ] && [ -x "$d/pg_ctl" ] && [ -x "$d/postgres" ]; then
      printf '%s\n' "$d"; return 0
    fi
  done
  if command -v initdb >/dev/null 2>&1 && command -v pg_ctl >/dev/null 2>&1 && command -v postgres >/dev/null 2>&1; then
    dirname "$(command -v initdb)"; return 0
  fi
  return 1
}

# Locate a client psql (the server package does not ship psql). Returns its full
# path or fails. Used only for the health check, never for starting the server.
find_client_psql() {
  local d
  if [ -n "${SS_PSQL:-}" ] && [ -x "$SS_PSQL" ]; then printf '%s\n' "$SS_PSQL"; return 0; fi
  for d in /usr/lib/postgresql/*/bin; do
    if [ -x "$d/psql" ]; then printf '%s\n' "$d/psql"; return 0; fi
  done
  if command -v psql >/dev/null 2>&1; then command -v psql; return 0; fi
  return 1
}

# Download an official apt package and extract it into an OWNED temp dir. No
# sudo, no system install, no system service changes.
download_extract() {
  local root="$1" pkg="$2" deb
  command -v apt-get >/dev/null 2>&1 || die "no apt-get to fetch $pkg"
  command -v dpkg-deb >/dev/null 2>&1 || die "dpkg-deb not found"
  ( cd "$root" && apt-get download "$pkg" ) >/dev/null || die "apt-get download $pkg failed"
  deb="$(ls "$root"/"$pkg"_*.deb 2>/dev/null | head -n1)"
  [ -n "$deb" ] || die "downloaded package not found: $pkg"
  dpkg-deb -x "$deb" "$root/extracted" || die "dpkg-deb extract $pkg failed"
}

# Resolve the libicu runtime package name for this distro (postgresql-18 links
# libicuuc/libicui18n; the ABI suffix differs across Ubuntu releases). Uses a
# `case` match (not `grep -q` on a pipe) so `set -o pipefail` cannot be tripped
# by grep exiting after the match and SIGPIPE-ing apt-cache.
resolve_libicu_pkg() {
  local p out
  for p in libicu78 libicu77 libicu76 libicu74 libicu72; do
    out="$(apt-cache policy "$p" 2>/dev/null || true)"
    case "$out" in
      *"Candidate: "*[0-9]*) printf '%s\n' "$p"; return 0 ;;
    esac
  done
  return 1
}

# Fetch the runtime shared libraries the extracted server/client binaries need
# but that a clean distro may not have installed system-wide (libpq5, libicu,
# libnuma1, liburing2). Extracted into the OWNED temp tree and found via
# LD_LIBRARY_PATH — no sudo, no system install.
fetch_runtime_libs() {
  local root="$1" icu pkg
  icu="$(resolve_libicu_pkg)" || die "no libicu runtime package resolvable"
  for pkg in libpq5 "$icu" libnuma1 liburing2; do
    download_extract "$root" "$pkg" || die "runtime lib fetch failed: $pkg"
  done
}

find_share_dir() {
  local pgbin="$1" root="$2" s
  if [ -n "${SS_PG_SHARE:-}" ] && [ -d "$SS_PG_SHARE" ]; then
    printf '%s\n' "$SS_PG_SHARE"; return 0
  fi
  if [ -x "$pgbin/pg_config" ]; then
    s="$("$pgbin/pg_config" --sharedir 2>/dev/null || true)"
    if [ -n "$s" ] && [ -d "$s" ]; then printf '%s\n' "$s"; return 0; fi
  fi
  if [ -d "$root/extracted/usr/share/postgresql/18" ]; then
    printf '%s\n' "$root/extracted/usr/share/postgresql/18"; return 0
  fi
  return 1
}

# True (exit 0) ONLY when the server is PROVABLY stopped:
#   pg_ctl status: 0 = running; 3 = "no server running" (proven stopped);
#   any other non-zero (1/2/4/...) = error/unknown — NOT treated as stopped.
#   Additionally require postmaster.pid absent (belt-and-suspenders).
pg_is_stopped() {
  local pgbin="$1" datadir="$2" rc
  if [ ! -x "$pgbin/pg_ctl" ] || [ ! -d "$datadir" ]; then
    return 1   # cannot prove -> unknown (deny deletion)
  fi
  "$pgbin/pg_ctl" -D "$datadir" status >/dev/null 2>&1
  rc=$?
  [ "$rc" -eq 3 ] || return 1
  [ ! -f "$datadir/postmaster.pid" ] || return 1
  return 0
}

# The exact canonical path the current run created and may delete. safe_cleanup
# refuses any other path — even one that passes the ownership guard — so a
# recomputed basename can never name a foreign directory.
EXPECTED_DELETE_ROOT=""

# Delete a disposable root ONLY after (a) it is the exact per-run path, (b) it is
# owned and non-symlinked, and (c) the stop is proven.
safe_cleanup() {
  local pgbin="$1" root="$2" datadir="${3:-$2/data}"
  if [ "${SS_CLEANUP_ON_SUCCESS:-1}" != "1" ]; then
    log "retaining $root (SS_CLEANUP_ON_SUCCESS != 1)"; return 0
  fi
  [ -n "${EXPECTED_DELETE_ROOT:-}" ] || { log "REFUSE cleanup: no expected per-run delete root set"; return 1; }
  [ "$root" = "$EXPECTED_DELETE_ROOT" ] || {
    log "REFUSE cleanup: '$root' is not the per-run root '$EXPECTED_DELETE_ROOT'"; return 1; }
  is_owned_test_root "$root" || { log "REFUSE cleanup: not an owned disposable test root: $root"; return 1; }
  if pg_is_stopped "$pgbin" "$datadir"; then
    rm -rf "$root" && log "removed proven-stopped disposable cluster $root"
  else
    log "REFUSE cleanup: server not proven stopped (running/error/unknown); retaining $root"; return 1
  fi
}

###############################################################################
# Selftest: controlled fake-command safety tests (no Postgres, no network).
###############################################################################
SELFTEST_ROOT=""
cleanup_selftest() {
  local d="${SELFTEST_ROOT:-}"
  [ -n "$d" ] || return 0
  case "$(basename "$d")" in showstake-pg-selftest.*) ;; *) return 0 ;; esac
  [ -d "$d" ] && [ ! -L "$d" ] && rm -rf "$d"
}

# Create a fake pg_ctl whose `status` exits with a fixed code.
fake_pgctl() {
  local dir="$1" code="$2"
  mkdir -p "$dir"
  printf '#!/usr/bin/env bash\nexit %s\n' "$code" > "$dir/pg_ctl"
  chmod +x "$dir/pg_ctl"
}

selftest() {
  local fail=0 selftest_root fake_running fake_error fake_stopped fake_unknown
  SELFTEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/showstake-pg-selftest.XXXXXX")"
  trap cleanup_selftest EXIT
  selftest_root="$SELFTEST_ROOT"
  EXPECTED_DELETE_ROOT=""

  log "selftest: owned disposable root accepted"
  local ok_dir="$selftest_root/showstake-pg-test.accept"; mkdir -p "$ok_dir"
  is_owned_test_root "$ok_dir" || { log "FAIL: owned test root rejected"; fail=1; }

  log "selftest: wrong-name directory refused"
  local bad="$selftest_root/not-ours"; mkdir -p "$bad"
  is_owned_test_root "$bad" && { log "FAIL: wrong-name dir accepted"; fail=1; }

  log "selftest: symlink (final component) refused"
  ln -s "$ok_dir" "$selftest_root/showstake-pg-test.symlink"
  is_owned_test_root "$selftest_root/showstake-pg-test.symlink" && { log "FAIL: final symlink accepted"; fail=1; }

  log "selftest: relative path refused"
  ( cd "$selftest_root" && is_owned_test_root "showstake-pg-test.accept" ) && { log "FAIL: relative path accepted"; fail=1; }

  log "selftest: symlink COMPONENT (path escape) refused"
  local linkdir="$selftest_root/nested"
  mkdir -p "$linkdir" "$ok_dir/showstake-pg-test.inner"
  ln -s "$ok_dir" "$linkdir/escape"
  local escaped="$linkdir/escape/showstake-pg-test.inner"
  # canonical=$(readlink -f) resolves the `escape` symlink component to ok_dir,
  # so it cannot equal the symlinked path -> refused.
  is_owned_test_root "$escaped" && { log "FAIL: symlink-component path accepted"; fail=1; }

  log "selftest: owner mismatch refused (SS_OWNER_UID override)"
  SS_OWNER_UID=999999
  is_owned_test_root "$ok_dir" && { log "FAIL: owner-mismatch dir accepted"; fail=1; }
  unset SS_OWNER_UID
  is_owned_test_root "$ok_dir" || { log "FAIL: unset SS_OWNER_UID broke owned check"; fail=1; }

  # --- pg_is_stopped discrimination ---
  fake_pgctl "$selftest_root/fake-running" 0
  fake_pgctl "$selftest_root/fake-error" 1
  fake_pgctl "$selftest_root/fake-stopped" 3
  fake_pgctl "$selftest_root/fake-unknown" 4

  log "selftest: pg_ctl status 0 (running) is NOT stopped"
  pg_is_stopped "$selftest_root/fake-running" "$ok_dir" && { log "FAIL: running reported stopped"; fail=1; }

  log "selftest: pg_ctl status 1 (error) is NOT stopped (fail-closed)"
  pg_is_stopped "$selftest_root/fake-error" "$ok_dir" && { log "FAIL: error reported stopped"; fail=1; }

  log "selftest: pg_ctl status 4 (unknown) is NOT stopped"
  pg_is_stopped "$selftest_root/fake-unknown" "$ok_dir" && { log "FAIL: unknown reported stopped"; fail=1; }

  log "selftest: pg_ctl status 3 WITHOUT postmaster.pid is PROVEN stopped"
  local stopped_dir="$selftest_root/showstake-pg-test.stopped"; mkdir -p "$stopped_dir/data"
  pg_is_stopped "$selftest_root/fake-stopped" "$stopped_dir/data" || { log "FAIL: proven stopped not recognized"; fail=1; }

  log "selftest: pg_ctl status 3 WITH postmaster.pid is NOT stopped"
  local stale_dir="$selftest_root/showstake-pg-test.stalepid"; mkdir -p "$stale_dir/data"
  : > "$stale_dir/data/postmaster.pid"
  pg_is_stopped "$selftest_root/fake-stopped" "$stale_dir/data" && { log "FAIL: stale postmaster.pid reported stopped"; fail=1; }

  # --- safe_cleanup: marker, ownership, proven stop, stop failure ---
  log "selftest: deletion refused when no per-run marker set"
  local no_marker="$selftest_root/showstake-pg-test.nomarker"; mkdir -p "$no_marker/data"
  EXPECTED_DELETE_ROOT=""
  safe_cleanup "$selftest_root/fake-stopped" "$no_marker" "$no_marker/data" && { log "FAIL: cleanup without marker"; fail=1; }
  [ -d "$no_marker" ] || { log "FAIL: marker-less dir deleted"; fail=1; }

  log "selftest: deletion refused on marker mismatch (foreign path)"
  local marker_a="$selftest_root/showstake-pg-test.a"; mkdir -p "$marker_a/data"
  local marker_b="$selftest_root/showstake-pg-test.b"; mkdir -p "$marker_b/data"
  EXPECTED_DELETE_ROOT="$marker_a"
  safe_cleanup "$selftest_root/fake-stopped" "$marker_b" "$marker_b/data" && { log "FAIL: marker mismatch deleted"; fail=1; }
  [ -d "$marker_b" ] || { log "FAIL: marker-mismatch dir deleted"; fail=1; }

  log "selftest: deletion refused when stop cannot be proven (error exit)"
  local victim="$selftest_root/showstake-pg-test.running"; mkdir -p "$victim/data"
  EXPECTED_DELETE_ROOT="$victim"
  safe_cleanup "$selftest_root/fake-error" "$victim" "$victim/data" && { log "FAIL: cleanup without proven stop"; fail=1; }
  [ -d "$victim" ] || { log "FAIL: unproven-stop dir was deleted"; fail=1; }

  log "selftest: deletion allowed after proven stop + marker + ownership"
  local temp="$selftest_root/showstake-pg-test.delete"; mkdir -p "$temp/data"
  EXPECTED_DELETE_ROOT="$temp"
  safe_cleanup "$selftest_root/fake-stopped" "$temp" "$temp/data" || { log "FAIL: proven-stop cleanup refused"; fail=1; }
  [ ! -d "$temp" ] || { log "FAIL: proven-stop dir not removed"; fail=1; }

  EXPECTED_DELETE_ROOT=""
  unset SS_OWNER_UID 2>/dev/null || true

  if [ "$fail" = 0 ]; then log "selftest PASS_LOCAL (controlled fakes only; no live server)"; else log "selftest FAILED"; fi
  return "$fail"
}

###############################################################################
# run: one-shot real server test.
###############################################################################
# Globals referenced by the EXIT trap (function locals are out of scope at EXIT).
RUN_ROOT=""; RUN_PGBIN=""; RUN_DATADIR=""; RUN_STARTED=0

stop_and_verify() {
  # Stop whenever a data dir + postmaster.pid exists — INCLUDING a start that
  # failed after the postmaster began (postmaster.pid present, RUN_STARTED=0).
  if [ -n "$RUN_DATADIR" ] && [ -d "$RUN_DATADIR" ] && [ -f "$RUN_DATADIR/postmaster.pid" ]; then
    if ! "$RUN_PGBIN/pg_ctl" -D "$RUN_DATADIR" -m fast -w stop >/dev/null 2>&1; then
      log "ERROR: pg_ctl stop failed; retaining $RUN_ROOT for inspection"
      exit 1
    fi
    if ! pg_is_stopped "$RUN_PGBIN" "$RUN_DATADIR"; then
      log "ERROR: stop not proven (running/error/unknown); retaining $RUN_ROOT for inspection"
      exit 1
    fi
    RUN_STARTED=0
  fi
}

run() {
  local tmpbase="${TMPDIR:-/tmp}"
  local root canonical pgbin psql share datadir
  root="$(mktemp -d "$tmpbase/showstake-pg-test.XXXXXX")"
  canonical="$(readlink -f "$root")"
  datadir="$canonical/data"
  is_owned_test_root "$canonical" || die "mktemp dir failed ownership guard: $canonical"
  log "disposable cluster root: $canonical"

  if ! pgbin="$(find_server_bindir)"; then
    log "no verified PostgreSQL server binaries; downloading official postgresql-18 into owned temp dir"
    download_extract "$canonical" postgresql-18
    pgbin="$canonical/extracted/usr/lib/postgresql/18/bin"
  fi
  log "server bindir: $pgbin"
  [ -x "$pgbin/initdb" ] && [ -x "$pgbin/pg_ctl" ] && [ -x "$pgbin/postgres" ] \
    || die "bindir lacks server binaries (initdb/pg_ctl/postgres): $pgbin"

  if ! psql="$(find_client_psql)"; then
    log "no client psql found; downloading postgresql-client-18 into owned temp dir"
    download_extract "$canonical" postgresql-client-18
    psql="$canonical/extracted/usr/lib/postgresql/18/bin/psql"
  fi
  [ -x "$psql" ] || die "no psql client available for the health check: $psql"

  # Fetch runtime shared libraries (libpq5 / libicu / libnuma1 / liburing2) and
  # expose them so the extracted server/client binaries can link without a system
  # install. No sudo; everything stays in the owned temp tree.
  fetch_runtime_libs "$canonical"
  export LD_LIBRARY_PATH="$canonical/extracted/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

  share="$(find_share_dir "$pgbin" "$canonical")" || die "no PostgreSQL share directory; set SS_PG_SHARE"
  log "share dir: $share"

  # Publish trap-relevant values to globals and install the EXIT trap EARLY
  # (before initdb/start), so any failure path still attempts a guarded stop.
  RUN_ROOT="$canonical"; RUN_PGBIN="$pgbin"; RUN_DATADIR="$datadir"; RUN_STARTED=0
  EXPECTED_DELETE_ROOT="$canonical"
  trap stop_and_verify EXIT

  mkdir -p "$canonical/socket"
  "$pgbin/initdb" -D "$datadir" -L "$share" -U "$SS_SUPERUSER" \
    --auth-local=trust --auth-host=reject --no-locale -E UTF8 > "$canonical/initdb.log"

  "$pgbin/pg_ctl" -D "$datadir" -l "$canonical/server.log" \
    -o "-k $canonical/socket -c listen_addresses='' -p $SS_PORT" -w start >/dev/null
  RUN_STARTED=1

  # Health check (socket only, no TCP). Validate the server actually runs.
  "$psql" -h "$canonical/socket" -p "$SS_PORT" -U "$SS_SUPERUSER" -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE $SS_DB" >/dev/null
  "$psql" -h "$canonical/socket" -p "$SS_PORT" -U "$SS_SUPERUSER" -d "$SS_DB" -v ON_ERROR_STOP=1 -tAc \
    "SELECT current_setting('listen_addresses'), version()"

  stop_and_verify
  safe_cleanup "$pgbin" "$canonical" "$datadir" || { log "artifacts retained: $canonical"; return 1; }
  log "one-shot cleanup complete (server proven stopped)"
  EXPECTED_DELETE_ROOT=""
}

# Only dispatch when executed directly (not sourced), so run-suite.sh can reuse
# these guards without triggering the one-shot `run`.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-run}" in
    selftest) selftest ;;
    run) run ;;
    *) die "unknown command: ${1:-} (use run|selftest)" ;;
  esac
fi