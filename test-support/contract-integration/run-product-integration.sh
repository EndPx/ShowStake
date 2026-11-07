#!/usr/bin/env bash
# LOCAL product integration proof for the reviewed one-event ShowStake artifact.
#
# Reuses the existing sandbox-probe isolated toolchain, pinned near-sandbox
# binary, FT fixture Wasm, WSL target cache and supervised owned-teardown
# script. It adds no bootstrap, framework, contract rebuild or new target.
#
# The reviewed contract source/Wasm are inputs only:
#   test-support/contract-integration/wasm/showstake.wasm (candidate fc49fb85...)
# and are never rebuilt or modified here.
set -euo pipefail

INTEGRATION_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$INTEGRATION_ROOT/../.." && pwd)"
PROBE_ROOT="$WORKSPACE_ROOT/.local/zcode-settlement-oracle/sandbox-probe"
source "$PROBE_ROOT/scripts/lib.sh"

ensure_owned_paths

EXPECTED_SHOWSTAKE_SHA256="fc49fb85cc6e718086ddf81e9a936362a8c36ef9384a8444eadafa6ec0cdcd8e"
EXPECTED_FT_SHA256="d1c7d009a2c49bee5ad4997fe7e3114899fa667a06876fb6e435d9a72fffb195"
EXPECTED_SANDBOX_SHA256="797b9d7a9a23907048d68a427e86a55c94f1de232dbfb8b8a1eec09ecef3bf13"

RUN_TIMEOUT_SECONDS="${RUN_TIMEOUT_SECONDS:-1200}"
MIN_D_FREE_KB="${MIN_D_FREE_KB:-2097152}"     # 2 GiB
MIN_C_FREE_KB="${MIN_C_FREE_KB:-3145728}"     # 3 GiB
MIN_TMP_FREE_KB="${MIN_TMP_FREE_KB:-5242880}" # 5 GiB ext4 (not tmpfs /tmp)

RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')}"
RUN_DIR="$INTEGRATION_ROOT/evidence/runs/$RUN_ID"
RUN_TMP="$RUNS_TMP_ROOT/$RUN_ID"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p "$RUN_DIR" "$RUN_TMP"
export RUN_TMP RUN_ID

RUN_OWNER_EXPECTED="$ROOT:$RUN_ID"
if [ -f "$RUN_TMP/.owner" ]; then
  [ "$(cat "$RUN_TMP/.owner")" = "$RUN_OWNER_EXPECTED" ] || {
    echo "RUN_TMP_OWNERSHIP_COLLISION: $RUN_TMP" >&2
    exit 2
  }
else
  printf '%s\n' "$RUN_OWNER_EXPECTED" > "$RUN_TMP/.owner"
fi

free_kb() { df -Pk "$1" 2>/dev/null | awk 'NR==2 {print $4}'; }
D_FREE_BEFORE="$(free_kb /mnt/d || echo 0)"
C_FREE_BEFORE="$(free_kb /mnt/c || echo 0)"
TMP_FREE_BEFORE="$(free_kb /var/tmp || echo 0)"

log() { printf '%s\n' "$*" | tee -a "$RUN_DIR/runner.log"; }
log "RUN_ID=$RUN_ID"
log "RUN_DIR=$RUN_DIR"
log "WORKSPACE_ROOT=$WORKSPACE_ROOT"
log "PROBE_ROOT=$PROBE_ROOT"
log "WORKSPACE_ID=$WORKSPACE_ID"
log "RUN_TMP=$RUN_TMP"
log "disk_guard D=${D_FREE_BEFORE}KiB/min=${MIN_D_FREE_KB}KiB C=${C_FREE_BEFORE}KiB/min=${MIN_C_FREE_KB}KiB WSL_tmp=${TMP_FREE_BEFORE}KiB/min=${MIN_TMP_FREE_KB}KiB"

if [ "$D_FREE_BEFORE" -lt "$MIN_D_FREE_KB" ] || [ "$C_FREE_BEFORE" -lt "$MIN_C_FREE_KB" ] || [ "$TMP_FREE_BEFORE" -lt "$MIN_TMP_FREE_KB" ]; then
  log "BLOCKED_RESOURCE: D=${D_FREE_BEFORE}KiB C=${C_FREE_BEFORE}KiB WSL=/var/tmp=${TMP_FREE_BEFORE}KiB"
  exit 3
fi

TOOLCHAIN_EXIT=0
if ! toolchain_ready; then
  TOOLCHAIN_EXIT=4
  log "TOOLCHAIN_NOT_READY: $TOOLCHAIN under $TOOLCHAIN_ROOT (no bootstrap in this run)"
