# Fallback drill (H2, gate B1′)

Kit rule 4, "static first": the submitted app works fully with the server off, and no static view
imports from `web/src/live/`. When `/health` has been unreachable for 2 s, the live controls hide
behind the offline banner.

## Current result: run 2 (after the health fix) — all four steps PASS

| Step | What | Run 1 (19b7ce2) | Run 2 (c7e4ea7 = H2 doc on main 2fd9cb2) |
|---|---|---|---|
| 1 | Static build, flag off | PASS | **PASS** |
| 2 | Live build, no server | PASS | **PASS** |
| 3 | Server killed mid-session | **FAIL**: no banner until a page reload | **PASS**: the banner shows 2.5–3.0 s after a refused connection and 3.6–4.8 s after a hang. The controls hide, and they come back when the server returns |
| 4 | Official permalink, server down | PASS | **PASS** (it also follows the health state mid-session) |

The step-3 failure was fixed by U1b in PR #56 (9392cd8): "keep polling /health while ready; offline hides
every live control mid-session". That PR does three things:
- It polls `/health` every 3 s (`CLIENT.healthPollMs`) in every state.
- A failed live request triggers a check at once.
- `#/plan/{hash}` views follow the health state.

A separate finding is not a fallback failure, but it should be fixed (see "Other findings"): the **static console**
throws a map-layer error when you leave it within about 1 s of its headline appearing. It happens with the
flag off too, and also at 19b7ce2.

### Run 2 setup
- Date: 2026-11-15, ~02:30–03:30 local.
- Branch `hardening-h2` rebased onto origin/main 2fd9cb2, which contains 9392cd8; HEAD c7e4ea7.
- I ran `npm ci` and `uv sync --frozen`.
- Browser: **Playwright 1.65.1 from `web/node_modules`** (added on main by D5) driving the system Chromium 157
  (`executablePath`). Playwright's bundled browser does not start on NixOS. The driver is in the appendix.
- Ports:
  - 8090: live build with the default API base 8012
  - 8091: blackhole (accepts connections, never answers)
  - 8092: live build that talks to 8091
  - 8094: live build that talks to the API on 8022
  - 8095: static build
  - 8022: API
  - 8012 was free throughout (`ss -ltn | grep 8012` returned nothing).
- `/engine/version` reported `commit c7e4ea70…` = HEAD for every server I started, including the restarted one.
- The official hash at this HEAD is `c51b1b82b5269ce6`:
  `uv run --no-sync python -c "from server.engine.hashing import official_hash; print(official_hash())"`.
  `GET /results/c51b1b82b5269ce6/provenance` returned 200 with origin `precomputed`. The hash changes with the
  engine identity: run 1 used `c20497ca023aab37`.
- Every server, preview, blackhole and browser I started was stopped. Afterwards nothing listened on 8012,
  8022 or 8090–8096. Port 8099 belongs to another process and was already in use before the drill.

### Step 1: static build, flag off — PASS
```
cd web && npm ci
flock /tmp/hl-heavy.lock npx vite build      # ✓ built
ls dist/assets | grep -ci live               # 0  (no live chunk)
grep -l "Live planning is offline" dist/assets/*.js   # nothing (exit 1)
npm test                                     # 61 files passed, 1 skipped; 787 passed, 13 skipped
npx tsc --noEmit                             # OK
npx vitest run src/live/health.test.ts src/live/healthpoll.test.tsx src/live/index.test.ts src/live/isolation.test.ts   # 4 files, 30 passed
```

### Step 2: live build, no server — PASS
```
VITE_LIVE=1 flock /tmp/hl-heavy.lock npx vite build --outDir <scratch>/r3-live-8012 --emptyOutDir   # live-*.js, base localhost:8012
VITE_LIVE=1 VITE_API_BASE=http://localhost:8091 flock /tmp/hl-heavy.lock npx vite build --outDir <scratch>/r3-live-8091 --emptyOutDir
npx vite preview --outDir <scratch>/r3-live-8012 --port 8090 --strictPort --host 127.0.0.1
npx vite preview --outDir <scratch>/r3-live-8091 --port 8092 --strictPort --host 127.0.0.1
node blackhole.mjs                                   # 8091: accepts, never answers
OFFICIAL_HASH=c51b1b82b5269ce6 node drive-pw.mjs offline http://127.0.0.1:8090   # refused
OFFICIAL_HASH=c51b1b82b5269ce6 node drive-pw.mjs offline http://127.0.0.1:8092   # hanging
```

