#if UNITY_STANDALONE_WIN || UNITY_EDITOR_WIN
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using Debug = UnityEngine.Debug;

namespace NasaSpaceApp.Homeline.Web
{
    /// <summary>
    /// Starts and supervises MartisWeb.exe, the helper that shows the web planner in a borderless WebView2 window owned
    /// by the game window. One line per command on its stdin (show, hide, focus, bounds, quit) and one line per event
    /// on its stdout (ready, loaded, loadfail, shown, hidden, fatal, exit); see README.md in this folder.
    /// One instance per started process. Commands are sent from the main thread; the events are read on a background
    /// thread into the flags below.
    /// </summary>
    internal sealed class ViewerProcess
    {
        const string PlayerWindowClass = "UnityWndClass";
        const int ExitNoRuntime = 3;
        const int MaxEditorWidth = 1280, MaxEditorHeight = 800;

        Process process;
        int processId;
        volatile bool ready, loaded, visible, exited;
        volatile string fatal;
        volatile int exitCode;

        /// <summary>WebView2 is initialised.</summary>
        public bool Ready { get { return ready; } }
        /// <summary>The page has loaded at least once.</summary>
        public bool Loaded { get { return loaded; } }
        /// <summary>The viewer window is on screen (its last event was shown, not hidden).</summary>
        public bool Visible { get { return visible; } }
        /// <summary>The reason of a fatal event, else null.</summary>
        public string Fatal { get { return fatal; } }
        public bool Exited { get { return exited; } }
        public int ProcessId { get { return processId; } }
        public int ExitCode { get { return exitCode; } }
        /// <summary>Started, still running and not fatal.</summary>
        public bool Alive { get { return process != null && !exited && fatal == null; } }
        /// <summary>The machine has no WebView2 runtime: starting the viewer again cannot help.</summary>
        public bool NoRuntime { get { return fatal == "no-runtime" || exited && exitCode == ExitNoRuntime; } }

        /// <summary>Why the viewer is not alive, for the log.</summary>
        public string Status
        {
            get
            {
                if (fatal != null) return "fatal: " + fatal;
                return exited ? "exit code " + exitCode : "running";
            }
        }

        /// <summary>
        /// Starts the viewer hidden; it loads <paramref name="url"/> at once. <paramref name="bounds"/> is "x,y,w,h" in
        /// screen pixels, or null to follow the owner window's client area.
        /// </summary>
        public bool Start(string exe, IntPtr owner, string url, string userDataFolder, string background, string bounds, bool dev)
        {
            var info = new ProcessStartInfo
            {
                FileName = exe,
                Arguments = "--owner " + owner.ToInt64() + " --url " + Quote(url) + " --udf " + Quote(userDataFolder) +
                            " --bg " + background + (bounds != null ? " --bounds " + bounds : "") + (dev ? " --dev" : ""),
                WorkingDirectory = Path.GetDirectoryName(exe),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                StandardOutputEncoding = Encoding.UTF8,
            };
            try
            {
                process = Process.Start(info);
            }
            catch (Exception e)
            {
                Debug.LogWarning("[WebPlanner] viewer not started: " + e.Message);
                process = null;
            }
            if (process == null)
            {
                return false;
            }
            processId = process.Id;
            var reader = new Thread(ReadEvents) { IsBackground = true, Name = "MartisWeb events" };
            reader.Start(process);
            return true;
        }

        /// <summary>Puts the viewer over its bounds, in front, with the keyboard on the page.</summary>
        public bool Show()
        {
            Win32.AllowSetForegroundWindow(processId);
            return Send("show");
        }

        /// <summary>Hides the viewer; it hands the foreground back to the game window.</summary>
        public bool Hide()
        {
            return Send("hide");
        }

        public bool Focus()
        {
            Win32.AllowSetForegroundWindow(processId);
            return Send("focus");
        }

        /// <summary>Fixed bounds in screen pixels (the editor; a player lets the viewer follow its window).</summary>
        public bool SetBounds(int x, int y, int width, int height)
        {
            return Send("bounds " + x + " " + y + " " + width + " " + height);
        }

        /// <summary>Runs one line of JavaScript in the page.</summary>
        public bool Eval(string javascript)
        {
            return Send("eval " + javascript);
        }