fi

SHOWSTAKE_WASM="$INTEGRATION_ROOT/wasm/showstake.wasm"
FT_WASM="$PROBE_ROOT/wasm/ft_fixture.wasm"
SHOWSTAKE_WASM_SHA256="$(sha256sum "$SHOWSTAKE_WASM" 2>/dev/null | awk '{print $1}')"
FT_WASM_SHA256="$(sha256sum "$FT_WASM" 2>/dev/null | awk '{print $1}')"
WASM_OK=false
if [ "$SHOWSTAKE_WASM_SHA256" = "$EXPECTED_SHOWSTAKE_SHA256" ] && [ "$FT_WASM_SHA256" = "$EXPECTED_FT_SHA256" ]; then
  WASM_OK=true
fi
log "showstake_wasm=$SHOWSTAKE_WASM sha256=${SHOWSTAKE_WASM_SHA256:-missing} expected=$EXPECTED_SHOWSTAKE_SHA256"
log "ft_fixture_wasm=$FT_WASM sha256=${FT_WASM_SHA256:-missing} expected=$EXPECTED_FT_SHA256"

RUNNER_BUILD_EXIT=1
RUNNER_EXIT=1
RUNNER_BIN="$CARGO_TARGET_DIR/debug/showstake-product-runner"
RUNNER_SHA256=""
BUILD_RUNNER_CMD="cd $INTEGRATION_ROOT/runner && CARGO_NET_OFFLINE=true $RUSTUP run $TOOLCHAIN cargo build --locked"
if [ "$TOOLCHAIN_EXIT" -eq 0 ] && [ "$WASM_OK" = true ]; then
  set +e
  (
    cd "$INTEGRATION_ROOT/runner" &&
    CARGO_NET_OFFLINE=true "$RUSTUP" run "$TOOLCHAIN" cargo build --locked
  ) > "$RUN_DIR/build-runner.log" 2>&1
  RUNNER_BUILD_EXIT=$?
  set -e
  if [ "$RUNNER_BUILD_EXIT" -eq 0 ] && [ -f "$RUNNER_BIN" ]; then
    RUNNER_SHA256="$(sha256sum "$RUNNER_BIN" | awk '{print $1}')"
  fi
  log "runner_build_exit=$RUNNER_BUILD_EXIT runner_sha256=${RUNNER_SHA256:-none}"
  if [ "$RUNNER_BUILD_EXIT" -ne 0 ]; then
    tail -40 "$RUN_DIR/build-runner.log" | tee -a "$RUN_DIR/runner.log" || true
  fi
fi

SANDBOX_BIN=""
SANDBOX_BIN_SHA256=""
SANDBOX_BIN_OK=false
while IFS= read -r candidate; do
  [ -n "$candidate" ] || continue
  candidate_sha="$(sha256sum "$candidate" | awk '{print $1}')"
  if [ "$candidate_sha" = "$EXPECTED_SANDBOX_SHA256" ]; then
    SANDBOX_BIN="$candidate"
    break
  fi
  [ -n "$SANDBOX_BIN" ] || SANDBOX_BIN="$candidate"
done < <(find "$CARGO_TARGET_DIR/debug/build" /var/tmp/showstake-target*/debug/build \
  -path '*near-sandbox*/out/.near/near-sandbox-2.14.0/near-sandbox' -type f 2>/dev/null)
if [ -n "$SANDBOX_BIN" ] && [ -f "$SANDBOX_BIN" ]; then
  SANDBOX_BIN_SHA256="$(sha256sum "$SANDBOX_BIN" | awk '{print $1}')"
  if [ "$SANDBOX_BIN_SHA256" = "$EXPECTED_SANDBOX_SHA256" ]; then
    SANDBOX_BIN_OK=true
  fi
  log "sandbox_bin=$SANDBOX_BIN sha256=$SANDBOX_BIN_SHA256 matches=$SANDBOX_BIN_OK"
else
  log "sandbox_bin=NOT_FOUND"
fi

