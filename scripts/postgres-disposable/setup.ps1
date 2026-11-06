# Disposable ShowStake PostgreSQL via Docker: DETECT-ONLY, destructive lifecycle REMOVED.
#
# The previous version here created/removed a fixed-name container, volume and
# network with `docker rm -f` / `docker volume rm`, mapped the port on ALL host
# interfaces, ignored native command failures, and used the floating `postgres:16`
# image. That was rejected: a fixed name is not ownership proof, it could delete
# non-owned resources, and failures were not fail-closed.
#
# This stub therefore performs NO container/volume/network creation or removal.
# It only reports whether a Docker engine is reachable and points to the verified
# WSL one-shot path (scripts/postgres-disposable/setup.sh) which downloads the
# official postgresql-18 server package into an owned temp dir, no Docker required.
#
# Any future Docker path must be reimplemented from scratch with: an exact image
# digest (not a floating tag), ownership labels, localhost-only port binding,
# fail-closed ($ErrorActionPreference='Stop' and explicit exit checks on every
# native command), and no destructive teardown without proven ownership — then be
# Codex-reviewed before it ever runs. Do not restore the deleted lifecycle here.
param(
  [ValidateSet('status','setup','teardown')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'

function Write-Blocked {
  Write-Output 'BLOCKED_EXTERNAL: Docker path not implemented (destructive lifecycle removed).'
  Write-Output 'Use the WSL one-shot script instead (verified official PostgreSQL 18.6, no Docker):'
  Write-Output '  wsl bash scripts/postgres-disposable/setup.sh selftest'
  Write-Output '  wsl bash scripts/postgres-disposable/setup.sh run'
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Output 'docker CLI not found.'
  Write-Blocked
  exit 0
}

docker info *> $null
$engineOk = ($LASTEXITCODE -eq 0)

if (-not $engineOk) {
  Write-Output 'Docker engine is DOWN (docker info failed).'
  Write-Blocked
  exit 0
}

Write-Output 'Docker engine is reachable.'
Write-Output 'The disposable-container lifecycle is intentionally NOT implemented here (unverified destructive teardown).'
Write-Output 'Do not create or remove ShowStake Docker resources from this stub.'
Write-Blocked
exit 0