# Runs the unattended hand-off test of a built MARTIS.exe (WebPlannerTest, switch -martisWebTest) with the game
# window in front, as it is when a person starts the game, so that the test's screenshots show the game and the
# focus hand-off between the game and the web viewer is the real one.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File Run-HandoffTest.ps1 [-Windowed] [-Exe <MARTIS.exe>]
#              [-Mission <mission.json>] [-OutDir <dir>] [-LogFile <player log>]
#
# It takes the keyboard away from whatever is in front for about 20 seconds. It refuses to start while another
# MARTIS.exe runs (it waits up to -GuardSeconds for it to end). Exit code: the game's (0 = PASS), 2 = not started.
param(
    [string]$Exe = (Join-Path $PSScriptRoot '..\..\..\Builds\MARTIS\MARTIS.exe'),
    [string]$Mission = (Join-Path $PSScriptRoot '..\fixtures\mission_sample.json'),
    [string]$OutDir,
    [string]$LogFile,
    [switch]$Windowed,          # a 1280 x 720 window instead of the delivery mode (borderless full screen)
    [int]$GuardSeconds = 240,
    [int]$TimeoutSeconds = 150
)
$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MartisFront {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);

    // Width and height of the primary display in physical pixels.
    public static int[] PrimaryPixels() {
        SetProcessDPIAware();
        return new[] { GetSystemMetrics(0), GetSystemMetrics(1) };
    }

    // True when the window is in front afterwards. A background process may not take the foreground by itself:
    // it joins the input queue of the thread that has it for the moment of the call.
    public static bool Bring(IntPtr window) {
        IntPtr front = GetForegroundWindow();
        if (front == window) return true;
        uint pid, me = GetCurrentThreadId(), other = GetWindowThreadProcessId(front, out pid);
        bool attached = front != IntPtr.Zero && other != me && AttachThreadInput(me, other, true);
        BringWindowToTop(window);
        SetForegroundWindow(window);
        if (attached) AttachThreadInput(me, other, false);
        return GetForegroundWindow() == window;
    }
}
'@

$Exe = (Resolve-Path $Exe).Path
$Mission = (Resolve-Path $Mission).Path
if (-not $OutDir) { $OutDir = Join-Path (Split-Path $Exe) 'webtest' }

$waited = 0
while (Get-Process -Name MARTIS -ErrorAction SilentlyContinue) {
    if ($waited -ge $GuardSeconds) { Write-Output "another MARTIS.exe is still running after $GuardSeconds s: not started"; exit 2 }
    Start-Sleep -Seconds 20
    $waited += 20
}
if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }

$gameArgs = @('-martisWebTest', "`"$Mission`"", '-martisWebTestDir', "`"$OutDir`"")
if ($Windowed) { $gameArgs += @('-screen-fullscreen', '0', '-screen-width', '1280', '-screen-height', '720') }
else {
    # Unity remembers the last screen settings per user (a windowed test leaves "windowed"): ask for the delivery
    # mode explicitly, borderless full screen at the primary display's own resolution.
    $px = [MartisFront]::PrimaryPixels()
    $gameArgs += @('-screen-fullscreen', '1', '-window-mode', 'borderless', '-screen-width', $px[0], '-screen-height', $px[1])
}
if ($LogFile) { $gameArgs += @('-logFile', "`"$LogFile`"") }
$game = Start-Process -FilePath $Exe -ArgumentList $gameArgs -PassThru

# Put the game window in front as soon as it exists, and once more a little later (the first frames can lose it).
$watch = [Diagnostics.Stopwatch]::StartNew()
$brought = 0
while (-not $game.HasExited -and $watch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
    if ($brought -lt 2) {
        $game.Refresh()
        if ($game.MainWindowHandle -ne [IntPtr]::Zero) {
            $ok = [MartisFront]::Bring($game.MainWindowHandle)
            $brought++
            Write-Output ("game window in front: $ok (" + [int]$watch.Elapsed.TotalMilliseconds + " ms)")
            if ($brought -lt 2) { Start-Sleep -Milliseconds 1200 }
        }
    }
    Start-Sleep -Milliseconds 100
}
if (-not $game.HasExited) {
    Write-Output "MARTIS.exe still running after $TimeoutSeconds s: killed"
    $game.Kill()
    $game.WaitForExit()
}
Write-Output "exit code $($game.ExitCode)"
$result = Join-Path $OutDir 'result.txt'
if (Test-Path $result) { Get-Content $result } else { Write-Output "no result.txt in $OutDir" }
exit $game.ExitCode
