# MARVIS

A first-person Mars EVA simulator for Windows, with its mission planner in the same window.
NASA Space Apps Challenge 2026, challenge *Interplanetary Survival Guide: Martian Map*.

You plan a route on a map of lower Mount Sharp (Gale crater), send it to the simulator, and walk it with the
planned oxygen and margin on the helmet. Along the way you scan rocks and read what Curiosity measured there.
The terrain, the rock chemistry, the weather statistics and the night sky come from NASA data; the crew, the
EVA and the suit are simulated.

## Try it (Windows)

1. Download the Windows build from the [Releases page](https://github.com/lucabresciani/Nasa-Space-App/releases):
   one zip of about 430 MB (about 750 MB unzipped).
2. Unzip the whole folder, then run `MARVIS.exe`. Windows 10 or 11, 64-bit, a graphics card with DirectX 11 or 12.
   The app is not signed: if "Windows protected your PC" appears, choose **More info**, then **Run anyway**.
3. Use a PC that is online. The planner is the live site, shown inside the MARVIS window through the
   Microsoft Edge WebView2 Runtime (part of Windows 11 and of an up-to-date Windows 10). Offline, MARVIS shows
   the copy of the planner that ships in the zip.

The user guide is `README.md` inside the zip, the same text as [Docs/homeline/USER_GUIDE.md](Docs/homeline/USER_GUIDE.md).

## The two parts

| Part | Where |
| --- | --- |
| Simulator (Unity 6, this repository) | https://github.com/lucabresciani/Nasa-Space-App |
| Mission planner (web app) | https://github.com/LuxKaiwalker/home-line, live at https://marvis.vxliu.com |

HOMELINE is the working name of the planner; some folders and file names still carry it.

## Branches

- `V1`: the delivered version. The Windows build on the Releases page was made from it.
- `main`: the simulator without the planner window.

## What is in this repository

| Path | Content |
| --- | --- |
| `Assets/Mars` | The simulator: terrain, rock science, weather, night sky, helmet HUD, menu, mission hand-over |
| `WebPlanner` | A copy of the planner with the bridge to MARVIS; it is the offline copy that ships with the game |
| `Tools` | Scripts that build the terrain, the map image and the sky from the source data, and the planner viewer (`Tools/marvis-web`) |
| `Docs/homeline` | User guide and hand-over notes |
| `DATA_SOURCES.md` | The data sources, what is measured and what is derived |
| `THIRD-PARTY-NOTICES.txt` | Licences of the third-party software and fonts that ship with the game |

## Build from source

Needs Unity 6000.6.7f1, Git with Git LFS, and Node.js for the planner copy. Clone with git: GitHub's
"Download ZIP" does not contain the LFS files (terrain, textures, models). Run these lines in a Command Prompt
(cmd.exe), not in PowerShell:

```
git lfs install
git clone -b V1 https://github.com/lucabresciani/Nasa-Space-App.git
cd Nasa-Space-App
powershell -NoProfile -ExecutionPolicy Bypass -File Tools\marvis-web\Build-Web.ps1
"C:\Program Files\Unity\Hub\Editor\6000.6.7f1\Editor\Unity.exe" -batchmode -quit -projectPath "%CD%" -logFile build.log -executeMethod NasaSpaceApp.Homeline.EditorTools.HomelineBuild.Win64
```

`Build-Web.ps1` builds the planner copy into `HomelineData` (not in git). The game is written to `Builds\MARVIS`.
Build this way, or in the editor with **Tools > Mars > HOMELINE > Build Windows Player**: this build sets the
window mode the planner needs, makes sure the night-sky shaders are included and copies `HomelineData` and the user
guide next to the exe; the plain Build dialog does not. A build from source has no
`HomelineData\router` (made by `Tools\homeline-data\make_router_grid.py`), so edited plans cannot be re-routed in
the built-in planning screen. More detail is in [Tools/marvis-web/README.md](Tools/marvis-web/README.md).

## Data and credits

Rock chemistry and mineralogy: Curiosity APXS from the NASA Planetary Data System; CheMin and ChemCam values from
the published papers named in the source list. Terrain: elevation model and orthoimage of the Curiosity landing
region from the USGS Astrogeology Science Center, from MRO HiRISE images; the distant backdrop from MRO CTX and
the USGS MOLA-HRSC blend. Weather: Curiosity REMS and Mastcam. Night sky: Bright Star Catalogue through NASA
HEASARC, NASA JPL Solar System Dynamics, NASA NAIF. The source list, with what is not NASA data and what is
derived, is in [DATA_SOURCES.md](DATA_SOURCES.md) and on the CREDITS screen of the game. The rock dataset was
compiled with AI assistance and cross-checked against the original PDS tables.

Use of NASA data and imagery does not imply NASA endorsement of this project.

## Team

Vincent Xigu Liu, Jan Oliver Schlueter, Charlie Verleysen, Luca Bresciani, Alessandro Battaglini, Jonas Balukonis.
