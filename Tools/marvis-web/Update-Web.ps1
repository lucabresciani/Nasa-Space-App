# Brings a new version of the HOMELINE web app (the planner shown inside MARVIS) into this project.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File Update-Web.ps1 -Ref <branch or commit>
#              [-WebRepo <web worktree>] [-Build <folder of a built game>] [-SkipTest] [-Continue] [-WhatIf]
#
#   -Ref       what the web team published: a branch name or a commit of the HOMELINE repository's origin.
#   -WebRepo   the web worktree, on the branch that carries the MARVIS bridge.
#   -Build     the folder of a built game (the one with MARVIS.exe): its MarvisPlanner folder is replaced too and,
#              unless -SkipTest, the hand-off test runs on it (the game opens in front for about 20 seconds).
#   -Continue  after a merge conflict was resolved and committed by hand: skips the fetch and the merge.
#   -WhatIf    shows the steps that would change something without running them; the checks still run.
#
# Steps; the script stops at the first one that fails and says why:
#    1. the web worktree is on a branch with the bridge committed and has nothing uncommitted
#    2. git fetch origin <Ref>
#    3. git merge --no-edit FETCH_HEAD
#    4. web\public\marvis-bridge.json is still there
#    5. npx tsc --noEmit                      (a failure is a warning only)
#    6. node scripts/build-marvis.mjs when the worktree has it (build + visible name MARVIS + checks), else npx vite build
#    7. web\dist  ->  HomelineData\web of this project   (robocopy /MIR; the next game build ships it)
#    8. web-patch\marvis-embed.patch = git diff FETCH_HEAD HEAD   (the bridge on top of the web team's version)
#    9. with -Build: web\dist  ->  <Build>\MarvisPlanner   (robocopy /MIR)
#   10. with -Build, without -SkipTest: test\Run-HandoffTest.ps1 -Exe <Build>\MARVIS.exe, reported as PASS or FAIL
# Exit code: 0 = done, 1 = stopped or hand-off test FAIL.
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Ref,
    # The web team's new design plus the Mission Planer page and the bridge (branch marvis-main). The previous
    # layout lives in C:\Users\bresc\home-line-martis (branch marvis-embed; the folder keeps its old name on disk).
    [string]$WebRepo = 'C:\Users\bresc\home-line-marvis',
    [string]$Build,
    [switch]$SkipTest,
    [switch]$Continue
)
$ErrorActionPreference = 'Stop'

$Marker = 'marvis-bridge.json'
$BridgeFiles = @("web/public/$Marker", 'web/src/marvis/bridge.ts')   # committed on the bridge branch
$Unity = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path        # the project this script belongs to
$WebData = Join-Path $Unity 'HomelineData\web'
$Patch = Join-Path $PSScriptRoot 'web-patch\marvis-embed.patch'
$HandoffTest = Join-Path $PSScriptRoot 'test\Run-HandoffTest.ps1'

$StepCount = 8
if ($Build) { $StepCount = 9 }
if ($Build -and -not $SkipTest) { $StepCount = 10 }
$StepNo = 0
$StepName = ''
$StepWatch = [Diagnostics.Stopwatch]::StartNew()
$TotalWatch = [Diagnostics.Stopwatch]::StartNew()
$Warnings = @()
$Branch = ''
$TestVerdict = ''

function Seconds([Diagnostics.Stopwatch]$Watch) {
    return $Watch.Elapsed.TotalSeconds.ToString('0.0', [Globalization.CultureInfo]::InvariantCulture) + ' s'
}

function Stop-Update([string]$Message) {
    Write-Host ''
    if ($script:StepNo -gt 0) {
        Write-Host "STOPPED at step $script:StepNo of $StepCount ($script:StepName) after $(Seconds $script:StepWatch):" -ForegroundColor Red
    }
    else {
        Write-Host 'STOPPED before the first step:' -ForegroundColor Red
    }
    Write-Host $Message -ForegroundColor Red
    exit 1
}

function Step([string]$Name, [scriptblock]$Body) {
    $script:StepNo++
    $script:StepName = $Name
    $script:StepWatch = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "[$script:StepNo/$StepCount] $Name" -ForegroundColor Cyan
    & $Body
    Write-Host "    done in $(Seconds $script:StepWatch)"
}

