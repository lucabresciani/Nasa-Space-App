# 🤖 Agent kit — start here

> 🛠️ **Fresh run.** This build restarts from H0 in the repo `home-line` (`LuxKaiwalker/home-line`), which replaces the `nasa-space-app` repo named in the H0 bootstrap below. Agents may read code in `~/coding/homeline` (tag `pre-h0-reference`) as a reference only, but must never copy its data, outputs, figures, numbers or decisions. Decisions from that run are withdrawn. Shared data lives in `~/hl-data` (symlinked as `data/`). Live build progress is tracked in Notion and in `STATUS.md`.
>
> ⏸️ **2026-11-14 14:19 (user):** WS9's position work (F21, F22) and WS10 (X8, X9) are **suspended softly (optional add-on)**: no new sessions; merged work stays (SPEC §2.4, D19).

> 📌 **What this is.** Everything a coding agent needs to build HOMELINE from H0, plus the rules that keep ten agent sessions from colliding. The parent page is the spec (SPEC). The subpages are the agent-ready material.
>
> **Pre-event rule.** All of this is text. At H0 (Sat 09:00) C exports the spec and these pages into the repo: `SPEC.md`, `AGENTS.md` (this page), `briefs/WS1.md … WS10.md`, `config/*.yaml` (from the config page), `docs/discovery.md` (the checklist, filled in by N) and `docs/dummy.md`. No code or data before H0.

## Subpages

- **Config values**: every constant and formula, ready to paste into `config/*.yaml`
- **H0 discovery checklist**: exact endpoints to verify in the first hour; findings go to `docs/discovery.md`
- **Dummy data spec**: the fake-but-contract-valid data that lets WS5, WS7, WS8 and WS9 start at H1–H2
- **WS1–WS10 briefs**: one brief per agent session

## H0 bootstrap (C, 09:00–09:45)

1. Use the team's **existing** repo `nasa-space-app` (no new repo). Check its default branch (expected `main`), that all six teammates have write access, and that it can be **public** at submission with GitHub Pages and Actions enabled. Turn on branch protection: PR + green CI + C's approval. Keep any existing files; HOMELINE is added alongside them.
2. Commit `SPEC.md`, `AGENTS.md`, `briefs/`, `config/`, `docs/` from these pages.
3. Write `contracts/*.schema.json` from spec §6, §6.1 and §6.2 (JSON Schema for every JSON/GeoJSON file; a README for raster and PNG formats). Freeze them at H1.
4. Scaffold: `pyproject.toml` (uv), `Makefile` with empty targets, `web/` Vite + TS skeleton, CI workflow (§CI below), `STATUS.md`.
5. Start N on the discovery checklist and WS1/WS3/WS4 downloads; start the dummy-data generator (owner C, ≤ 45 min).
6. Launch agent sessions with the prompt template below, one per workstream.

## Agent session prompt template

```txt
You are the coding agent for WS{n} ({name}) of HOMELINE, a NASA Space Apps 2026 project.
Read in this order: AGENTS.md, briefs/WS{n}.md, the SPEC.md sections your brief cites,
config/*.yaml, contracts/, docs/discovery.md. Then follow your brief.
Rules: work only in the paths your brief says you own; take every constant from config/
(never hard-code or invent one); validate every output against contracts/; write
known-answer tests first; record every on-screen number in the provenance manifest;
update STATUS.md at each milestone; open small PRs to main for {reviewer}.
If something you need is missing or contradictory, stop that task, write the question
in STATUS.md under "Blocked", tell {reviewer}, and continue with the next task.
Current time and gate: {time}, next gate {gate}.
```

## Rules for every agent

1. **Scope.** Work only in the paths your brief lists under "Owns". Read anything; write only your own paths. Need a change elsewhere? Ask the owner via `STATUS.md` and your reviewer.
2. **Constants.** Every number comes from `config/`. If you need a new one, add it to your config file with `assumed: true` and a one-line note, and flag it in your PR.
3. **Decisions.** Logged decisions in SPEC §11 are final. Anything not logged uses its recommended default. Never decide an open item (D3, D7, D8, D16, D17) yourself; the brief says who does.
4. **Contracts.** Outputs must validate against `contracts/`. Only C changes a contract, by PR with a version bump and a note to every consumer.
5. **Tests first.** Write the known-answer tests (SPEC §9 and your brief) before the implementation. A task is not done until they pass.
6. **Provenance.** Every number shown in the app goes into `manifest.json` via `pipeline/provenance/manifest.py` (value, units, file, script, commit, UTC time).
7. **Honesty.** Never fabricate data, coordinates or results. If a download fails or a number looks wrong, report it; don't paper over it. Unknown stays unknown.
8. **No pre-H0 artefacts.** Never import data, figures or numbers created before Sat 09:00 (`h0_utc` = 2026-11-14T08:00:00Z in `config/event.yaml`). Write all timestamps in UTC; if your machine's clock disagrees with `date -u` on another machine, stop and tell C.
9. **Size.** Nothing over 50 MB in git. Raw downloads live in `data/raw/` (git-ignored) with a cache index.
10. **Gates beat polish.** At G1 (Sat 19:00), G2 (Sun 08:00) and the freeze (Sun 12:00), ship what passes tests; follow the cut order in SPEC §2.1.

