<#
  Tests MarvisWeb.exe (the WebView2 viewer) against a dummy owner window and a local static server.

    powershell -NoProfile -ExecutionPolicy Bypass -File Test-MarvisWeb.ps1

  It shows a small window near the bottom-right of the primary screen for about a minute. Other test runs on
  the same desktop need to keep the focus, so it first waits (up to 4 minutes) until no MARVIS.exe is running.
  The live-site protocol (--inject, post, reload, downloads, page messages, blocked navigations, F10) is tested
  against a small page and inject script that the test writes to a temp folder and serves on Port + 1.
  Screenshots and the WebView2 user data folder go to .\out . The exit code is the number of failed checks.
#>
param(
    [string]$Exe  = (Join-Path $PSScriptRoot '..\viewer\dist\MarvisWeb.exe'),
    [string]$Site = (Join-Path $env:USERPROFILE 'home-line\web\dist'),   # any built copy of the web app
    [int]$Port = 8771,
    [int]$UnlockWaitSeconds = 0   # how long to wait for a locked workstation before going on without screen captures
)
$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

// Win32 queries, all in real screen pixels (powershell.exe itself is not DPI aware).
public static class Mw
{
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref Point p);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);

    public static void Dpi() { SetThreadDpiAwarenessContext(new IntPtr(-4)); }   // per-monitor v2

    // The top-level window of the process that is owned by the given window.
    public static IntPtr FindViewer(int pid, IntPtr owner)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            uint p;
            GetWindowThreadProcessId(h, out p);
            if (p == (uint)pid && GetWindow(h, 4) == owner) { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static bool Visible(IntPtr h) { return IsWindowVisible(h); }
    public static bool Exists(IntPtr h) { return IsWindow(h); }
    public static bool IsForeground(IntPtr h) { return GetForegroundWindow() == h; }
    public static string ForegroundProcess()
    {
        uint pid;
        GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        try { return Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { return "?"; }
    }
    public static long ExStyle(IntPtr h) { return GetWindowLongPtr(h, -20).ToInt64(); }
    public static long Style(IntPtr h) { return GetWindowLongPtr(h, -16).ToInt64(); }

    // True when window a is above window b in the z-order.
    public static bool IsAbove(IntPtr a, IntPtr b)
    {
        bool above = false;
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            if (h == a) above = true;
            return h != a && h != b;   // stop at whichever comes first, top to bottom
        }, IntPtr.Zero);
        return above;
    }

    // The window's visible frame as the compositor sees it; equal to RectOf for a window without any border.
    public static string FrameOf(IntPtr h)
    {
        RECT f;
        DwmGetWindowAttribute(h, 9, out f, Marshal.SizeOf(typeof(RECT)));
        return f.Left + "," + f.Top + "," + (f.Right - f.Left) + "," + (f.Bottom - f.Top);
    }
    public static void PostClose(IntPtr h) { PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); }

    // Posts a key press (WM_SYSKEYDOWN + WM_SYSKEYUP, as F10 arrives) to every descendant window of the given
    // class; returns how many windows got it. The web content's windows belong to the browser process.
    public static int PostKey(IntPtr top, string className, int vk)
    {
        int n = 0;
        EnumChildWindows(top, delegate(IntPtr h, IntPtr l)
        {
            System.Text.StringBuilder s = new System.Text.StringBuilder(256);
            GetClassName(h, s, 256);
            if (s.ToString() != className) return true;
            PostMessage(h, 0x0104, new IntPtr(vk), new IntPtr(1));
            PostMessage(h, 0x0105, new IntPtr(vk), new IntPtr(unchecked((int)0xC0000001)));
            n++;
            return true;
        }, IntPtr.Zero);
        return n;
    }
    public static void Minimize(IntPtr h) { ShowWindow(h, 7); }   // SW_SHOWMINNOACTIVE
    public static void Restore(IntPtr h) { ShowWindow(h, 4); }    // SW_SHOWNOACTIVATE

    public static string RectOf(IntPtr h)
    {
        Dpi();
        RECT r;
        GetWindowRect(h, out r);
        return r.Left + "," + r.Top + "," + (r.Right - r.Left) + "," + (r.Bottom - r.Top);
    }

    public static string ClientOf(IntPtr h)
    {
        Dpi();
        RECT c;
        GetClientRect(h, out c);
        Point o = new Point(0, 0);
        ClientToScreen(h, ref o);
        return o.X + "," + o.Y + "," + c.Right + "," + c.Bottom;
    }

    // Saves a PNG of the owner's visible frame as it is on screen, and describes its client area.
    public static string Shot(IntPtr owner, string png)
    {
        Dpi();
        RECT f;
        if (DwmGetWindowAttribute(owner, 9, out f, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(owner, out f);
        RECT c;
        GetClientRect(owner, out c);
        Point o = new Point(0, 0);
        ClientToScreen(owner, ref o);
        int w = f.Right - f.Left, h = f.Bottom - f.Top;
        using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
        {
            using (Graphics g = Graphics.FromImage(bmp)) g.CopyFromScreen(f.Left, f.Top, 0, 0, new Size(w, h));
            bmp.Save(png, ImageFormat.Png);
            return Describe(bmp, new Rectangle(o.X - f.Left, o.Y - f.Top, c.Right, c.Bottom));
        }
    }

    // Saves a PNG of what one window itself has drawn (works when it is covered or the screen is locked).
    public static string Print(IntPtr window, string png)
    {
        Dpi();
        RECT r;
        GetWindowRect(window, out r);
        int w = r.Right - r.Left, h = r.Bottom - r.Top;
        using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
        {
            using (Graphics g = Graphics.FromImage(bmp))
            {
                IntPtr dc = g.GetHdc();
                PrintWindow(window, dc, 2);   // PW_RENDERFULLCONTENT
                g.ReleaseHdc(dc);
            }
            bmp.Save(png, ImageFormat.Png);
            return Describe(bmp, new Rectangle(0, 0, w, h));
        }
    }

    // Share of pixels with the owner's marker colour, share of near-white pixels, number of distinct colours
    // (every second pixel of the area is sampled).
    static string Describe(Bitmap bmp, Rectangle area)
    {
        int marker = 0, white = 0, total = 0;
        HashSet<int> colours = new HashSet<int>();
        for (int y = area.Top; y < area.Bottom; y += 2)
            for (int x = area.Left; x < area.Right; x += 2)
            {
                if (x < 0 || y < 0 || x >= bmp.Width || y >= bmp.Height) continue;
                Color p = bmp.GetPixel(x, y);
                total++;
                if (p.R == 255 && p.G == 0 && p.B == 255) marker++;
                if (p.R > 245 && p.G > 245 && p.B > 245) white++;
                colours.Add(p.ToArgb());
            }
        return string.Format(CultureInfo.InvariantCulture, "marker={0:0.000} white={1:0.000} colours={2}",
            (double)marker / total, (double)white / total, colours.Count);
    }
}

// The dummy owner: a plain magenta window with its own UI thread, shown without taking the focus.
public class MwOwner
{
    class QuietForm : Form { protected override bool ShowWithoutActivation { get { return true; } } }
    Form form;
    Thread thread;
    public IntPtr Handle;

    public MwOwner(int width, int height)
    {
        ManualResetEvent ready = new ManualResetEvent(false);
        thread = new Thread(delegate()
        {
            Mw.Dpi();
            form = new QuietForm();
            form.Text = "MarvisWeb test owner";
            form.StartPosition = FormStartPosition.Manual;
            form.BackColor = Color.FromArgb(255, 0, 255);
            Rectangle area = Screen.PrimaryScreen.WorkingArea;
            form.Bounds = new Rectangle(area.Right - width - 60, area.Bottom - height - 60, width, height);
            form.Shown += delegate { Handle = form.Handle; ready.Set(); };
            Application.Run(form);
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.IsBackground = true;
        thread.Start();
        if (!ready.WaitOne(10000)) throw new Exception("the owner window did not appear");
    }

    public void MoveBy(int dx, int dy, int width, int height)
    {
        form.Invoke(new MethodInvoker(delegate { form.Bounds = new Rectangle(form.Left + dx, form.Top + dy, width, height); }));
    }

    public void Close()
    {
        if (!thread.IsAlive) return;
        form.Invoke(new MethodInvoker(form.Close));
        thread.Join(3000);
    }
}

// MarvisWeb.exe with redirected stdin/stdout; every stdout line is kept as "<ms since process start> <line>".
public class MwProc
{
    public Process P;
    Stopwatch clock;
    List<string> lines = new List<string>();
    int cursor;

    public MwProc(string exe, string args)
    {
        ProcessStartInfo info = new ProcessStartInfo(exe, args);
        info.UseShellExecute = false;
        info.RedirectStandardInput = true;
        info.RedirectStandardOutput = true;
        info.CreateNoWindow = true;
        P = new Process();
        P.StartInfo = info;
        P.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
        {
            if (e.Data == null) return;
            lock (lines) { lines.Add(clock.ElapsedMilliseconds + " " + e.Data); Monitor.PulseAll(lines); }
        };
        clock = Stopwatch.StartNew();
        P.Start();
        P.BeginOutputReadLine();
    }

    public void Send(string command) { P.StandardInput.Write(command + "\n"); P.StandardInput.Flush(); }
    public void CloseInput() { P.StandardInput.Close(); }

    // The next line, after the previous match, that starts with the prefix; null on timeout.
    public string WaitFor(string prefix, int timeoutMs)
    {
        DateTime end = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        lock (lines)
        {
            while (true)
            {
                for (; cursor < lines.Count; cursor++)
                {
                    string line = lines[cursor];
                    if (line.Substring(line.IndexOf(' ') + 1).StartsWith(prefix)) { cursor++; return line; }
                }
                int left = (int)(end - DateTime.UtcNow).TotalMilliseconds;
                if (left <= 0) return null;
                Monitor.Wait(lines, left);
            }
        }
    }

    public string[] Lines() { lock (lines) return lines.ToArray(); }
    public int WaitExit(int timeoutMs) { return P.WaitForExit(timeoutMs) ? P.ExitCode : -999; }   // -999 = still running
}
'@

$Exe = (Resolve-Path $Exe).Path
$out = Join-Path $PSScriptRoot 'out'
$udf = Join-Path $out 'udf'
$url = "http://127.0.0.1:$Port/"
New-Item -ItemType Directory -Force $out | Out-Null
Get-ChildItem $out -Filter *.png | Remove-Item
if (Test-Path $udf) { Remove-Item -Recurse -Force $udf }   # a fresh profile, so the first start is a true cold start

$results = New-Object System.Collections.ArrayList
function Check([string]$name, [bool]$pass, [string]$detail = '') {
    [void]$results.Add([pscustomobject]@{ Pass = $pass; Check = $name; Detail = $detail })
    Write-Host ('{0}  {1}  [{2}]' -f $(if ($pass) { 'PASS' } else { 'FAIL' }), $name, $detail)
}
function Skip([string]$name, [string]$why) {
    [void]$results.Add([pscustomobject]@{ Pass = $null; Check = $name; Detail = $why })
    Write-Host ('SKIP  {0}  [{1}]' -f $name, $why)
}
# A check on what the screen shows around the owner. Skipped when the desktop is not what the screen shows
# (locked workstation, or another window covering that corner): see $screenOk below.
function ScreenCheck([string]$name, [string]$file, [scriptblock]$test) {
    $shot = [Mw]::Shot($owner.Handle, (Join-Path $out $file))
    if ($script:screenOk) { Check $name (& $test $shot) $shot } else { Skip $name "desktop not visible; $shot" }
}
function Wait-NoMarvis {
    for ($i = 0; $i -le 12; $i++) {
        if (-not (Get-Process -Name 'MARVIS' -ErrorAction SilentlyContinue)) { return }
        if ($i -eq 12) { throw 'MARVIS.exe is still running after 4 minutes; not opening a window.' }
        Write-Host 'MARVIS.exe is running; waiting 20 s...'
        Start-Sleep -Seconds 20
    }
}
function Test-Port([int]$p) {
    $c = New-Object System.Net.Sockets.TcpClient
    try { $c.Connect('127.0.0.1', $p); return $true } catch { return $false } finally { $c.Close() }
}
function Start-Viewer([IntPtr]$owner, [string]$startUrl, [string]$extra = '') {
    New-Object MwProc($Exe, ('--owner {0} --url {1} --udf "{2}" {3}' -f $owner.ToInt64(), $startUrl, $udf, $extra))
}
function Text($line) { if ($line) { $line.Substring($line.IndexOf(' ') + 1) } else { '' } }   # drops the "<ms> " prefix
function Ms($line) { if ($line) { [int]$line.Substring(0, $line.IndexOf(' ')) } else { -1 } }
# The first stdout line, from index $from on, that matches the pattern (without the "<ms> " prefix); '' on timeout.
# Unlike WaitFor it does not depend on the order of the lines.
function Wait-Line($proc, [string]$pattern, [int]$from = 0, [int]$timeoutMs = 10000) {
    $end = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
    do {
        $all = @($proc.Lines())
        for ($i = $from; $i -lt $all.Count; $i++) { $t = Text $all[$i]; if ($t -match $pattern) { return $t } }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $end)
    return ''
}
function Count-Lines($proc) { @($proc.Lines()).Count }
function Since($proc, [int]$from) { (@($proc.Lines()) | Select-Object -Skip $from | ForEach-Object { Text $_ }) -join ' | ' }
function No-LoadFail($proc, [int]$from) { @(@($proc.Lines()) | Select-Object -Skip $from | Where-Object { (Text $_) -like 'loadfail*' }).Count -eq 0 }

$server = $null; $pageServer = $null; $tmp = $null; $owner = $null; $v = $null
try {
    # ---- no window needed ------------------------------------------------------------------------------------
    $v = New-Object MwProc($Exe, '')
    $code = $v.WaitExit(5000)
    Check 'no arguments: exit code 2' ($code -eq 2) "exit $code; $(Text $v.WaitFor('fatal', 1000))"

    $clock = [Diagnostics.Stopwatch]::StartNew()
    $v = Start-Viewer ([IntPtr]123456789) $url
    $code = $v.WaitExit(5000)
    Check 'bogus --owner: exits 4 quickly' ($code -eq 4 -and $clock.ElapsedMilliseconds -lt 3000) "exit $code after $($clock.ElapsedMilliseconds) ms; $(Text $v.WaitFor('fatal', 1000))"

    # ---- with the dummy owner --------------------------------------------------------------------------------
    if (Test-Port $Port) { throw "port $Port is already in use" }
    $server = Start-Process python -ArgumentList '-m', 'http.server', $Port, '--bind', '127.0.0.1', '--directory', "`"$Site`"" -WindowStyle Hidden -PassThru
    for ($i = 0; $i -lt 50 -and -not (Test-Port $Port); $i++) { Start-Sleep -Milliseconds 200 }
    if (-not (Test-Port $Port)) { throw 'the static server did not start' }

    for ($t = 0; $t -lt $UnlockWaitSeconds -and [Mw]::ForegroundProcess() -eq 'LockApp'; $t += 20) {
        Write-Host 'The workstation is locked; waiting 20 s...'
        Start-Sleep -Seconds 20
    }
    Wait-NoMarvis
    $owner = New-Object MwOwner(900, 560)
    $visibleClock = [Diagnostics.Stopwatch]::StartNew()

    # Run 1: the whole show / follow / hide / eval / quit cycle, on a fresh profile.
    $v = Start-Viewer $owner.Handle $url
    $ready = $v.WaitFor('ready', 60000)
    $loaded = $v.WaitFor('loaded ', 60000)
    Check 'prints ready, then loaded <url>' ($ready -and (Text $loaded) -eq "loaded $url") "$ready | $loaded"
    $coldMs = Ms $loaded
    $h = [Mw]::FindViewer($v.P.Id, $owner.Handle)
    Check 'its window is owned by the owner window' ($h -ne [IntPtr]::Zero) "hwnd $h"
    $ex = [Mw]::ExStyle($h)
    Check 'tool window without taskbar style (WS_EX_TOOLWINDOW set, WS_EX_APPWINDOW clear)' ((($ex -band 0x80) -ne 0) -and (($ex -band 0x40000) -eq 0)) ('exstyle 0x{0:X}' -f $ex)
    Check 'not visible before show' (-not [Mw]::Visible($h))
    Check 'already sized to the owner client area while hidden' ([Mw]::RectOf($h) -eq [Mw]::ClientOf($owner.Handle)) "viewer $([Mw]::RectOf($h)) client $([Mw]::ClientOf($owner.Handle))"
    $shot = [Mw]::Shot($owner.Handle, (Join-Path $out '00-before-show.png'))
    $screenOk = $shot -match 'marker=(0\.9|1\.0)'   # the owner's magenta client area is what the screen shows
    if ($screenOk) { Check 'screenshot before show: only the owner' $true $shot }
    else { Write-Host "WARN  the screen does not show the owner window (foreground process: $([Mw]::ForegroundProcess())); screen-capture checks are skipped" }

    $v.Send('show')
    $shown = $v.WaitFor('shown', 5000)
    Start-Sleep -Milliseconds 3000   # let the page paint
    Check 'show: prints shown, window visible' ($shown -and [Mw]::Visible($h)) "$shown"
    Check 'show: covers the owner client area exactly' ([Mw]::RectOf($h) -eq [Mw]::ClientOf($owner.Handle)) "viewer $([Mw]::RectOf($h)) client $([Mw]::ClientOf($owner.Handle))"
    $style = [Mw]::Style($h)
    Check 'show: above the owner in the z-order' ([Mw]::IsAbove($h, $owner.Handle))
    Check 'show: borderless (no caption or sizing frame; compositor frame = window rectangle)' ((($style -band 0xC40000) -eq 0) -and [Mw]::FrameOf($h) -eq [Mw]::RectOf($h)) ('style 0x{0:X}; frame {1}' -f $style, [Mw]::FrameOf($h))
    $isPage = { param($d) ($d -match 'colours=(\d+)') -and ([int]$Matches[1] -gt 50) -and ($d -notmatch 'white=(0\.[5-9]|1)') }
    $print = [Mw]::Print($h, (Join-Path $out '01-viewer-window.png'))
    Check 'viewer window content: the page is drawn (not a flat or white box)' (& $isPage $print) $print
    ScreenCheck 'screenshot after show: no owner pixel left in the client area, page content' '01-shown.png' { param($d) ($d -match 'marker=0\.000') -and (& $isPage $d) }
    Write-Host "INFO  viewer is the foreground window after show: $([Mw]::IsForeground($h)) (the test harness is not the foreground process, so this is not a pass/fail check)"

    $owner.MoveBy(-160, -100, 760, 470)
    Start-Sleep -Milliseconds 700
    Check 'follows the owner after move + resize' ([Mw]::RectOf($h) -eq [Mw]::ClientOf($owner.Handle)) "viewer $([Mw]::RectOf($h)) client $([Mw]::ClientOf($owner.Handle))"
    ScreenCheck 'screenshot after move: still covers the client area' '02-moved.png' { param($d) $d -match 'marker=0\.000' }

    [Mw]::Minimize($owner.Handle)
    Start-Sleep -Milliseconds 500
    $goneWithOwner = -not [Mw]::Visible($h)
    [Mw]::Restore($owner.Handle)
    Start-Sleep -Milliseconds 700
    Check 'owner minimised: viewer hidden with it; restored: visible and in place again' ($goneWithOwner -and [Mw]::Visible($h) -and [Mw]::RectOf($h) -eq [Mw]::ClientOf($owner.Handle)) "hidden while minimised: $goneWithOwner; visible after restore: $([Mw]::Visible($h)); viewer $([Mw]::RectOf($h))"

    $c = [Mw]::ClientOf($owner.Handle) -split ','
    $fixed = '{0},{1},400,300' -f ([int]$c[0] + 40), ([int]$c[1] + 30)
    $v.Send('bounds ' + ($fixed -replace ',', ' '))
    Start-Sleep -Milliseconds 400
    Check 'bounds x y w h: fixed rectangle applied' ([Mw]::RectOf($h) -eq $fixed) "viewer $([Mw]::RectOf($h)) wanted $fixed"
    $v.Send('autobounds')
    Start-Sleep -Milliseconds 400
    Check 'autobounds: back over the owner client area' ([Mw]::RectOf($h) -eq [Mw]::ClientOf($owner.Handle)) "viewer $([Mw]::RectOf($h))"

    $v.Send('hide')
    $hidden = $v.WaitFor('hidden', 5000)
    Start-Sleep -Milliseconds 400
    Check 'hide: prints hidden, window not visible' ($hidden -and -not [Mw]::Visible($h)) "$hidden"
    ScreenCheck 'screenshot after hide: only the owner again' '03-hidden.png' { param($d) $d -match 'marker=(0\.9|1\.0)' }

    # eval: set the title, then navigate to a url that carries it, which comes back as a loaded event.
    $v.Send("eval document.title = 'marvis-eval-ok'")
    $v.Send("eval location.href = '/favicon.svg?title=' + encodeURIComponent(document.title)")
    $evalLine = $v.WaitFor("loaded ${url}favicon.svg?title=marvis-eval-ok", 10000)
    Check 'eval: runs javascript in the page' ([bool]$evalLine) "$evalLine"
    $v.Send("nav ${url}index.html?nav=1")
    $navLine = $v.WaitFor("loaded ${url}index.html?nav=1", 15000)
    Check 'nav <url>: navigates and prints loaded' ([bool]$navLine) "$navLine"

    $v.Send('quit')
    $exitLine = $v.WaitFor('exit', 5000)
    $code = $v.WaitExit(5000)
    Check 'quit: prints exit, exit code 0' ($exitLine -and $code -eq 0) "exit $code"

    # Run 2: existing profile; the window is asked to close, as Alt+F4 does. Over the owner's client area the viewer
    # passes the request on to the owner: the owner closes, and the viewer ends because its owner is gone.
    $v = Start-Viewer $owner.Handle $url
    $loaded = $v.WaitFor('loaded ', 60000)
    $warmMs = Ms $loaded
    $closedOwner = $owner.Handle
    [Mw]::PostClose([Mw]::FindViewer($v.P.Id, $owner.Handle))
    $code = $v.WaitExit(5000)
    Check 'window close (WM_CLOSE) over the owner: the owner window is closed, viewer exits 4' ($code -eq 4 -and -not [Mw]::Exists($closedOwner)) "exit $code; owner still there: $([Mw]::Exists($closedOwner)); $(Text $v.WaitFor('fatal', 1000))"
    $owner = New-Object MwOwner(900, 560)   # the runs below need an owner again

    # Run 3: the optional arguments, then end of input.
    $v = Start-Viewer $owner.Handle $url "--bounds $fixed --bg #203040 --dev --inject `"$(Join-Path $out 'no-such-inject.js')`""
    $ready = $v.WaitFor('ready', 60000)
    Check '--bounds x,y,w,h --bg --dev: starts, with the fixed rectangle' ($ready -and [Mw]::RectOf([Mw]::FindViewer($v.P.Id, $owner.Handle)) -eq $fixed) "$ready"
    Check '--inject with a missing file: prints warn inject-not-read and starts anyway' ($ready -and @($v.Lines() | Where-Object { (Text $_) -eq 'warn inject-not-read' }).Count -eq 1) (Since $v 0)
    $v.CloseInput()
    $exitLine = $v.WaitFor('exit', 5000)
    $code = $v.WaitExit(5000)
    Check 'stdin end of file: prints exit, exit code 0' ($exitLine -and $code -eq 0) "exit $code"

    # Run 3b: with fixed bounds (a window of its own, as over the Unity editor) a close ends only the viewer.
    $v = Start-Viewer $owner.Handle $url "--bounds $fixed"
    $ready = $v.WaitFor('ready', 60000)
    [Mw]::PostClose([Mw]::FindViewer($v.P.Id, $owner.Handle))
    $exitLine = $v.WaitFor('exit', 5000)
    $code = $v.WaitExit(5000)
    Check 'window close (WM_CLOSE) with fixed bounds: prints exit, exit code 0, owner untouched' ($exitLine -and $code -eq 0 -and [Mw]::Exists($owner.Handle)) "exit $code"

    # Run 3c: the live-site protocol, against a small page and inject script made here. The page reports its start
    # (and whether the inject script had already run), echoes every message it gets, and can save a Blob the way
    # the planner's own button does.
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('marvisweb-test-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Force $tmp | Out-Null
    $utf8 = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText((Join-Path $tmp 'index.html'), @'
<!doctype html><html><head><meta charset="utf-8"><title>MarvisWeb test page</title></head><body>test page
<script>
var send = function (o) { window.chrome.webview.postMessage(o); };
send({ type: 'page-start', injected: window.__marvisInjected === true });
window.chrome.webview.addEventListener('message', function (e) { send({ type: 'echo', got: e.data }); });
function blobDownload(name, text) {
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}
</script></body></html>
'@, $utf8)
    [IO.File]::WriteAllText((Join-Path $tmp 'inject.js'), 'window.__marvisInjected = true;', $utf8)
    [IO.File]::WriteAllText((Join-Path $tmp 'marvisweb-test-plain.bin'), 'not a mission', $utf8)
    $pagePort = $Port + 1
    $pageUrl = "http://127.0.0.1:$pagePort/"
    if (Test-Port $pagePort) { throw "port $pagePort is already in use" }
    $pageServer = Start-Process python -ArgumentList '-m', 'http.server', $pagePort, '--bind', '127.0.0.1', '--directory', "`"$tmp`"" -WindowStyle Hidden -PassThru
    for ($i = 0; $i -lt 50 -and -not (Test-Port $pagePort); $i++) { Start-Sleep -Milliseconds 200 }
    if (-not (Test-Port $pagePort)) { throw 'the test page server did not start' }
    $downloads = (New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path

    $v = Start-Viewer $owner.Handle $pageUrl "--inject `"$(Join-Path $tmp 'inject.js')`""
    $start = Wait-Line $v '^message .*"type":"page-start"' 0 60000
    $loadedPage = Wait-Line $v ('^loaded ' + [regex]::Escape($pageUrl) + '$') 0 60000
    Check '--inject: the script ran before the page script' ($start -match '"injected":true') $start
    Check 'page postMessage: prints message <json>' (($start -match '^message \{.*"type":"page-start".*\}$') -and [bool]$loadedPage) "$start | $loadedPage"

    $missionText = '{"kind":"homeline_mission","name":"viewer test","waypoints":[1,2,3]}'
    $from = Count-Lines $v
    $v.Send("eval blobDownload('marvisweb-test-mission.json', '$missionText')")
    $line = Wait-Line $v '^mission ' $from 15000
    $path = if ($line) { $line.Substring(8) } else { '' }
    $ok = $path -and (Test-Path -LiteralPath $path) -and ([IO.File]::ReadAllText($path) -ceq $missionText) -and ((Split-Path $path -Parent) -eq (Join-Path $udf 'marvis-downloads'))
    Check 'blob download with "homeline_mission": prints mission <path>, the file is there with the same text' ([bool]$ok) (Since $v $from)
    if ($path -and (Test-Path -LiteralPath $path)) { Remove-Item -LiteralPath $path }

    $otherText = '{"kind":"something_else","n":7}'
    $from = Count-Lines $v
    $v.Send("eval blobDownload('marvisweb-test-notes.json', '$otherText')")
    $line = Wait-Line $v '^saved ' $from 15000
    $told = Wait-Line $v '^message .*"type":"saved"' $from 5000   # the keys of a message come back in alphabetical order
    $path = if ($line) { $line.Substring(6) } else { '' }
    $ok = $path -and (Test-Path -LiteralPath $path) -and ([IO.File]::ReadAllText($path) -ceq $otherText) -and ((Split-Path $path -Parent) -eq $downloads) -and ($told -match '"name":"marvisweb-test-notes\.json"')
    Check 'another blob download: prints saved <path>, the file is in the Downloads folder, the page is told' ([bool]$ok) "downloads folder $downloads; $(Since $v $from)"
    if ($path -and (Test-Path -LiteralPath $path)) { Remove-Item -LiteralPath $path }

    $postFile = Join-Path $tmp 'post.json'
    [IO.File]::WriteAllText($postFile, '{"type":"ping","n":42}', $utf8)
    $from = Count-Lines $v
    $v.Send("post $postFile")
    $echo = Wait-Line $v '^message .*"type":"echo".*"n":42' $from 10000
    Check 'post <file>: reaches the page, the file is deleted' ($echo -and -not (Test-Path $postFile)) (Since $v $from)
    [IO.File]::WriteAllText($postFile, 'this is not json', $utf8)
    $from = Count-Lines $v
    $v.Send("post $postFile")
    $v.Send("post $(Join-Path $tmp 'no-such-file.json')")
    $v.Send("eval send({ type: 'after-bad-posts' })")
    [void](Wait-Line $v '^message .*after-bad-posts' $from 10000)
    $warns = @(@($v.Lines()) | Select-Object -Skip $from | Where-Object { (Text $_) -like 'warn post-failed *' }).Count
    Check 'post <file> that is not JSON, or missing: prints warn post-failed <reason>' ($warns -eq 2 -and -not (Test-Path $postFile)) (Since $v $from)

    $from = Count-Lines $v
    $v.Send("eval location.href = '$url'")   # the other server: same host, another port = another origin
    $blocked = Wait-Line $v ('^blocked ' + [regex]::Escape($url) + '$') $from 10000
    $told = Wait-Line $v '^message .*"type":"blocked"' $from 5000
    Start-Sleep -Milliseconds 2000   # longer than the viewer holds back the loadfail of an aborted navigation
    $v.Send("eval send({ type: 'still-here', href: location.href })")
    $still = Wait-Line $v ('^message .*still-here.*' + [regex]::Escape($pageUrl)) $from 10000
    Check 'navigation to another origin: prints blocked <url>, no loadfail, the page stays and is told' ($blocked -and $told -and $still -and (No-LoadFail $v $from)) (Since $v $from)

    $from = Count-Lines $v
    $v.Send("eval location.href = '/marvisweb-test-plain.bin'")   # served as application/octet-stream: becomes a download
    $line = Wait-Line $v '^saved ' $from 15000
    Start-Sleep -Milliseconds 2000
    $path = if ($line) { $line.Substring(6) } else { '' }
    Check 'navigation that becomes a download: prints saved <path>, no loadfail' ($path -and (Test-Path -LiteralPath $path) -and (No-LoadFail $v $from)) (Since $v $from)
    if ($path -and (Test-Path -LiteralPath $path)) { Remove-Item -LiteralPath $path }

    $from = Count-Lines $v
    $v.Send('reload')
    $again = Wait-Line $v '^message .*"type":"page-start".*"injected":true' $from 15000
    $reloaded = Wait-Line $v ('^loaded ' + [regex]::Escape($pageUrl) + '$') $from 15000
    Check 'reload: the page loads again, the inject script runs again' ($again -and $reloaded) (Since $v $from)

    # F10 is posted straight to the web content's window, so the test does not depend on which window has the focus.
    $v.Send('show')
    [void](Wait-Line $v '^shown$' $from 5000)
    Start-Sleep -Milliseconds 800
    $h = [Mw]::FindViewer($v.P.Id, $owner.Handle)
    $from = Count-Lines $v
    $closeLine = ''; $via = ''
    foreach ($class in 'Chrome_WidgetWin_1', 'Chrome_WidgetWin_0', 'Chrome_RenderWidgetHostHWND') {
        $n = [Mw]::PostKey($h, $class, 0x79)
        $closeLine = Wait-Line $v '^message \{"type":"close"\}$' $from 2500
        $via += "$class x$n; "
        if ($closeLine) { break }
    }
    Check 'F10 in the page: prints message {"type":"close"}' ([bool]$closeLine) "posted to $via$(Since $v $from)"
    $v.Send('quit')
    [void]$v.WaitExit(5000)

    # Run 4: nothing listens on the start url; then the owner goes away.
    $deadUrl = "http://127.0.0.1:$($Port + 8)/"
    if (Test-Port ($Port + 8)) { throw "port $($Port + 8) should be closed for this test" }
    $v = Start-Viewer $owner.Handle $deadUrl
    $fail = $v.WaitFor('loadfail', 30000)
    Start-Sleep -Milliseconds 500
    Check 'closed port: prints loadfail and keeps running' ($fail -and -not $v.P.HasExited) ($v.Lines() -join ' | ')
    $owner.Close()
    $code = $v.WaitExit(5000)
    Check 'owner window closed: exit code 4' ($code -eq 4) "exit $code; $(Text $v.WaitFor('fatal', 1000))"
    $visibleMs = $visibleClock.ElapsedMilliseconds

    Write-Host ''
    Write-Host "Cold start, fresh profile (process start -> loaded): $coldMs ms"
    Write-Host "Start with an existing profile (process start -> loaded): $warmMs ms"
    Write-Host "A test window was on screen for $([int]($visibleMs / 1000)) s"
}
finally {
    if ($v -and -not $v.P.HasExited) { $v.P.Kill() }
    if ($owner) { $owner.Close() }
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
    if ($pageServer -and -not $pageServer.HasExited) { Stop-Process -Id $pageServer.Id -Force }
    if ($tmp -and (Test-Path $tmp)) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}

$failed = @($results | Where-Object { $_.Pass -eq $false }).Count
$skipped = @($results | Where-Object { $null -eq $_.Pass }).Count
Write-Host ("{0} checks, {1} failed, {2} skipped. Screenshots: {3}" -f $results.Count, $failed, $skipped, $out)
exit $failed
