#!/usr/bin/env bash
# Local build only. Does not load a signer, deploy, or contact a blockchain.
set -euo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OUT="$REPO/.local/mainnet-release"
mkdir -p "$OUT"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/var/tmp/showstake-mainnet-build-cache}"
export PATH="${HOME}/.cargo/bin:$PATH"
TOOLS="${SHOWSTAKE_WASM_TOOLS:-/var/tmp/showstake-mainnet-size/tools/usr}"
export LD_LIBRARY_PATH="$TOOLS/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
cd "$REPO/contracts/showstake/event-escrow-candidate"
cargo +1.99.1 test --features mainnet-review --lib --locked --offline 2>&1 | tee "$OUT/unit-tests.log"
cargo +1.99.1 test --lib --locked --offline
cargo +1.99.1 build --features mainnet-review --target wasm32-unknown-unknown --release --locked --offline
cp "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/showstake_event_escrow_candidate.wasm" "$OUT/release-unoptimized.wasm"
"$TOOLS/bin/wasm-opt" "$OUT/release-unoptimized.wasm" -Oz -o "$OUT/release-optimized.wasm"
"$TOOLS/bin/wasm-validate" "$OUT/release-optimized.wasm"
sha256sum "$OUT/release-optimized.wasm"
stat -c '%s bytes' "$OUT/release-optimized.wasm"
