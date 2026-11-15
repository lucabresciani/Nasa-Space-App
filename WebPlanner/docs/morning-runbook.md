# 🌅 Morning runbook — Sat 14 Nov, 08:15–11:00

> ⏸️ **2026-11-14 14:19 (user, D19):** WS9 position work (F21/F22) and WS10 (X8/X9) are now **optional add-ons**. Start no new sessions on them; merged work stays.

> ⏰ **Goal:** by 10:00 every workstream has an agent session running on the right machine with a named reviewer; by 11:00 G0 is reported and the visual-odometry go/no-go is decided. Nothing below starts before 09:00 except setup checks.

# 1. Machines and how sessions share data

**One pipeline host runs every Python workstream.** The large rasters (elevation, return fields) never go into git, so the agents that produce and consume them must sit on one machine.

| Machine | Runs | Who connects |
| --- | --- | --- |
| **Pipeline host** (strongest laptop: ≥ 16 GB RAM, ≥ 20 GB free) | WS1, WS2, WS3, WS4, WS6, WS9 (Python part), WS10, the bootstrap and dummy sessions | Everyone over SSH (Tailscale), one tmux window per session |
| D's laptop | WS5 web, WS7 HUD (web part) | — |
| R's laptop | WS8 3D (web part) | — |
| N's laptop | Discovery session (09:00–10:30), WS9 web part | — |

- On the pipeline host, all worktrees share one data folder: `~/hl-data/` with `raw/` and `interim/`, linked into every worktree as `data/`.
- Web-facing outputs (small: GeoJSON, JSON, field PNGs, 3D chunks ≤ 30 MB) reach the laptops through git via `make web` → `web/public/data/`.
- Before real data exists, web sessions use `VITE_DATA=dummy`.

# 2. Timeline

| Time | Who | What |
| --- | --- | --- |
| 08:15 | All | Arrive, power, Wi-Fi test, phone hotspot ready; pipeline host online on Tailscale; everyone can SSH in |
| 08:45 | All | 10-min stand-up: role names confirmed (C, S, D, G, R, N), gates G0 11:00 / G1 19:00 / G2 08:00 / freeze 12:00 / submit 21:00 |
| **09:00** | C | Export Notion (spec page + Agent kit, Markdown, with subpages) → pull the existing repo `nasa-space-app` on the pipeline host → start **Session B0 (bootstrap)** in it |
| 09:00 | N | Start **Session D0 (discovery)** on N's laptop |
| 09:00 | G | Read the 2026 PSG/JAG and Resources tab (portal items of the discovery checklist); post changes in the team chat |
| 09:00 | S | Check the IST-2 table for `delta_mass_kg` in `config/variants.yaml`; read the WS1/WS2 briefs |
| 09:00 | D, R | Read briefs; prepare worktrees as soon as the skeleton is pushed |
| ~09:25 | C | Skeleton pushed → everyone clones and creates worktrees (§3) → C starts **Session M0 (dummy data)** |
| ~09:30 | Owners | Launch first-wave sessions: **WS2, WS3, WS4, WS5, WS6, WS9** (they need only the skeleton, configs and contracts) |
| ~10:00 | C | Contracts + dummy data merged; **contracts v1 frozen** (H1) → launch **WS7, WS8** on dummy data |
| ~10:30 | N | `docs/discovery.md` merged → launch **WS1** and **WS10 (probe only)**; tell WS3 and WS4 to switch to real data tasks |
| 11:00 | S, N | **G0 report** (WS1) and **D16 go/no-go** (WS10). Decide D3 from discovery |
| From 11:00 | Reviewers | Check-ins every 2 h in `STATUS.md`; G and N run the 4-hourly audit |

# 3. Starting a session (every workstream)

```bash
# once per machine
git clone git@github.com:<owner>/nasa-space-app.git ~/nasa-space-app   # or `git pull` if already cloned

# per workstream (example WS2), on the pipeline host
cd ~/nasa-space-app
git worktree add ../hl-ws2 -b ws2-engine
cd ../hl-ws2
ln -s ~/hl-data data            # shared data folder (pipeline host only)
uv sync                          # Python sessions
# (web sessions: cd web && npm install && export VITE_DATA=dummy)
export NASA_API_KEY=…            # never committed
tmux new -s ws2
<agent CLI>                      # then paste the launch prompt (§4)
```

