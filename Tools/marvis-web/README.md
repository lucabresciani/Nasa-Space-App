# Tools/marvis-web: the web planner inside MARVIS

MARVIS shows the HOMELINE web app (the mission planner) inside the game window. The game serves the
built web app on `http://127.0.0.1:47815/` and a helper exe, `MarvisWeb.exe`, shows the page in a
window owned by the game window. This folder holds everything about that which is not Unity code.
The Unity side and its reference (API, switches, fallback, viewer protocol) are in
`Assets/Mars/Scripts/Homeline/Web/` (see the README there) and `Assets/Mars/Editor/Homeline/WebEmbedBuild.cs`.

## What is here

| Path | What it is |
| --- | --- |
| `viewer/` | source of `MarvisWeb.exe` (.NET Framework 4.8, WinForms + WebView2): `Program.cs`, `MarvisWeb.csproj`, `app.manifest` |
| `viewer/dist/` | the five files that ship (`MarvisWeb.exe`, its `.config`, three WebView2 dlls). Committed; the game build copies them to `MarvisWeb/` next to `MARVIS.exe`, the editor uses them in place |
| `Update-Web.ps1` | brings a new version of the web app into the project (below) |
| `web-patch/marvis-embed-newdesign.patch` | the web side used now: the Mission Planer page and the MARVIS bridge on top of the web team's new design (HOMELINE repository, branch `main`, commit `2940436`); written by `Update-Web.ps1`, apply with `git apply` |
| `web-patch/marvis-embed.patch` | the same bridge for the previous layout (on top of commit `36bc6cc`, branch `claude/unity-link-web-fixes`); kept for the branch `web-app-merge-not-final` |
| `mock/marvis-mock.mjs` | a stand-in for the game side, so the web team can test the page without Unity: `node mock/marvis-mock.mjs --root <built web app>`. It serves the app and `/marvis/api/`; its test-only controls are under `/marvis/mock/`. Its EVA logs are synthetic |
| `fixtures/` | missions for tests (`mission_sample.json`, `mission_sample_storm.json`, `mission_sample_newdesign.json`) and reference screenshots of the planner |
| `test/Run-HandoffTest.ps1` | the hand-off test of a built game (below) |
| `test/Test-MarvisWeb.ps1` | tests the viewer alone, against a dummy owner window and a local static server |

The built web app itself is not here: it lives in `HomelineData/web` of the project (not in git) and
the game build copies it to `MarvisPlanner/` next to `MARVIS.exe`. The game accepts a folder as the web
app only when it has `index.html`, an `assets` folder and the marker file `marvis-bridge.json`.

## First time on another machine

The repository does not contain the built web app (about 280 MB), so MISSION PLAN opens the built-in
planning panel until it is put in place:

1. Get the project's planner data as for the rest of the project (`HomelineData/` in the project root:
   see `Docs/homeline/HANDOFF.md`).
2. Build the web app with the bridge and copy it in (`<project>` is this repository's folder):

```
git clone https://github.com/LuxKaiwalker/home-line.git
cd home-line
git checkout 2940436
git apply <project>\Tools\marvis-web\web-patch\marvis-embed-newdesign.patch
cd web
npm ci
node scripts/build-marvis.mjs
robocopy dist <project>\HomelineData\web /MIR
```

   `build-marvis.mjs` builds the site, writes MARVIS where the bundled text says HOMELINE in capitals
   (the product name shown to the user; the lower-case contract names stay) and checks the result.
3. Open the project in Unity and press Play, or build the game (`HomelineBuild.Win64`, output
   `Builds\MARVIS`). In the editor the planner is a centred window over the editor; in the built game
   it covers the game window.

No server is needed: the Mission Planer page computes the route in the browser. The web team's
backend route editing is not switched on in this build.

## Build the viewer

Needs the .NET SDK (the build downloads the WebView2 package from NuGet the first time).

```
cd Tools\marvis-web\viewer
dotnet build -c Release
```

A Release build rewrites `viewer\dist`. Commit `dist` with the source change; `bin` and `obj` are ignored.
Then `test\Test-MarvisWeb.ps1` checks the new exe (it shows a small window for about half a minute).

## Update the web app

When the web team publishes a new version, from the project root:

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

It starts a built game with `-marvisWebTest`: the game opens the planner through MISSION PLAN, posts
a mission as the page does, checks that the EVA starts, and exits.

```
powershell -NoProfile -ExecutionPolicy Bypass -File Tools\marvis-web\test\Run-HandoffTest.ps1 [-Windowed] [-Exe <MARVIS.exe>]
```

The default exe is `Builds\MARVIS\MARVIS.exe`; `-Windowed` uses a 1280 x 720 window instead of the
delivery mode (borderless full screen). The game takes the keyboard for about 20 seconds. The script
waits while another game is running and gives up after four minutes (exit code 2, not started).
Exit code 0 = PASS, anything else = FAIL. The output is in `webtest` next to the exe: `result.txt`
(first line PASS or FAIL, then one line per check), `planner.png`, `planner-late.png` and `eva.png`.