        /// <summary>Asks the viewer to quit and kills it if it has not gone within a second.</summary>
        public void Quit()
        {
            Process p = process;
            if (p == null)
            {
                return;
            }
            Send("quit");
            process = null;
            try
            {
                p.StandardInput.Close();   // end of file makes it exit too
            }
            catch (Exception)
            {
            }
            try
            {
                if (!p.WaitForExit(1000))
                {
                    p.Kill();
                    Debug.Log("[WebPlanner] viewer killed (it did not exit within a second)");
                }
            }
            catch (Exception)
            {
                // already gone
            }
        }

        // UTF-8 bytes straight to the pipe: the process's own stdin writer would use the console code page.
        bool Send(string command)
        {
            Process p = process;
            if (p == null || exited)
            {
                return false;
            }
            try
            {
                byte[] bytes = Encoding.UTF8.GetBytes(command + "\n");
                Stream stdin = p.StandardInput.BaseStream;
                stdin.Write(bytes, 0, bytes.Length);
                stdin.Flush();
                return true;
            }
            catch (Exception e)
            {
                Debug.LogWarning("[WebPlanner] viewer command '" + command + "' not sent: " + e.Message);
                return false;
            }
        }

        // Background thread: one event per line until the viewer closes its stdout, then its exit code.
        void ReadEvents(object state)
        {
            var p = (Process)state;
            try
            {
                string line;
                while ((line = p.StandardOutput.ReadLine()) != null)
                {
                    line = line.Trim();
                    int space = line.IndexOf(' ');
                    string name = space < 0 ? line : line.Substring(0, space);
                    string detail = space < 0 ? "" : line.Substring(space + 1).Trim();
                    switch (name)
                    {
                        case "ready":
                            ready = true;
                            break;
                        case "loaded":
                            loaded = true;
                            break;
                        case "loadfail":
                            Debug.LogWarning("[WebPlanner] viewer could not load the page: " + detail);
                            break;
                        case "shown":
                            visible = true;
                            break;
                        case "hidden":
                            visible = false;
                            break;
                        case "fatal":
                            fatal = detail.Length > 0 ? detail : "unknown";
                            break;
                    }
                }
            }
            catch (Exception e)
            {
                Debug.LogWarning("[WebPlanner] viewer events: " + e.Message);
            }

            int code = -1;
            try
            {
                p.WaitForExit();
                code = p.ExitCode;
            }
            catch (Exception)
            {
            }
            exitCode = code;
            visible = false;
            exited = true;
        }

        // One command-line argument in double quotes (no quote inside, no trailing backslash: a URL or a folder path).
        static string Quote(string s)
        {
            return "\"" + s.Replace("\"", "").TrimEnd('\\') + "\"";
        }

        // ---------------------------------------------------------------- the window the viewer is owned by

        /// <summary>
        /// The game's own window, or zero when it is not there yet. Player: the visible top-level UnityWndClass window
        /// of the main thread. Editor: the main editor window.
        /// </summary>
        public static IntPtr FindOwnerWindow(uint mainThreadId, bool editor)
        {
            if (editor)
            {
                IntPtr main = IntPtr.Zero;
                try
                {
                    main = Process.GetCurrentProcess().MainWindowHandle;
                }
                catch (Exception)
                {
                }
                return main != IntPtr.Zero ? main : Win32.GetActiveWindow();
            }

            IntPtr found = IntPtr.Zero;
            var name = new StringBuilder(64);
            Win32.EnumWindowsProc visit = (window, lParam) =>
            {
                if (!Win32.IsWindowVisible(window))
                {
                    return true;
                }
                name.Length = 0;
                Win32.GetClassName(window, name, name.Capacity);
                if (name.ToString() != PlayerWindowClass)
                {
                    return true;
                }
                found = window;
                return false;
            };
            Win32.EnumThreadWindows(mainThreadId, visit, IntPtr.Zero);
            GC.KeepAlive(visit);
            return found;
        }

        /// <summary>Editor: a centred rectangle of at most 1280 x 800 inside the main editor window, screen pixels.</summary>
        public static bool EditorBounds(IntPtr window, out int x, out int y, out int width, out int height)
        {
            x = y = width = height = 0;
            if (window == IntPtr.Zero || !Win32.GetWindowRect(window, out Win32.Rect r))
            {
                return false;
            }
            int w = r.Right - r.Left, h = r.Bottom - r.Top;
            width = Math.Min(MaxEditorWidth, w);
            height = Math.Min(MaxEditorHeight, h);
            x = r.Left + (w - width) / 2;
            y = r.Top + (h - height) / 2;
            return width > 0 && height > 0;
        }
    }
}
#endif