| | Refused (8012) | Hanging (8091) |
|---|---|---|
| Banner `Live planning is offline · showing precomputed plans` visible, `data-state=offline` | 293 ms after load | 2080 ms after load (the 2 s timeout) |
| Live controls visible | 0 | 0 |
| Console headline `23%` | yes, at 0.7 s | yes, before the banner |
| `#/trade`, `#/scorecard`, `#/conditions`, `#/` | render, banner offline, 0 live controls | the same |
| Uncaught errors on a plain load (`drive-pw.mjs plain`, 10 s, 3 runs) | 0 | — |

Every run showed the same expected log entries:
- `ERR_CONNECTION_REFUSED` for `/health` and provenance, or an empty response from the blackhole.
- `favicon.ico` 404 from `vite preview`.

The navigation sequence leaves the console about 1 s after load. In both drill runs that sequence also logged
the static console's map-layer race (see "Other findings"). The same race occurs in the flag-off build, so it is
not a fallback issue.

### Step 3: server up, then killed mid-session — PASS
```
HL_SERVER_DATA=/home/vincent/hl-data/server uv run --no-sync uvicorn server.app:app --host 127.0.0.1 --port 8022
curl -s http://127.0.0.1:8022/api/v1/engine/version   # commit c7e4ea70… = HEAD
VITE_LIVE=1 VITE_API_BASE=http://localhost:8022 flock /tmp/hl-heavy.lock npx vite build --outDir <scratch>/r3-live-8022 --emptyOutDir
npx vite preview --outDir <scratch>/r3-live-8022 --port 8094 --strictPort --host 127.0.0.1
# server killed (refused afterwards), then restarted:
NOSEC=1 OFFICIAL_HASH=c51b1b82b5269ce6 REVIVE_CMD="bash revive.sh" node drive-pw.mjs kill http://127.0.0.1:8094 "kill <uvicorn pid>"
# server frozen (hanging afterwards), then resumed:
NOSEC=1 OFFICIAL_HASH=c51b1b82b5269ce6 REVIVE_CMD="kill -CONT <pid>" node drive-pw.mjs kill http://127.0.0.1:8094 "kill -STOP <pid>"
```
`NOSEC=1` launches the test browser with `--disable-web-security`. The preview origin is not in
`api.cors_origins` (see "Other findings"), and without the flag the browser blocks the API, so the app shows
offline from the start. The flag affects only the drill browser. The app and the server run unchanged.

Before the kill:
- Console: `ready` was reached in about 0.5 s, with the banner hidden, the pad tool visible and 23% shown.
- The official permalink rendered "Precomputed · official plan · provenance of plan c51b1b82b5269ce6 | 23% |
  reachable of the assessed flat disc within 30 min. | Range 15.2% …".

After the kill, measured on the console with a 100 ms probe:

| Run | Way the server went down | Banner shown and pad tool hidden after |
|---|---|---|
| 1 | `kill` (refused) | 2947 ms |
| 2 | `kill` (refused) | 2541 ms |
| 3 | `kill` (refused) | 2544 ms |
| 1 | `kill -STOP` (hanging) | 3865 ms |
| 2 | `kill -STOP` (hanging) | 4778 ms |
| 3 | `kill -STOP` (hanging) | 3561 ms |

This matches the design: at most one poll interval (3 s) for a refused connection, and one poll interval plus
the 2 s timeout (≤ 5 s) for a hang.

Also after the kill:
- The official permalink, which had already been opened in the session, showed the offline text within
  95–159 ms: "Live planning is offline · showing precomputed plans. This plan needs the live server.". The
  Play, Export and simulator controls were gone (0 live controls).
- The static views kept working: `#/trade`, `#/scorecard`, `#/conditions` and `#/` all rendered, with the
  banner offline, 0 live controls, and 23% on the console.
