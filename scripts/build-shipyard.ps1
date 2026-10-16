#Requires -Version 5.1
<#
  Build Harbor Shipyard (the managed installer) locally.

    powershell -File scripts/build-shipyard.ps1             # build everything, print the exe path
    powershell -File scripts/build-shipyard.ps1 -Run        # ...and launch the installer
    powershell -File scripts/build-shipyard.ps1 -SkipApp    # reuse the existing app release build
    powershell -File scripts/build-shipyard.ps1 -RebuildApp # force a fresh app release build
    powershell -File scripts/build-shipyard.ps1 -Channel beta   # stamp the build as beta

  Or through pnpm:  pnpm shipyard   /   pnpm shipyard -- -Run

  The frontend stamps itself from HARBOR_CHANNEL at build time: only "stable" clears the
  Beta label the app shows in About. -Channel sets it when this script builds the app;
  without it, an existing HARBOR_CHANNEL is respected, and the default is stable.

  Steps:
    1. app release build (pnpm tauri build --no-bundle) when harbor.exe is missing or -RebuildApp
    2. standalone uninstaller (no payload, small)
    3. payload assembly + verification (make-payload.mjs)
    4. Harbor Shipyard build + embedded-payload verification

  No signing, no staging, no publishing. For release artifacts use
  scripts/release-beta.ps1 (or pnpm release:stable / pnpm release:beta),
  which adds version checks, staging and signing.
#>
[CmdletBinding()]
param(
  [switch]$Run,
  [switch]$SkipApp,
  [switch]$RebuildApp,
  [ValidateSet('stable', 'beta')]
  [string]$Channel
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Step([string]$text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }
function Invoke-Tool([string]$file, [string[]]$arguments) {
  & $file @arguments
  if ($LASTEXITCODE -ne 0) { throw "$file $($arguments -join ' ') failed with exit $LASTEXITCODE" }
}

if ($SkipApp -and $RebuildApp) { throw 'Use either -SkipApp or -RebuildApp, not both.' }

$appExe = 'src-tauri/target/release/harbor.exe'
$shipyard = 'installer/src-tauri/target/release/harbor-shipyard.exe'

# No staged extension runtime means this build ships without extension support. The layer's
# sources are tracked while its jars are gitignored, so a jarless checkout looks "present but
# broken" to capstan-stage and it stops when sh cannot fetch the jars. Point it at a path that
# does not exist so the build takes the documented no-layer path instead.
if (-not (Test-Path -LiteralPath 'src-tauri/resources/capstan/capstan.jar')) {
  if (-not $env:HARBOR_CAPSTAN_OPTIONAL) {
    Write-Host 'No extension runtime staged; building without it (HARBOR_CAPSTAN_OPTIONAL=1).' -ForegroundColor Yellow
    $env:HARBOR_CAPSTAN_OPTIONAL = '1'
  }
  $noLayer = Join-Path $env:TEMP 'harbor-no-capstan-layer'
  Remove-Item -LiteralPath $noLayer -Recurse -Force -ErrorAction SilentlyContinue
  $env:HARBOR_CAPSTAN_SRC = $noLayer
}

# No staged game engine means this build ships tab-only games, which the payload script would
# otherwise refuse. Mirror the capstan fallback.
if (-not (Test-Path -LiteralPath 'src-tauri/resources/pokemon-engine/Harbor.PokemonEngine.exe') -and -not $env:HARBOR_POKEMON_OPTIONAL) {
  Write-Host 'No game engine staged; shipping tab-only games (HARBOR_POKEMON_OPTIONAL=1).' -ForegroundColor Yellow
  $env:HARBOR_POKEMON_OPTIONAL = '1'
}

if (-not $SkipApp) {
  if ((Test-Path -LiteralPath $appExe) -and -not $RebuildApp) {
    Step "App build skipped (found $appExe; pass -RebuildApp to force)"
  } else {
    Step 'App release build (pnpm tauri build --no-bundle)'
    if ($PSBoundParameters.ContainsKey('Channel')) {
      $env:HARBOR_CHANNEL = $Channel
    } elseif (-not $env:HARBOR_CHANNEL) {
      $env:HARBOR_CHANNEL = 'stable'
    }
    Write-Host "  channel stamp: $env:HARBOR_CHANNEL"
    Invoke-Tool 'pnpm' @('tauri', 'build', '--no-bundle')
  }
}
if (-not (Test-Path -LiteralPath $appExe)) {
  throw "Missing $appExe. Run without -SkipApp first, or build it with: pnpm tauri build --no-bundle"
}

Step 'Uninstaller build'
Invoke-Tool 'cargo' @('build', '--manifest-path', 'installer/src-tauri/Cargo.toml', '--release',
  '--no-default-features', '--features', 'tauri/custom-protocol', '--bin', 'harbor-uninstall', '--locked')

Step 'Payload'
Invoke-Tool 'node' @('installer/scripts/make-payload.mjs')
Invoke-Tool 'node' @('scripts/verify-managed-payload.mjs')

Step 'Shipyard build'
Invoke-Tool 'cargo' @('build', '--manifest-path', 'installer/src-tauri/Cargo.toml', '--release',
  '--features', 'tauri/custom-protocol', '--bin', 'harbor-shipyard', '--locked')
Invoke-Tool 'node' @('scripts/verify-managed-payload.mjs', '--embedded')

$version = (Get-Content src-tauri/tauri.conf.json -Raw | ConvertFrom-Json).version
Write-Host "`nHarbor Shipyard $version ready:" -ForegroundColor Green
Write-Host "  $((Resolve-Path $shipyard).Path)"

if ($Run) {
  Step 'Launching Harbor Shipyard'
  Start-Process -FilePath (Resolve-Path $shipyard).Path
}