Branch names: `ws1-terrain`, `ws2-engine`, `ws3-horizon`, `ws4-conditions`, `ws5-web`, `ws6-provenance`, `ws7-hud`, `ws8-3d`, `ws9-nav`, `ws10-vo`. Only C merges to `main`.

# 4. Session prompts

## B0 — Bootstrap (C, pipeline host, 09:00)

```txt
You are the bootstrap agent for HOMELINE (NASA Space Apps 2026). It is Sat 09:00, H0.
Work in ~/nasa-space-app, the team's EXISTING GitHub repo (already cloned; do not create a
new repo). First run `git status`, `git log --oneline | head -20` and `ls -la`, report what is
already there (default branch, files, visibility if `gh repo view` works), and never delete,
move or overwrite existing files without asking me. Add HOMELINE into this repo.
Input: docs/notion-export/ = Notion Markdown export of
the page "HOMELINE — project proposal & technical specification" and its subpage
"Agent kit — start here" with all subpages.
Do in order, committing after each step:
1. Convert the export into SPEC.md (spec page), AGENTS.md ("Agent kit — start here"),
   briefs/WS1.md … briefs/WS10.md, docs/discovery-checklist.md, docs/dummy.md,
   docs/morning-runbook.md. Keep the text verbatim; fix only Markdown formatting.
2. Copy every YAML block from the "Config values" page verbatim into config/<name>.yaml
   (site, stations, crew, variants, haul, horizon, conditions, hud, nav). Check they parse.
3. Scaffold: pyproject.toml (uv, Python 3.11; deps numpy scipy numba rasterio pyproj shapely
   geopandas scikit-image pillow opencv-python-headless requests pyyaml jsonschema cdasws
   pytest ruff); Makefile with stub targets terrain engine horizons conditions nav web dummy
   test clean all; the folder tree from SPEC §4.3 with empty __init__.py; web/ as a Vite
   vanilla-ts app with maplibre-gl, three, preact; STATUS.md with one section per WS
   (Done / Doing / Next / Blocked / Assumptions added); LICENSE Apache-2.0 (keep an existing LICENSE and tell me if it differs); .gitignore (append to
   an existing one)
   (data/, node_modules/, web/dist/).
4. Push to main now so the team can clone (tell me when done).
5. contracts/: one JSON Schema (draft 2020-12) per JSON/GeoJSON file in SPEC §6, §6.1, §6.2;
   every index schema gets a boolean "dummy"; contracts/README.md for raster and PNG formats;
   tools/validate_contracts.py that validates web/public/data and web/public/data-dummy.
6. .github/workflows/ci.yml: ruff, pytest, tsc --noEmit, vite build, contract validation,
   no-dummy-in-public check, file-size check (<= 50 MB). WS6 adds the H0 provenance check.
7. Open a PR, print a summary and list every ambiguity you had to resolve.
Rules: no domain logic, no data downloads, no numbers beyond config/. Stop after step 7.
```

## M0 — Dummy data (C, pipeline host, ~09:25)

```txt
You are the dummy-data agent for HOMELINE. Read AGENTS.md, docs/dummy.md, contracts/ and config/.
Implement tools/make_dummy.py exactly per docs/dummy.md: a deterministic (seed 20261114),
offline generator that writes web/public/data-dummy/ in the real formats, every index file
with "dummy": true, finishing in under a minute. Add `make dummy`, and tests that every
generated file validates against contracts/. Then run it, open a PR for C, and report the
file list with sizes. Do not touch any other folder.
```

## D0 — Discovery (N, N's laptop, 09:00)

```txt
You are the discovery agent for HOMELINE (NASA Space Apps 2026). It is Sat 09:00, H0.
Work in ~/hl-discovery (later copied into the repo). Your checklist is below (pasted from
the Notion page "H0 discovery checklist"); skip the "Rules and portal" items (G does those).
For every item run the smallest command that proves it: gdalinfo on /vsicurl/ URLs, STAC
searches with the planning bbox, one API request per endpoint. Never download whole
datasets: metadata and small windows only, at most 50 MB total. Save raw responses under
raw/. For each item record in discovery.md: URL, status (OK / changed / failed), field names,
CRS, nodata, sizes, cadence, surprises, and the fallback if it failed.
Also for the raw-image API: for 5 recent Curiosity boxwork drives, record whether Navcam
left/right frames exist during the drive (not only at the stops), their spacing, and whether
camera models and attitude are present (input for the WS10 probe).
Finish with a summary table: item, status, consequence, workstream to tell. Target 10:30.
Then copy discovery.md into the repo at docs/discovery.md on a branch and open a PR.
[PASTE CHECKLIST HERE]
```

