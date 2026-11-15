# Web planner inside MARVIS

MARVIS shows the mission planner web app inside its own window, takes the planned mission from it,
runs the EVA, and hands the EVA log back to the page for the debrief. Windows only.

The page is the **live planner site** (`https://homeline.vxliu.com/`, made by the web team). When
the site changes, the game shows the new version: nothing in Unity has to be rebuilt. A copy of the
planner shipped with the game is the fallback when the site cannot be reached.

## Where the page comes from

Order: live site -> local copy -> built-in planning panel.

1. **Live site.** Its address is, in this order: the switch `-plannerUrl <value>`, the environment
   variable `MARVIS_PLANNER_URL`, the file `planner-url.txt` next to `MarvisWeb.exe` (editor:
   `Tools/marvis-web/live/planner-url.txt`), else `https://homeline.vxliu.com/`. In the file, lines
   starting with `#` are comments and the first other non-empty line is the address. The word
   `local` means "no site, only the local copy". A value that is not an http or https address is
   logged and treated as `local`. To point MARVIS at a web developer's own machine, put for example
   `http://localhost:5173/` in `planner-url.txt`.
2. **Page script.** The site has no MARVIS code. The viewer runs `marvis-inject.js` (next to
   `MarvisWeb.exe`; editor: `Tools/marvis-web/live/`) in every page before the page's own scripts.
   It adds the MARVIS menu button, the EVA debrief panel and the toasts, and talks to the game.
   Without that file the site is not used (its page would have no way back to the menu).
