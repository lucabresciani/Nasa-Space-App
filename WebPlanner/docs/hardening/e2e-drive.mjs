// H5 end-to-end driver (gate B1′): custom pad on the real demo configuration.
//   API  : make serve (127.0.0.1:8012), HL_SERVER_DATA=~/hl-data/server
//   Web  : cd web && VITE_LIVE=1 npm run dev  (http://localhost:5173, an origin in api.cors_origins)
// Playwright from a worktree's web/node_modules (NOT a dependency of this repo) driving the SYSTEM
// Chromium: Playwright's bundled browser does not start on NixOS. Web security stays ON.
//
// usage: node e2e-drive.mjs [base=http://localhost:5173]
// env:
//   PW            path to playwright/index.mjs (default: ~/coding/hl-h2/web/node_modules/playwright/index.mjs)
//   CHROMIUM      browser binary (default: `chromium` on PATH)
//   OUT           screenshots + result JSON (default /tmp/hl-orch/h5)
//   API           API root (default http://127.0.0.1:8012/api/v1), used only to cross-check numbers
//   OFFICIAL_HASH official plan hash at the HEAD under test (server.engine.hashing.official_hash())
//   PAD_CLICK     spot clicked for the valid pad "lon,lat" (default 137.3933,-4.7745: slope, 96 m north of
//                 rank 2; its nearest valid block is rank 3 137.393301,-4.776114, which the driver then takes)
//   BAD           invalid spot "lon,lat" (default E8's pad 137.401783,-4.771407: disc_off_grid, north edge)
//   JOB_WAIT_S    how long to wait for the full plan (default 660 = job_timeout_s 600 + 60)
//   CREW_PROBE    "field=value" typed into the crew panel (U4) to check its out-of-range flag, e.g. tools_kg=35
//   CREW_SET      "field=value" left in the crew panel for the step-4 job, e.g. tools_kg=30 (+20 kg tools)
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const { chromium } = await import(process.env.PW ?? `${process.env.HOME}/coding/hl-h2/web/node_modules/playwright/index.mjs`)
const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = process.env.OUT ?? '/tmp/hl-orch/h5'
const API = process.env.API ?? 'http://127.0.0.1:8012/api/v1'
const OFFICIAL = process.env.OFFICIAL_HASH ?? 'c51b1b82b5269ce6'
const PCLICK = (process.env.PAD_CLICK ?? '137.3933,-4.7745').split(',').map(Number)
const [BLON, BLAT] = (process.env.BAD ?? '137.401783,-4.771407').split(',').map(Number)
const JOB_WAIT_S = Number(process.env.JOB_WAIT_S ?? 660)
const LIVE_LABEL = 'Computed live · not part of the validated scorecard'
const PRE_LABEL = 'Precomputed · official plan'
mkdirSync(OUT, { recursive: true })

const exe = process.env.CHROMIUM ?? execSync('command -v chromium').toString().trim()
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 1900, height: 1000 }, acceptDownloads: true })
const T0 = performance.now()
const now = () => +((performance.now() - T0) / 1000).toFixed(2)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[${now()}s]`, ...a)
const errors = [], netlog = [], jobPolls = []
const R = { base: BASE, official: OFFICIAL, padClick: PCLICK, bad: [BLON, BLAT], steps: {} }

function watch(page, tag) {
  page.on('pageerror', (e) => errors.push({ t: now(), page: tag, kind: 'uncaught', msg: e.message, stack: (e.stack ?? '').split('\n').slice(1, 3).join(' ') }))
  page.on('console', (m) => { if (m.type() === 'error') errors.push({ t: now(), page: tag, kind: 'console.error', msg: m.text().split('\n')[0] }) })
  page.on('requestfinished', (q) => {
    if (q.method() === 'POST' && q.url().includes('/api/v1/')) netlog.push({ t: now(), page: tag, finished: q.url().replace(/^.*\/api\/v1/, ''), method: 'POST', durationMs: Math.round(q.timing().responseEnd) })
  })
  page.on('requestfailed', (q) => netlog.push({ t: now(), page: tag, failed: q.failure()?.errorText, method: q.method(), url: q.url() }))
  page.on('response', async (r) => {
    const u = r.url()
    if (!u.includes('/api/v1/')) return
    netlog.push({ t: now(), page: tag, status: r.status(), method: r.request().method(), url: u.replace(/^.*\/api\/v1/, '') })
    if (/\/jobs\/[^/]+$/.test(u) && r.request().method() === 'GET') {
      try { const j = await r.json(); jobPolls.push({ t: now(), status: j.status, stage: j.stage, stages_done: j.stages_done, progress: j.progress }) } catch {}
    }
  })
}
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` }).catch((e) => log('screenshot failed', name, e.message))
const txt = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.innerText.replace(/\s+/g, ' ').trim() : null }, sel)
const visible = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!(e && (e.offsetWidth || e.offsetHeight)) }, sel)
async function until(fn, ms, step = 100) {
  const t = performance.now()
  while (performance.now() - t < ms) { const v = await fn().catch(() => null); if (v) return { ms: Math.round(performance.now() - t), v }; await sleep(step) }
  return { ms: null, v: null }
}
const nums = (s) => (s ?? '').match(/-?\d+(?:\.\d+)?/g) ?? []
const apiJson = async (p) => (await fetch(API + p)).json()

