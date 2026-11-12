#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
source "$root/.local/zcode-settlement-oracle/sandbox-probe/scripts/lib.sh"
ensure_owned_paths
cd "$root/test-support/contract-integration/runner"
CARGO_NET_OFFLINE=true "$RUSTUP" run "$TOOLCHAIN" cargo build --locked --bin mainnet_storage
expected=797b9d7a9a23907048d68a427e86a55c94f1de232dbfb8b8a1eec09ecef3bf13
sandbox=""
while IFS= read -r candidate; do
  if [ "$(sha256sum "$candidate" | cut -d' ' -f1)" = "$expected" ]; then sandbox="$candidate"; break; fi
done < <(find "$CARGO_TARGET_DIR/debug/build" /var/tmp/showstake-target*/debug/build -type f -name near-sandbox 2>/dev/null)
[ -n "$sandbox" ] || { echo 'BLOCKED_EXTERNAL: pinned sandbox unavailable'; exit 1; }
run_id="mainnet-storage-$(date -u +%Y%m%dT%H%M%SZ)-$$"
export RUN_ID="$run_id"
run_tmp="$RUNS_TMP_ROOT/$run_id"
mkdir -p "$run_tmp"
printf '%s\n' "$ROOT:$run_id" > "$run_tmp/.owner"
out="$root/test-support/contract-integration/evidence/runs/$run_id"
mkdir -p "$out"
wasm="$root/test-support/contract-integration/wasm/showstake-mainnet-review.wasm"
sha256sum "$wasm" | tee "$out/wasm.sha256"
HOME="$SANDBOX_CACHE_HOME" SHOWSTAKE_WASM="$wasm" bash "$ROOT/scripts/run-harness-owned.sh" "$CARGO_TARGET_DIR/debug/mainnet_storage" 300 "$run_tmp" "$sandbox" "$out/teardown.json" "$out/harness.log" | tee "$out/result.json"
echo "EVIDENCE=$out"
