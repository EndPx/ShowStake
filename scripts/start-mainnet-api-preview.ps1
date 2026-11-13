param([switch]$Build)
# Local HTTP preview only. No wallet key, chain signing or broadcasting.
$ErrorActionPreference='Stop'
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
if ($Build) {
  & pnpm --filter @showstake/api build
  if ($LASTEXITCODE -ne 0) { throw 'API build failed' }
}
$env:HOST='127.0.0.1'
$env:PORT='3002'
$env:DATABASE_URL='postgresql://showstake_dev_api@127.0.0.1:55440/showstake_dev'
$env:DB_ROLE='showstake_api'
$env:AUTH_DOMAIN='showstake.app'
$env:AUTH_NETWORK='mainnet'
$env:COOKIE_NAME='showstake_mainnet_session'
$env:COOKIE_SECURE='false' # Loopback HTTP only; production HTTPS requires true.
$env:AUTH_ALLOWED_ORIGINS='http://127.0.0.1:3012,http://localhost:3012'
$env:RPC_MAINNET_URL='https://rpc.mainnet.near.org'
$env:ACCESS_CONTRACT_ALLOWLIST='mainnet:showstake-mainnet-escrow-endpx-2026.near'
$env:ACCESS_CONTRACT_ABIS='mainnet:showstake-mainnet-escrow-endpx-2026.near=candidate-v1'
$env:ACCESS_CONTRACT_CODE_HASHES='mainnet:showstake-mainnet-escrow-endpx-2026.near=CpnhymSeF785ZBVTaBZfW8ApsfMVUByNCrys8R2i8os'
$env:ACCESS_FACTORY_CODE_HASHES=''
$env:RHEA_MICROTEST_APPROVAL_FILE=''
$env:PRIVATE_CONTENT_DIR=Join-Path $env:LOCALAPPDATA 'ShowStake/private-content'
if (!(Test-Path -LiteralPath $env:PRIVATE_CONTENT_DIR)) { New-Item -ItemType Directory -Path $env:PRIVATE_CONTENT_DIR -Force | Out-Null }
# Restart intentionally invalidates old local QR challenges; never print this value.
$qrBytes=New-Object byte[] 32
$qrRng=[Security.Cryptography.RandomNumberGenerator]::Create()
try { $qrRng.GetBytes($qrBytes) } finally { $qrRng.Dispose() }
$env:QR_HMAC_KEY=[Convert]::ToBase64String($qrBytes)
Write-Output 'Mainnet read-only API preview: http://127.0.0.1:3002/v1/mainnet/readiness'
Write-Output 'Requires migrated local dev DB and restricted service login. Ctrl+C stops this API only.'
try { & node apps/api/dist/index.js; $result=$LASTEXITCODE } finally { $env:QR_HMAC_KEY='' }
exit $result