3. **Local copy.** `WebServer` serves the built web app with the MARVIS bridge on
   `http://127.0.0.1:47815/` (47816..47819 if busy; loopback only, so no firewall prompt), with a
   JSON API under `/marvis/api/`. It is started whenever a valid web root is found. The viewer is
   sent there when the site does not load, at the start or at a later reload (`Player.log`: "the
   planner site could not be reached"), and stays there for the rest of that run, so a route being
   drawn in the copy is not dropped; the next start of the game tries the site first again. With no
   site configured the copy is the planner, as before.
4. **Built-in panel.** With no viewer, or with neither a site nor a local copy, MISSION PLAN keeps
   opening the built-in planning panel (see "Fallback").

## How it works

1. `ViewerProcess` starts `MarvisWeb.exe` (WebView2) hidden at boot, on the live site when there is
   one. Its borderless window is owned by the game window and covers its client area, so to the
   user it is one window. The page loads at once, so the first show is warm.
2. `WebPlanner` puts itself in `MarvisMenu.PlanRequested`. **MISSION PLAN** (title or pause) shows
   the viewer. On the live site the page script is also asked to check for a newer version of the
   site. While the page is up, uGUI navigation is off (`EventSystem.sendNavigationEvents`): the
   game runs in the background there, and a controller would otherwise move and press the menu
   entries hidden underneath. Alt+F4 on the page closes the game, as it does on the game window.
3. **Send to simulator** on the site downloads a mission file (`"kind": "homeline_mission"`). The
   viewer catches the download and reports the file; `WebPlanner` loads it with
   `MissionLink.LoadJson`, hides the viewer, the menu closes and the EVA starts on the pad. A
   mission that is refused is shown by the page as an error. The local copy posts the mission to
   the API instead; the rest is the same.
4. The **MARVIS menu button** of the page script, or **F10**, hides the planner: the menu is back.
   F10 is handled by the viewer itself, so it works even when the page script failed.
5. When `EvaLogger` writes a log of the current mission, the live page gets it as a message and
   shows the debrief; the local copy reads it from the API. Six seconds after a complete EVA the
   pause menu opens with the planner over it.

## Folders next to the exe

```
MARVIS.exe
MarvisWeb/       MarvisWeb.exe and its WebView2 dlls, marvis-inject.js, planner-url.txt
MarvisPlanner/   the local copy: index.html, assets/, data/, marvis-bridge.json
HomelineData/    planner data of the built-in panel (not used by the web planner)
```

A folder is a valid web root when it has `index.html`, an `assets` folder and the marker file
`marvis-bridge.json` (`{"bridge":1}`, from `web/public/` of the web app): the marker says that the
build contains the MARVIS bridge. `WebPlanner.IsValidWebRoot` is the one rule, used by the game
and by the build step.

`Editor/Homeline/WebEmbedBuild.cs` fills the first two after every Windows build, from
`Tools/marvis-web/viewer/dist`, `Tools/marvis-web/live` and `HomelineData/web` of the project. A
missing source is a warning (the old output folder is removed); a copy that fails, for example a
file in use in the output, fails the build. In the editor the same project folders are used
directly, and the viewer is a centred window of at most 1280 x 800 over the editor. WebView2 keeps
its profile in `{persistentDataPath}/WebView2`. Messages for the page are written to
`{temporaryCachePath}/marvis-post` and deleted by the viewer.

## Switches

| Switch | Effect |
| --- | --- |
| `-plannerUrl <url>` | address of the planner site for this run; `local` = only the local copy |
| `-noWebPlanner` | no server, no viewer; MISSION PLAN opens the built-in panel |
| `-homelineSelfTest` | same (the self-test drives the built-in panel); batch mode too |
| `-marvisWebTest <mission.json>` | unattended hand-off test (`WebPlannerTest`): writes `result.txt` (first line PASS or FAIL, a line `mode live` or `mode local`), `planner.png`, `planner-late.png` (4 s later) and `eva.png`, exits with 0 or 1. Run it with `Tools/marvis-web/test/Run-HandoffTest.ps1`, which puts the game window in front so the screenshots show it |
| `-marvisWebTestDir <dir>` | output folder of the test (default `webtest` next to the exe) |
| env `MARVIS_PLANNER_URL` | address of the planner site (after `-plannerUrl`, before `planner-url.txt`) |
| env `MARVIS_WEB` | web root to serve as the local copy instead of `MarvisPlanner` |
| env `MARVIS_WEBVIEW` | path of `MarvisWeb.exe` (the page script and `planner-url.txt` are looked for next to it) |

## Fallback

One `[WebPlanner]` line in `Player.log` says what was found and why something is not used.
MISSION PLAN keeps opening the built-in planning panel when:

- there is no `MarvisWeb.exe`, or neither a planner site nor a local copy (no valid web root, or
  no free port in 47815..47819), or the game window was not found;
- the planner site cannot be reached and there is no local copy;
- the viewer exits or reports `fatal` (exit code 3 = no WebView2 runtime on the machine), or has
  not loaded a page 20 s after its start. The next MISSION PLAN opens the built-in panel and
  starts the viewer once more; if that one stays up, the web planner is back from the following
  request. A page that is only late (the game loads its scene at the same time) is used as soon
  as it has loaded: `Player.log` has `viewer ready` and `page loaded` with the seconds each took.

`WebPlanner.ReplacesPlanningPanel` is true exactly while MISSION PLAN opens the web planner. The
Controls list (`Menu/KeybindCatalog.cs`) leaves its MISSION PLAN group (V, T, [ ], R) out while it
is true: those keys act only on a plan made in the built-in panel. The list is read again every
time the Controls page is shown, so it follows a fallback.

## Messages between the page script and the game

Page to game, `window.chrome.webview.postMessage(object)`:

| Message | Meaning |
| --- | --- |
| `{"type":"hello","inject":1,"url":"...","bridge":true\|false}` | once per document. `bridge` true = the page is the game's own local copy (`/marvis/api/hello` answers there): it has its own controls and debrief, so the script adds neither |
| `{"type":"close"}` | the MARVIS menu button: the planner is hidden |
| `{"type":"reloading","reason":"update"}` | the page loads itself again (a newer version of the site) |

Game to page, `window.chrome.webview.addEventListener('message', ...)`:

| Message | Meaning |
| --- | --- |
| `{"type":"eva-log","eva":"complete"\|"ended","log":{...}}` | the EVA log of the current mission: show the debrief. Sent when the log is written, and again to a page of the site that says hello later |
| `{"type":"mission-error","error":"..."}` | the game refused the mission |
| `{"type":"toast","text":"...","level":"info"\|"error"}` | a toast |
| `{"type":"saved","name":"..."}` | from the viewer: a download was saved to the Downloads folder |
| `{"type":"blocked","url":"..."}` | from the viewer: a link to another site was not opened |
| `{"type":"check-update"}` | check now for a newer version of the site |
| `{"type":"test-download","name":"...","text":"..."}` | download this text as a file, as the site's own button does (the hand-off test) |

## API of the local copy (same origin as the page, JSON, `Cache-Control: no-store`)

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
thread (503 after 10 s). Files under `assets/` (content hash in the name) are sent with
`max-age=3600`, everything else with `no-cache`.

## Viewer protocol (`MarvisWeb.exe`)

Arguments: `--owner <HWND> --url <url> --udf <folder> [--bg #RRGGBB] [--dev] [--bounds x,y,w,h]
[--inject <file>]`. `--inject` is a UTF-8 JavaScript file run in every document before the page's
own scripts (`warn inject-not-read` when it cannot be read).

One line per command on stdin:

| Command | Effect |
| --- | --- |
| `show`, `hide`, `focus` | the window |
| `nav <url>` | load another address; its origin is allowed from then on |
| `reload` | load the current page again |
| `post <file>` | deliver the JSON document in the UTF-8 file to the page, then delete the file (`warn post-failed <reason>` otherwise) |
| `bounds <x> <y> <w> <h>`, `autobounds` | fixed bounds, or follow the owner window |
| `eval <js>` | run one line of JavaScript in the page |
| `quit` | exit |

One line per event on stdout:

| Event | Meaning |
| --- | --- |
| `ready` | WebView2 is initialised |
| `loaded <url>` | a page has loaded |
| `loadfail <status>` | the page could not be loaded (not printed for a navigation the viewer cancelled itself, nor for one that became a download) |
| `shown`, `hidden` | the window |
| `mission <path>` | a finished download whose text contains `homeline_mission`; the game reads and deletes the file |
| `saved <path>` | any other finished download, moved to the user's Downloads folder; the page gets `{"type":"saved"}` |
| `downloadfail <reason>` | a download failed |
| `message <json>` | the page called `window.chrome.webview.postMessage`; F10 in the page prints `message {"type":"close"}` |
| `blocked <url>` | a navigation of the page to another origin was cancelled; the page gets `{"type":"blocked"}` |
| `warn <text>` | a problem that is not fatal |
| `fatal <reason>`, `exit` | the viewer ends |

Downloads never show the browser's own download UI; they go to `<udf>\marvis-downloads`. Allowed
origins are the one of `--url`, those of every later `nav`, and `about:blank`. The viewer exits
when the owner window is gone or stdin closes. A request to close its window (Alt+F4) is passed on
to the owner window; with fixed bounds (the editor) it closes only the viewer. A lost page (render
process) is loaded again once; the second time the viewer ends with `fatal render-process-exited`.
Its source and build are in `Tools/marvis-web/`.
