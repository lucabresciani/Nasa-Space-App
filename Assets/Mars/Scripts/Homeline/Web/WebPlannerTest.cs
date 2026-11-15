#if UNITY_STANDALONE_WIN || UNITY_EDITOR_WIN
using System;
using System.Collections;
using System.IO;
using System.Net;
using System.Text;
using System.Threading.Tasks;
using NasaSpaceApp.Menu;
using Newtonsoft.Json.Linq;
using UnityEngine;
using MissionLink = global::NasaSpaceApp.Mission.MissionLink;

namespace NasaSpaceApp.Homeline.Web
{
    /// <summary>
    /// Unattended check of the hand-off between the web planner and the simulator:
    ///   MARVIS.exe -marvisWebTest &lt;mission.json&gt; [-marvisWebTestDir DIR] [-plannerUrl URL|local]
    /// With the title menu up it waits for the planner page (the planner site, or the local copy), opens the planner
    /// through MISSION PLAN, checks that the Controls list then has no MISSION PLAN group (the keys of a plan made in
    /// the built-in panel), takes a screenshot of the game window's place on the desktop, hands the mission over as
    /// the page does, and checks that the menu closed and the mission is loaded.
    /// "mode live" (the page is the planner site): the page script must have answered, and the mission goes the way
    /// of the site's "Send to simulator": the page script is asked to download it and the viewer catches the file.
    /// "mode local" (the page is the local copy): the mission is posted to the API over real HTTP.
    /// Whenever the local copy is served its API is checked too: hello, index.html, the state, a broken document
    /// (422) and a post without the X-Marvis header (403).
    /// It writes result.txt (first line PASS or FAIL, then one line per check and the line "mode live" or
    /// "mode local"), planner.png (the planner up, 1.5 s after it was shown), planner-late.png (4 s later) and
    /// eva.png (after the hand-off) to DIR (default: webtest next to the exe) and exits with 0 or 1.
    /// A watchdog quits with FAIL after 120 s. The screenshots are desktop pixels: they show the game only when its
    /// window is in front (Tools/marvis-web/test/Run-HandoffTest.ps1 starts it that way).
    /// </summary>
    public sealed class WebPlannerTest : MonoBehaviour
    {
        const float WatchdogSeconds = 120f;
        const float LivePageWait = 40f, LocalPageWait = 25f;   // seconds given to the page to load

        public static bool Requested
        {
            get { return Arg("-marvisWebTest") != null; }
        }

        sealed class Reply
        {
            public int Status;          // 0 when the request itself failed
            public string Text = "";
        }

        string dir;
        readonly StringBuilder log = new StringBuilder();
        int failures;
        float startedAt;
        bool finished;
        Reply last;

        static float Now
        {
            get { return Time.realtimeSinceStartup; }
        }