## Definition of done (per task)

- Known-answer tests pass in CI
- Outputs validate against the contract schema
- Manifest entries written for any displayed number
- `STATUS.md` updated
- Reviewer approved the PR

## Repo rules

| Topic | Rule |
| --- | --- |
| Branches | `ws1-terrain`, `ws2-engine`, `ws3-horizon`, `ws4-conditions`, `ws5-web`, `ws6-provenance`, `ws7-hud`, `ws8-3d`, `ws9-nav`, `ws10-vo` |
| Merging | Small PRs; only C merges to `main`; rebase on `main` before merge |
| Commits | `WS{n}: short imperative summary`; mention feature IDs (F4, F21 …) |
| Data outputs | Pipeline writes to `data/interim/`; web-facing files to `web/public/data/` only via `make web`; committed at the freeze |
| Dummy data | Lives in `web/public/data-dummy/`, every index file has `"dummy": true`; CI fails if any `dummy` flag appears in `web/public/data/` |
| Status | `STATUS.md` has one section per workstream: Done, Doing, Next, Blocked, Assumptions added |
| Secrets | `NASA_API_KEY` via environment only, never committed |

## Folder ownership

| Path | Owner |
| --- | --- |
| `pipeline/terrain/`, `config/site.yaml`, `config/stations.yaml` | WS1 |
| `pipeline/engine/`, `config/crew.yaml`, `config/variants.yaml`, `config/haul.yaml` | WS2 |
| `pipeline/horizon/`, `pipeline/validation/v2_skyline.py`, `config/horizon.yaml` | WS3 |
| `pipeline/conditions/`, `config/conditions.yaml` | WS4 |
| `web/` except `web/src/hud/`, `web/src/fp3d/`, `web/src/nav/` | WS5 |
| `pipeline/provenance/`, `pipeline/validation/v1_tilt.py`, `pipeline/validation/figures.py`, `.github/workflows/` | WS6 (CI jointly with C) |
| `web/src/hud/`, `pipeline/export/fields_png.py`, `pipeline/export/worstcase.py`, `config/hud.yaml` | WS7 |
| `web/src/fp3d/`, `pipeline/export/terrain_chunks.py`, `far_mesh.py`, `ortho_chunks.py` | WS8 |
| `pipeline/navigation/` (except `vo*.py`, `orthomatch.py`), `web/src/nav/`, `config/nav.yaml` | WS9 |
| `pipeline/navigation/vo_probe.py`, `vo.py`, `orthomatch.py` | WS10 |
| `contracts/`, `Makefile`, `pyproject.toml`, `tools/make_dummy.py` | C |

## CI

On every PR: `ruff` + `pytest` (all KATs), `tsc --noEmit` + `vite build`, schema validation of every file in `web/public/data/` and `data-dummy/`, the H0 provenance check (no manifest time before 2026-11-14 09:00 local), the no-dummy-in-public check, and a file-size check (≤ 50 MB).

## Reviewer map (decided, D18)

| WS | Human owner / reviewer |
| --- | --- |
| WS1 Terrain | S |
| WS2 Engine | S (science), C (code) |
| WS3 Horizon | C |
| WS4 Conditions | G |
| WS5 Web | D |
| WS6 Provenance | G |
| WS7 HUD | D (UI), C (data) |
| WS8 3D | R |
| WS9 Navigation | N (model), C (skyline fix), D (HUD) |
| WS10 Visual odometry | N |

- Config values (`config/*.yaml`) → `config/*.yaml`
- H0 discovery checklist → `docs/discovery-checklist.md`
- Dummy data spec → `docs/dummy.md`
- WS1 brief — Terrain → `briefs/WS1.md`
- WS2 brief — Engine → `briefs/WS2.md`
- WS3 brief — Horizon and camera → `briefs/WS3.md`
- WS4 brief — Conditions → `briefs/WS4.md`
- WS5 brief — Web app → `briefs/WS5.md`
- WS6 brief — Provenance and validation → `briefs/WS6.md`
- WS7 brief — Live HUD → `briefs/WS7.md`
- WS8 brief — 3D first-person view → `briefs/WS8.md`
- WS9 brief — Navigation → `briefs/WS9.md`
- WS10 brief — Visual odometry → `briefs/WS10.md`
- Morning runbook — Sat 14 Nov, 08:15–11:00 → `docs/morning-runbook.md`
- HOMELINE waypoint block — proposal and implementation plan (D97) → `docs/waypoints.md`
- [Pre-H0 build log (deprecated, reference only)](https://app.notion.com/p/418961bcb611814c9d64fd95e66e6d2d)
