# Tools/marvis-web: the web planner inside MARVIS

MARVIS shows the mission planner web app inside the game window: a helper exe, `MarvisWeb.exe`,
shows the page in a window owned by the game window. This folder holds everything about that which
is not Unity code. The Unity side and its reference (messages, API, switches, fallback, viewer
protocol) are in `Assets/Mars/Scripts/Homeline/Web/` (see the README there) and
`Assets/Mars/Editor/Homeline/WebEmbedBuild.cs`.

## Live site first

The page is the web team's live site, `https://homeline.vxliu.com/`. When the site changes, the
game shows the new version: nothing in Unity, and nothing here, has to be rebuilt.

- `live/planner-url.txt` holds the address. Lines starting with `#` are comments, the first other
  non-empty line is the address, and the word `local` means "no site, only the local copy". To
  point MARVIS at a web developer's own machine put for example `http://localhost:5173/` there
  (in a built game the file is `MarvisWeb\planner-url.txt`). The switch `-plannerUrl` and the
  environment variable `MARVIS_PLANNER_URL` come before the file.
- `live/marvis-inject.js` is the page script. The site has no MARVIS code, so the viewer runs this
  script in every page: it adds the MARVIS menu button, the EVA debrief panel and the toasts.
  Without it the site is not used.
- **Send to simulator** on the site downloads a mission file; the viewer catches the download,
  the game loads the mission and the EVA starts.
- The **MARVIS menu button**, or **F10**, goes back to the game menu.
- Fallback order: live site -> local copy -> built-in planning panel. The local copy is the web
  app built from `WebPlanner/` (below) and served by the game on `http://127.0.0.1:47815/`; it is
  used when the site cannot be reached, and the site is tried again later.

## What is here

| Path | What it is |
| --- | --- |
| `live/` | `planner-url.txt` (the address of the planner site) and `marvis-inject.js` (the page script). The game build copies both to `MarvisWeb/` next to `MARVIS.exe`, the editor uses them in place |
| `viewer/` | source of `MarvisWeb.exe` (.NET Framework 4.8, WinForms + WebView2): `Program.cs`, `MarvisWeb.csproj`, `app.manifest` |
| `viewer/dist/` | the five files that ship (`MarvisWeb.exe`, its `.config`, three WebView2 dlls). Committed; the game build copies them to `MarvisWeb/` next to `MARVIS.exe`, the editor uses them in place |
| `Build-Web.ps1` | builds the web planner kept in `WebPlanner/` and puts it where the game serves it (see "First time on another machine") |
| `Update-Web.ps1` | merges a newer version of the web team's repository, in a separate checkout of it (below) |
| `web-patch/marvis-embed-newdesign.patch` | the web side used now: the Mission Planer page and the MARVIS bridge on top of the web team's new design (HOMELINE repository, branch `main`, commit `2940436`); written by `Update-Web.ps1`, apply with `git apply` |
| `web-patch/marvis-embed.patch` | the same bridge for the previous layout (on top of commit `36bc6cc`, branch `claude/unity-link-web-fixes`); kept for the branch `web-app-merge-not-final` |
| `mock/marvis-mock.mjs` | a stand-in for the game side, so the web team can test the page without Unity: `node mock/marvis-mock.mjs --root <built web app>`. It serves the app and `/marvis/api/`; its test-only controls are under `/marvis/mock/`. Its EVA logs are synthetic |
| `fixtures/` | missions for tests (`mission_sample.json`, `mission_sample_storm.json`, `mission_sample_newdesign.json`) and reference screenshots of the planner |
| `test/Run-HandoffTest.ps1` | the hand-off test of a built game (below) |
| `test/Test-MarvisWeb.ps1` | tests the viewer alone, against a dummy owner window and a local static server |

The built local copy is not here: it lives in `HomelineData/web` of the project (not in git) and
the game build copies it to `MarvisPlanner/` next to `MARVIS.exe`. The game accepts a folder as the
local copy only when it has `index.html`, an `assets` folder and the marker file `marvis-bridge.json`.

## The local copy: first time on another machine

The live site needs nothing built. The steps below make the local copy, the fallback for when the
site cannot be reached. Its sources and map data are in `WebPlanner/` at the repository root: a copy
of the web team's repository (HOMELINE, branch `main`, commit `2940436`) with the Mission Planer page
and the MARVIS bridge added. The built copy is not committed (it is made from `WebPlanner/` in
seconds); until it is built there is no fallback, and without the site MISSION PLAN opens the
built-in planning panel.

1. Clone the branch `web-embed` (Git LFS is needed for the Unity assets, as for the rest of the project).
2. Build the web planner (needs Node.js), from the project root:

