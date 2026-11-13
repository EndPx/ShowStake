param([switch]$Build)
# Local browser preview only. This script never loads a key or signs a transaction.
$ErrorActionPreference='Stop'
$repo=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $repo
$env:NEXT_PUBLIC_SHOWSTAKE_NETWORK='mainnet'
$env:SHOWSTAKE_NEXT_DIST_DIR='.next-mainnet-review'
$env:SHOWSTAKE_API_UPSTREAM_URL='http://127.0.0.1:3002'
$profile=Join-Path $repo 'apps/web/.next-mainnet-review/showstake-profile.json'
$needsBuild=$Build -or !(Test-Path -LiteralPath $profile)
if (!$needsBuild) {
  $saved=Get-Content -LiteralPath $profile -Raw|ConvertFrom-Json
  $needsBuild=$saved.network -ne 'mainnet' -or $saved.apiPort -ne 3002
}
if ($needsBuild) {
  & pnpm --filter @showstake/web build
  if ($LASTEXITCODE -ne 0) { throw 'Mainnet preview build failed; server not started' }
  [IO.File]::WriteAllText($profile,'{"network":"mainnet","apiPort":3002}')
}
Write-Output 'Local mainnet preview: http://127.0.0.1:3012/events/new'
Write-Output 'Funding, provider and event approvals remain controlled by the reviewed release configuration.'
Write-Output 'The mainnet API is expected on loopback port 3002. Ctrl+C stops this frontend only.'
& pnpm --dir apps/web exec next start --hostname 127.0.0.1 --port 3012
exit $LASTEXITCODE
