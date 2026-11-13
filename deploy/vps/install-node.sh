#!/usr/bin/env bash
# Install an already-downloaded official Node archive after independently verifying its SHA-256.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo 'Run as root.' >&2; exit 1; }
archive="${1:?Node v24.18.0 Linux x64 tar.xz path required}"
expected="${2:?independently verified SHA-256 required}"
[[ "$expected" =~ ^[0-9a-f]{64}$ ]] || { echo 'Invalid SHA-256.' >&2; exit 1; }
[ -f "$archive" ] && [ ! -L "$archive" ] || { echo 'Invalid archive.' >&2; exit 1; }
target=/opt/showstake/tools/node-v24.18.0-linux-x64
[ -d /opt/showstake/tools ] && [ ! -e "$target" ] && [ ! -L "$target" ] || { echo 'Target missing parent or already exists.' >&2; exit 1; }
actual="$(sha256sum "$archive" | cut -d' ' -f1)"
[ "$actual" = "$expected" ] || { echo 'Node archive hash mismatch.' >&2; exit 1; }
while IFS= read -r path; do
  case "$path" in node-v24.18.0-linux-x64|node-v24.18.0-linux-x64/*) ;; *) echo 'Unexpected archive member.' >&2; exit 1;; esac
  case "/$path/" in */../*) echo 'Unsafe archive member.' >&2; exit 1;; esac
done < <(tar -tJf "$archive")
tar -xJf "$archive" -C /opt/showstake/tools --no-same-owner
[ "$("$target/bin/node" --version)" = v24.18.0 ] || { echo 'Node version mismatch.' >&2; exit 1; }
echo 'Verified isolated Node installed.'