        IEnumerator Start()
        {
            startedAt = Now;
            string fixturePath = Arg("-marvisWebTest");
            dir = Arg("-marvisWebTestDir") ?? Path.Combine(Directory.GetParent(Application.dataPath).FullName, "webtest");
            Directory.CreateDirectory(dir);
            Note("web planner test started, mission " + fixturePath);

            // The menu builds itself after the scene has loaded; the planner object starts with the game.
            WebPlanner planner = WebPlanner.Instance;
            float until = Now + 30f;
            while (!MarvisMenu.IsOpen && Now < until) yield return null;
            Check(MarvisMenu.IsOpen, "title menu is up");
            Check(planner != null && planner.Running,
                  "web planner is on" + (planner != null
                      ? " (planner site " + (planner.LiveUrl ?? "not used") + ", local copy " +
                        (planner.Port != 0 ? "on port " + planner.Port : "not served") + ")"
                      : ""));
            if (failures > 0)
            {
                Finish();
                yield break;
            }
            bool hasServer = planner.Port != 0;
            string site = "http://127.0.0.1:" + planner.Port;
            string api = site + "/marvis/api/";
            JObject o = null;

            // 1. The local copy's server, over real HTTP.
            if (hasServer)
            {
                yield return Send("GET", api + "hello", null, false);
                o = Json(last);
                Check(last.Status == 200 && o != null && (string)o["app"] == "MARVIS" && (int?)o["bridge"] == 1, "GET hello " + Short(last));
                yield return Send("GET", site + "/index.html", null, false);
                Check(last.Status == 200 && last.Text.IndexOf("<html", StringComparison.OrdinalIgnoreCase) >= 0,
                      "GET /index.html (" + last.Status + ", " + last.Text.Length + " chars)");
            }
            else
            {
                Note("INFO no local copy is served: the checks of its API are left out");
            }

            // 2. The viewer and its page: reported, not required here (a slow first start of WebView2 must not fail
            //    the hand-off). With a planner site the page is the site, or the local copy when the site failed.
            until = Now + (planner.LiveUrl != null ? LivePageWait : LocalPageWait);
            while ((planner.Viewer == null || planner.Viewer.Alive && planner.PageUrl == null) && Now < until) yield return null;
            ViewerProcess viewer = planner.Viewer;
            Note("INFO viewer: " + (viewer == null ? "not started"
                                    : planner.PageUrl != null ? "page loaded (" + planner.PageUrl + ")"
                                    : "page NOT loaded (" + viewer.Status + ")"));
            if (planner.PageIsLive)
            {
                until = Now + 10f;   // the page script says hello when the document is ready
                while (planner.HelloCount == 0 && Now < until) yield return null;
            }
            bool live = planner.OnLiveSite;
            Note("mode " + (live ? "live" : "local"));
            if (live)
            {
                Check(planner.PageIsLive, "page shown is the planner site (" + planner.PageUrl + ")");
                Check(planner.HelloCount > 0, "page script answered (hello from " + (planner.HelloUrl ?? "no page") + ")");
            }
            else if (planner.LiveUrl != null)
            {
                Note("INFO the planner site " + planner.LiveUrl + " is not shown: the page is " + (planner.PageUrl ?? "not loaded"));
            }

            // 3. MISSION PLAN opens the web planner.
            Action plan = MarvisMenu.PlanRequested;
            Check(plan != null, "MISSION PLAN is wired");
            if (plan != null) plan();
            until = Now + 8f;
            while ((planner.Viewer == null || !planner.Viewer.Visible) && Now < until) yield return null;
            Check(planner.Viewer != null && planner.Viewer.Visible, "viewer reports shown");
            if (hasServer)
            {
                yield return Send("GET", api + "state", null, false);
                o = Json(last);
                Check(o != null && (bool?)o["planner_visible"] == true, "state says planner_visible true " + Short(last));
            }
            else
            {
                Check(planner.PlannerVisible, "planner is visible");
            }
            // The Controls list leaves out the keys of a plan made in the built-in panel while the web planner replaces it.
            string titles = "";
            bool planKeys = false;
            foreach (KeybindCatalog.Group g in KeybindCatalog.Read())
            {
                titles += (titles.Length > 0 ? ", " : "") + g.Title;
                planKeys |= g.Title == "MISSION PLAN";
            }
            Check(WebPlanner.ReplacesPlanningPanel && !planKeys,
                  "Controls list has no MISSION PLAN group while the web planner replaces the panel (ReplacesPlanningPanel " +
                  WebPlanner.ReplacesPlanningPanel + "; groups: " + titles + ")");
            until = Now + 1.5f;   // let the page paint
            while (Now < until) yield return null;
            Note("INFO foreground with the planner up: " + Foreground(planner));
            Note("INFO screenshot: " + Screenshot(planner.OwnerWindow, Path.Combine(dir, "planner.png")));
            // The page's map starts drawing only when the page is first visible, and its overlays (boundary, route)
            // need a few seconds more: a second picture shows whether they came.
            until = Now + 4f;
            while (Now < until) yield return null;
            Note("INFO screenshot, 4 s later: " + Screenshot(planner.OwnerWindow, Path.Combine(dir, "planner-late.png")));

            // 4. The hand-off: the page hands the mission over, the menu closes, the EVA runs.
            string fixture = null;
            try
            {
                fixture = File.ReadAllText(fixturePath);
            }
            catch (Exception e)
            {
                Check(false, "mission file readable: " + e.Message);
            }
            if (fixture != null)
            {
                if (live)
                {
                    // As "Start EVA in MARVIS" does: the page builds the mission file the way the site does, the page
                    // script takes it before it becomes a download and sends it to the game as a message.
                    string download = new JObject
                    {
                        ["type"] = "test-send",
                        ["name"] = "marvis-test-mission.json",
                        ["text"] = fixture,
                    }.ToString(Newtonsoft.Json.Formatting.None);
                    until = Now + 20f;   // showing the planner asks the site for a newer version: the page may be loading again
                    while (planner.PageReloading && Now < until) yield return null;
                    int accepted = planner.MissionsAccepted, refused = planner.MissionsRefused, hellos = planner.HelloCount;
                    bool sent = planner.Viewer != null && planner.Viewer.Post(download);
                    bool again = false;
                    until = Now + 20f;
                    while (sent && planner.MissionsAccepted == accepted && planner.MissionsRefused == refused && Now < until)
                    {
                        if (!again && planner.HelloCount != hellos && planner.Viewer != null)
                        {
                            // A new document said hello after the request: the request went to the one that left.
                            again = true;
                            Note("INFO the page was loaded again meanwhile: the mission is asked for once more");
                            planner.Viewer.Post(download);
                        }
                        yield return null;
                    }
                    string why = planner.MissionsAccepted > accepted ? ""
                        : !sent ? " (the request could not be sent to the page)"
                        : planner.MissionsRefused > refused ? " (refused: " + planner.LastRefusal + ")"
                        : " (no mission came from the page)";
                    Check(planner.MissionsAccepted > accepted, "mission sent by the page accepted (Start EVA in MARVIS)" + why);
                }
                else if (hasServer)
                {
                    yield return Send("POST", api + "mission", fixture, true);
                    o = Json(last);
                    Check(last.Status == 200 && o != null && (bool?)o["ok"] == true, "POST mission accepted " + Short(last));
                }
                else
                {
                    Check(false, "mission handed over (the planner site is not shown and no local copy is served)");
                }
                until = Now + 10f;
                while ((MarvisMenu.IsOpen || MissionLink.Current == null) && Now < until) yield return null;
                Check(!MarvisMenu.IsOpen, "menu closed after the hand-off");
                Check(MissionLink.Current != null, "mission loaded in the simulator" +
                                                   (MissionLink.Current != null ? " (" + MissionLink.Current.Id + ")" : ""));
                if (hasServer)
                {
                    yield return Send("GET", api + "state", null, false);
                    o = Json(last);
                    Check(o != null && (string)o["eva"] == "running" && (bool?)o["planner_visible"] == false,
                          "state says eva running, planner hidden " + Short(last));
                }
                else
                {
                    Check(!planner.PlannerVisible, "planner hidden after the hand-off");
                }
                until = Now + 2f;   // the menu fades out
                while (Now < until) yield return null;
                Note("INFO foreground after the hand-off: " + Foreground(planner) + "; game focused " + Application.isFocused +
                     ", cursor " + Cursor.lockState);
                Note("INFO screenshot: " + Screenshot(planner.OwnerWindow, Path.Combine(dir, "eva.png")));
            }

            // 5. Refusals of the local copy's API.
            if (hasServer)
            {
                yield return Send("POST", api + "mission", "{\"kind\":\"not a mission\"}", true);
                o = Json(last);
                Check(last.Status == 422 && o != null && (bool?)o["ok"] == false && !string.IsNullOrEmpty((string)o["error"]),
                      "broken mission answered 422 with the reason " + Short(last));
                yield return Send("POST", api + "mission", fixture ?? "{}", false);
                Check(last.Status == 403, "POST without X-Marvis answered 403 " + Short(last));
            }

            Finish();
        }