if [ "$TOOLCHAIN_EXIT" -eq 0 ] && [ "$WASM_OK" = true ] && [ "$RUNNER_BUILD_EXIT" -eq 0 ] && [ "$SANDBOX_BIN_OK" = true ]; then
  RUN_SANDBOX_CMD="bash $PROBE_ROOT/scripts/run-harness-owned.sh $RUNNER_BIN $RUN_TIMEOUT_SECONDS $RUN_TMP $SANDBOX_BIN $RUN_DIR/teardown.json $RUN_DIR/harness.log"
  set +e
  HOME="$SANDBOX_CACHE_HOME" \
    FT_WASM="$FT_WASM" \
    FT_WASM_SHA256="$FT_WASM_SHA256" \
    SHOWSTAKE_WASM="$SHOWSTAKE_WASM" \
    SHOWSTAKE_WASM_SHA256="$SHOWSTAKE_WASM_SHA256" \
    EVIDENCE_OUT="$RUN_DIR/result.json" \
    RUN_ID="$RUN_ID" \
    bash "$PROBE_ROOT/scripts/run-harness-owned.sh" \
      "$RUNNER_BIN" "$RUN_TIMEOUT_SECONDS" "$RUN_TMP" "$SANDBOX_BIN" \
      "$RUN_DIR/teardown.json" "$RUN_DIR/harness.log"
  RUNNER_EXIT=$?
  set -e
  log "runner_exit=$RUNNER_EXIT"
  tail -25 "$RUN_DIR/harness.log" | tee -a "$RUN_DIR/runner.log" || true
fi

D_FREE_AFTER="$(free_kb /mnt/d || echo 0)"
C_FREE_AFTER="$(free_kb /mnt/c || echo 0)"
TMP_FREE_AFTER="$(free_kb /var/tmp || echo 0)"
FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

python3 - "$RUN_DIR/run.json" "$RUN_DIR/result.json" "$RUN_DIR/teardown.json" \
  "$RUN_ID" "$STARTED_AT" "$FINISHED_AT" "$RUNNER_EXIT" "$RUNNER_BUILD_EXIT" \
  "$SHOWSTAKE_WASM_SHA256" "$FT_WASM_SHA256" "$EXPECTED_SHOWSTAKE_SHA256" "$EXPECTED_FT_SHA256" \
  "$SANDBOX_BIN" "$SANDBOX_BIN_SHA256" "$EXPECTED_SANDBOX_SHA256" "$SANDBOX_BIN_OK" \
  "$RUNNER_BIN" "$RUNNER_SHA256" "$WASM_OK" "$RUN_DIR" "$RUN_TMP" \
  "$BUILD_RUNNER_CMD" "${RUN_SANDBOX_CMD:-NOT_RUN}" \
  "$D_FREE_BEFORE" "$C_FREE_BEFORE" "$TMP_FREE_BEFORE" \
  "$D_FREE_AFTER" "$C_FREE_AFTER" "$TMP_FREE_AFTER" <<'PY'
import hashlib, json, os, sys

(out_path, result_path, teardown_path, run_id, started_at, finished_at,
 runner_exit, runner_build_exit, showstake_sha, ft_sha, expected_showstake_sha,
 expected_ft_sha, sandbox_bin, sandbox_sha, expected_sandbox_sha, sandbox_ok,
 runner_bin, runner_sha, wasm_ok, run_dir, run_tmp, build_cmd, run_cmd,
 d_before, c_before, tmp_before, d_after, c_after, tmp_after) = sys.argv[1:]

def read_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception as exc:
        return {"_read_error": str(exc)}

result = read_json(result_path)
teardown = read_json(teardown_path)
checks = result.get("checks", []) if isinstance(result, dict) else []
txs = result.get("transactions", []) if isinstance(result, dict) else []
checks_passed = sum(1 for item in checks if item.get("passed") is True)
checks_total = len(checks)
result_status = result.get("status", "MISSING") if isinstance(result, dict) else "MISSING"
proven_stopped = teardown.get("proven_stopped", False) is True
ownership_verified = teardown.get("ownership_verified", False) is True
result_wasm = result.get("wasm", {}) if isinstance(result, dict) else {}
result_wasm_ok = (
    result_wasm.get("showstake_sha256") == expected_showstake_sha
    and result_wasm.get("ft_fixture_sha256") == expected_ft_sha
)

failed = []
if runner_build_exit != "0":
    failed.append(f"runner_build_exit={runner_build_exit}")
if runner_exit != "0":
    failed.append(f"runner_exit={runner_exit}")
if wasm_ok != "true":
    failed.append("input_wasm_hash_mismatch")
if sandbox_ok != "true":
    failed.append("sandbox_binary_hash_mismatch")
if result_status != "PASS_LOCAL":
    failed.append(f"result_status={result_status}")
if checks_total == 0 or checks_passed != checks_total:
    failed.append(f"checks={checks_passed}/{checks_total}")
if not txs:
    failed.append("no_transactions")
if not result_wasm_ok:
    failed.append("result_wasm_hash_mismatch")
if not proven_stopped:
    failed.append("teardown_not_proven")
if not ownership_verified:
    failed.append("teardown_ownership_not_verified")