- Recovery: after a restart or `kill -CONT`, the console went back to `ready` with the pad tool in 2.9–4.1 s,
  and the permalink showed the precomputed plan with 23% again.
- Uncaught errors in all six runs: **0**.

### Step 4: official permalink with the server down — PASS
With no server on 8012 or a hanging one on 8091 (`drive-pw.mjs offline`, `OFFICIAL_HASH=c51b1b82b5269ce6`):
- Fresh document load of `#/plan/c51b1b82b5269ce6`: the offline text "Live planning is offline · showing
  precomputed plans. This plan needs the live server. Back to the plan." appears after 6 ms when the
  connection is refused and after 2031 ms when the server hangs. The h1 reads "Plan c51b1b82b5269ce6".
  In run 1, the hanging case took 15 s (the request timeout); it now follows the health state.
- In-app hash change from `#/`: the offline text appears after 78–336 ms.
- The page does not crash.

### Other findings (not fallback failures)
1. **The static console races its map setup when you leave the view early.** This is for the WS5/console owner.
   - Symptom: navigating away from `#/` within about 1 s of the headline appearing logs
     `Error: Cannot add layer "siting-img" (or "unknown-hatch") before non-existing layer "iso-lines"`
     (console.error from `consoleMap.setSiting` / `setUnknownMask`). Sometimes it also throws an uncaught
     `TypeError: Cannot read properties of undefined (reading 'setData')` at `consoleMap.setRoute`.
   - Reproduced with `drive-pw.mjs race` (reload `#/`, wait for 23%, go to `#/trade`, ×5–8) in three builds:
     - the flag-off static build (1 error in 5)
     - the live build (2 in 5)
     - a static build of the old 19b7ce2 sources (3 in 8)
   - It is pre-existing and independent of the live layer. A plain load with no early navigation logs 0 errors.
   - Run 1's CDP driver waited 1.5 s on the console before navigating, which is why it did not show up there.
   - Suggested fix: in `views/console.tsx`, stop the async layer effects after unmount or when the map is gone.
2. **CORS.** `api.cors_origins` contains only Pages, the custom domain and `http://localhost:5173`. A live
   build served from any other origin is blocked by the browser and shows the offline banner. That is safe,
   but it is not live. Examples are `vite preview` (default port 4173) and any 80xx port. The demo must serve
   the app from 5173 or Pages, or add its origin to the list.
3. While a permalink loads, its label briefly reads "Computed live · not part of the validated scorecard"
   (PlanLoading uses `LIVE_LABEL`) before the run record says "Precomputed · official plan". This is cosmetic.

## History: run 1 (19b7ce2, 2026-11-15 ~01:00–01:40) — step 3 FAILED

- Run 1 used a hand-written CDP driver, because Playwright was not yet in `web/node_modules`. The ports were
  the same, the API was on 8022, and the official hash at that HEAD was `c20497ca023aab37`.
- Steps 1, 2 and 4 passed:
  - 751 tests passed.
  - The banner showed after 123 ms (refused) or 2227 ms (hanging), with 0 live controls and 23% on the console.
  - The permalink showed the offline text.
- **Step 3 failed.** After `kill <uvicorn pid>`:
  - Over 60 s with a 250 ms probe, `data-state` stayed `ready`, the banner stayed hidden, and the pad tool
    stayed visible.
  - The static views kept working.
  - A permalink already opened in the session still rendered from cache, with Play and Export visible.
  - Only a page reload brought the banner back, in 143–176 ms.
  - Cause: `watchHealth` in `web/src/live/health.ts` re-checked only while `warming`. It stopped at `ready`
    ("a page reload checks again").
- Run 1 also noted that, with a hanging server, a permalink waited the 15 s request timeout before it showed
  the offline text.
- Fixed by PR #56 (9392cd8, U1b). The run-1 record and its CDP driver are in this file's history at commit
  c7e4ea7 (first H2 commit).

## Appendix: drive-pw.mjs (run 2 driver)

Usage: `[PW=…/playwright/index.mjs] [CHROMIUM=…] [NOSEC=1] [OFFICIAL_HASH=…] [REVIVE_CMD=…] node drive-pw.mjs plain|race|offline|kill <base> [killCmd]`