        void Update()
        {
            if (!finished && Now - startedAt > WatchdogSeconds)
            {
                StopAllCoroutines();
                Check(false, "watchdog: not finished after " + WatchdogSeconds + " s");
                Finish();
            }
        }

        void Check(bool ok, string what)
        {
            if (!ok) failures++;
            Note((ok ? "ok    " : "FAIL  ") + what);
        }

        void Note(string line)
        {
            log.Append(line).Append('\n');
            // The player log also says when, in seconds since the game started.
            Debug.Log("[WebPlanner] test " + Now.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + " s: " + line);
        }

        void Finish()
        {
            if (finished) return;
            finished = true;
            string verdict = failures == 0 ? "PASS" : "FAIL";
            try
            {
                File.WriteAllText(Path.Combine(dir, "result.txt"), verdict + "\n" + log);
            }
            catch (Exception e)
            {
                Debug.LogError("[WebPlanner] test: result.txt not written: " + e.Message);
            }
            Debug.Log("[WebPlanner] test " + verdict + " (" + failures + " failed), output " + dir);
#if UNITY_EDITOR
            UnityEditor.EditorApplication.isPlaying = false;
#else
            Application.Quit(failures == 0 ? 0 : 1);
#endif
        }

        // ---------------------------------------------------------------- HTTP, off the main thread