## Workstream sessions (WS1–WS10)

Use the launch template from *Agent kit — start here* and append the first-milestone line from this table.

```txt
You are the coding agent for WS{n} ({name}) of HOMELINE, a NASA Space Apps 2026 project.
Read in this order: AGENTS.md, briefs/WS{n}.md, the SPEC.md sections your brief cites,
config/*.yaml, contracts/, docs/discovery.md (if present). Then follow your brief.
Rules: work only in the paths your brief says you own; take every constant from config/
(never hard-code or invent one); validate every output against contracts/; write
known-answer tests first; record every on-screen number in the provenance manifest;
update STATUS.md at each milestone; open small PRs to main for {reviewer}.
If something you need is missing or contradictory, stop that task, write the question
in STATUS.md under "Blocked", tell {reviewer}, and continue with the next task.
Current time and gate: {time}, next gate {gate}.
First milestone: {first milestone}
```

| Session | Machine | Start | Reviewer | Data at start | First milestone (append to the prompt) |
| --- | --- | --- | --- | --- | --- |
| WS1 Terrain | Pipeline host | ~10:30 | S | Discovery | "Window the merged DEM over the planning extent, reproject to the analysis CRS at 1 m, compute the source mask and coverage, and post the G0 report draft by 11:00." |
| WS2 Engine | Pipeline host | ~09:30 | S, C | Synthetic | "Implement `physio.py` exactly per config/variants.yaml and crew.yaml with the physiology KATs, then the directed 16-neighbour Numba Dijkstra with the router KATs on synthetic grids. Real grid comes from WS1 at about H4." |
| WS3 Horizon | Pipeline host | ~09:30 | C | Synthetic → discovery | "Build the horizon ray engine and the CAHVOR projection with all horizon and camera KATs on synthetic data. After `discovery.md` lands, start caching Navcam frames for drive ends in the focus area." |
| WS4 Conditions | Pipeline host | ~09:30 | G | Synthetic → discovery | "Implement the Mars24 clock and sun API with the clock KAT on known values; once `discovery.md` has the RAD variable names, cache RAD L2 and build the parser, storm numbers, tripwire and leash with KATs." |
| WS5 Web | D's laptop | ~09:30 | D | Dummy (from ~10:00) | "Deploy the empty Vite shell to GitHub Pages, then build the map, layer toggles, legend, Mars scale bar and band/edge layers on data-dummy." |
| WS6 Provenance | Pipeline host | ~09:30 | G | None | "Implement `pipeline/provenance/manifest.py` (record API) and `check_h0.py`, add the H0 check to CI with C, and announce the manifest API to all workstreams in `STATUS.md`." |
| WS7 HUD | D's laptop (+ pipeline host for export) | ~10:00 | D, C | Dummy | "Implement the field PNG encoder/decoder with the exact round-trip test, then the HUD panel (minimal level), alarm rules and playback clock on data-dummy." |
| WS8 3D | R's laptop | ~10:00 | R | Dummy | "Build the Three.js scene shell with the chunk loader, camera at 1.7 m on the dummy route, frame-rate meter and 2D fallback on data-dummy/fp3d." |
| WS9 Navigation | Pipeline host (Python), N's laptop (web) | ~09:30 | N, C, D | Synthetic | "Implement the dead-reckoning error model per config/nav.yaml and the Monte Carlo with 95% ellipses and the r95 fit on a synthetic straight route, with all F21 KATs." |
| WS10 Visual odometry | Pipeline host | ~10:30 | N | Discovery | "Run only the data probe from your brief (≤ 30 min), write vo/probe.json, apply the go rule from config/nav.yaml, report to N, and STOP. Continue only if N records D16 = go." |

# 5. Reviewer routine

