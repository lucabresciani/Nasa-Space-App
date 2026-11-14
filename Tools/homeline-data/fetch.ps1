<#
.SYNOPSIS
    Fills <project>/HomelineData with the planner inputs the app needs: the built planner web app and the
    simulator bundle. The data stays OUT of this repository (HomelineData ignores itself).

.DESCRIPTION
    HomelineData/
      web/      the planner's web/dist (static site, about 250 MB, 3,000+ files)
      bundle/   plan_bundle.zip, world_pack.zip, plan.json, fixture.json (official pad, contracts/bundle v1)
      source.json   which planner commit the data came from

    The planner repository (LuxKaiwalker/home-line) is only READ: cloned or fetched, never changed or pushed.
    Both PCs must use the same pinned commit so they run the same bytes.

.PARAMETER Commit
    Planner commit to use. Default: the commit pinned below.

.PARAMETER Clone
    An existing local clone of home-line to read from. Default: a "home-line" folder next to this project.
    If it does not exist it is cloned there (needs access to the private repository).

.PARAMETER SkipWebBuild
    Use the clone's existing web/dist instead of running npm ci and npm run build (needs Node 20.19+ or 22.12+).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File Tools\homeline-data\fetch.ps1
#>
param(
    [string]$Commit = "d943f39",
    [string]$Clone = "",
    [switch]$SkipWebBuild
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Data = Join-Path $ProjectRoot "HomelineData"
if (-not $Clone) { $Clone = Join-Path (Split-Path $ProjectRoot -Parent) "home-line" }
$RepoUrl = "https://github.com/LuxKaiwalker/home-line.git"

function Run([string]$Exe, [string[]]$Arguments, [string]$WorkDir) {
    Push-Location $WorkDir
    try {
        & $Exe @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$Exe $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
    } finally { Pop-Location }
}

if (-not (Test-Path (Join-Path $Clone ".git"))) {
    Write-Host "Cloning the planner (read-only use) into $Clone"
    Run "git" @("clone", "--quiet", $RepoUrl, $Clone) (Split-Path $Clone -Parent)
}

# Read-only use of the planner clone: fetch, then check that the pinned commit is what is checked out.
Run "git" @("fetch", "--quiet", "origin") $Clone
$Head = (& git -C $Clone rev-parse --short=7 HEAD).Trim()
$Want = (& git -C $Clone rev-parse --short=7 $Commit).Trim()
if ($Head -ne $Want) {
    $Dirty = (& git -C $Clone status --porcelain --untracked-files=no)
    if ($Dirty) { throw "The planner clone has local changes; refusing to switch it to $Commit. Use a clean clone." }
    Write-Host "Checking out planner commit $Want (detached) in $Clone"
    Run "git" @("checkout", "--quiet", "--detach", $Want) $Clone
}

$Web = Join-Path $Clone "web"
$Dist = Join-Path $Web "dist"
if (-not $SkipWebBuild) {
    Write-Host "Building the planner web app (npm ci, npm run build)"
    Run "npm" @("ci", "--no-audit", "--no-fund") $Web
    Run "npm" @("run", "build") $Web
}
if (-not (Test-Path (Join-Path $Dist "index.html"))) { throw "No built web app at $Dist. Run without -SkipWebBuild." }

$Fixture = Join-Path $Clone "contracts\bundle\fixtures\official_pad_v1"
foreach ($f in @("plan_bundle.zip", "world_pack.zip", "plan.json", "fixture.json")) {
    if (-not (Test-Path (Join-Path $Fixture $f))) { throw "Fixture file missing in the planner clone: $f" }
}

New-Item -ItemType Directory -Force -Path $Data | Out-Null
# The folder ignores itself, so nothing in it can be committed by mistake.
Set-Content -Path (Join-Path $Data ".gitignore") -Value "*" -Encoding ascii

Write-Host "Copying the web app"
& robocopy $Dist (Join-Path $Data "web") /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy (web) failed with exit code $LASTEXITCODE" }

Write-Host "Copying the simulator bundle"
& robocopy $Fixture (Join-Path $Data "bundle") /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy (bundle) failed with exit code $LASTEXITCODE" }
$global:LASTEXITCODE = 0

# The fixture states the sha256 of its zips: check the copies.
$FixtureInfo = Get-Content (Join-Path $Data "bundle\fixture.json") -Raw | ConvertFrom-Json
foreach ($name in @("plan_bundle.zip", "world_pack.zip")) {
    $want = $FixtureInfo.zips.$name.sha256
    $got = (Get-FileHash (Join-Path $Data "bundle\$name") -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($got -ne $want) { throw "sha256 mismatch for $name (got $got, fixture.json says $want)" }
}

$Source = [ordered]@{
    planner_repository = $RepoUrl
    planner_commit     = (& git -C $Clone rev-parse HEAD).Trim()
    plan_id            = $FixtureInfo.plan_id
    world_version      = $FixtureInfo.world_version_full
    copied_utc         = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
}
$Source | ConvertTo-Json | Set-Content -Path (Join-Path $Data "source.json") -Encoding utf8

$Files = (Get-ChildItem $Data -Recurse -File | Measure-Object -Property Length -Sum)
Write-Host ("HomelineData ready: {0} files, {1:N0} MB, planner commit {2}, plan {3}" -f $Files.Count, ($Files.Sum / 1MB), $Source.planner_commit.Substring(0, 7), $Source.plan_id)