        // The request runs on a pool thread while the game keeps its frames (POST mission is answered by the main thread).
        IEnumerator Send(string method, string url, string body, bool marvisHeader)
        {
            Task<Reply> task = Task.Run(() => Request(method, url, body, marvisHeader));
            while (!task.IsCompleted) yield return null;
            last = task.Result;
        }

        static Reply Request(string method, string url, string body, bool marvisHeader)
        {
            var reply = new Reply();
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = method;
                req.Proxy = null;
                req.KeepAlive = false;
                req.Timeout = 25000;
                if (marvisHeader) req.Headers["X-Marvis"] = "1";
                if (body != null)
                {
                    byte[] bytes = Encoding.UTF8.GetBytes(body);
                    req.ContentType = "application/json";
                    req.ContentLength = bytes.Length;
                    using (Stream s = req.GetRequestStream()) s.Write(bytes, 0, bytes.Length);
                }
                HttpWebResponse res;
                try
                {
                    res = (HttpWebResponse)req.GetResponse();
                }
                catch (WebException e) when (e.Response is HttpWebResponse)
                {
                    res = (HttpWebResponse)e.Response;   // 4xx and 5xx carry a JSON body too
                }
                using (res)
                using (var reader = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                {
                    reply.Status = (int)res.StatusCode;
                    reply.Text = reader.ReadToEnd();
                }
            }
            catch (Exception e)
            {
                reply.Text = e.Message;
            }
            return reply;
        }

        static JObject Json(Reply reply)
        {
            try
            {
                return reply.Status != 0 ? JObject.Parse(reply.Text) : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        static string Short(Reply reply)
        {
            string text = reply.Text.Replace('\n', ' ').Replace('\r', ' ');
            return "(" + reply.Status + " " + (text.Length > 200 ? text.Substring(0, 200) + "..." : text) + ")";
        }

        // ---------------------------------------------------------------- screenshot

        // Who is in front on the desktop: the screenshots show the game only when it or its viewer is.
        static string Foreground(WebPlanner planner)
        {
            Win32.GetWindowThreadProcessId(Win32.GetForegroundWindow(), out uint pid);
            if (planner.Viewer != null && pid == (uint)planner.Viewer.ProcessId) return "the viewer";
            return pid == (uint)System.Diagnostics.Process.GetCurrentProcess().Id
                ? "the game window"
                : "another application (the screenshots show what covers the game)";
        }

        // The desktop pixels where the game window's client area is, viewer included, as a PNG. Returns what happened.
        static string Screenshot(IntPtr window, string path)
        {
            if (!Win32.ClientRectOnScreen(window, out int x, out int y, out int width, out int height))
            {
                return "skipped (no game window)";
            }
            IntPtr screen = Win32.GetDC(IntPtr.Zero);
            IntPtr memory = Win32.CreateCompatibleDC(screen);
            IntPtr bitmap = Win32.CreateCompatibleBitmap(screen, width, height);
            IntPtr old = Win32.SelectObject(memory, bitmap);
            bool ok = Win32.BitBlt(memory, 0, 0, width, height, screen, x, y, Win32.SrcCopy);
            Win32.SelectObject(memory, old);
            var pixels = new byte[width * height * 4];
            var info = new Win32.BitmapInfoHeader { Size = 40, Width = width, Height = height, Planes = 1, BitCount = 32 };
            // Positive height = bottom row first, 32-bit BGRA: the layout of a Unity BGRA32 texture.
            ok = ok && Win32.GetDIBits(memory, bitmap, 0, (uint)height, pixels, ref info, 0) == height;
            Win32.DeleteObject(bitmap);
            Win32.DeleteDC(memory);
            Win32.ReleaseDC(IntPtr.Zero, screen);
            if (!ok)
            {
                return "failed (the screen could not be copied)";
            }
            for (int i = 3; i < pixels.Length; i += 4) pixels[i] = 255;   // GDI leaves alpha at 0
            var texture = new Texture2D(width, height, TextureFormat.BGRA32, false);
            try
            {
                texture.LoadRawTextureData(pixels);
                File.WriteAllBytes(path, texture.EncodeToPNG());
            }
            catch (Exception e)
            {
                return "failed (" + e.Message + ")";
            }
            finally
            {
                Destroy(texture);
            }
            return path + " (" + width + " x " + height + ")";
        }

        static string Arg(string name)
        {
            string[] args = Environment.GetCommandLineArgs();
            for (int i = 0; i + 1 < args.Length; i++)
                if (args[i] == name) return args[i + 1];
            return null;
        }
    }
}
#endif
