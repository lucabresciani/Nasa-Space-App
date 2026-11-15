# Web planner inside MARVIS

MARVIS shows the HOMELINE web app (the Mission Planer, `#/mission`) inside its own window, takes the
planned mission from it, runs the EVA, and hands the EVA log back to the page for the debrief.
Windows only. Nothing is loaded from the network: the game serves the built web app itself.

## How it works

1. `WebServer` listens on `http://127.0.0.1:47815/` (47816..47819 if busy; loopback only, so no
   firewall prompt). It serves the web app as static files and a JSON API under `/marvis/api/`.
   Files under `assets/` (content hash in the name) are sent with `max-age=3600`, everything else
   with `no-cache`: the viewer's cache outlives the game and `data/` keeps its file names.
2. `ViewerProcess` starts `MarvisWeb.exe` (WebView2) hidden at boot. Its borderless window is owned
   by the game window and covers its client area, so to the user it is one window. The page loads
   at once, so the first show is warm.
3. `WebPlanner` puts itself in `MarvisMenu.PlanRequested`. **MISSION PLAN** (title or pause) shows
   the viewer. The page posts the mission; it is loaded with `MissionLink.LoadJson`, the viewer is
   hidden, the menu closes and the EVA starts on the pad. While the page is up, uGUI navigation is
   off (`EventSystem.sendNavigationEvents`): the game runs in the background there, and a
   controller would otherwise move and press the menu entries hidden underneath. Alt+F4 on the
   page closes the game, as it does on the game window.
4. When `EvaLogger` writes a log, its text is served at `eva-log`. Six seconds after a complete
   EVA the pause menu opens with the planner over it, on the Mission Planer page.

## Folders next to the exe

```
MARVIS.exe
MarvisPlanner/     the built web app: index.html, assets/, data/, marvis-bridge.json
MarvisWeb/       MarvisWeb.exe and its WebView2 dlls
HomelineData/    planner data of the built-in panel (not used by the web planner)
```

A folder is a valid web root when it has `index.html`, an `assets` folder and the marker file
`marvis-bridge.json` (`{"bridge":1}`, from `web/public/` of the web app): the marker says that the
build contains the MARVIS bridge. `WebPlanner.IsValidWebRoot` is the one rule, used by the game
and by the build step.

`Editor/Homeline/WebEmbedBuild.cs` fills the first two after every Windows build, from
`HomelineData/web` and `Tools/marvis-web/viewer/dist` of the project. A missing source is a warning
(the old output folder is removed); a copy that fails, for example a file in use in the output,
fails the build. In the editor the same two
project folders are used directly, and the viewer is a centred window of at most 1280 x 800 over
the editor. WebView2 keeps its profile in `{persistentDataPath}/WebView2`.
`Tools/marvis-web/Update-Web.ps1` brings a new version of the web app into `HomelineData/web`.

## Switches

| Switch | Effect |
| --- | --- |
| `-noWebPlanner` | no server, no viewer; MISSION PLAN opens the built-in panel |
| `-homelineSelfTest` | same (the HOMELINE self-test drives the built-in panel); batch mode too |
| `-marvisWebTest <mission.json>` | unattended hand-off test (`WebPlannerTest`): writes `result.txt` (first line PASS or FAIL), `planner.png`, `planner-late.png` (4 s later) and `eva.png`, exits with 0 or 1. Run it with `Tools/marvis-web/test/Run-HandoffTest.ps1`, which puts the game window in front so the screenshots show it |
| `-marvisWebTestDir <dir>` | output folder of the test (default `webtest` next to the exe) |
| env `MARVIS_WEB` | web root to serve instead of `MarvisPlanner` |
| env `MARVIS_WEBVIEW` | path of `MarvisWeb.exe` |

## Fallback

The web planner is used only when everything is there. Otherwise one `[WebPlanner]` line in
`Player.log` says why, and MISSION PLAN keeps opening the built-in planning panel:

- no valid web root (`index.html`, `assets/`, `marvis-bridge.json`) or no `MarvisWeb.exe`;
- no free port in 47815..47819, or the game window was not found;
- the viewer exits or reports `fatal` (exit code 3 = no WebView2 runtime on the machine), or has
  not loaded the page 20 s after its start. The next MISSION PLAN opens the built-in panel and
  starts the viewer once more; if that one stays up, the web planner is back from the following
  request. A page that is only late (the game loads its scene at the same time) is used as soon
  as it has loaded: `Player.log` has `viewer ready` and `page loaded` with the seconds each took.

`WebPlanner.ReplacesPlanningPanel` is true exactly while MISSION PLAN opens the web planner. The
Controls list (`Menu/KeybindCatalog.cs`) leaves its MISSION PLAN group (V, T, [ ], R) out while it
is true: those keys act only on a plan made in the built-in panel. The list is read again every
time the Controls page is shown, so it follows a fallback.

## API (same origin as the page, JSON, `Cache-Control: no-store`)

| Call | Answer |
| --- | --- |
| `GET /marvis/api/hello` | `{"app":"MARVIS","bridge":1,"version":"..."}` |
| `GET /marvis/api/state` | `{"seq","planner_visible","eva","mission_id","eva_log_seq","last_error"}` |
| `POST /marvis/api/mission` (body: mission.json) | `200 {"ok":true,"mission_id"}`, `422 {"ok":false,"error"}`, `503` when the scene is not ready |
| `GET /marvis/api/eva-log` | the latest `homeline_eva_log` document, or `404 {"ok":false,"error":"no log"}` |
| `POST /marvis/api/close` | `200 {"ok":true}`; the viewer hides, the menu is back |

`eva`: `idle` no mission; `running` a mission is loaded and has no log yet; `complete` / `ended`
the latest log is of the current mission and its `summary.complete` is true / false. `seq` grows
with every change. POST needs the header `X-Marvis: 1`; the API answers 403 without it, and to any
request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>`. Bodies are limited to 4 MB.
`hello`, `state` and `eva-log` are answered at once from a snapshot; the two POSTs wait for the main
thread (503 after 10 s).

## Viewer protocol (`MarvisWeb.exe`)

Arguments: `--owner <HWND> --url <url> --udf <folder> [--bg #RRGGBB] [--dev] [--bounds x,y,w,h]`.
One line per command on stdin: `show`, `hide`, `focus`, `nav <url>`, `bounds <x> <y> <w> <h>`,
`autobounds`, `eval <js>`, `quit`. One line per event on stdout: `ready`, `loaded <url>`,
`loadfail <text>`, `shown`, `hidden`, `fatal <reason>`, `exit`. It exits when the owner window is
gone or stdin closes. A request to close its window (Alt+F4) is passed on to the owner window;
with fixed bounds (the editor) it closes only the viewer. A lost page (render process) is loaded
again once; the second time the viewer ends with `fatal render-process-exited`. Its source and
build are in `Tools/marvis-web/`.