```
powershell -NoProfile -ExecutionPolicy Bypass -File Tools\marvis-web\Build-Web.ps1
```

   It installs the web packages the first time, builds `WebPlanner\web`, writes MARVIS where the product
   name is shown (the lower-case contract names such as `homeline_mission` stay), and fills
   `HomelineData\web` (the site the game serves) and `HomelineData\bundle` (the planner's official bundle).
3. Open the project in Unity and press Play, or build the game (`HomelineBuild.Win64`, output
   `Builds\MARVIS`). In the editor the planner is a centred window over the editor; in the built game
   it covers the game window.

To change the local copy: edit under `WebPlanner\web\src` (the Mission Planer page is
`views\mission.tsx` and `mission\`, the bridge to the game is `marvis\bridge.ts`), run `Build-Web.ps1`
again, and press Play. With `-Build <folder of a built game>` the script also replaces the site inside an
already built game, so no Unity build is needed for a web-only change.

No server is needed: the Mission Planer page computes the route in the browser. The web team's
backend route editing is not switched on in this build. `HomelineData\router` (used only by the
built-in planning panel to re-route edited plans) is not in the repository; `Tools\homeline-data\make_router_grid.py` makes it.

## Build the viewer

Needs the .NET SDK (the build downloads the WebView2 package from NuGet the first time).

```
cd Tools\marvis-web\viewer
dotnet build -c Release
```

A Release build rewrites `viewer\dist`. Commit `dist` with the source change; `bin` and `obj` are ignored.
Then `test\Test-MarvisWeb.ps1` checks the new exe (it shows a small window for about half a minute).

## Take a newer version from the web team into the local copy

The live site needs none of this. `WebPlanner/` is a copy without the web team's git history, so merging their later work is done in a
separate checkout of their repository that carries the same changes as a branch, and the result is
copied back over `WebPlanner/` (that last copy is by hand for now). In that checkout, from the project root:

```
powershell -NoProfile -ExecutionPolicy Bypass -File Tools\marvis-web\Update-Web.ps1 -Ref main
```

`-Ref` is a branch name or a commit of the HOMELINE repository's origin. The script works in the web
worktree (`-WebRepo`, default `C:\Users\bresc\home-line-marvis`, branch `marvis-main`: the new design;
the previous layout is in `C:\Users\bresc\home-line-martis`), which must be on the branch that carries
the MARVIS bridge, with nothing uncommitted. It prints every
step with its duration and stops at the first one that fails:

1. checks the web worktree (branch, bridge committed, nothing uncommitted)
2. `git fetch origin <Ref>`
3. `git merge --no-edit FETCH_HEAD`
4. checks that `web\public\marvis-bridge.json` is still there
5. `npx tsc --noEmit` (errors are a warning only)
6. `node scripts/build-marvis.mjs` when the worktree has it (build, visible name MARVIS, checks), otherwise `npx vite build`
7. mirrors `web\dist` into `HomelineData\web` of the project (`robocopy /MIR`)
8. rewrites `web-patch\marvis-embed-newdesign.patch` (`marvis-embed.patch` for the previous layout) from `git diff FETCH_HEAD HEAD`
9. with `-Build <folder of a built game>`: mirrors `web\dist` into `<Build>\MarvisPlanner`
10. with `-Build`, unless `-SkipTest`: runs the hand-off test on `<Build>\MARVIS.exe` and reports PASS or FAIL

On a merge conflict it names the files and stops. Resolve them in the web worktree (`git add`,
`git commit --no-edit`) and run the script again with `-Continue`, which skips the fetch and the merge.
`-WhatIf` runs the checks and only shows the steps that would change something.

Afterwards: commit the new patch file here, and build the game (or pass `-Build`)
so that the exe has the new web app.

## Run the hand-off test

It starts a built game with `-marvisWebTest`: the game opens the planner through MISSION PLAN, hands
a mission over as the page does, checks that the EVA starts, and exits. On the live site
(`mode live` in `result.txt`) the page script is asked to download the mission file, as the site's
"Send to simulator" does, and the viewer catches it. On the local copy (`mode local`) the mission
is posted to the game's API. The API of the local copy is checked whenever the copy is served.

```
powershell -NoProfile -ExecutionPolicy Bypass -File Tools\marvis-web\test\Run-HandoffTest.ps1 [-Windowed] [-Exe <MARVIS.exe>] [-PlannerUrl <url>|local]
```

The default exe is `Builds\MARVIS\MARVIS.exe`; `-Windowed` uses a 1280 x 720 window instead of the
delivery mode (borderless full screen). `-PlannerUrl` is passed to the game as `-plannerUrl`:
another address for the site, or `local` to test the fallback. The game takes the keyboard while
the test runs (the live page gets up to 40 s to load). The script waits while another game is
running and gives up after four minutes (exit code 2, not started).
Exit code 0 = PASS, anything else = FAIL. The output is in `webtest` next to the exe: `result.txt`
(first line PASS or FAIL, then one line per check and the mode), `planner.png`, `planner-late.png`
and `eva.png`.
