#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
source "$root/.local/zcode-settlement-oracle/sandbox-probe/scripts/lib.sh"
ensure_owned_paths
cd "$root/test-support/contract-integration/runner"
CARGO_NET_OFFLINE=true "$RUSTUP" run "$TOOLCHAIN" cargo build --locked --bin capacity_storage
expected=797b9d7a9a23907048d68a427e86a55c94f1de232dbfb8b8a1eec09ecef3bf13
sandbox=""
while IFS= read -r candidate; do if [ "$(sha256sum "$candidate" | cut -d' ' -f1)" = "$expected" ]; then sandbox="$candidate"; break; fi; done < <(find "$CARGO_TARGET_DIR/debug/build" /var/tmp/showstake-target*/debug/build -type f -name near-sandbox 2>/dev/null)
[ -n "$sandbox" ] || { echo 'BLOCKED_EXTERNAL: pinned sandbox unavailable'; exit 1; }
run_id="capacity-storage-$(date -u +%Y%m%dT%H%M%SZ)-$$"; export RUN_ID="$run_id"
run_tmp="$RUNS_TMP_ROOT/$run_id"; mkdir -p "$run_tmp"; printf '%s\n' "$ROOT:$run_id" > "$run_tmp/.owner"
out="$root/test-support/contract-integration/evidence/runs/$run_id"; mkdir -p "$out"
wasm="$root/test-support/contract-integration/wasm/showstake-mainnet-review.wasm"
ft="$root/.local/zcode-settlement-oracle/sandbox-probe/wasm/ft_fixture.wasm"
mock=/var/tmp/showstake-mainnet-build-cache/wasm32-unknown-unknown/release/mock_earn.wasm
sha256sum "$wasm" "$ft" "$mock" | tee "$out/wasm.sha256"
[ "$(sha256sum "$wasm" | cut -d' ' -f1)" = 03076c4a9496e8ae1e6af68c791752d4a7220597942effd0c3a1839a252be9d2 ]
[ "$(sha256sum "$ft" | cut -d' ' -f1)" = d1c7d009a2c49bee5ad4997fe7e3114899fa667a06876fb6e435d9a72fffb195 ]
[ "$(sha256sum "$mock" | cut -d' ' -f1)" = f780dcf30e3e23b236f842770be08ba1a763d99e9df702b56c4a1874b7a2b1d9 ]
HOME="$SANDBOX_CACHE_HOME" SHOWSTAKE_WASM="$wasm" FT_WASM="$ft" MOCK_WASM="$mock" bash "$ROOT/scripts/run-harness-owned.sh" "$CARGO_TARGET_DIR/debug/capacity_storage" 1200 "$run_tmp" "$sandbox" "$out/teardown.json" "$out/harness.log" | tee "$out/result.json"
echo "EVIDENCE=$out"