- **Every 2 h:** read your sessions' `STATUS.md` sections; answer anything under Blocked; review and approve PRs (C merges).
- **Every 4 h (G, N):** the audit from the WS6 brief: units, CRS, nodata, manifest coverage.
- **Capacity:** at most two live agent sessions per reviewer. The G0, G1 and G2 gate reviews come first.
- **Restarting a session:** if an agent loses context or goes off-scope, stop it, write a short handover in `STATUS.md`, and start a new session with the same prompt plus "Resume from `STATUS.md`, WS{n} section".

# 6. If something goes wrong

| Problem | Do this |
| --- | --- |
| Repo not pushed by 09:30 | C pushes whatever skeleton exists; first-wave sessions start on it and rebase later |
| Discovery late | WS1 starts the merged-DEM window anyway from the URL in `config/site.yaml`; other data tasks wait |
| Venue Wi-Fi too slow | Pipeline host on the phone hotspot; windowed reads only; WS1 downloads first |
| Pipeline host dies | Second-strongest laptop takes over; code is in git; re-run `make` targets from cached raw data if copied, else re-download in priority order WS1 → WS4 → WS3 |
| Agent quota runs out | Pause the stretch sessions first (WS10, then WS8); never pause WS1, WS2, WS5 |

# 7. Notion access: who needs it

> 🔒 **Agents never need Notion.** From 09:00 the repo is the single source of truth: C exports the spec and the Agent kit once, the bootstrap session turns the export into `SPEC.md`, `AGENTS.md`, `briefs/` and `config/`, and every agent reads only those files. Local coding agents usually have no Notion connection, and nothing in the plan assumes one.
>
> **Humans need read access tonight.** The pages are private to Vincent's workspace. Share the spec page (with subpages) with the five teammates, read-only, so they can read their briefs before 09:00.

| Who | Needs | How |
| --- | --- | --- |
| Vincent | Edit access | Owner |
| Teammates (humans) | Read access tonight | Vincent shares "HOMELINE — project proposal & technical specification" with subpages, can-view |
| C at 09:00 | The export | Notion: ••• → Export → Markdown & CSV → include subpages → unzip into `docs/notion-export/` |
| Every agent | Nothing in Notion | Reads repo files only |

**After 09:00:** change the plan in the repo by PR, not in Notion. If the Notion page is edited later anyway, C re-exports and the change goes in by PR. If the Notion export fails at 09:00, C pastes the pages' Markdown by hand (copy page → paste as Markdown) into `docs/notion-export/`; B0 handles either form.

# 8. Machine setup prompt (for any laptop that wasn't set up the night before)

Run this on each teammate's machine as early as possible (tonight, or from 08:15). It only installs and checks tools, so it's safe before 09:00. Set `ROLE` first: `PIPELINE_HOST` for the one shared pipeline machine, `WEB_LAPTOP` for D, R and N.

```txt
You are setting up my laptop for a hackathon team. ROLE = <PIPELINE_HOST or WEB_LAPTOP>.
Before 09:00 Sat 14 Nov 2026 you may ONLY install and verify generic tools.
Hard rules: create no project repository or project files; write no project code or configs;
download no Mars or NASA mission data; do all test work in /tmp/toolcheck-* and delete it at the
end; show me any system-level change (sudo, package manager, shell rc, NixOS or Home Manager
config) and ask before applying; report failures honestly.

STEP 0. Detect OS (macOS, Linux distribution incl. NixOS/Arch, or Windows -> recommend WSL2
Ubuntu and continue inside it), CPU, RAM, free disk, browser with WebGL2.
If ROLE=PIPELINE_HOST, confirm >= 16 GB RAM and >= 20 GB free disk; warn me if not.

STEP 1. Install or verify for every role: git, GitHub CLI (gh) with `gh auth status`
(if logged out, tell me to run `gh auth login`), Node.js 20 LTS + npm, tmux, a Chromium-based
browser, Tailscale (`tailscale status`; if logged out, tell me to run `tailscale up`), and my
coding-agent CLI (report version and login status).
Use the platform's normal method: Homebrew on macOS, apt in Ubuntu/WSL2, pacman on Arch,
a nix-shell/flake devShell or Home Manager snippet on NixOS (ask before editing config).

STEP 2. Only if ROLE=PIPELINE_HOST: Python 3.11 + uv; GDAL >= 3.8 CLI built with curl;
an SSH server reachable over Tailscale; ffmpeg. In a throwaway uv env under /tmp install
numpy scipy numba rasterio pyproj shapely geopandas scikit-image pillow opencv-python-headless
requests pyyaml jsonschema cdasws pytest ruff, and verify: all imports work; a toy Numba
function JIT-compiles; rasterio writes and reads a synthetic GeoTIFF; GDAL reports curl support;
pyproj accepts a custom sphere CRS (generic radius). Create the empty shared data folder
~/hl-data/raw and ~/hl-data/interim (empty folders only).

STEP 3. Every role: in /tmp create a throwaway Vite vanilla-ts app, install maplibre-gl, three
and preact, run `npm run build`, report success.

STEP 4. Check that NASA_API_KEY is set (never print it); if not, tell me how to set it.
Measure download speed with a generic large file (stop after ~100 MB).

STEP 5. Delete /tmp/toolcheck-* (keep package caches). Write ~/hackathon-readiness.md with a
table (tool, required, found, OK/FAIL), machine specs, network speed, account status
(GitHub, Tailscale, agent CLI, NASA key), and a list of what I must still do myself.
Print the summary and stop.
```