const page = await ctx.newPage(); watch(page, 'main')
try {
  // ---------- 1. load: live ready, pad tool, static numbers ----------
  {
    const t = performance.now()
    await page.goto(BASE + '/#/')
    const ready = await until(async () => {
      const st = await page.evaluate(() => { const l = document.querySelector('.live-status'); return l ? { state: l.dataset.state, hidden: l.hidden || !(l.offsetWidth || l.offsetHeight) } : null })
      const pad = await visible(page, '.live-pad')
      const head = await txt(page, '.outlet .headline')
      return st && st.state === 'ready' && pad && head && /(^|\D)23\s*%/.test(head) ? { st, head } : null
    }, 30000)
    await sleep(1500) // let the console map settle (H2 finding 1: leaving early races the layers)
    const offlineBanner = await page.evaluate(() => { const l = document.querySelector('.live-status'); return !!(l && !l.hidden && (l.offsetWidth || l.offsetHeight) && l.dataset.state === 'offline') })
    R.steps[1] = { pass: !!ready.v && !offlineBanner, ms: Math.round(performance.now() - t), readyAfterMs: ready.ms, banner: ready.v?.st, offlineBanner, consoleHeadline: ready.v?.head, padTool: await txt(page, '.live-pad') }
    R.staticHeadline = ready.v?.head
    log('step 1', JSON.stringify(R.steps[1]))
    await shot(page, 'step1-console-ready')
  }

  // ---------- map clicks at a lon/lat ----------
  // The app exposes no map handle, so the driver clicks, reads the pad position the tool reports
  // (".live-pad-pos") and corrects. The live aside changes width with its content, which resizes the
  // map (same zoom and centre, new pixel offset), so the offset is re-anchored on every click and the
  // clickable area (left of the console panel, not covered by an HTML marker) is re-measured.
  const padPos = async () => { const s = await txt(page, '.live-pad-pos'); const m = s && s.match(/(-?\d+\.\d+)°E (-?\d+\.\d+)°N/); return m ? [Number(m[1]), Number(m[2])] : null }
  async function clickAt(x, y) {
    const before = await txt(page, '.live-pad-pos')
    await page.mouse.click(x, y)
    const r = await until(async () => { const s = await txt(page, '.live-pad-pos'); return s && s !== before ? padPos() : null }, 5000, 50)
    await sleep(300) // let the aside re-layout (and the map resize) before the next measurement
    return r.v
  }
  const onCanvas = (x, y) => page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.classList.contains('maplibregl-canvas') ?? false, [x, y])
  async function geom() {
    const c = await page.locator('.outlet .maplibregl-canvas').first().boundingBox()
    const panelX = await page.evaluate(() => document.querySelector('.outlet .headline')?.getBoundingClientRect().x ?? Infinity)
    const right = Math.min(c.x + c.width, panelX - 20)
    const vis = { x1: c.x + 50, x2: right - 30, y1: c.y + 70, y2: c.y + c.height - 50 } // off the zoom buttons + scale bar
    return { vis, cx: Math.round((vis.x1 + vis.x2) / 2), cy: Math.round((vis.y1 + vis.y2) / 2) }
  }
  let g = await geom()
  // scale: vertical clicks only (the resize never moves the map vertically); Web Mercator: dlon = dlat / cos(lat)
  let anchor = { px: [g.cx, g.cy], ll: await clickAt(g.cx, g.cy) }
  const llB = await clickAt(g.cx, g.cy + 120)
  const sy = (llB[1] - anchor.ll[1]) / 120
  const sx = -sy / Math.cos((anchor.ll[1] * Math.PI) / 180)
  anchor = { px: [g.cx, g.cy + 120], ll: llB }
  R.calibration = { vis: g.vis, degPerPx: [sx, sy], mPerPx: -sy * 111320 }
  log('calibration', JSON.stringify(R.calibration))
  const toPx = ([lon, lat]) => [anchor.px[0] + (lon - anchor.ll[0]) / sx, anchor.px[1] + (lat - anchor.ll[1]) / sy]
  const inside = ([x, y]) => x >= g.vis.x1 && x <= g.vis.x2 && y >= g.vis.y1 && y <= g.vis.y2
  async function reanchor() { g = await geom(); const ll = await clickAt(g.cx, g.cy); if (ll) anchor = { px: [g.cx, g.cy], ll } }
  async function clickLonLat(target, tolPx = 1.5) {
    let got = null
    for (let i = 0; i < 8; i++) {
      g = await geom()
      if (!inside(toPx(target))) {
        // drag the map (a pan fires no click) so the target moves towards the centre, then re-anchor
        const [tx, ty] = toPx(target)
        const lim = (v, m) => Math.max(-m, Math.min(m, v))
        const dx = lim(g.cx - tx, (g.vis.x2 - g.vis.x1) / 2 - 5), dy = lim(g.cy - ty, (g.vis.y2 - g.vis.y1) / 2 - 5)
        await page.mouse.move(g.cx - dx / 2, g.cy - dy / 2); await page.mouse.down()
        await page.mouse.move(g.cx + dx / 2, g.cy + dy / 2, { steps: 12 }); await page.mouse.up()
        await sleep(500); await reanchor(); continue
      }
      const [x, y] = toPx(target)
      if (!(await onCanvas(x, y))) throw new Error(`target ${target} at px ${Math.round(x)},${Math.round(y)} is covered by ${await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.outerHTML.slice(0, 120), [x, y])}`)
      got = await clickAt(x, y)
      if (!got) throw new Error(`click at ${Math.round(x)},${Math.round(y)} did not move the pad`)
      anchor = { px: [x, y], ll: got } // re-anchored on the reported position (the map may have resized meanwhile)
      if (Math.hypot((got[0] - target[0]) / sx, (got[1] - target[1]) / sy) <= tolPx) break
      g = await geom() // the click's answer may have resized the map: the next pass measures again
      const ll = await clickAt(g.cx, g.cy); if (ll) anchor = { px: [g.cx, g.cy], ll }
    }
    return got
  }

  // ---------- 2. invalid spot: reason + nearest valid block ----------
  {
    const t = performance.now()
    const got = await clickLonLat([BLON, BLAT])
    const r = await until(async () => (await visible(page, '.live-invalid')) ? { reason: await page.getAttribute('.live-reason', 'data-reason'), text: await txt(page, '.live-invalid') } : null, 10000, 50)
    const nearestBtn = await visible(page, '.live-nearest .live-btn')
    R.steps[2] = { pass: !!r.v && !!r.v.reason && nearestBtn, clicked: got, reasonAfterMs: r.ms, ...r.v, nearestButton: nearestBtn, msTotal: Math.round(performance.now() - t) }
    log('step 2', JSON.stringify(R.steps[2]))
    await shot(page, 'step2-invalid-pad')
  }

  // ---------- 3. valid pad -> instant preview flagged as estimates ----------
  // Rank 2's own location is covered by its "#2" HTML marker (a click there never reaches the map), so
  // the driver clicks PAD_CLICK, an invalid (slope) spot just north of the rank-2/3 blocks, and takes
  // "Use the nearest valid block". If PAD_CLICK validates directly, the preview follows that click.
  {
    const t = performance.now()
    const clicked = await clickLonLat(PCLICK)
    await until(async () => (await visible(page, '.live-invalid')) || (await visible(page, '.live-ok')) || null, 10000, 50)
    let via = 'click'
    let nearestOffered = null
    if (await visible(page, '.live-nearest .live-btn')) {
      nearestOffered = await txt(page, '.live-nearest')
      await shot(page, 'step3a-invalid-near-rank2')
      await page.click('.live-nearest .live-btn')
      via = 'nearest valid block'
    }
    const tClick = performance.now()
    const r = await until(async () => (await visible(page, '.live-preview')) && (await visible(page, '.live-ok')) ? true : null, 10000, 50)
    const ms = r.ms === null ? null : Math.round(performance.now() - tClick)
    const flagged = await page.evaluate(() => {
      const card = document.querySelector('.live-preview')
      const all = card ? [...card.querySelectorAll('.num')] : []
      return { nums: all.length, screen: all.filter((e) => e.classList.contains('num-screen')).length, unknown: all.filter((e) => e.classList.contains('num-unknown')).length, title: all[0]?.getAttribute('title') ?? null }
    })
    const pad = await padPos()
    // "within about 2 s" -> 2500 ms; every number on the card is an estimate (num-screen) or unknown
    R.steps[3] = { pass: !!r.v && ms !== null && ms <= 2500 && flagged.screen > 0 && flagged.screen + flagged.unknown === flagged.nums, clicked, via, nearestOffered, pad, previewAfterMs: ms, flagged, card: await txt(page, '.live-preview'), msTotal: Math.round(performance.now() - t) }
    R.customPad = pad
    log('step 3', JSON.stringify(R.steps[3]))
    await shot(page, 'step3-preview')
  }

  // ---------- 7 (optional). crew panel (U4): out-of-range flag, then the crew used by the step-4 job ----------
  // CREW_PROBE=field=value (expected outside its range), CREW_SET=field=value (sent with the job).
  if (process.env.CREW_SET || process.env.CREW_PROBE) {
    const t = performance.now()
    const crew = { set: process.env.CREW_SET ?? null, probe: process.env.CREW_PROBE ?? null }
    await until(async () => (await visible(page, '.live-crew-fields')) || null, 15000)
    const setField = async (kv) => {
      const [f, v] = kv.split('=')
      await page.fill(`#live-crew-${f}`, v)
      await sleep(300)
      return page.evaluate((f) => {
        const tr = document.querySelector(`.live-crew tr[data-field="${f}"]`)
        return { field: f, check: tr?.dataset.check ?? null, row: tr?.innerText.replace(/\s+/g, ' ').trim() ?? null, flag: tr?.querySelector('.live-extrapolation')?.innerText ?? null, blocked: document.querySelector('.live-compute')?.disabled ?? null }
      }, f)
    }
    if (crew.probe) { crew.probeResult = await setField(crew.probe); await shot(page, 'step7a-crew-out-of-range') }
    if (crew.set) { crew.setResult = await setField(crew.set); await shot(page, 'step7b-crew-set') }
    crew.panel = await txt(page, '.live-crew')
    crew.ms = Math.round(performance.now() - t)
    R.crew = crew
    log('crew', JSON.stringify(crew))
  }

  // ---------- 4. full plan: staged, nominal band + route first, done, label + provenance ----------
  let hash = null
  {
    const t = performance.now()
    await page.click('.live-compute')
    const order = [], stageAt = {}, shots = new Set()
    let last = null, final = null, lastHead = null, firstDrawn = null
    const headlines = [] // (H5r) what the headline area shows while the job runs (nominal-only phase: range [null, null])
    const t0net = (t - T0) / 1000
    while ((performance.now() - t) / 1000 < JOB_WAIT_S) {
      const s = await page.evaluate(() => {
        const p = document.querySelector('.live-pad .live-plan')
        if (!p) return null
        const prov = p.querySelector('.live-prov')
        return { kind: p.dataset.plan, progress: p.querySelector('.live-progress')?.innerText ?? null, stages: p.querySelector('.live-stages')?.innerText ?? null, label: p.querySelector('.live-label')?.innerText ?? null, prov: prov?.getAttribute('href') ?? null, headline: p.querySelector('.live-headline')?.innerText ?? null, failed: p.querySelector('.live-failed')?.innerText ?? null, flags: p.querySelector('.live-range-flags-box')?.innerText ?? p.querySelector('.live-no-flags')?.innerText ?? null, attached: p.querySelector('.live-attached')?.innerText ?? null, errs: p.querySelector('.live-errors')?.innerText ?? null }
      }).catch(() => null)
      if (s) {
        const done = (s.stages ?? '').replace('Stages on the map: ', '').split(', ').filter(Boolean)
        for (const st of done) if (!(st in stageAt)) { stageAt[st] = +((performance.now() - t) / 1000).toFixed(1); order.push(st); log('stage on the map:', st, stageAt[st], 's') }
        if (!hash && s.prov) hash = (s.prov.match(/#\/plan\/([0-9a-f]+)/) ?? [])[1] ?? null
        if (done.length && !shots.has(done.length)) { shots.add(done.length); await shot(page, `step4-stage${done.length}-${done.at(-1)}`) }
        const at = +((performance.now() - t) / 1000).toFixed(1)
        const head = s.headline ?? (await txt(page, '.live-pad .live-plan .muted'))
        if (head !== lastHead) { lastHead = head; headlines.push({ s: at, kind: s.kind, stages: s.stages, headline: head }); log('headline area:', JSON.stringify(head)) }
        // (H5r) the first map file of the result tree (band or route, 200) while the job runs: screenshot that moment
        if (!firstDrawn) {
          const n = netlog.find((n) => n.t >= t0net && n.status === 200 && n.method === 'GET' && /^\/results\/[0-9a-f]+\/(route_|scenarios\/bands_)/.test(n.url ?? ''))
          if (n) {
            await sleep(1500) // let maplibre draw the layers
            firstDrawn = { fetchS: +(n.t - t0net).toFixed(1), url: n.url, shotS: +((performance.now() - t) / 1000).toFixed(1), kind: s.kind, stages: s.stages, headline: await txt(page, '.live-pad .live-plan .live-headline'), plan: await txt(page, '.live-pad .live-plan') }
            log("first map content", JSON.stringify(firstDrawn))
            await shot(page, 'step4-first-map')
          }
        }
        const key = JSON.stringify([s.kind, s.progress?.slice(0, 40)])
        if (key !== last) { last = key; log('plan', s.kind, s.progress ?? '') }
        if (s.kind === 'done' || s.kind === 'failed' || s.kind === 'cancelled') { final = s; break }
      }
      await sleep(500)
    }
    const totalS = +((performance.now() - t) / 1000).toFixed(1)
    if (final?.kind === 'done' && !final.flags) {
      // the run record (range flags) is read after the job is done (U4)
      const f = await until(() => page.evaluate(() => { const p = document.querySelector('.live-pad .live-plan'); return p?.querySelector('.live-range-flags-box')?.innerText ?? p?.querySelector('.live-no-flags')?.innerText ?? null }), 5000)
      final.flags = f.v
    }
    // what the page fetched from the result tree, in seconds since "Compute full plan" (same clock as stageAt)
    const t0s = (t - T0) / 1000
    const resNet = netlog.filter((n) => hash && n.url && n.url.startsWith(`/results/${hash}/`) && n.method === 'GET').map((n) => ({ ...n, s: +(n.t - t0s).toFixed(1) }))
    const firstMap = (f) => resNet.find((n) => n.url.includes(f) && n.status === 200)?.s ?? null
    const firstStageT = stageAt[order[0]]
    R.steps[4] = {
      hash, final: final?.kind ?? 'timeout', totalS, order, stageAt,
      firstMapFiles: { band: firstMap('bands_'), route: firstMap('route_'), isochrones: firstMap('isochrones'), index: firstMap('scenarios/index.json'), manifest: firstMap('manifest.json') },
      resultFetches: resNet.map((n) => `${n.s}s ${n.status} ${n.url.replace(`/results/${hash}/`, '')}`),
      label: final?.label ?? null, labelOk: !!final?.label?.includes(LIVE_LABEL), provHref: final?.prov ?? null,
      headline: final?.headline ?? null, rangeFlags: final?.flags ?? null, attached: final?.attached ?? null, failed: final?.failed ?? null, contractErrors: final?.errs ?? null,
      uncaughtSoFar: errors.filter((e) => e.kind === 'uncaught').length,
      firstDrawn, headlines,
      notFound404: errors.filter((e) => e.t >= t0net && /404/.test(e.msg)).length,
    }
    R.steps[4].nominalFirst = order[0] === 'nominal'
    // "the nominal band and route appear on the map first": both fetched (200) before the first job poll that
    // says done. A job that was already done at its first poll (cached / attached) cannot show this: 'cached'.
    const fm = R.steps[4].firstMapFiles
    const polls = jobPolls.filter((p) => p.t >= t0s)
    const doneAt = polls.find((p) => p.status === 'done')?.t
    const cached = polls.length > 0 && polls[0].status === 'done'
    R.steps[4].jobDoneAtS = doneAt === undefined ? null : +(doneAt - t0s).toFixed(1)
    R.steps[4].mapBeforeDone = cached ? 'cached' : fm.band !== null && fm.route !== null && doneAt !== undefined && fm.band < doneAt - t0s - 0.5 && fm.route < doneAt - t0s - 0.5
    R.steps[4].pass = final?.kind === 'done' && R.steps[4].nominalFirst && R.steps[4].mapBeforeDone !== false && R.steps[4].labelOk && !!hash && R.steps[4].provHref === `#/plan/${hash}` && !final?.errs && R.steps[4].uncaughtSoFar === 0
    log('step 4', JSON.stringify(R.steps[4]), 'first stage at', firstStageT)
    await shot(page, 'step4-done')
    // zoom the map out (wheel over the visible map) so the live band and route are in frame
    const gz = await geom(); await page.mouse.move(gz.cx, gz.cy)
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 400); await sleep(400) }
    await sleep(1500); await shot(page, 'step4-done-zoomed-out')
  }

  // ---------- 5. permalink in a fresh page; provenance; export + re-import ----------
  if (hash) {
    const p2 = await ctx.newPage(); watch(p2, 'permalink')
    const t = performance.now()
    await p2.goto(`${BASE}/#/plan/${hash}`)
    const r = await until(async () => {
      const o = await p2.getAttribute('.live-plan-page .live-label[data-origin]', 'data-origin').catch(() => null)
      const h = await txt(p2, '.live-plan-page .live-headline')
      return o && h && !/Loading/.test(h) ? { origin: o, headline: h } : null
    }, 20000)
    await sleep(800)
    const numInfo = await p2.evaluate(() => ({ ok: document.querySelectorAll('.live-plan-page .num-live').length, withheld: document.querySelectorAll('.live-plan-page .num-withheld').length, label: document.querySelector('.live-plan-page .live-label')?.innerText ?? null }))
    // cross-check the headline against the result's own index.json + manifest
    const idx = await apiJson(`/results/${hash}/scenarios/index.json`)
    const man = await apiJson(`/results/${hash}/manifest.json`)
    const sid = idx.default ?? idx.scenarios?.[0]?.id
    const sc = (idx.scenarios ?? []).find((s) => s.id === sid)
    const b = sc?.headline?.budget_min
    const key = `reachable_pct.${sid}.${b}`
    const inManifest = JSON.stringify(man).includes(key)
    const shown = nums(r.v?.headline)[0]
    await shot(p2, 'step5-permalink')
    const permalinkMs = r.ms
    // provenance view
    await p2.evaluate((h) => { location.hash = `#/plan/${h}/provenance` }, hash)
    const pv = await until(async () => (await txt(p2, '.live-origin')) ? { origin: await txt(p2, '.live-origin'), stages: await txt(p2, '.live-plan-page table.live-stages'), table: await txt(p2, '.live-prov-table') } : null, 10000)
    await shot(p2, 'step5-provenance')
    // export plan_inputs.json (data: URL of the export link) and re-import it on #/plan
    await p2.evaluate((h) => { location.hash = `#/plan/${h}` }, hash)
    await until(async () => (await visible(p2, '.live-export')) || null, 10000)
    const exportText = await p2.evaluate(async () => { const a = document.querySelector('.live-export'); return a ? (await fetch(a.href)).text() : null })
    const exportName = await p2.getAttribute('.live-export', 'download')
    writeFileSync(`${OUT}/plan_inputs.json`, exportText ?? '')
    await p2.evaluate(() => { location.hash = '#/plan' })
    await until(async () => (await visible(p2, '.live-import input[type=file]')) || null, 10000)
    const ti = performance.now()
    await p2.setInputFiles('.live-import input[type=file]', `${OUT}/plan_inputs.json`)
    const im = await until(async () => {
      const h = await p2.evaluate(() => location.hash)
      const o = await p2.getAttribute('.live-plan-page .live-label[data-origin]', 'data-origin').catch(() => null)
      return h === `#/plan/${hash}` && o ? { hash: h, origin: o } : null
    }, 15000, 50)
    const importMs = im.ms === null ? null : Math.round(performance.now() - ti)
    const importNet = netlog.filter((n) => n.page === 'permalink' && n.url && (n.url.startsWith('/plans/import') || n.url.startsWith('/jobs')) && n.t >= (ti - T0) / 1000 - 0.1)
    await shot(p2, 'step5-reimport')
    R.steps[5] = {
      permalinkMs, origin: r.v?.origin, headline: r.v?.headline, liveNums: numInfo.ok, withheld: numInfo.withheld, label: numInfo.label,
      check: { scenario: sid, key, inManifest, valueInIndex: sc?.headline?.reachable_pct, shownFirstNumber: shown },
      provenance: pv.v, exportName, exportBytes: exportText?.length ?? 0, importMs, importLanded: im.v, importNet,
      msTotal: Math.round(performance.now() - t),
    }
    const valMatch = shown !== undefined && sc && Math.abs(Number(shown) - sc.headline.reachable_pct) < 0.051
    R.steps[5].pass = r.v?.origin === 'computed_live' && numInfo.withheld === 0 && numInfo.ok > 0 && inManifest && valMatch &&
      pv.v?.origin === 'computed_live' && !!pv.v?.stages && exportName === 'plan_inputs.json' && !!im.v && importMs !== null && importMs < 3000
    log('step 5', JSON.stringify(R.steps[5]))
    await p2.close()
  } else R.steps[5] = { pass: false, why: 'no hash from step 4' }

  // ---------- 6. official permalink == static console ----------
  {
    const p3 = await ctx.newPage(); watch(p3, 'official')
    const t = performance.now()
    await p3.goto(`${BASE}/#/plan/${OFFICIAL}`)
    const r = await until(async () => {
      const o = await p3.getAttribute('.live-plan-page .live-label[data-origin]', 'data-origin').catch(() => null)
      const h = await txt(p3, '.live-plan-page .live-headline')
      return o === 'precomputed' && h ? { origin: o, label: await txt(p3, '.live-plan-page .live-label[data-origin]'), headline: h } : null
    }, 20000)
    await sleep(800)
    await shot(p3, 'step6-official')
    const a = nums(R.staticHeadline).slice(0, 3), b = nums(r.v?.headline).slice(0, 3)
    R.steps[6] = { ms: r.ms, ...r.v, staticHeadline: R.staticHeadline, consoleNums: a, planNums: b, withheld: await p3.evaluate(() => document.querySelectorAll('.live-plan-page .num-withheld').length) }
    R.steps[6].pass = !!r.v && r.v.label.includes(PRE_LABEL) && a.length === 3 && JSON.stringify(a) === JSON.stringify(b) && R.steps[6].withheld === 0
    log('step 6', JSON.stringify(R.steps[6]))
    await p3.close()
  }
} catch (e) {
  R.fatal = String(e?.stack ?? e)
  log('FATAL', R.fatal)
  await shot(page, 'fatal')
} finally {
  R.errors = errors
  R.jobPolls = jobPolls
  R.netlog = netlog
  writeFileSync(`${OUT}/e2e-result.json`, JSON.stringify(R, null, 2))
  log('errors (uncaught + console.error):', errors.length); for (const e of errors) log('  ', JSON.stringify(e).slice(0, 300))
  log('PASS per step:', JSON.stringify(Object.fromEntries(Object.entries(R.steps).map(([k, v]) => [k, v.pass]))))
  await browser.close()
}