`blackhole.mjs` is `net.createServer((s) => keep(s)).listen(8091, '127.0.0.1')`.

`revive.sh` restarts the same uvicorn command in the background.

```js
// H2 fallback drill driver (run 2): Playwright from web/node_modules, launching the system Chromium
// (Playwright's bundled browser does not start on NixOS; see web/playwright.config HL_CHROMIUM).
// usage: node drive-pw.mjs offline|kill <baseUrl> [killCmd]
//   offline : no API: time the banner, check live controls, 23 %, static views, official permalink
//   kill    : API up: wait for ready, open the official permalink, run killCmd (kill or kill -STOP),
//             time the banner, check controls, static views, permalink; REVIVE_CMD optionally restarts
// env: PW=<path to web/node_modules/playwright/index.mjs>, CHROMIUM (default: `chromium` on PATH),
//      NOSEC=1 (--disable-web-security: the preview origin is not in api.cors_origins), OFFICIAL_HASH,
//      KILL_WAIT_MS (default 20000), REVIVE_CMD
import { execSync } from 'node:child_process'
const { chromium } = await import(process.env.PW ?? '/home/vincent/coding/hl-h2/web/node_modules/playwright/index.mjs')
const [mode, base, killCmd] = process.argv.slice(2)
const OFFICIAL = process.env.OFFICIAL_HASH ?? 'c20497ca023aab37'
const exe = process.env.CHROMIUM ?? execSync('command -v chromium').toString().trim()
const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
if (process.env.NOSEC === '1') args.push('--disable-web-security')
const browser = await chromium.launch({ executablePath: exe, headless: true, args })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const errors = [], logs = []
page.on('pageerror', (e) => errors.push(`[${((performance.now() - T0) / 1000).toFixed(2)}s] UNCAUGHT ` + e.message + ' @ ' + (e.stack ?? '').split('\n').slice(1, 3).join(' ')))
page.on('console', (m) => { logs.push(`${m.type()}: ${m.text()}`); if (m.type() === 'error' && !/Failed to load resource|blocked by CORS/.test(m.text())) errors.push(`[${((performance.now() - T0) / 1000).toFixed(2)}s] console.error ` + m.text().split('\n')[0]) })
const T0 = performance.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[${((performance.now() - T0) / 1000).toFixed(2)}s]`, ...a)
const probe = () => page.evaluate(() => {
  const l = document.querySelector('.live-status')
  const vis = (e) => !!(e && (e.offsetWidth || e.offsetHeight || e.getClientRects().length))
  const liveCtl = [...document.querySelectorAll('.live-pad, .live-btn, .live-import, input[type=file], [class*="live-"] button, [class*="live-"] a[download]')].filter(vis).length
  const txt = document.body?.innerText ?? ''
  const plan = document.querySelector('.live-plan')
  return {
    banner: l ? { hidden: l.hidden, visible: vis(l), state: l.dataset.state, text: l.textContent } : null,
    liveControlsVisible: liveCtl,
    has23: /(^|\D)23\s*%/.test(txt),
    route: document.body?.dataset.route ?? null,
    planOffline: vis(plan) ? (plan.querySelector('.live-offline')?.innerText ?? null) : null,
    planText: vis(plan) ? plan.innerText.replace(/\n+/g, ' | ').slice(0, 220) : null,
    outlet: (document.querySelector('.outlet')?.innerText ?? '').replace(/\n+/g, ' | ').slice(0, 70),
  }
}).catch(() => ({ banner: null, liveControlsVisible: -1, has23: false }))
async function waitFor(pred, ms, step = 100) {
  const t0 = performance.now()
  while (performance.now() - t0 < ms) {
    const p = await probe()
    if (pred(p)) return { ms: Math.round(performance.now() - t0), p }
    await sleep(step)
  }
  return { ms: null, p: await probe() }
}
const isOffline = (p) => p.banner && !p.banner.hidden && p.banner.visible && p.banner.state === 'offline'
const short = (p) => JSON.stringify(p)
const hash = (h) => page.evaluate((h) => { location.hash = h }, h)
async function staticViews(tag) {
  for (const h of ['#/trade', '#/scorecard', '#/conditions', '#/']) {
    await hash(h); await sleep(1200)
    const p = await probe()
    log(tag, h, short({ route: p.route, banner: p.banner?.state, liveCtl: p.liveControlsVisible, has23: p.has23, outlet: p.outlet }))
  }
}
try {
  if (mode === 'race') {
    // leave the console soon after its headline renders (map layers may still be loading)
    for (let i = 0; i < Number(process.env.RACE_N ?? 5); i++) {
      await page.goto(base + '/#/'); await page.reload()
      await waitFor((p) => p.has23, 15000, 20)
      await sleep(Number(process.env.RACE_DELAY_MS ?? 0))
      await hash('#/trade'); await sleep(2500)
      log('race', i, 'errors so far', errors.length)
    }
  } else if (mode === 'plain') {
    await page.goto(base + '/' + (process.env.START_HASH ?? '#/'))
    await sleep(Number(process.env.PLAIN_MS ?? 10000))
    log('plain load:', short(await probe()))
  } else if (mode === 'offline') {
    await page.goto(base + '/#/')
    const b = await waitFor(isOffline, 15000)
    log('banner offline after ms:', b.ms, short(b.p))
    const c = await waitFor((p) => p.has23, 15000)
    log('23 % present after ms:', c.ms, 'liveCtl', c.p.liveControlsVisible)
    await staticViews('offline')
    await page.goto(base + '/#/plan/' + OFFICIAL); await page.reload() // a real fresh document load
    const pl = await waitFor((p) => p.planOffline, 20000)
    log('permalink fresh load after ms:', pl.ms, short(pl.p))
    await hash('#/'); await sleep(1500)
    await hash('#/plan/' + OFFICIAL)
    const pl2 = await waitFor((p) => p.planOffline, 20000)
    log('permalink in-app after ms:', pl2.ms, short(pl2.p))
  } else if (mode === 'kill') {
    await page.goto(base + '/#/')
    const r = await waitFor((p) => p.banner?.state === 'ready' && p.has23 && p.liveControlsVisible > 0, 15000)
    log('ready + 23 % + live controls after ms:', r.ms, short(r.p))
    await hash('#/plan/' + OFFICIAL)
    await waitFor((p) => p.planText && /Precomputed/.test(p.planText) && /23/.test(p.planText), 10000)
    const up = await probe()
    log('permalink with server up:', short(up))
    await hash('#/')
    await waitFor((p) => p.route === 'console' && p.has23 && p.liveControlsVisible > 0, 10000)
    await sleep(2000)
    log('console before kill:', short(await probe()))
    log('KILL:', killCmd); execSync(killCmd, { stdio: 'inherit' })
    const k = await waitFor((p) => isOffline(p) && p.liveControlsVisible === 0, Number(process.env.KILL_WAIT_MS ?? 20000), 100)
    log('console: banner shown + live controls hidden after kill, ms:', k.ms, short(k.p))
    await hash('#/plan/' + OFFICIAL)
    const pk = await waitFor((p) => p.planOffline, 10000)
    log('permalink opened earlier in the session, after kill, ms:', pk.ms, short(pk.p))
    await staticViews('after kill')
    if (process.env.REVIVE_CMD) {
      log('REVIVE:', process.env.REVIVE_CMD); execSync(process.env.REVIVE_CMD, { stdio: 'inherit' })
      const rv = await waitFor((p) => p.banner?.state === 'ready' && p.liveControlsVisible > 0, 30000, 200)
      log('console ready again after revive, ms:', rv.ms, short(rv.p))
      await hash('#/plan/' + OFFICIAL)
      const pr = await waitFor((p) => p.planText && /Precomputed/.test(p.planText), 15000)
      log('permalink after revive, ms:', pr.ms, short(pr.p))
    }
  }
  log('ERRORS (uncaught + console.error other than network failures):', errors.length); for (const e of errors) log('  ', e)
  log('console entries:', logs.length); for (const e of logs.slice(0, 30)) log('  ', e.slice(0, 260))
} finally {
  await browser.close()
}
```
