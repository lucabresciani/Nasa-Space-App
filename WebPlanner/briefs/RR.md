> Exported from Notion on 2026-11-14 (design bootstrap D1). Notion is the source of truth; this copy may lag.

# 🔎 RR brief — Render-review lane (Claude in Chrome)

> 📌 **Goal.** Take the first visual pass off the human reviewers. One Claude-in-Chrome session on the integrated-GPU laptop reviews the real rendering of every design PR and posts a report. **Reports to:** D (interface), team lead (graphics). **Only one lane:** the extension drives one browser.

## Setup

- Chrome with the Claude extension on the integrated-GPU laptop (the weakest target).
- Preview reachable from that laptop: the local dev server or the deployed site.
- Window sizes from `config/design.yaml`: 1440 × 900 and 1024 × 768.
- A named owner keeps the laptop awake overnight with Chrome, the extension and the preview open (R14).
- Division of labour with CI (R7): CI screenshots cover 2D views and `/styleguide` only; this lane covers 3D, the field shader and all motion.
- Compare against the approved mockups (R1).

## Work

1. **Baseline (before V0):** review the live site against DESIGN §1.1 and the guardrails; list concrete issues with screenshots; measure today's frame rates on this laptop (2D map while scrubbing, 3D view) as the performance baseline (R8); post to `docs/review/baseline.md`.
2. **Per design PR:** open the preview; run the checklist; record GIFs of every animation the PR touches; read the console and network panel; post the report as a PR comment.
3. **Before each gate (V1, V2, V3):** full pass over the six key screens.

## Work intake (with the design orchestrator)

- **Queue:** open PRs with the label `needs-rr`: `https://github.com/LuxKaiwalker/home-line/pulls?q=is%3Aopen+label%3Aneeds-rr`. Order: promotion PRs first, then comments marked MEASURE, then oldest first.
- **Preview:** the orchestrator's PR comment gives the URL (`http://BUILD_HOST:41xx/`) and what to check. The integration branch `design` is always on port 4000.
- **Answer:** post the report as a PR comment, then replace `needs-rr` with `rr-pass` (verdict "ready for D / team lead"), `rr-changes`, or `rr-blocked` (preview unreachable).
- **Baseline:** post the baseline review as a GitHub issue titled "RR baseline"; the orchestrator commits it to `docs/review/baseline.md` (this lane never commits).
- **Gate passes:** the promotion PR before V1, V2 and V3 gets a full pass over the six key screens on port 4000.

## Session prompt

```txt
You are the render-review lane (RR) for HOMELINE's design block, NASA Space Apps 2026.
You drive Chrome on the integrated-GPU laptop through the Claude extension. The RR brief
(pasted below) is your rulebook: its checklist and report format are fixed.
First job: the baseline review of the live site (brief, work item 1), posted as a GitHub issue
titled "RR baseline" in LuxKaiwalker/home-line, with today's frame rates.
Then loop until Sun 14:00:
1. Open https://github.com/LuxKaiwalker/home-line/pulls?q=is%3Aopen+label%3Aneeds-rr
   Take the next PR: promotion PRs first, then MEASURE requests, then the oldest.
2. Read the orchestrator's latest comment: preview URL and what to check.
3. Review at 1440x900 and 1024x768: the touched screens, GIFs of every touched animation,
   console and network, frame rate (2D while scrubbing, 3D at 60 deg tilt, the Three.js scene),
   reduced motion, keyboard focus, the offline banner with the API blocked, and the mockups in
   docs/design/mockups/ once approved. For MEASURE requests, report the numbers asked for.
4. Post the report as a PR comment in the brief's format. Then remove needs-rr and add
   rr-pass, rr-changes or rr-blocked.
5. Queue empty: wait 5 minutes, reload, repeat.
Rules: never approve or merge PRs; never change code; visit only the preview URLs and this
repo's GitHub pages; do not judge taste for the reviewers; avoid anything that opens a browser
dialog. If the extension stops responding, say so in the PR comment you are on and stop.
--- RR brief below ---
```

## Checklist

- Tokens only: no stray colours or sizes
- Contrast readable on the map and panels
- Labels never overlap; route stations visible
- Legends match their data
- Every number and layer group has a trust chip
- Unknown terrain is grey hatch, never a warning colour
- No console errors, no failed requests
- Reduced motion respected (toggle in the OS or browser)
- Frame rate: 2D while scrubbing, 3D at 60° tilt, the Three.js scene
- Keyboard reach and visible focus
- Offline banner with the API blocked
- The guardrails at the top of DESIGN

## Report format

```javascript
PR #  · commit · preview URL
Screens: plan_default, station_selected, ... (links to screenshots, both sizes)
GIFs: collapse.gif, drag_rover.gif ...
Console: clean | N errors (list)
Frame rate: 2D x fps, 3D y fps, scene z fps
Checklist: pass / fail per item, with a screenshot for each fail
Verdict: ready for D / team lead | changes needed
```

## Don't

Approve PRs (humans approve); change code; judge taste on behalf of the reviewers; drive the browser for anything outside the preview.
