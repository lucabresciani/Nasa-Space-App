// MarvisWeb.exe - shows the route planner (a web site, or the copy shipped with the game) inside the MARVIS
// (Unity) window.
//
// A borderless WebView2 window, owned by the Unity window and kept exactly over its client area, so that the two
// look like one window. Unity starts it hidden and drives it over stdin; events come back on stdout.
// One command or event per line, UTF-8.
//
//   args  : --owner <HWND, decimal> --url <start url> --udf <WebView2 user data folder>
//           [--bg #RRGGBB] [--dev] [--bounds x,y,w,h] [--inject <file>]
//             --inject   a UTF-8 JavaScript file; it runs in every document before the page's own scripts.
//                        A file that cannot be read gives "warn inject-not-read" and the viewer goes on without it.
//   stdin : show | hide | focus | nav <url> | reload | bounds <x> <y> <w> <h> | autobounds | eval <javascript>
//           | post <file> | quit
//             post       the file holds one JSON document (UTF-8). It is delivered to the page as a web message
//                        (window.chrome.webview 'message' event, e.data) and the file is then deleted.
//   stdout: ready | loaded <url> | loadfail <status> | shown | hidden | fatal <reason> | exit
//           mission <path>        a finished download whose text contains "homeline_mission" (files up to 16 MB
//                                 are checked). The file stays at <path>; the receiver deletes it.
//           saved <path>          any other finished download, moved to the user's Downloads folder under a unique
//                                 name. The page also gets {"type":"saved","name":"<file name>"}.
//           downloadfail <reason>
//           message <json>        the page called window.chrome.webview.postMessage(x).
//                                 F10 pressed in the page prints  message {"type":"close"}  (the way out of the
//                                 planner when the page script failed).
//           blocked <url>         a navigation to another origin, or a new window, was refused. Allowed origins:
//                                 the one of --url, the one of every later "nav <url>", and about:blank.
//                                 The page also gets {"type":"blocked","url":"<url>"}.
//           warn <text>           a problem that is not fatal: inject-not-read | post-failed <reason>
//           "loadfail" means that the page could not be loaded. It is not printed for a navigation refused here
//           (blocked) nor for one that turned into a download. A page that redirects to another origin is
//           refused and counts as not loaded: "blocked <url>", then "loadfail redirected-to-other-origin".
//   downloads never show the browser's own download UI; they are written to <udf>\marvis-downloads, a folder
//           emptied at start.
//   exit  : 0 normal (after "exit"), 1 unexpected error, 2 bad arguments, 3 WebView2 runtime not installed,
//           4 owner window gone. Every non-zero exit is preceded by a "fatal <reason>" line.
//   close : Alt+F4 on the viewer asks the owner window to close (WM_CLOSE) and the viewer stays until told to quit;
//           with fixed bounds it closes only the viewer (exit 0).

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace MarvisWeb
{
    static class Program
    {
        public static IntPtr Owner;
        public static string Url, Udf, InjectFile;
        public static Color Bg = Color.FromArgb(0x0b, 0x0e, 0x13);
        public static bool Dev;
        public static Rectangle? FixedBounds;   // null = follow the owner's client rectangle

        static TextWriter stdout;

        [STAThread]
        static int Main(string[] args)
        {
            SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);   // a crash must never open a dialog
            stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
            AppDomain.CurrentDomain.UnhandledException += (s, e) =>
                Fatal(e.ExceptionObject is Exception x ? x.Message : "unhandled exception");
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += (s, e) => Fatal(e.Exception.Message);

            try { ParseArgs(args); }
            catch (Exception e) { return Fatal("bad-args " + e.Message, 2); }
            if (!IsWindow(Owner)) return Fatal("owner-gone", 4);
            try
            {
                if (string.IsNullOrEmpty(CoreWebView2Environment.GetAvailableBrowserVersionString()))
                    return Fatal("no-runtime", 3);
            }
            catch (WebView2RuntimeNotFoundException) { return Fatal("no-runtime", 3); }

            var viewer = new Viewer();
            IntPtr handle = viewer.Handle;   // create the window now, hidden, so commands can be marshalled to it
            viewer.Start();
            new Thread(() => ReadCommands(viewer)) { IsBackground = true, Name = "stdin" }.Start();
            Application.Run();
            return 0;
        }

        static void ParseArgs(string[] a)
        {
            for (int i = 0; i < a.Length; i++)
            {
                string key = a[i];
                if (key == "--dev") { Dev = true; continue; }
                if (i + 1 >= a.Length) throw new ArgumentException("missing value for " + key);
                string v = a[++i];
                switch (key)
                {
                    case "--owner": Owner = new IntPtr(long.Parse(v, CultureInfo.InvariantCulture)); break;
                    case "--url": Url = v; break;
                    case "--udf": Udf = Path.GetFullPath(v); break;
                    case "--inject": InjectFile = v; break;   // read in Viewer.Start; a bad path is only a warning
                    case "--bg":
                        if (v.Length != 7 || v[0] != '#') throw new ArgumentException("--bg must be #RRGGBB");
                        int rgb = int.Parse(v.Substring(1), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
                        Bg = Color.FromArgb(255, Color.FromArgb(rgb));
                        break;
                    case "--bounds":
                        if (!TryParseRect(v, out Rectangle r)) throw new ArgumentException("--bounds must be x,y,w,h");
                        FixedBounds = r;
                        break;
                    default: throw new ArgumentException("unknown argument " + key);
                }
            }
            if (Owner == IntPtr.Zero || string.IsNullOrEmpty(Url) || string.IsNullOrEmpty(Udf))
                throw new ArgumentException("--owner, --url and --udf are required");
        }

        // "x,y,w,h" or "x y w h", screen pixels.
        public static bool TryParseRect(string s, out Rectangle r)
        {
            r = Rectangle.Empty;
            string[] p = s.Split(new[] { ',', ' ' }, StringSplitOptions.RemoveEmptyEntries);
            var n = new int[4];
            if (p.Length != 4) return false;
            for (int i = 0; i < 4; i++)
                if (!int.TryParse(p[i], NumberStyles.Integer, CultureInfo.InvariantCulture, out n[i])) return false;
            if (n[2] <= 0 || n[3] <= 0) return false;
            r = new Rectangle(n[0], n[1], n[2], n[3]);
            return true;
        }

        // Background thread: one command per line, each run on the UI thread. End of input means quit.
        static void ReadCommands(Viewer viewer)
        {
            try
            {
                var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false), true);
                string line;
                while ((line = stdin.ReadLine()) != null)
                {
                    string command = line.Trim();
                    if (command.Length > 0) viewer.BeginInvoke(new Action(() => viewer.Command(command)));
                }
            }
            catch (IOException) { }   // a broken pipe is the same as end of input
            viewer.BeginInvoke(new Action(viewer.Quit));
        }

        public static void Emit(string line)
        {
            lock (stdout)
            {
                try { stdout.WriteLine(line); }
                catch (IOException) { }   // nobody is listening any more
            }
        }

        public static int Fatal(string reason, int code = 1)
        {
            Emit("fatal " + OneLine(reason));
            Environment.Exit(code);
            return code;
        }

        public static string OneLine(string s) { return s.Replace('\r', ' ').Replace('\n', ' '); }

        const uint SEM_FAILCRITICALERRORS = 0x0001, SEM_NOGPFAULTERRORBOX = 0x0002;
        [DllImport("kernel32.dll")] static extern uint SetErrorMode(uint mode);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    }

    sealed class Viewer : Form
    {
        const long MaxMissionBytes = 16 * 1024 * 1024;   // larger downloads are not read: they cannot be a mission

        readonly WebView2 web = new WebView2();
        readonly System.Windows.Forms.Timer tracker = new System.Windows.Forms.Timer { Interval = 50 };
        bool reloaded;   // a failed render process is reloaded only once
        bool quitting;

        // Navigation: only these origins (scheme://host[:port]) may be shown in the main frame.
        readonly HashSet<string> allowedOrigins = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        readonly HashSet<ulong> openNavs = new HashSet<ulong>();    // started, not completed yet
        readonly HashSet<ulong> quietNavs = new HashSet<ulong>();   // refused here or turned into a download: no loadfail
        // A navigation that turns into a download ends as "aborted", and the download may be announced just after:
        // such a loadfail is held back for a moment and dropped when a download starts.
        readonly System.Windows.Forms.Timer heldTimer = new System.Windows.Forms.Timer { Interval = 1000 };
        string heldFail;
        int heldAtDownload;

        string downloadDir;
        int downloadCount;

        public Viewer()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None;
            BackColor = Program.Bg;
            web.DefaultBackgroundColor = Program.Bg;   // same colour before the page paints: no white flash
            web.Dock = DockStyle.Fill;
            Controls.Add(web);
            ActiveControl = web;   // the web content gets the keyboard whenever this window is activated
            heldTimer.Tick += (s, e) => FlushHeldFail();
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.Style |= WS_POPUP;
                cp.ExStyle |= WS_EX_TOOLWINDOW;   // no Alt-Tab entry
                return cp;
            }
        }

        // The Unity window owns this one: always above it, minimised with it, no taskbar button.
        // Done after base.CreateHandle because WinForms gives a ShowInTaskbar=false form a hidden owner of its own there.
        protected override void CreateHandle()
        {
            base.CreateHandle();
            SetWindowLongPtr(Handle, GWLP_HWNDPARENT, Program.Owner);
        }

        public async void Start()
        {
            Track();
            tracker.Tick += (s, e) => Track();
            tracker.Start();

            Directory.CreateDirectory(Program.Udf);
            downloadDir = Path.Combine(Program.Udf, "marvis-downloads");
            try { if (Directory.Exists(downloadDir)) Directory.Delete(downloadDir, true); }
            catch (Exception) { }   // a file still in use stays; new downloads get new names
            Directory.CreateDirectory(downloadDir);

            string inject = null;
            if (Program.InjectFile != null)
            {
                try { inject = File.ReadAllText(Program.InjectFile, Encoding.UTF8); }
                catch (Exception) { Program.Emit("warn inject-not-read"); }
            }

            // Accept any reasonably recent runtime; the default would demand at least this SDK's own build.
            var options = new CoreWebView2EnvironmentOptions { TargetCompatibleBrowserVersion = "100.0.0.0" };
            CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, Program.Udf, options);
            await web.EnsureCoreWebView2Async(env);

            CoreWebView2 core = web.CoreWebView2;
            CoreWebView2Settings settings = core.Settings;
            settings.AreDefaultContextMenusEnabled = false;
            settings.AreDevToolsEnabled = Program.Dev;
            settings.AreBrowserAcceleratorKeysEnabled = Program.Dev;
            settings.IsStatusBarEnabled = false;
            settings.IsZoomControlEnabled = false;
            settings.IsSwipeNavigationEnabled = false;
            settings.IsPasswordAutosaveEnabled = false;
            settings.IsGeneralAutofillEnabled = false;
            // Nothing opens outside this window.
            core.NewWindowRequested += (s, e) => { e.Handled = true; Blocked(e.Uri); };
            core.NavigationStarting += OnNavigationStarting;
            core.NavigationCompleted += OnNavigationCompleted;
            core.DownloadStarting += OnDownloadStarting;
            core.WebMessageReceived += (s, e) => Program.Emit("message " + Program.OneLine(e.WebMessageAsJson));
            core.PermissionRequested += (s, e) =>
            {
                // A page that saves a second file without a click would otherwise get the browser's own prompt.
                if (e.PermissionKind == CoreWebView2PermissionKind.MultipleAutomaticDownloads)
                    e.State = CoreWebView2PermissionState.Allow;
            };
            core.ProcessFailed += OnProcessFailed;
            // The control passes the keys the browser does not type (function keys, Ctrl/Alt combinations) here
            // first; a handled key never reaches the page.
            web.KeyDown += (s, e) =>
            {
                if (e.KeyData != Keys.F10) return;
                e.Handled = true;
                Program.Emit("message {\"type\":\"close\"}");
            };
            if (!string.IsNullOrEmpty(inject)) await core.AddScriptToExecuteOnDocumentCreatedAsync(inject);

            Program.Emit("ready");
            Navigate(Program.Url);
        }

        void OnProcessFailed(object sender, CoreWebView2ProcessFailedEventArgs e)
        {
            Program.Emit("loadfail process-failed " + e.ProcessFailedKind);
            // RenderProcessUnresponsive is only a slow script: the page and what the user did in it are kept.
            if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited)
            {
                // The page is gone: load it again, once. A second loss ends the viewer, so that the caller starts a
                // new one instead of showing a dead page.
                if (reloaded) Program.Fatal("render-process-exited");
                reloaded = true;
                web.CoreWebView2.Reload();
            }
            else if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
                Program.Fatal("browser-process-exited");   // nothing left to reload; the caller may start a new viewer
        }

        // ---- navigation ------------------------------------------------------------------------------------------

        static string OriginOf(string url)
        {
            return Uri.TryCreate(url, UriKind.Absolute, out Uri u) ? u.Scheme + "://" + u.Authority : null;
        }

        bool IsAllowed(string url)
        {
            if (url.StartsWith("about:blank", StringComparison.OrdinalIgnoreCase)) return true;
            string origin = OriginOf(url);
            return origin != null && allowedOrigins.Contains(origin);
        }

        // Main frame only (also raised for each redirect, with the same id).
        void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            if (IsAllowed(e.Uri)) { openNavs.Add(e.NavigationId); return; }
            e.Cancel = true;
            quietNavs.Add(e.NavigationId);
            Blocked(e.Uri);
            // A redirect (same id) of a navigation allowed above: the page that was asked for did not load.
            if (openNavs.Contains(e.NavigationId)) Program.Emit("loadfail redirected-to-other-origin");
        }

        void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            FlushHeldFail();   // keeps the order of the events of two navigations
            openNavs.Remove(e.NavigationId);
            bool quiet = quietNavs.Remove(e.NavigationId);
            if (e.IsSuccess) { Program.Emit("loaded " + web.CoreWebView2.Source); return; }
            if (quiet) return;   // refused here, or it became a download: not a page that failed to load
            if (e.WebErrorStatus == CoreWebView2WebErrorStatus.ConnectionAborted
                || e.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled)
            {
                heldFail = e.WebErrorStatus.ToString();
                heldAtDownload = downloadCount;
                heldTimer.Start();
                return;
            }
            Program.Emit("loadfail " + e.WebErrorStatus);
        }

        void FlushHeldFail()
        {
            heldTimer.Stop();
            if (heldFail == null) return;
            string status = heldFail;
            heldFail = null;
            if (downloadCount == heldAtDownload) Program.Emit("loadfail " + status);
        }

        void Blocked(string url)
        {
            Program.Emit("blocked " + Program.OneLine(url));
            Post("{\"type\":\"blocked\",\"url\":" + Json(url) + "}");
        }

        // ---- downloads -------------------------------------------------------------------------------------------

        void OnDownloadStarting(object sender, CoreWebView2DownloadStartingEventArgs e)
        {
            e.Handled = true;   // never the browser's own download UI
            foreach (ulong id in openNavs) quietNavs.Add(id);   // a navigation still open is the one that became this download
            string name;
            try { name = Path.GetFileName(e.ResultFilePath); } catch (ArgumentException) { name = ""; }
            name = SafeName(name);
            string path = Path.Combine(downloadDir, (++downloadCount).ToString(CultureInfo.InvariantCulture) + "-" + name);
            e.ResultFilePath = path;

            CoreWebView2DownloadOperation download = e.DownloadOperation;
            bool done = false;
            download.StateChanged += (s, a) =>
            {
                if (done || download.State == CoreWebView2DownloadState.InProgress) return;
                done = true;
                if (download.State == CoreWebView2DownloadState.Completed) Downloaded(path, name);
                else
                {
                    Program.Emit("downloadfail " + download.InterruptReason);
                    try { File.Delete(path); } catch (Exception) { }
                }
            };
        }

        // A mission file is handed to the game where it is; anything else goes to the user's Downloads folder.
        void Downloaded(string path, string name)
        {
            try
            {
                if (new FileInfo(path).Length <= MaxMissionBytes
                    && File.ReadAllText(path, Encoding.UTF8).Contains("homeline_mission"))
                {
                    Program.Emit("mission " + path);
                    return;
                }
                string folder = DownloadsFolder();
                Directory.CreateDirectory(folder);
                string target = Path.Combine(folder, name);
                for (int n = 1; File.Exists(target) || Directory.Exists(target); n++)
                    target = Path.Combine(folder, Path.GetFileNameWithoutExtension(name) + " (" + n + ")" + Path.GetExtension(name));
                File.Move(path, target);
                Program.Emit("saved " + target);
                Post("{\"type\":\"saved\",\"name\":" + Json(Path.GetFileName(target)) + "}");
            }
            catch (Exception x) { Program.Emit("downloadfail " + Program.OneLine(x.Message)); }
        }

        static string SafeName(string name)
        {
            var b = new StringBuilder();
            foreach (char c in name ?? "")
                b.Append(c < ' ' || Array.IndexOf(Path.GetInvalidFileNameChars(), c) >= 0 ? '_' : c);
            string s = b.ToString().Trim(' ', '.');
            if (s.Length > 120) s = s.Substring(0, 80) + Path.GetExtension(s);
            return s.Length == 0 ? "download" : s;
        }

        // The Downloads folder as Windows knows it (the user may have moved it); else the usual place.
        static string DownloadsFolder()
        {
            try
            {
                if (SHGetKnownFolderPath(new Guid("374DE290-123F-4565-9164-39C4925E467B"), 0, IntPtr.Zero, out IntPtr p) == 0)
                {
                    string s = Marshal.PtrToStringUni(p);
                    Marshal.FreeCoTaskMem(p);
                    if (!string.IsNullOrEmpty(s)) return s;
                }
            }
            catch (Exception) { }
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
        }

        // ---- messages to the page ----------------------------------------------------------------------------------

        void Post(string json)
        {
            try { if (web.CoreWebView2 != null) web.CoreWebView2.PostWebMessageAsJson(json); }
            catch (Exception) { }
        }

        static string Json(string s)
        {
            var b = new StringBuilder("\"");
            foreach (char c in s)
            {
                if (c == '"' || c == '\\') b.Append('\\').Append(c);
                else if (c < ' ' || c > '~') b.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                else b.Append(c);
            }
            return b.Append('"').ToString();
        }

        // post <file>: the file is one JSON document for the page; it is deleted in every case.
        void PostFile(string file)
        {
            file = file.Trim('"');
            try
            {
                if (web.CoreWebView2 == null) throw new InvalidOperationException("not-ready");
                string json = File.ReadAllText(file, Encoding.UTF8);
                try { web.CoreWebView2.PostWebMessageAsJson(json); }
                catch (ArgumentException) { throw new InvalidOperationException("not-json"); }
            }
            catch (FileNotFoundException) { Program.Emit("warn post-failed not-found"); }
            catch (DirectoryNotFoundException) { Program.Emit("warn post-failed not-found"); }
            catch (Exception x) { Program.Emit("warn post-failed " + Program.OneLine(x.Message)); }
            try { File.Delete(file); } catch (Exception) { }
        }

        public void Command(string line)
        {
            int space = line.IndexOf(' ');
            string name = space < 0 ? line : line.Substring(0, space);
            string arg = space < 0 ? "" : line.Substring(space + 1).Trim();
            switch (name)
            {
                case "show":
                    Track();
                    Show();
                    TakeFocus();
                    Program.Emit("shown");
                    break;
                case "hide":
                    Hide();
                    SetForegroundWindow(Program.Owner);
                    Program.Emit("hidden");
                    break;
                case "focus":
                    if (Visible) TakeFocus();
                    break;
                case "nav":
                    Navigate(arg);
                    break;
                case "reload":
                    if (web.CoreWebView2 != null) web.CoreWebView2.Reload();
                    break;
                case "bounds":
                    if (Program.TryParseRect(arg, out Rectangle r)) { Program.FixedBounds = r; Track(); }
                    break;
                case "autobounds":
                    Program.FixedBounds = null;
                    Track();
                    break;
                case "eval":
                    if (web.CoreWebView2 != null) _ = web.CoreWebView2.ExecuteScriptAsync(arg);
                    break;
                case "post":
                    PostFile(arg);
                    break;
                case "quit":
                    Quit();
                    break;
            }
        }

        // The start url and every "nav <url>": their origin becomes an allowed one.
        void Navigate(string url)
        {
            if (web.CoreWebView2 == null) { Program.Url = url; return; }   // not ready yet: becomes the start url
            string origin = OriginOf(url);
            if (origin != null) allowedOrigins.Add(origin);
            try { web.CoreWebView2.Navigate(url); }
            catch (ArgumentException) { Program.Emit("loadfail bad-url"); }
        }

        void TakeFocus()
        {
            SetForegroundWindow(Handle);
            web.Focus();
        }

        // Keeps the window over the owner's client area (or the fixed bounds); ends the process when the owner is gone.
        void Track()
        {
            if (!Program.IsWindow(Program.Owner)) { Program.Fatal("owner-gone", 4); return; }
            Rectangle target;
            if (Program.FixedBounds.HasValue) target = Program.FixedBounds.Value;
            else
            {
                var origin = new Point(0, 0);
                if (IsIconic(Program.Owner) || !GetClientRect(Program.Owner, out RECT client)
                    || !ClientToScreen(Program.Owner, ref origin)) return;
                if (client.Right <= 0 || client.Bottom <= 0) return;
                target = new Rectangle(origin.X, origin.Y, client.Right, client.Bottom);
            }
            if (Bounds != target) Bounds = target;
        }

        public void Quit()
        {
            if (quitting) return;
            quitting = true;
            Program.Emit("exit");
            try { web.Dispose(); } catch { }   // close the browser cleanly
            Environment.Exit(0);
        }

        // Alt+F4, or any other request to close this window. Over the owner's client area it is, to the user, the
        // owner's window: the owner is asked to close instead (it then sends quit as usual). With fixed bounds
        // (a window of its own over the Unity editor) only the viewer closes.
        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!quitting && !Program.FixedBounds.HasValue && e.CloseReason != CloseReason.WindowsShutDown)
            {
                e.Cancel = true;
                PostMessage(Program.Owner, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
                return;
            }
            base.OnFormClosing(e);
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            base.OnFormClosed(e);
            Quit();
        }

        const int WS_POPUP = unchecked((int)0x80000000), WS_EX_TOOLWINDOW = 0x80, GWLP_HWNDPARENT = -8;
        const uint WM_CLOSE = 0x0010;
        [DllImport("user32.dll", EntryPoint = "PostMessageW")] static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
        [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr value);
        [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hWnd, ref Point point);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("shell32.dll")] static extern int SHGetKnownFolderPath([MarshalAs(UnmanagedType.LPStruct)] Guid id, uint flags, IntPtr token, out IntPtr path);
    }
}