**After 09:00** the same prompt can be reused for a late joiner or a replacement machine; then also clone the repo and follow §3.

# 9. Claude accounts and usage limits

> 📊 **Budget:** one Max plan (5× Pro) on the pipeline host owner's account, five Pro plans. That's roughly 10 Pro-equivalents per five-hour window. Pro and Max both have a **five-hour limit** and a **weekly limit**, shared between Claude Code and the Claude apps, and there is no fixed message count: long contexts and heavy models use more. Ten agents running nonstop for 36 h on the Max account alone would hit limits early, so **sessions are spread across all six accounts**, including on the shared pipeline host.

## Allocation

| Account | Sessions | Load |
| --- | --- | --- |
| **Max** (pipeline host owner) | B0 bootstrap and M0 dummy data (morning only), WS2 Engine, WS3 Horizon, WS7 HUD | Heaviest coding |
| **S** (Pro) | WS1 Terrain | Heavy until G0, then moderate |
| **G** (Pro) | WS4 Conditions, WS6 Provenance | Light |
| **D** (Pro) | WS5 Web | Steady |
| **R** (Pro) | WS8 3D | Steady; first to pause after WS10 |
| **N** (Pro) | D0 discovery, then WS9 Navigation; WS10 probe (≤ 30 min) | Moderate |

## Different accounts on the shared pipeline host

Limits are per account, not per machine. Each teammate logs **their own** Claude Code account into **their own** tmux window on the host. If your Claude Code version supports a separate config directory per window via the `CLAUDE_CONFIG_DIR` environment variable (check tonight), use one directory per person:

```bash
# in the teammate's own tmux window on the pipeline host
export CLAUDE_CONFIG_DIR=~/.claude-<name>
<agent CLI>        # log in once with your own account, then paste the session prompt
```

If that isn't supported, run your sessions from your own laptop over SSH with your own login, or keep the host's sessions on the Max account and move the lighter Python sessions (WS4, WS6, WS10 probe) to laptops that have the Python stack installed.

## Rules to make it last

1. **Usage credits tonight:** every account turns on usage credits with a monthly spending cap they're comfortable with, so a limit never stalls a gate. Credits switch on only after the included limits are used up.
2. **Model per task:** the strongest model for the hard parts (router, CAHVOR projection, Monte Carlo, gate reviews); a lighter model for scaffolding, UI, tests and boilerplate.
3. **Short contexts:** restart a session from its `STATUS.md` handover when the conversation gets long; don't leave idle agents running; don't use the same account for unrelated chats during the event.
4. **Weekly resets:** tonight, everyone checks when their weekly limit resets and how much of this week is already used. Accounts that reset during the event can take extra load on Sunday; accounts that are nearly used up hand their sessions to others.
5. **Watch remaining usage** at every 2-hour check-in and note it in `STATUS.md`.
6. **Pause order** when an account runs dry: WS10 → WS8 → stretch items → then move sessions to an account with headroom. Never pause WS1, WS2 or WS5.

## Tonight's checklist (accounts)

- [ ] Each teammate: Claude Code installed and logged in with their own account
- [ ] Each teammate: usage credits on, with a spending cap
- [ ] Each teammate: weekly reset time and current weekly usage noted in the team chat
- [ ] Host owner: check `CLAUDE_CONFIG_DIR` support (or choose the fallback above)
