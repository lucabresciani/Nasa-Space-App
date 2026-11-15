> Exported from Notion on 2026-11-14 (design bootstrap D1). Notion is the source of truth; this copy may lag.

# 🤖 Design agent kit — start here

> 📌 **What this is.** Everything a coding agent needs to build the design block (U0–U17): how to start, the rules on top of the core agent kit, folder ownership, gates, and one brief per workstream (subpages). The parent page is the design specification (DESIGN). The core rules in [Agent kit — start here](https://app.notion.com/p/417961bcb61181e191b5f70d601e03a7) still apply; this kit adds to them. Decisions: [Decision log (D1–D76)](https://app.notion.com/p/418961bcb61181029fc0cb3a54e426c3) (D49: at least Tier A; the team lead reviews graphics).

## Current status

> 🛠️ **Sat 20:30 — Not started; runs through the design orchestrator.** The design block is built by one orchestrator session (see Orchestration below) next to the backend orchestrator. V0 becomes **V0′ = bootstrap done, target Sat 21:30**; V1–V3 are unchanged. Next: readiness R1, R3, R14, R16–R18, then launch the orchestrator and the RR lane. **Sat 21:24 — backend demo cut (D69) applied to the design block:** U8 terrain for any plan, U15 science points / insert / reorder / save, share-code search, mission control and comparison are cut and marked ✂️ in the specification; drag the rover (static and live) and undo stay. Up to 2 extra slots when the backend is idle.
>
> **Sat 22:30 — team lead (D72–D76):** design starts now with max(2, 6 − running backend packages) agents, 6 once the backend is done; new gates V0′ \~23:30, V1′ 04:00, V2′ 08:00, V3 09:00; V0 choices taken (D73); no promotion before 08:00, RR fallback `rr-pending` (D74); overnight rules and the [Overnight log — decisions and questions for 08:00](https://app.notion.com/p/418961bcb6118190ae91ec3b2f900617) (D71); simulator slot A5s, format-agnostic (D76).
>
> The orchestrator (for C) replaces this callout at each milestone; it does not append.

| Workstream | Features | State | Reviewer |
| --- | --- | --- | --- |
| WS15 Design system and panels | U0, U5, U10, U11, U14, U17 | Not started | D |
| WS16 Map visuals | U1–U4, U6, U7, U9, U13, U16 + pipeline exports | Not started | C (data), team lead (graphics) |
| WS17 3D scene | U8 | Not started | R (code), team lead (graphics) |
| WS18 Direct manipulation | U15 | Not started | D (interaction), N (backend calls) |
| RR Render-review lane | Visual checks on every design PR | Not started | Reports to D and the team lead |
| U12 quality checks | Visual regression, accessibility, performance | Starts with WS15 task 2 | G |

## Readiness checklist (before the first design session)

> 🚦 The kit covers process, rules and tasks. These items are still missing. Group 1 blocks the start; groups 2 and 3 can be settled in the first hours, but each one costs a session if left to the agents.

### 1. Needed before the first session

| # | Item | Why | Owner | Output |
| --- | --- | --- | --- | --- |
| R1 | **Mockups of the six key screens** (Plan default, station selected, drag the rover with ghost, Fly with margin field and storm, Report, Evidence) | Everything else is written in words. Without a picture, WS15 and WS16 each invent a look, and RR has nothing to compare against. The biggest gap | Team lead + D (Claude can draft from the tokens and layout) | `docs/design/mockups/*.png`  • an approved note in `STATUS.md` |
| R2 | **Repo map of the current web app**: real module names, MapLibre and Three.js versions, whether Preact signals is installed, how the loader, the number component and the HUD are wired | The paths in DESIGN and the briefs come from the planned layout, not the real code | C or one short agent session (≈ 20 min) | `docs/web-architecture.md` |
| R3 | **V0 choices**: palette (DESIGN §3.1), four modes yes/no, icon set (for example Lucide; licence checked) | WS15 task 1 is tokens and icons | Team lead + D | Rows in the decision log |
| R4 | **Copy deck**: captions, tooltips, empty, error and offline states, alarm texts, chip explanations, intro captions, card labels | Otherwise every agent writes its own wording | Claude drafts from the glossary (DESIGN §3.8); D approves | `web/src/ui/copy.json` |
| R5 | **Value-snapshot method**: a script that renders every manifest-backed number in every view and stores the values | Design rule 1 depends on it | C (bootstrap step 3) | `tools/values_snapshot.ts`  • `tests/fixtures/values_baseline.json` |

### 2. Facts to pin down early

| # | Item | Why | Owner |
| --- | --- | --- | --- |
| R6 | MapLibre features available in the installed version: canvas-source updates, terrain, relief shading, stretchable images for label pills | If the version is old, upgrading is its own task before U1, U2 and U13 | WS16, first 15 min (from R2) |
| R7 | Visual tests in CI: headless browsers render WebGL in software, so 3D screenshots are not stable | Decision: CI screenshots cover 2D views and `/styleguide` only; RR covers 3D and motion | C |
| R8 | Today's frame rates on the integrated-GPU laptop (2D map while scrubbing, 3D view) | Baseline for the performance budgets | RR, in the baseline review |
| R9 | Thresholds for highlight polygons: ridge-index cut-off, mineral-hint threshold | Science calls, not design calls | S confirms; values go into `config/design.yaml` |
| R10 | Where verified landmark coordinates live (probably WS3's card data) | Labels (U13) need them; never typed by hand (D33) | WS16 with C |

### 3. Coordination and logistics

| # | Item | Proposal | Owner |
| --- | --- | --- | --- |
| R11 | Ownership of `web/` while WS5 (core), WS13 (live UI) and WS15 (design) all touch it | WS15 tokens and components merge first; WS13 builds on them; WS5 only fixes for G2; C merges in that order | C |
| R12 | Reviewer load: D reviews WS15, WS18 and WS13 | R takes WS18's interaction review, or WS13 waits until WS15 has passed V1 | Team lead |
| R13 | Agent accounts and usage limits (two pauses today) | WS15 and WS16 (the long sessions) on the accounts with the most headroom; start them right after a reset | Team lead |
| R14 | The RR laptop | One named owner keeps it awake overnight with Chrome, the extension and the preview open | Team lead |
| R15 | Capture timing for the video | The first beat needs the collapse (U3). If U3 is not merged by V1, the old static shot stays the fallback | WS16, D |
| R16 | **RR laptop can reach the build machine's previews** | The orchestrator serves PR previews on `http://BUILD_HOST:4100–4199` and the `design` branch on port 4000. Test once from the laptop's Chrome; if the LAN blocks it, put both machines on Tailscale | Laptop owner (R14) |
| R17 | **Promotion approvals at V1, V2, V3** | Visible changes collect on the `design` branch and reach the published site only when the team lead approves the promotion PR (D co-approves interface items). Name who is awake at 01:00 and 06:00; without approval the site keeps its current look (safe) | Team lead |
| R18 | **Two orchestrators on one machine and the same accounts** | Backend runs 4 agents, design `SLOTS` (default 4) plus the RR lane: up to 9 sessions. Shared locks for heavy jobs and merges are built in. If the accounts cannot carry it, set design `SLOTS = 3`. After the backend demo cut (D69) the design orchestrator may borrow up to 2 idle backend slots (up to 6) | Team lead |

## Bootstrap (C, about 30 min)

> 🎛️ With the orchestrator, steps 2–6 run as packages D1–D5 (plus D6 copy-deck draft, D7 mockup drafts if needed, D8 baseline commit). Step 1 stays with the team lead; step 7's baseline review is the RR lane's first job; step 8 is the orchestrator's queue.

1. Check the readiness checklist above: R1–R5 done or explicitly waived by the team lead.
2. Export DESIGN to `docs/design.md`, this kit to `docs/design-agents.md`, the briefs to `briefs/WS15.md … WS18.md` and `briefs/RR.md`, and the design config page to `config/design.yaml` and `web/src/ui/tokens.json`.
3. Write the design contracts (DESIGN §6): `contracts/labels.schema.json`, `storyboard.schema.json`, `terrain_tiles.schema.json` (tile metadata), `highlights.schema.json`; document the field-shader interface (DESIGN §6.4) in `contracts/field_shader.md`. Freeze as design contracts v1 at V0.
4. Take the **value snapshot**: render every manifest key in every view on `main` and store it as `tests/fixtures/values_baseline.json`. Every design PR is checked against it.
5. Create branches `ws15-design-system`, `ws16-map-visuals`, `ws17-3d-scene`, `ws18-direct-edit`.
6. Add CI jobs: token lint, value snapshot, visual regression (empty baseline at first), bundle-size check (DESIGN §5.4).
7. Set up the render-review lane (RR brief) and post the baseline review.
8. Launch sessions in the order below with the prompt template.

## Launch order

| Order | Session | Starts when | First deliverable |
| --- | --- | --- | --- |
| 1 | WS16 | After bootstrap | Field-shader spike result (≤ 1 h): rendering path decided |
| 1 | WS15 | After bootstrap | Tokens, fonts, icon sprite, token lint |
| 1 | RR | After bootstrap | Baseline review of the live site |
| 2 | WS17 | Any time after bootstrap | Chase camera on the official route |
| 3 | WS18 | After WS15 has merged the selection store (WS15 task 5) | Plan-edit store and undo |

At most two agent sessions per reviewer. Core gate G2 and backend gates get reviewer time first.

## Orchestration

Prompt: [Design orchestrator — prompt](https://app.notion.com/p/418961bcb61181e6aa18cd7c0876ed74). RR lane prompt: on the [RR brief — Render-review lane (Claude in Chrome)](https://app.notion.com/p/418961bcb611818c9f4be7b0b2c78cca). Backend counterpart: [Backend orchestrator — prompt](https://app.notion.com/p/418961bcb61181ccb0a1e5173663b98f).

| Topic | How it works |
| --- | --- |
| Sessions | One orchestrator on the build machine keeps `SLOTS` subagents busy from a package queue (D1–D8, A1–A10, M0–M13, P1–P3, K1–K6, H1–H7, Q1). One package per stream at a time; WS16 runs as two streams (map, pipeline) because their files do not overlap. State in `/tmp/hl-design/`, so a restart resumes |
| Priority | Tier A for the next gate first (critical path: tokens → field shader → margin → collapse → thread), then earliest gate; Tier B only when Tier A for the next gate is running or merged; Tier C only after a GO at V3 |
| Class N | Nothing visible changes (visual regression empty, value snapshot unchanged, no 3D/shader/motion code): merged to `main` by the orchestrator |
| Class V | Anything visible or any 3D/shader/motion code: merged to the integration branch `design` after `rr-pass` |
| Promotion | 45 min before V1, V2 and V3: PR `design → main` with an RR full pass on port 4000; merged only after the team lead approves (D co-approves interface items) |
| RR lane | Fed through GitHub labels: `needs-rr` → `rr-pass` / `rr-changes` / `rr-blocked`. Class V is never merged without `rr-pass` |
| Shared with backend | `flock /tmp/hl-heavy.lock` for heavy jobs, `flock /tmp/hl-merge.lock` for every merge to main; disjoint folders, contract files and CI files; each orchestrator may read the other's `state.md` |
| Human-gated | Promotions, R1/R3/R4/R9 approvals, contract changes after V0′, existing WS8 files, MapLibre/Three.js upgrades, licence questions, the capture run |

## Overnight and simulator (D71–D76)

| Topic | Rule |
| --- | --- |
| Slots | max(2, 6 − running backend packages); 6 after "BACKEND DONE" (D72) |
| V0 choices | Palette §3.1, four modes, Lucide (ISC), crew in code, intro on; copy deck and mockup drafts provisional (D73) |
| Promotions | None before 08:00; promotion PR ready by 07:45; RR silent 45 min → class V merges to `design` as `rr-pending` (D74) |
| Questions overnight | DECIDE / PARK / ASK, logged in the [Overnight log — decisions and questions for 08:00](https://app.notion.com/p/418961bcb6118190ae91ec3b2f900617) (D71) |
| Simulator | Unity repo read-only; compiled-plan format still open (a new format may arrive); package A5s adds a "Send to simulator" slot behind `VITE_SIM_EXPORT` (off) that shows any manifest file of kind `sim_plan`; proposals to [Simulator integration — Unity findings and proposed changes](https://app.notion.com/p/418961bcb61181f3877df1cca3ac7c8c) (D76) |

## Gates

| Gate | When | Must be true | If not |
| --- | --- | --- | --- |
| V0′ | Sat \~23:30 (D72) | Bootstrap done; contracts frozen; value snapshot taken; RR baseline posted; WS16 spike running; palette, four modes and icon set confirmed by the team lead and D | Start anyway with tokens and the field shader; decide the rest by V1 |
| V1′ | Sun 04:00 (D72) | Tokens, field shader (bands + margin), collapse, thread home, markers, labels merged; RR green | Apply the cut order from the bottom up |
| V2′ | Sun 08:00 (D72; promotion with the team lead) | Shell and migration complete or reverted; 3D terrain; selection and sidebar; drag the rover; undo | Revert unfinished migrations; keep Tier A pieces that pass |
| V3 | Sun 09:00 (D72) | Go/no-go per Tier B item (timeline, flythrough, overlays, storm, U8, search) | Unfinished items are removed from the UI |
| Freeze | Sun 12:00 | No new design features | — |
| Capture | Sun 12:00–14:00 | Storyboard captures for the video (WS16) | — |

## Session prompt template

```txt
You are the coding agent for WS{n} ({name}) of HOMELINE's design block, NASA Space Apps 2026.
Read in this order: AGENTS.md, docs/design-agents.md, briefs/WS{n}.md, the docs/design.md
sections your brief cites, config/design.yaml, web/src/ui/tokens.json, contracts/ (design
contracts and the field and manifest contracts). Then follow your brief.
Rules: work only in the paths your brief owns; take every colour, size, duration and threshold
from tokens or config/design.yaml; never change a validated number (the value snapshot must
stay green); write the acceptance tests in your brief first; attach the render-review report to
every PR; update STATUS.md at each milestone; open small PRs to main for {reviewer}.
If something is missing or contradictory, stop that task, write it in STATUS.md under
"Blocked", tell {reviewer}, and continue with the next task.
Current time and gate: {time}, next gate {gate}.
```

## Rules for design agents (on top of the core rules)

1. **No validated number changes.** The value snapshot test must pass on every PR. Restyle only.
2. **Tokens only.** No colour, font size, radius, spacing or duration literal outside `web/src/ui/tokens.css` / `tokens.json` and `config/design.yaml`. The lint rule enforces it.
3. **Meaning of colour is fixed** (DESIGN §3.1): yellow = selection only; green/orange/red = margin states; blue = science; purple = live; grey hatch = unknown, never a warning colour.
4. **Trust chips on every number and layer group** (DESIGN §3.6).
5. **Honesty during interaction.** Values shown while dragging come from field lookups only; anything else is a ghost marked "computing…" (U15).
6. **Static first.** Everything except live-by-nature features works with the backend off; no static view imports from `web/src/live/` or `web/src/edit/` server paths.
7. **No new runtime dependencies** beyond self-hosted fonts and one icon set (DESIGN §5.5). Playwright is allowed as a development dependency.
8. **No branding or borrowed art.** No NASA insignia or look-alike graphics; no copied assets; no AI-generated imagery; every asset licence recorded for `/about`.
9. **Reduced motion respected** in every animation.
10. **U0 is finished or reverted.** Each migrated view keeps `?legacy=view` until V2.
11. **Performance budgets** (DESIGN §5.4) are checked before merge; 3D and shaders are lazy-loaded.
12. **Render review.** A design PR is not reviewable without the RR report (screenshots at 1440 × 900 and 1024 × 768, GIFs of touched animations, console clean).

## Definition of done (per task)

- Acceptance tests from the brief pass in CI
- Value snapshot unchanged; token lint clean; bundle budget met
- Visual regression updated and approved
- RR report attached; reviewer approved (graphics items: the team lead)
- Class V: merged to `design` after `rr-pass`; reaches `main` only through an approved promotion
- `STATUS.md` updated

## Folder ownership (design)

| Path | Owner |
| --- | --- |
| `web/src/ui/` (tokens, components, shell, timeline, search, charts, styleguide), `web/src/state/`, `web/src/report/` | WS15 |
| `web/src/map/` (style, field, layers, labels, thread, markers, camera), `web/src/story/`, `web/public/story/` | WS16 |
| `pipeline/export/terrain_tiles.py`, `relief_lowzoom.py`, `contours.py`, `overlays.py`, `highlights.py`, `labels.py`; `web/public/data/terrain/`, `overlays/`, `highlights/`, `labels.json` (via `make web`) | WS16 |
| `web/src/fp3d/` additions for U8 (`chase.ts`, `crew.ts`, `shadows.ts`, `thread3d.ts`, `worldtiles.ts`) | WS17 (existing WS8 files: change only with R) |
| `web/src/edit/` | WS18 |
| `config/design.yaml`, design contracts, CI design jobs, `tests/fixtures/values_baseline.json` | C |
| Existing views (`web/src/*.ts`, `hud/`, `live/`) | Their owners; WS15 migrates them by PR with the owner as second reviewer |

## Hand-offs between design workstreams

| From | To | What | When |
| --- | --- | --- | --- |
| WS15 | All | Tokens and `tokens.json` | WS15 task 1 (first hour) |
| WS15 | WS16, WS18 | Mission-state and selection stores | WS15 tasks 3 and 5 |
| WS16 | WS15 | Field decoder and lookup API (`fieldAt(lon, lat)`) for cards and readouts | WS16 task 2 |
| WS16 | WS18 | Pad validity from fields; ghost-route layer | WS16 tasks 2 and 5 |
| WS16 | WS17 | Thread-home path function | WS16 task 5 |
| WS13 (backend UI) | WS18 | Live API client (preview, jobs) | Backend gate B1 |
| RR | All | Review reports | Per PR |

## Subpages

- **Design config values**: `config/design.yaml` and `tokens.json`, ready to paste
- **WS15–WS18 briefs** and the **render-review lane brief**

[Design config values (config/design.yaml, tokens.json)](https://app.notion.com/p/418961bcb61181cc8a38c7f4349afd04)

[WS15 brief — Design system and panels](https://app.notion.com/p/418961bcb61181308878ec6b6d87f28d)

[WS16 brief — Map visuals](https://app.notion.com/p/418961bcb6118117941bd5ac1be16a4a)

[WS17 brief — 3D scene (crew and chase camera)](https://app.notion.com/p/418961bcb61181cfb88afc6b3409bd2b)

[WS18 brief — Direct manipulation](https://app.notion.com/p/418961bcb61181e6961dc853e6f4533e)

[RR brief — Render-review lane (Claude in Chrome)](https://app.notion.com/p/418961bcb611818c9f4be7b0b2c78cca)

[Design orchestrator — prompt](https://app.notion.com/p/418961bcb61181e6aa18cd7c0876ed74)
