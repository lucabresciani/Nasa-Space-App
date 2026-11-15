// MarvisWeb.exe - shows the HOMELINE web app inside the MARVIS (Unity) window.
//
// A borderless WebView2 window, owned by the Unity window and kept exactly over its client area, so that the two
// look like one window. Unity starts it hidden and drives it over stdin; events come back on stdout.
// One command or event per line, UTF-8.
//
//   args  : --owner <HWND, decimal> --url <start url> --udf <WebView2 user data folder>
//           [--bg #RRGGBB] [--dev] [--bounds x,y,w,h]
//   stdin : show | hide | focus | nav <url> | bounds <x> <y> <w> <h> | autobounds | eval <javascript> | quit
//   stdout: ready | loaded <url> | loadfail <status> | shown | hidden | fatal <reason> | exit
//   exit  : 0 normal (after "exit"), 1 unexpected error, 2 bad arguments, 3 WebView2 runtime not installed,
//           4 owner window gone. Every non-zero exit is preceded by a "fatal <reason>" line.
//   close : Alt+F4 on the viewer asks the owner window to close (WM_CLOSE) and the viewer stays until told to quit;
//           with fixed bounds it closes only the viewer (exit 0).

using System;
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
        public static string Url, Udf;
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
            Emit("fatal " + reason.Replace('\r', ' ').Replace('\n', ' '));
            Environment.Exit(code);
            return code;
        }

        const uint SEM_FAILCRITICALERRORS = 0x0001, SEM_NOGPFAULTERRORBOX = 0x0002;
        [DllImport("kernel32.dll")] static extern uint SetErrorMode(uint mode);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    }

    sealed class Viewer : Form
    {
        readonly WebView2 web = new WebView2();
        readonly System.Windows.Forms.Timer tracker = new System.Windows.Forms.Timer { Interval = 50 };
        bool reloaded;   // a failed render process is reloaded only once
        bool quitting;

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
            core.NewWindowRequested += (s, e) => e.Handled = true;   // nothing opens outside this window
            core.NavigationCompleted += (s, e) =>
                Program.Emit(e.IsSuccess ? "loaded " + core.Source : "loadfail " + e.WebErrorStatus);
            core.ProcessFailed += OnProcessFailed;

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
                case "quit":
                    Quit();
                    break;
            }
        }

        void Navigate(string url)
        {
            if (web.CoreWebView2 == null) { Program.Url = url; return; }   // not ready yet: becomes the start url
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
    }
}
