# Builds the web planner that is kept in this repository (WebPlanner\) and puts it where the game serves it.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File Tools\marvis-web\Build-Web.ps1 [-Build <folder of a built game>]
#
# Run it once after cloning, and again after every change under WebPlanner\web. Needs Node.js (npm) in PATH.
# Steps; the script stops at the first one that fails:
#   1. npm ci in WebPlanner\web, only when its packages are not installed yet
#   2. node scripts/build-marvis.mjs   (builds the site, writes MARVIS where the product name is shown, checks)
#   3. WebPlanner\web\dist  ->  HomelineData\web   (robocopy /MIR; the editor and the next game build use it)
#   4. the planner's official bundle  ->  HomelineData\bundle, only when that folder has no plan_bundle.zip yet
#   5. with -Build: WebPlanner\web\dist  ->  <Build>\MarvisPlanner, so an already built game gets the new site
# Exit code: 0 = done, 1 = stopped.
param(
    [string]$Build
)
$ErrorActionPreference = 'Stop'

$Project = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Web = Join-Path $Project 'WebPlanner\web'
$Dist = Join-Path $Web 'dist'
$Data = Join-Path $Project 'HomelineData'
$Marker = 'marvis-bridge.json'

function Stop-Build([string]$Message) {
    Write-Host "STOPPED: $Message" -ForegroundColor Red
    exit 1
}

# Runs a program in a folder and shows its output; its exit code is in $LASTEXITCODE. Windows PowerShell 5.1 turns
# a program's stderr lines into error records (npm reports progress there), so they are taken as plain text.
function Invoke-In([string]$Dir, [string]$Exe, [string[]]$Arguments) {
    $ErrorActionPreference = 'Continue'
    Push-Location $Dir
    try { & $Exe @Arguments 2>&1 | ForEach-Object { Write-Host "    $_" } }
    finally { Pop-Location }
}

# Makes $To an exact copy of $From. Robocopy answers 8 or more when something was not copied.
function Copy-Mirror([string]$From, [string]$To) {
    & robocopy.exe $From $To /MIR /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { Stop-Build "robocopy answered ${LASTEXITCODE}: not everything was copied to $To (a file in use there?)." }
    Write-Host "    $To : $((Get-ChildItem $To -Recurse -File | Measure-Object).Count) files"
}

if (-not (Test-Path (Join-Path $Web 'package.json'))) { Stop-Build "$Web is missing: is this the web-embed branch?" }
foreach ($tool in 'node.exe', 'npm.cmd', 'robocopy.exe') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Stop-Build "$tool was not found in PATH (install Node.js)." }
}
$watch = [Diagnostics.Stopwatch]::StartNew()

if (-not (Test-Path (Join-Path $Web 'node_modules\.bin\vite.cmd'))) {
    Write-Host '[1] npm ci (first time only)'
    Invoke-In $Web 'npm.cmd' @('ci')
    if ($LASTEXITCODE -ne 0) { Stop-Build 'npm ci failed (its reason is in the lines above).' }
}
else {
    Write-Host '[1] packages already installed'
}

Write-Host '[2] node scripts/build-marvis.mjs'
$started = Get-Date
Invoke-In $Web 'node.exe' @('scripts/build-marvis.mjs')
if ($LASTEXITCODE -ne 0) { Stop-Build 'the build failed (its reason is in the lines above). Nothing was copied.' }
foreach ($need in 'index.html', 'assets', $Marker, 'data') {
    if (-not (Test-Path (Join-Path $Dist $need))) { Stop-Build "$Dist has no $need. Nothing was copied." }
}
if ((Get-Item (Join-Path $Dist 'index.html')).LastWriteTime -lt $started.AddSeconds(-2)) {
    Stop-Build "$Dist was not written by this build. Nothing was copied."
}

Write-Host '[3] the built site -> HomelineData\web'
Copy-Mirror $Dist (Join-Path $Data 'web')

$bundle = Join-Path $Data 'bundle'
$fixture = Join-Path $Project 'WebPlanner\contracts\bundle\fixtures\official_pad_v1'
if (Test-Path (Join-Path $bundle 'plan_bundle.zip')) {
    Write-Host '[4] HomelineData\bundle is already there'
}
elseif (Test-Path (Join-Path $fixture 'plan_bundle.zip')) {
    Write-Host '[4] the official bundle -> HomelineData\bundle'
    New-Item -ItemType Directory -Force $bundle | Out-Null
    Copy-Item (Join-Path $fixture '*') $bundle -Recurse -Force
    Write-Host "    $bundle : $((Get-ChildItem $bundle -Recurse -File | Measure-Object).Count) files"
}
else {
    Write-Host "[4] WARNING: no official bundle found in $fixture; the built-in planning panel will have no plans" -ForegroundColor Yellow
}

if ($Build) {
    if (-not (Test-Path (Join-Path $Build 'MARVIS.exe'))) { Stop-Build "$Build has no MARVIS.exe: pass the folder of a built game." }
    Write-Host '[5] the built site -> the built game'
    Copy-Mirror $Dist (Join-Path $Build 'MarvisPlanner')
}

Write-Host ("DONE in {0} s. Open the project in Unity (Play, then MISSION PLAN), or build the game." -f [int]$watch.Elapsed.TotalSeconds) -ForegroundColor Green
if (-not (Test-Path (Join-Path $Data 'router\router.json'))) {
    Write-Host 'Note: HomelineData\router is missing. The web planner does not need it; only the built-in planning panel' -ForegroundColor Yellow
    Write-Host 'uses it to re-route edited plans (Tools\homeline-data\make_router_grid.py makes it).' -ForegroundColor Yellow
}
exit 0