# Runs a program in a folder, shows its output indented and returns it as lines; its exit code is in $LASTEXITCODE.
# Windows PowerShell 5.1 turns the stderr lines of a program into error records (git and npm report their progress
# there): the error preference is relaxed for the call and the records are taken as plain text.
function Invoke-Tool([string]$Dir, [string]$Exe, [string[]]$Arguments, [switch]$Quiet) {
    $ErrorActionPreference = 'Continue'
    Push-Location $Dir
    try {
        & $Exe @Arguments 2>&1 | ForEach-Object {
            $line = "$_"
            if (-not $Quiet -and $line.Trim()) { Write-Host "    $line" }
            $line
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-Git([string[]]$Arguments, [switch]$Quiet) {
    Invoke-Tool $WebRepo 'git.exe' $Arguments -Quiet:$Quiet
}

# The rule of the game (WebPlanner.IsValidWebRoot): index.html, an assets folder and the bridge marker.
function Test-WebRoot([string]$Dir) {
    return (Test-Path (Join-Path $Dir 'index.html')) -and (Test-Path (Join-Path $Dir 'assets') -PathType Container) -and
           (Test-Path (Join-Path $Dir $Marker))
}

# Makes $To an exact copy of $From. Robocopy answers 8 or more when something was not copied.
function Copy-Mirror([string]$From, [string]$To) {
    if (-not $PSCmdlet.ShouldProcess($To, "robocopy /MIR from $From")) { return }
    # Not shown line by line: robocopy names every old file it removes, hundreds after a new build.
    $lines = @(Invoke-Tool $From 'robocopy.exe' @($From, $To, '/MIR', '/R:2', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP') -Quiet)
    $code = $LASTEXITCODE
    if ($code -ge 8) {
        $lines | Where-Object { $_.Trim() -and $_ -notmatch 'EXTRA' } | Select-Object -Last 15 | ForEach-Object { Write-Host "    $_" }
        Stop-Update "robocopy answered ${code}: not everything was copied to $To (a file in use there?)."
    }
    $size = Get-ChildItem $To -Recurse -File | Measure-Object -Property Length -Sum
    Write-Host ("    now {0} files, {1} MB" -f $size.Count, ($size.Sum / 1MB).ToString('0.0', [Globalization.CultureInfo]::InvariantCulture))
}

trap {
    Stop-Update "unexpected error: $($_.Exception.Message)"
}

# ---------------------------------------------------------------- parameters

if (-not $Continue -and -not $Ref) {
    Stop-Update 'give the version to take: -Ref <branch name or commit of the HOMELINE repository''s origin>.'
}
foreach ($tool in 'git.exe', 'npx.cmd', 'robocopy.exe') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Stop-Update "$tool was not found in PATH." }
}
if (-not (Test-Path (Join-Path $WebRepo 'web\package.json'))) {
    Stop-Update "$WebRepo is not a checkout of the HOMELINE repository (no web\package.json). Pass -WebRepo <folder>."
}
$WebRepo = (Resolve-Path $WebRepo).Path.TrimEnd('\')
$Web = Join-Path $WebRepo 'web'
$Dist = Join-Path $Web 'dist'
# A worktree with web\scripts\build-marvis.mjs builds through it (the new design); otherwise a plain vite build.
$GameBuild = Test-Path (Join-Path $Web 'scripts\build-marvis.mjs')
$BuildName = 'npx vite build'
if ($GameBuild) {
    $BuildName = 'node scripts/build-marvis.mjs (build, visible name MARVIS, checks)'
    $Patch = Join-Path $PSScriptRoot 'web-patch\marvis-embed-newdesign.patch'
    if (-not (Get-Command 'node.exe' -ErrorAction SilentlyContinue)) { Stop-Update 'node.exe was not found in PATH.' }
}
if (-not (Test-Path (Join-Path $Web 'node_modules\.bin\vite.cmd'))) {
    Stop-Update "the web app's packages are not installed: run 'npm install' in $Web first."
}
if (-not (Test-Path (Join-Path $Unity 'Assets')) -or -not (Test-Path (Join-Path $Unity 'HomelineData'))) {
    Stop-Update "$Unity is not the MARVIS project (no Assets or HomelineData folder): run the script from Tools\marvis-web of the project."
}
if ($Build) {
    if (-not (Test-Path (Join-Path $Build 'MARVIS.exe'))) { Stop-Update "$Build is not the folder of a built game (no MARVIS.exe)." }
    $Build = (Resolve-Path $Build).Path.TrimEnd('\')
}

# ---------------------------------------------------------------- 1. the web worktree

Step 'web worktree: on the bridge branch, nothing uncommitted' {
    $script:Branch = "$(Invoke-Git @('branch', '--show-current') -Quiet)"
    if (-not $script:Branch) {
        Stop-Update "$WebRepo is not on a branch (detached HEAD). Check out the branch that carries the MARVIS bridge."
    }
    foreach ($file in $BridgeFiles) {
        Invoke-Git @('cat-file', '-e', "HEAD:$file") -Quiet | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Stop-Update ("branch '$script:Branch' does not have the MARVIS bridge: $file is not committed there.`n" +
                         'Check out the bridge branch, or commit the bridge first.')
        }
    }
    Invoke-Git @('rev-parse', '-q', '--verify', 'MERGE_HEAD') -Quiet | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Stop-Update ("a merge is not finished in $WebRepo. Resolve the conflicts, 'git add' the files, 'git commit --no-edit',`n" +
                     "then run this script again with -Continue. (To give the merge up instead: git merge --abort)")
    }
    $changes = @(Invoke-Git @('--no-optional-locks', 'status', '--porcelain', '--untracked-files=no') -Quiet)
    if ($changes.Count -gt 0) {
        Stop-Update ("$WebRepo has uncommitted changes; commit them or put them aside first:`n    " +
                     (($changes | Select-Object -First 20) -join "`n    "))
    }
    Write-Host "    branch $script:Branch at $(Invoke-Git @('log', '-1', '--format=%h %s') -Quiet)"
}

# ---------------------------------------------------------------- 2. fetch

$fetchName = "git fetch origin $Ref"
if ($Continue) { $fetchName = 'git fetch: skipped (-Continue)' }
Step $fetchName {
    if ($Continue) { return }
    if (-not $PSCmdlet.ShouldProcess("origin $Ref", 'git fetch')) { return }
    Invoke-Git @('fetch', 'origin', $Ref) | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-Update "git fetch origin $Ref failed: is '$Ref' a branch or a commit of origin?" }
    Write-Host "    fetched $(Invoke-Git @('log', '-1', '--format=%h %s', 'FETCH_HEAD') -Quiet)"
}

# ---------------------------------------------------------------- 3. merge

$mergeName = 'git merge --no-edit FETCH_HEAD'
if ($Continue) { $mergeName = 'git merge: skipped (-Continue); the fetched version must be merged already' }
Step $mergeName {
    if (-not $Continue) {
        if (-not $PSCmdlet.ShouldProcess("FETCH_HEAD into $script:Branch", 'git merge --no-edit')) { return }
        Invoke-Git @('merge', '--no-edit', 'FETCH_HEAD') | Out-Null
        if ($LASTEXITCODE -ne 0) {
            $conflicts = @(Invoke-Git @('diff', '--name-only', '--diff-filter=U') -Quiet)
            if ($conflicts.Count -eq 0) { Stop-Update 'git merge failed (its reason is in the lines above).' }
            Stop-Update ("merge conflict in $($conflicts.Count) file(s):`n    " + ($conflicts -join "`n    ") + "`n" +
                         "Resolve them in $WebRepo (edit each file, 'git add' it, then 'git commit --no-edit'),`n" +
                         "then run this script again with -Continue. (To give the merge up instead: git merge --abort)")
        }
    }
    # With or without -Continue: what was fetched is part of HEAD now.
    Invoke-Git @('merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD') -Quiet | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Stop-Update ("the fetched version (FETCH_HEAD) is not merged into '$script:Branch'. " +
                     'Finish the merge and commit it, or run the script again without -Continue.')
    }
    Write-Host "    HEAD is $(Invoke-Git @('log', '-1', '--format=%h %s') -Quiet)"
}

# ---------------------------------------------------------------- 4. the marker

Step "web\public\$Marker is still there" {
    if (-not (Test-Path (Join-Path $Web "public\$Marker"))) {
        Stop-Update ("web\public\$Marker is gone: without it the game does not take the build for one with the bridge.`n" +
                     "Put it back (content {`"bridge`":1}), commit, and run this script again with -Continue.")
    }
}

# ---------------------------------------------------------------- 5. and 6. build

Step 'npx tsc --noEmit (a failure is a warning only)' {
    if (-not $PSCmdlet.ShouldProcess($Web, 'npx tsc --noEmit')) { return }
    Invoke-Tool $Web 'npx.cmd' @('tsc', '--noEmit') | Out-Null
    if ($LASTEXITCODE -ne 0) {
        $script:Warnings += 'the type check (npx tsc --noEmit) reported errors: tell the web team'
        Write-Host '    WARNING: type errors (the build goes on)' -ForegroundColor Yellow
    }
}

Step $BuildName {
    if (-not $PSCmdlet.ShouldProcess($Web, $BuildName)) { return }
    $started = Get-Date
    if ($GameBuild) {
        # Builds, then writes MARVIS where the bundled text says HOMELINE in capitals (the product name; the
        # lower-case contract names stay), and checks the result.
        Invoke-Tool $Web 'node.exe' @('scripts/build-marvis.mjs') | Out-Null
    }
    else {
        Invoke-Tool $Web 'npx.cmd' @('vite', 'build') | Out-Null
    }
    if ($LASTEXITCODE -ne 0) { Stop-Update 'the build failed (its reason is in the lines above). Nothing was copied.' }
    if (-not (Test-WebRoot $Dist)) {
        Stop-Update "$Dist is not a usable build (index.html, assets\ and $Marker are needed). Nothing was copied."
    }
    # A build that failed without saying so leaves the previous dist in place: the folder must have been rewritten
    # (the build empties it and writes index.html into it, which changes the folder's own time).
    if ((Get-Item $Dist).LastWriteTime -lt $started.AddSeconds(-2)) {
        Stop-Update "$Dist was not written by this build (the folder is older than the build). Nothing was copied."
    }
}

# ---------------------------------------------------------------- 7. into the project

Step "web\dist -> $WebData" {
    # The built-in planning panel reads HomelineData\web\data: never mirror a build without it over one that has it.
    if ((Test-Path (Join-Path $WebData 'data')) -and (Test-Path $Dist) -and -not (Test-Path (Join-Path $Dist 'data'))) {
        Stop-Update "$Dist has no data folder (a build with VITE_DATA=dummy?): copying it would delete $WebData\data."
    }
    Copy-Mirror $Dist $WebData
}

# ---------------------------------------------------------------- 8. the patch for the web team

Step 'web-patch\marvis-embed.patch = git diff FETCH_HEAD HEAD' {
    if (-not $PSCmdlet.ShouldProcess($Patch, 'git diff --binary FETCH_HEAD HEAD')) { return }
    New-Item -ItemType Directory -Force (Split-Path $Patch) | Out-Null
    # Written by git itself: a redirection in PowerShell 5.1 would re-encode the text.
    Invoke-Git @('diff', '--binary', "--output=$Patch", 'FETCH_HEAD', 'HEAD') | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-Update 'git diff failed (its reason is in the lines above).' }
    $files = @(Invoke-Git @('diff', '--name-only', 'FETCH_HEAD', 'HEAD') -Quiet)
    Write-Host "    $($files.Count) file(s), $((Get-Item $Patch).Length) bytes"
    if ($files.Count -eq 0) {
        $script:Warnings += 'the patch is empty: the fetched version already contains everything of this branch'
        Write-Host '    WARNING: the patch is empty' -ForegroundColor Yellow
    }
}

# ---------------------------------------------------------------- 9. and 10. a built game

if ($Build) {
    $BuildWeb = Join-Path $Build 'MarvisPlanner'
    Step "web\dist -> $BuildWeb" {
        $running = Get-Process -Name MARVIS -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Build\*" }
        if ($running) { Stop-Update "the game in $Build is running: close it first, then run this script again with -Continue." }
        Copy-Mirror $Dist $BuildWeb
    }

    if (-not $SkipTest) {
        Step 'hand-off test (the game opens in front for about 20 seconds)' {
            $exe = Join-Path $Build 'MARVIS.exe'
            if (-not $PSCmdlet.ShouldProcess($exe, 'Run-HandoffTest.ps1')) { return }
            Invoke-Tool $PSScriptRoot 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $HandoffTest, '-Exe', $exe) | Out-Null
            if ($LASTEXITCODE -eq 0) { $script:TestVerdict = 'PASS' }
            elseif ($LASTEXITCODE -eq 2) { $script:TestVerdict = 'FAIL (the test did not start: see the lines above)' }
            else { $script:TestVerdict = "FAIL (exit code $LASTEXITCODE; the checks are in $Build\webtest\result.txt)" }
        }
    }
}

# ---------------------------------------------------------------- summary

Write-Host ''
if ($WhatIfPreference) {
    Write-Host "DRY RUN (-WhatIf) finished in $(Seconds $TotalWatch): the checks ran, nothing was changed." -ForegroundColor Green
    exit 0
}
Write-Host "DONE in $(Seconds $TotalWatch)." -ForegroundColor Green
Write-Host "    web app   $WebData (the next build of the game ships it as MarvisPlanner)"
Write-Host "    patch     $Patch"
if ($Build) { Write-Host "    game      $BuildWeb" }
foreach ($warning in $Warnings) { Write-Host "    WARNING   $warning" -ForegroundColor Yellow }
if ($TestVerdict) {
    $color = 'Red'
    if ($TestVerdict -eq 'PASS') { $color = 'Green' }
    Write-Host "HAND-OFF TEST: $TestVerdict" -ForegroundColor $color
    if ($TestVerdict -ne 'PASS') { exit 1 }
}
elseif ($Build) {
    Write-Host 'HAND-OFF TEST: not run (-SkipTest)'
}
exit 0