overall = "PASS_LOCAL" if not failed else "FAILED"
record = {
    "schema": "showstake.product-runner.run/1.1.0",
    "run_id": run_id,
    "overall_status": overall,
    "started_at_utc": started_at,
    "finished_at_utc": finished_at,
    "commands": {
        "build_runner": build_cmd,
        "run_sandbox": run_cmd,
    },
    "wasm": {
        "showstake_path": os.path.abspath(os.path.join(run_dir, "..", "..", "..", "wasm", "showstake.wasm")),
        "showstake_sha256": showstake_sha,
        "expected_showstake_sha256": expected_showstake_sha,
        "ft_fixture_sha256": ft_sha,
        "expected_ft_fixture_sha256": expected_ft_sha,
        "match": wasm_ok == "true",
    },
    "sandbox": {
        "binary": sandbox_bin,
        "sha256": sandbox_sha,
        "expected_sha256": expected_sandbox_sha,
        "match": sandbox_ok == "true",
    },
    "runner": {
        "binary": runner_bin,
        "sha256": runner_sha,
        "build_exit": int(runner_build_exit),
        "run_exit": int(runner_exit),
    },
    "result": {
        "path": result_path,
        "status": result_status,
        "error": result.get("error") if isinstance(result, dict) else None,
        "transactions": len(txs),
        "top_level_success": sum(1 for tx in txs if tx.get("top_level_success") is True),
        "expected_failures": [tx.get("label") for tx in txs if tx.get("top_level_failure") is True],
        "checks_passed": checks_passed,
        "checks_total": checks_total,
        "snapshots": len(result.get("snapshots", [])) if isinstance(result, dict) else 0,
        "wasm_hashes_match": result_wasm_ok,
    },
    "teardown": {
        "path": teardown_path,
        "ownership_verified": ownership_verified,
        "proven_stopped": proven_stopped,
        "owned": teardown.get("owned", []),
        "killed": teardown.get("killed", []),
        "remaining": teardown.get("remaining", []),
        "unverified_remaining": teardown.get("unverified_remaining", []),
        "pgid": teardown.get("pgid"),
        "harness_pid": teardown.get("harness_pid"),
        "strategy": teardown.get("strategy"),
        "limits": teardown.get("limits", []),
    },
    "paths": {
        "run_dir": run_dir,
        "run_tmp": run_tmp,
        "result_json": result_path,
        "teardown_json": teardown_path,
        "harness_log": os.path.join(run_dir, "harness.log"),
        "runner_log": os.path.join(run_dir, "runner.log"),
        "build_runner_log": os.path.join(run_dir, "build-runner.log"),
    },
    "free_space_kb": {
        "d_before": int(d_before), "c_before": int(c_before),
        "wsl_var_tmp_before": int(tmp_before),
        "d_after": int(d_after), "c_after": int(c_after),
        "wsl_var_tmp_after": int(tmp_after),
    },
    "failure_reasons": failed,
    "limits": [
        "Local synthetic NEAR Sandbox only; no testnet/mainnet, public RPC, wallet, key or real asset.",
        "The reviewed ShowStake Wasm is an input and was not rebuilt or modified by this run.",
        "PASS_LOCAL is local sandbox receipt/balance evidence only; it is not a testnet deployment gate.",
        "Teardown proves only this run's own PGID + pinned near-sandbox binary + run-owned --home.",
    ],
}
with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
    json.dump(record, fh, indent=2)
    fh.write("\n")

print(f"OVERALL_STATUS {overall}")
print(f"RESULT_STATUS {result_status}")
print(f"CHECKS {checks_passed}/{checks_total}")
print(f"TRANSACTIONS {len(txs)}")
print(f"TEARDOWN ownership={ownership_verified} stopped={proven_stopped}")
if failed:
    print("FAILURES " + ", ".join(failed))
PY

RUN_STATUS="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["overall_status"])' "$RUN_DIR/run.json")"
mkdir -p "$INTEGRATION_ROOT/evidence"
python3 - "$INTEGRATION_ROOT/evidence/latest.json" "$RUN_ID" "$RUN_DIR/run.json" "$RUN_STATUS" <<'PY'
import json, sys
out, run_id, run_path, status = sys.argv[1:]
with open(out, "w", encoding="utf-8", newline="\n") as fh:
    json.dump({
        "schema": "showstake.product-runner.latest/1.1.0",
        "run_id": run_id,
        "status": status,
        "run": run_path,
        "note": "Pointer to the current run only. Prior run folders are preserved.",
    }, fh, indent=2)
    fh.write("\n")
PY

log "overall_status=$RUN_STATUS run=$RUN_DIR"
if [ "$RUN_STATUS" != "PASS_LOCAL" ]; then
  exit 1
fi
