// WP8a (D97 waypoint block): end-to-end driver for the route features, in the style of
// docs/hardening/e2e-drive.mjs (H5): Playwright from a worktree's node_modules (NOT a dependency of
// this repo) driving the SYSTEM Chromium headless (Playwright's bundled browser does not start on
// NixOS), web security ON, timings per scenario, screenshots + one JSON result per run.
//
//   node tests/e2e/route/drive-route.mjs --mock                       # mock API (mock-api.mjs) + Vite dev
//   node tests/e2e/route/drive-route.mjs --real http://127.0.0.1:8012 --official-hash <hash>
//
// Modes
//   --mock          starts mock-api.mjs on --api-port (8170) and the web (serve-web.mjs, Vite dev, VITE_LIVE=1,
//                   VITE_API_BASE = the mock) on --web-port (4230). Ports: 8150-8199 / 4200-4299 only.
//   --real <origin> uses that API read-only: it only submits normal plan jobs (and one refused 422 job).
//                   The web runs on --web-port with Vite proxying /api/v1 to <origin> (same origin; the
//                   real API's CORS list has only localhost:5173 and Pages), unless --web <url> is given.
// Options
//   --web <url>         use an already running web app instead of starting one
//   --web-dir <dir>     web/ of the checkout under test (default: this checkout's web/)
//   --scenarios a,b,..  subset (default all: a b c d e f g)
//   --ordered S4,S1,S2  stops of scenario a (picked in this order)
//   --infeasible S4,S1,S2,S7,S8   stops of scenario b (the mock's time model fails it on leg S7 -> S8)
//   --official-hash <h> official plan hash for g (mock: the mock's own; real: required for g,
//                       `uv run --no-sync python -c "from server.engine.hashing import official_hash; print(official_hash())"`)
//   --job-wait-s <s>    per job (mock 120, real 900: job_timeout_s 600 + queue)
//   --stage-ms <ms>     mock stage length (default 4000: five stages = 20 s)
//   --wp6               run scenario d (free points); skipped until WP6 lands (TODO selectors below)
//   --out <dir>         screenshots + route-e2e-result.json (default $OUT or /tmp/hl-way/wp8a/run)
// env: PW (playwright/index.mjs), CHROMIUM (browser binary)
import { execSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = (k) => argv.includes(k)
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d }
const REAL = opt('--real', null)
const MOCK = flag('--mock') || !REAL
const API_PORT = Number(opt('--api-port', 8170))
const WEB_PORT = Number(opt('--web-port', 4230))
if (MOCK && !(API_PORT >= 8150 && API_PORT <= 8199)) throw new Error('--api-port: 8150-8199 only (8012 is the demo)')
const WEB_DIR = resolve(opt('--web-dir', resolve(HERE, '../../../web')))
const REPO = resolve(WEB_DIR, '..')
const OUT = opt('--out', process.env.OUT ?? '/tmp/hl-way/wp8a/run')
const ONLY = (opt('--scenarios', 'a,b,c,d,e,f,g')).split(',')
const ORDERED = opt('--ordered', 'S4,S1,S2').split(',')
const INFEASIBLE = opt('--infeasible', 'S4,S1,S2,S7,S8').split(',')
const JOB_WAIT_S = Number(opt('--job-wait-s', MOCK ? 120 : 900))
const STAGE_MS = Number(opt('--stage-ms', 4000))
const WP6 = flag('--wp6')
mkdirSync(OUT, { recursive: true })

// Interface text the checks read (web/src/edit/route/text.ts ROUTE_TEXT / LIMIT_TEXT, R5 #110).
const TXT = { computed: 'Computed live', infeasibleLeg: (n, from, to) => `Leg ${n}: ${from} → ${to}`, short: (m) => `Short by ${m} min` }
const LIMIT_WORD = { O2: 'O₂', daylight: 'Daylight', 'EVA duration': 'EVA length', dose: 'Radiation dose' }
const PRE_LABEL = 'Precomputed · official plan'

// Selectors (R5 #110 panel.tsx; R7 plans/view.tsx, planview.tsx). Stable: data-* and BEM classes.
const S = {
  section: 'section.hl-rail__section[aria-label="Stations and route"]',
  panel: '.hl-route',
  mode: (m) => `.hl-route__modebtn[data-value="${m}"]`,
  check: (id) => `.hl-route__stop[data-station="${id}"] .hl-route__check`,
  checkedRows: '.hl-route__stop.is-checked',
  legs: '.hl-route__legs .hl-route__leg',
  compute: '.hl-route__compute',
  panelHash: '.hl-route__hash code',
  stageFirst: '.hl-route__stage[data-stage="first"]',
  stageRest: '.hl-route__stage[data-stage="rest"]',
  progress: '.hl-route__progress',
  result: '.hl-route__result',
  label: '.hl-route__label',
  prov: '.hl-route__prov',
  ok: '.hl-route__ok',
  infeasible: '.hl-route__infeasible',
  failed: '.hl-route__failed',
  liveStatus: '.live-status',
  headline: '.headline',
  // R7
  planPage: '.live-plan-page',
  planLabel: '.live-plan-page .live-label[data-origin]',
  planHeadline: '.live-plan-page .live-headline',
  routeMode: '.live-route-mode',
  routeStops: '.live-route-stops li',
  save: '.live-plan-save button',
  myplan: (h) => `.live-myplan[data-hash="${h}"]`,
  importInput: '.live-import input[type=file]',
  // WP6 (not built yet): TODO selectors, requested from WP6 in the PR. Scenario d is skipped without --wp6.
  wp6AddPoint: '[data-route-action="add-point"]', // TODO(WP6): "Add a point" toggle; then a map click adds W{n}
  wp6Point: (n) => `.hl-route__stop[data-point="W${n}"]`, // TODO(WP6): list row of free point W{n}
  wp6Marker: (n) => `.hl-route-marker[data-point="W${n}"]`, // TODO(WP6): draggable map marker of W{n}
  wp6Label: (n) => `.hl-route__stop[data-point="W${n}"] input[name="label"]`, // TODO(WP6): rename field
  wp6Delete: (n) => `.hl-route__stop[data-point="W${n}"] [data-route-action="delete-point"]`, // TODO(WP6)
  wp6Validity: (n) => `.hl-route__stop[data-point="W${n}"] [data-validity]`, // as stations (panel.tsx)
  wp6Ghost: '[data-route-ghost]', // TODO(WP6): ghost route summary labelled "estimate"
}

const T0 = performance.now()
const now = () => +((performance.now() - T0) / 1000).toFixed(2)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[${now()}s]`, ...a)
const R = { mode: MOCK ? 'mock' : 'real', startedUtc: new Date().toISOString(), webDir: WEB_DIR, ordered: ORDERED, infeasible: INFEASIBLE, scenarios: {} }
const children = []
let mock = null

// ---------- servers ----------
async function startServers() {
  let apiOrigin = REAL
  if (MOCK) {
    const { startMock } = await import('./mock-api.mjs')
    mock = await startMock({ port: API_PORT, repo: REPO, stageMs: STAGE_MS })
    apiOrigin = mock.url
    log('mock API', mock.url, 'official hash', mock.officialHash)
  }
  let web = opt('--web', null)
  if (!web) {
    const args = [join(HERE, 'serve-web.mjs'), '--port', String(WEB_PORT), '--web-dir', WEB_DIR, ...(MOCK ? ['--api', apiOrigin] : ['--proxy', apiOrigin])]
    const ch = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(ch)
    web = await new Promise((ok, fail) => {
      const to = setTimeout(() => fail(new Error('web did not start in 60 s')), 60000)
      let buf = ''
      const on = (d) => { buf += d; process.stdout.write(`[web] ${d}`); const m = /READY (\S+)/.exec(buf); if (m) { clearTimeout(to); ok(m[1]) } }
      ch.stdout.on('data', on); ch.stderr.on('data', (d) => process.stdout.write(`[web!] ${d}`))
      ch.on('exit', (c) => fail(new Error(`web exited ${c}`)))
    })
  }
  // the API as the driver reads it (cross-checks only; never writes)
  const api = `${apiOrigin.replace(/\/+$/, '')}/api/v1`
  return { web, api }
}

// ---------- browser ----------
const { chromium } = await import(process.env.PW ?? `${process.env.HOME}/coding/hl-h2/web/node_modules/playwright/index.mjs`)
const exe = process.env.CHROMIUM ?? execSync('command -v chromium').toString().trim()
let browser = null
const errors = []
const warnings = []
const netlog = []

async function newPage(tag, { block = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1900, height: 1000 }, acceptDownloads: true })
  if (block) await ctx.route('**/api/v1/**', (r) => r.abort('connectionrefused'))
  const page = await ctx.newPage()
  const jobs = [], polls = [], routeFiles = [], posts = []
  page.on('pageerror', (e) => errors.push({ t: now(), page: tag, kind: 'uncaught', msg: e.message }))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push({ t: now(), page: tag, kind: 'console.error', msg: m.text().split('\n')[0] })
    else if (m.type() === 'warning') warnings.push({ t: now(), page: tag, msg: m.text().split('\n')[0].slice(0, 300) })
  })
  page.on('request', (q) => {
    if (q.method() === 'POST' && /\/api\/v1\/jobs$/.test(q.url())) { try { posts.push({ t: now(), body: JSON.parse(q.postData() ?? 'null') }) } catch {} }
  })
  page.on('response', async (r) => {
    const u = r.url()
    if (!u.includes('/api/v1/')) return
    const path = u.replace(/^.*\/api\/v1/, '')
    netlog.push({ t: now(), page: tag, status: r.status(), method: r.request().method(), url: path })
    try {
      if (/\/jobs$/.test(path) && r.request().method() === 'POST') jobs.push({ t: now(), status: r.status(), body: await r.json() })
      else if (/\/jobs\/[^/]+$/.test(path)) { const j = await r.json(); polls.push({ t: now(), status: j.status, stage: j.stage, stages_done: j.stages_done, hash: j.hash }) }
      else if (/\/results\/[0-9a-f]+\/route_[^/]+\.geojson$/.test(path) && r.status() === 200) routeFiles.push({ t: now(), path, legs: ((await r.json()).features ?? []).map((f) => [f.properties?.from, f.properties?.to]) })
    } catch {}
  })
  return { ctx, page, jobs, polls, routeFiles, posts, close: () => ctx.close() }
}
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` }).catch((e) => log('screenshot failed', name, e.message))
const txt = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.innerText.replace(/\s+/g, ' ').trim() : null }, sel)
const visible = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!(e && (e.offsetWidth || e.offsetHeight)) }, sel)
const attr = (page, sel, a) => page.evaluate(([s, a]) => document.querySelector(s)?.getAttribute(a) ?? null, [sel, a])
async function until(fn, ms, step = 100) {
  const t = performance.now()
  while (performance.now() - t < ms) { const v = await fn().catch(() => null); if (v) return { ms: Math.round(performance.now() - t), v }; await sleep(step) }
  return { ms: null, v: null }
}
const nums = (s) => (s ?? '').match(/-?\d+(?:\.\d+)?/g) ?? []
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const uncaught = (tag) => errors.filter((e) => e.kind === 'uncaught' && (!tag || e.page === tag)).length

// ---------- flow helpers ----------
/** Open the Plan console and wait until the route panel can compute (live ready). */
async function openPanel(p, tag) {
  const t = performance.now()
  await p.page.goto(`${CTX.web}/#/`)
  const r = await until(async () => (await visible(p.page, S.panel)) && (await attr(p.page, S.liveStatus, 'data-state')) === 'ready' ? true : null, 30000)
  return { ms: Math.round(performance.now() - t), ready: !!r.v, sectionVisible: await visible(p.page, S.section) }
}
/** "My order", then check the stations in the given order; returns the list order shown. */
async function pickStops(p, ids) {
  const t = performance.now()
  await p.page.click(S.mode('ordered'))
  for (const id of ids) await p.page.check(S.check(id))
  const ms = Math.round(performance.now() - t)
  // the D57 hash shows once /engine/version answered (pending text otherwise)
  await until(async () => { const h = await txt(p.page, S.panelHash); return h && /^[0-9a-f]{16}$/.test(h) ? h : null }, 10000)
  const shown = await p.page.$$eval(S.checkedRows, (els) => els.map((e) => e.dataset.station))
  const legs = await p.page.$$eval(S.legs, (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()))
  return { ms, shown, legs, panelHash: await txt(p.page, S.panelHash) }
}
/** Compute plan; follow the panel until a result, a failure or the timeout. */
async function computeAndWait(p, name) {
  await until(async () => (await p.page.$eval(S.compute, (b) => !b.disabled).catch(() => false)) || null, 15000)
  const t = performance.now()
  const at = () => +((performance.now() - t) / 1000).toFixed(2)
  await p.page.click(S.compute)
  const seen = { first: null, rest: null, result: null, failed: null }
  const progress = []
  let lastProg = null
  while ((performance.now() - t) / 1000 < JOB_WAIT_S) {
    const s = await p.page.evaluate((S) => {
      const q = (x) => document.querySelector(x)
      return { first: q(S.stageFirst)?.classList.contains('is-shown') ?? false, rest: q(S.stageRest)?.classList.contains('is-shown') ?? false, progress: q(S.progress)?.innerText ?? null, result: !!q(S.result), failed: !!q(S.failed) }
    }, { stageFirst: S.stageFirst, stageRest: S.stageRest, progress: S.progress, result: S.result, failed: S.failed }).catch(() => null)
    if (s) {
      if (s.first && seen.first === null) { seen.first = at(); log(name, 'nominal band + route on the map', seen.first, 's'); await shot(p.page, `${name}-first-stage`) }
      if (s.rest && seen.rest === null) { seen.rest = at(); log(name, 'other layers on the map', seen.rest, 's') }
      if (s.progress && s.progress !== lastProg) { lastProg = s.progress; progress.push({ s: at(), text: s.progress }) }
      if (s.result) { seen.result = at(); break }
      if (s.failed) { seen.failed = at(); break }
    }
    await sleep(200)
  }
  await sleep(300)
  return { seen, progress, totalS: at() }
}
/** Stages as the job polls reported them: each stages_done extends the previous one (no reordering). */
function stageOrder(polls) {
  const order = []
  let ok = true
  for (const pl of polls) {
    const d = pl.stages_done ?? []
    if (!same(d.slice(0, order.length), order)) ok = false
    for (const s of d.slice(order.length)) order.push(s)
  }
  return { order, inOrder: ok }
}
const routeOf = (post) => post?.body?.inputs?.route ?? null
const stopIds = (route) => (route?.stops ?? []).map((s) => s.station ?? `(${s.lon},${s.lat})`)
const legChain = (ids) => ['pad', ...ids, 'pad'].slice(1).map((to, i) => [['pad', ...ids][i], to])
const apiJson = async (path) => { const r = await fetch(CTX.api + path); return { status: r.status, body: await r.json().catch(() => null) } }

/** Run one scenario: catches its own failure, records timing, never stops the others. */
async function scenario(key, what, fn) {
  if (!ONLY.includes(key)) return
  const t = performance.now()
  log(`---- ${key}: ${what}`)
  try {
    const r = await fn()
    R.scenarios[key] = { what, ...r, ms: Math.round(performance.now() - t) }
  } catch (e) {
    R.scenarios[key] = { what, pass: false, fatal: String(e?.stack ?? e).split('\n').slice(0, 4).join(' | '), ms: Math.round(performance.now() - t) }
  }
  const s = R.scenarios[key]
  log(`${key}:`, s.skipped ? `SKIPPED (${s.skipped})` : s.pass ? 'PASS' : 'FAIL', JSON.stringify({ ...s, criteria: s.criteria }).slice(0, 1500))
}
/** pass = every criterion true; criteria with value null are informational (not judged). */
const verdict = (criteria) => Object.values(criteria).every((v) => v === null || v === true)

const CTX = {}
try {
  Object.assign(CTX, await startServers())
  R.web = CTX.web
  R.api = CTX.api
  const ev = await apiJson('/engine/version').catch((e) => ({ status: 0, body: String(e) }))
  R.engine = ev.body
  R.official = opt('--official-hash', mock?.officialHash ?? process.env.OFFICIAL_HASH ?? null)
  log('engine', JSON.stringify(ev.body)?.slice(0, 200), 'official', R.official)
  browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })

  // ---------- f. static first: API unreachable -> static app unchanged, no route controls ----------
  // Run first so the static headline of the console is known for g. The browser refuses every
  // /api/v1 request (page.route abort): the API itself is not touched (safe in --real mode).
  let staticHeadline = null
  await scenario('f', 'static-first: API down, static app unchanged, no route controls', async () => {
    const p = await newPage('f', { block: true })
    const t = performance.now()
    await p.page.goto(`${CTX.web}/#/`)
    const head = await until(async () => { const h = await txt(p.page, S.headline); return h && /(^|\D)23\s*%/.test(h) ? h : null }, 30000)
    const banner = await until(async () => (await attr(p.page, S.liveStatus, 'data-state')) === 'offline' && (await visible(p.page, S.liveStatus)) ? await txt(p.page, S.liveStatus) : null, 15000)
    await sleep(1500)
    const ctl = await p.page.evaluate(() => {
      const vis = (e) => !!(e && (e.offsetWidth || e.offsetHeight))
      const all = (s) => [...document.querySelectorAll(s)]
      return {
        panelVisible: vis(document.querySelector('.hl-route')),
        visibleControls: all('.hl-route button, .hl-route input').filter(vis).length,
        enabledControls: all('.hl-route button, .hl-route input').filter((e) => vis(e) && !e.disabled).length,
        computeEnabled: (() => { const b = document.querySelector('.hl-route__compute'); return !!b && vis(b) && !b.disabled })(),
        reason: document.querySelector('.hl-route__reason')?.innerText ?? null,
      }
    })
    staticHeadline = head.v
    await shot(p.page, 'f-static-first')
    const criteria = {
      staticHeadline23: !!head.v,
      offlineBanner: !!banner.v,
      noRouteControlsShown: !ctl.panelVisible && ctl.visibleControls === 0,
      computeDisabled: !ctl.computeEnabled,
      noUncaught: uncaught('f') === 0,
    }
    await p.close()
    return { pass: verdict(criteria), criteria, headline: head.v, headlineAfterMs: head.ms, banner: banner.v, bannerAfterMs: banner.ms, controls: ctl, msTotal: Math.round(performance.now() - t) }
  })

  // ---------- a. ordered stations ----------
  let routeHash = null
  await scenario('a', `ordered stations ${ORDERED.join(', ')}: staged result, Computed live, order kept`, async () => {
    const p = await newPage('a')
    const open = await openPanel(p)
    const pick = await pickStops(p, ORDERED)
    await shot(p.page, 'a-picked')
    const run = await computeAndWait(p, 'a')
    await p.page.locator(S.result).scrollIntoViewIfNeeded().catch(() => {})
    await shot(p.page, 'a-done')
    const post = p.posts.at(-1)
    const job = p.jobs.at(-1)?.body
    const hash = job?.hash ?? null
    routeHash = hash
    const st = stageOrder(p.polls)
    const doneAt = p.polls.find((x) => x.status === 'done')?.t
    const label = await txt(p.page, S.label)
    const prov = await attr(p.page, S.prov, 'href')
    const after = { shown: await p.page.$$eval(S.checkedRows, (els) => els.map((e) => e.dataset.station)) }
    const rec = hash ? await apiJson(`/results/${hash}/provenance`) : null
    const feas = rec?.body?.feasibility ?? null
    const routeLegs = p.routeFiles.at(-1)?.legs ?? null
    const plannedLegs = feas && !feas.feasible ? feas.legs_planned ?? feas.leg : ORDERED.length + 1
    // provenance view of the link the panel gives
    let provView = null
    if (prov) {
      await p.page.evaluate((h) => { location.hash = h }, prov)
      const pv = await until(async () => (await txt(p.page, '.live-origin')) ?? null, 15000)
      provView = { ms: pv.ms, origin: pv.v, stages: await txt(p.page, `${S.planPage} table.live-stages`) }
      await shot(p.page, 'a-provenance')
    }
    const criteria = {
      panelReady: open.ready,
      listInPickOrder: same(pick.shown, ORDERED),
      submittedInOrder: same(routeOf(post), { mode: 'ordered', stops: ORDERED.map((s) => ({ station: s })) }),
      stagesInOrder: st.inOrder && st.order.length > 0 && st.order[0] === 'nominal',
      firstStageBeforeDone: run.seen.first !== null && (p.polls[0]?.status === 'done' ? null : doneAt !== undefined),
      resultShown: run.seen.result !== null,
      labelComputedLive: !!label?.includes(TXT.computed),
      provenanceLink: !!hash && prov === `#/plan/${hash}/provenance`,
      provenanceView: !!provView?.origin && /computed_live|Computed live/.test(provView.origin),
      runRecordOrdered: rec?.body?.route_mode === 'ordered',
      runRecordStopsInOrder: same(stopIds(rec?.body?.inputs?.route), ORDERED),
      mapRouteInOrder: routeLegs ? same(routeLegs, legChain(ORDERED).slice(0, plannedLegs)) : false,
      listUnchangedAfter: same(after.shown, ORDERED),
      panelFeasibilityMatchesRecord: feas ? (feas.feasible ? !!(await p.page.$(S.ok)) || null : null) : null,
      panelHashEqualsJobHash: MOCK ? null : pick.panelHash === hash, // D57 client hash = server hash (real only)
      noUncaught: uncaught('a') === 0,
    }
    await p.close()
    return {
      pass: verdict(criteria), criteria, hash, panelHash: pick.panelHash, openMs: open.ms, pickMs: pick.ms, legsShown: pick.legs,
      timings: { firstStageS: run.seen.first, restS: run.seen.rest, resultS: run.seen.result, failedS: run.seen.failed, totalS: run.totalS, submitStatus: p.jobs.at(-1)?.status },
      stageOrder: st.order, progress: run.progress, label, prov, provView, feasibility: feas, routeMode: rec?.body?.route_mode ?? null, mapRouteLegs: routeLegs,
    }
  })

  // ---------- b. infeasible order ----------
  await scenario('b', `infeasible order ${INFEASIBLE.join(', ')}: failing leg, limit, minutes short; nothing reordered`, async () => {
    const p = await newPage('b')
    const open = await openPanel(p)
    const pick = await pickStops(p, INFEASIBLE)
    const run = await computeAndWait(p, 'b')
    await p.page.locator(S.infeasible).scrollIntoViewIfNeeded().catch(() => {})
    await shot(p.page, 'b-infeasible')
    const hash = p.jobs.at(-1)?.body?.hash ?? null
    const rec = hash ? await apiJson(`/results/${hash}/provenance`) : null
    const f = rec?.body?.feasibility ?? null
    const box = await p.page.evaluate((s) => {
      const e = document.querySelector(s)
      const t = (c) => e?.querySelector(c)?.innerText.replace(/\s+/g, ' ').trim() ?? null
      return e ? { leg: e.dataset.leg, limit: e.dataset.limit, legText: t('.hl-route__infeasible-leg'), limitText: t('.hl-route__infeasible-limit'), shortText: t('.hl-route__infeasible-short') } : null
    }, S.infeasible)
    const legRows = await p.page.$$eval(S.legs, (els) => els.map((e) => ({ leg: e.dataset.leg, state: e.dataset.state ?? null, failing: e.classList.contains('is-failing'), text: e.innerText.replace(/\s+/g, ' ').trim() })))
    const shown = await p.page.$$eval(S.checkedRows, (els) => els.map((e) => e.dataset.station))
    const routeLegs = p.routeFiles.at(-1)?.legs ?? null
    const infeasible = f && f.feasible === false
    const criteria = {
      panelReady: open.ready,
      runRecordInfeasible: !!infeasible, // the order really is infeasible on this API (else pick another with --infeasible)
      panelShowsInfeasible: !!box,
      namesFailingLeg: !!infeasible && box?.legText === TXT.infeasibleLeg(f.leg + 1, f.from, f.to) && box?.leg === String(f.leg),
      namesLimit: !!infeasible && !!box?.limitText?.includes(LIMIT_WORD[f.limit] ?? f.limit),
      namesMinutesShort: !!infeasible && !!box?.shortText?.includes(TXT.short(Number(f.shortfall_min).toFixed(1))),
      legHighlightedInList: !!infeasible && legRows.some((r) => r.leg === String(f.leg) && r.failing && r.state === 'failing'),
      // the map highlight (live/route/map.ts layer hl-route-failing-leg) is not readable without a map
      // handle: judged on the screenshot b-infeasible.png (selector request R5-1)
      legHighlightedOnMap: null,
      submittedInOrder: same(stopIds(routeOf(p.posts.at(-1))), INFEASIBLE),
      listNotReordered: same(shown, INFEASIBLE),
      mapRouteIsPlannedPrefix: !!infeasible && !!routeLegs && same(routeLegs, legChain(INFEASIBLE).slice(0, f.legs_planned ?? f.leg)),
      noUncaught: uncaught('b') === 0,
    }
    await p.close()
    return { pass: verdict(criteria), criteria, hash, feasibility: f, panel: box, legRows, mapRouteLegs: routeLegs, timings: { firstStageS: run.seen.first, resultS: run.seen.result, totalS: run.totalS }, pickMs: pick.ms }
  })

  // ---------- c. 422 on a bad stop ----------
  // The panel cannot produce a bad station (checkboxes over stations.json), so the driver rewrites
  // the submitted body in the browser: stop 2 becomes the unknown station S99. The API answers 422
  // route_station_unknown with Error.stop = 1 and no job is created (safe in --real mode).
  await scenario('c', '422 on a bad stop: the panel names the stop (Error.stop)', async () => {
    const p = await newPage('c')
    const open = await openPanel(p)
    let rewritten = null
    await p.page.route('**/api/v1/jobs', async (route) => {
      const q = route.request()
      if (q.method() !== 'POST') return route.continue()
      const body = JSON.parse(q.postData() ?? '{}')
      if (body?.inputs?.route?.stops?.length > 1) { body.inputs.route.stops[1] = { station: 'S99' }; rewritten = body.inputs.route }
      return route.continue({ postData: JSON.stringify(body) })
    })
    await pickStops(p, ORDERED)
    const run = await computeAndWait(p, 'c')
    await p.page.locator(S.failed).scrollIntoViewIfNeeded().catch(() => {})
    await shot(p.page, 'c-422')
    const resp = p.jobs.at(-1)
    const fail = await p.page.evaluate((s) => { const e = document.querySelector(s); return e ? { status: e.dataset.status, code: e.dataset.code, text: e.innerText.replace(/\s+/g, ' ').trim() } : null }, S.failed)
    const stop = resp?.body?.stop
    const criteria = {
      panelReady: open.ready,
      api422: resp?.status === 422,
      errorStopGiven: Number.isInteger(stop),
      panelShowsFailure: !!fail && fail.status === '422' && fail.code === resp?.body?.error,
      panelNamesStop: Number.isInteger(stop) && !!fail?.text.includes(`Stop ${stop + 1}`),
      noJobCreated: p.polls.length === 0,
      noUncaught: uncaught('c') === 0,
    }
    await p.close()
    return { pass: verdict(criteria), criteria, sentRoute: rewritten, response: resp, panel: fail, failedAfterS: run.seen.failed }
  })

  // ---------- d. free points (WP6) ----------
  await scenario('d', 'free points: add two, drag, rename, delete, validity, ghost route "estimate", compute', async () => {
    if (!WP6) return { skipped: 'WP6 (free-point map editing) not landed; run with --wp6 once it is', pass: null, todoSelectors: Object.fromEntries(Object.entries(S).filter(([k]) => k.startsWith('wp6')).map(([k, v]) => [k, typeof v === 'function' ? v('n') : v])) }
    // TODO(WP6): written against the requested selectors above; adjust to WP6's final ones.
    const p = await newPage('d')
    const open = await openPanel(p)
    await p.page.click(S.mode('ordered'))
    await p.page.check(S.check(ORDERED[0]))
    const canvas = await p.page.locator('.maplibregl-canvas').first().boundingBox()
    const cx = canvas.x + canvas.width * 0.45, cy = canvas.y + canvas.height * 0.5
    await p.page.click(S.wp6AddPoint); await p.page.mouse.click(cx - 60, cy - 40)
    await p.page.click(S.wp6AddPoint); await p.page.mouse.click(cx + 60, cy + 40)
    const added = (await visible(p.page, S.wp6Point(1))) && (await visible(p.page, S.wp6Point(2)))
    const m = await p.page.locator(S.wp6Marker(1)).boundingBox()
    if (m) { await p.page.mouse.move(m.x + m.width / 2, m.y + m.height / 2); await p.page.mouse.down(); await p.page.mouse.move(m.x + 40, m.y + 20, { steps: 10 }); await p.page.mouse.up() }
    await p.page.fill(S.wp6Label(1), 'Dark sand edge'); await p.page.keyboard.press('Enter')
    const validity = await attr(p.page, S.wp6Validity(1), 'data-validity')
    const ghost = await txt(p.page, S.wp6Ghost)
    await p.page.click(S.wp6Delete(2))
    const deleted = !(await visible(p.page, S.wp6Point(2)))
    const run = await computeAndWait(p, 'd')
    const sent = routeOf(p.posts.at(-1))
    const criteria = {
      panelReady: open.ready, addedTwo: added, dragged: !!m, validityShown: ['valid', 'invalid', 'unknown'].includes(validity), ghostLabelledEstimate: /estimate/i.test(ghost ?? ''),
      deleted, submittedWithPoint: !!sent?.stops?.some((s) => s.label === 'Dark sand edge'), resultShown: run.seen.result !== null, noUncaught: uncaught('d') === 0,
    }
    await shot(p.page, 'd-free-points')
    await p.close()
    return { pass: verdict(criteria), criteria, sent, ghost, validity }
  })

  // ---------- e. saving: My plans, permalink, export/import ----------
  await scenario('e', 'save to My plans, reload, open, rename, delete; permalink; export + import = same hash', async () => {
    const hash = routeHash
    if (!hash) return { pass: false, why: 'no route hash from scenario a' }
    const p = await newPage('e')
    // permalink in a fresh page
    let t = performance.now()
    await p.page.goto(`${CTX.web}/#/plan/${hash}`)
    // PlanLoading already shows a label: wait for the loaded page (its route-mode section)
    const perm = await until(async () => { const o = await attr(p.page, S.planLabel, 'data-origin'); return o && (await p.page.$(S.routeMode)) ? { origin: o, label: await txt(p.page, S.planLabel), headline: await txt(p.page, S.planHeadline) } : null }, 20000)
    const permalinkMs = perm.ms
    const routeMode = await attr(p.page, S.routeMode, 'data-route-mode')
    const stopsShown = await p.page.$$eval(S.routeStops, (els) => els.map((e) => e.innerText.trim())).catch(() => [])
    await shot(p.page, 'e-permalink')
    // save
    t = performance.now()
    await p.page.click(S.save)
    const saved = await until(async () => (await visible(p.page, S.myplan(hash))) || null, 5000)
    const saveMs = Math.round(performance.now() - t)
    const routeLine = await txt(p.page, `${S.myplan(hash)} .caption`)
    // reload: still listed
    await p.page.reload()
    const kept = await until(async () => (await visible(p.page, S.myplan(hash))) || null, 20000)
    // rename
    const newTitle = 'WP8a route check'
    await p.page.fill(`${S.myplan(hash)} input[name=title]`, newTitle)
    await p.page.click(`${S.myplan(hash)} .live-plan-rename button[type=submit]`)
    const renamed = await until(async () => (await txt(p.page, `${S.myplan(hash)} .live-plan-open`)) === newTitle || null, 5000)
    await p.page.reload()
    const renameKept = await until(async () => (await txt(p.page, `${S.myplan(hash)} .live-plan-open`)) === newTitle || null, 20000)
    // open from the list
    await p.page.goto(`${CTX.web}/#/plan`)
    await until(async () => (await visible(p.page, S.myplan(hash))) || null, 20000)
    await p.page.click(`${S.myplan(hash)} .live-plan-open`)
    const opened = await until(async () => (await p.page.evaluate(() => location.hash)) === `#/plan/${hash}` && (await attr(p.page, S.planLabel, 'data-origin')) ? true : null, 20000)
    // export from the list, import on #/plan
    const exportText = await p.page.evaluate(async (s) => { const a = document.querySelector(s); return a ? (await fetch(a.href)).text() : null }, `${S.myplan(hash)} .live-plan-export`)
    let exported = null
    try { exported = JSON.parse(exportText) } catch {}
    writeFileSync(`${OUT}/e-plan_inputs.json`, exportText ?? '')
    await p.page.goto(`${CTX.web}/#/plan`)
    await until(async () => (await p.page.$(S.importInput)) || null, 20000)
    t = performance.now()
    await p.page.setInputFiles(S.importInput, `${OUT}/e-plan_inputs.json`)
    const imp = await until(async () => (await p.page.evaluate(() => location.hash)) === `#/plan/${hash}` && (await attr(p.page, S.planLabel, 'data-origin')) ? true : null, 20000, 50)
    const importMs = imp.ms
    await shot(p.page, 'e-reimport')
    // delete
    await p.page.goto(`${CTX.web}/#/plan`)
    await until(async () => (await visible(p.page, S.myplan(hash))) || null, 20000)
    await p.page.click(`${S.myplan(hash)} .live-plan-delete`)
    const gone = await until(async () => !(await p.page.$(S.myplan(hash))) || null, 5000)
    await p.page.reload(); await sleep(2000)
    const goneAfterReload = !(await p.page.$(S.myplan(hash)))
    await shot(p.page, 'e-deleted')
    const criteria = {
      permalinkRenders: perm.v?.origin === 'computed_live',
      permalinkRouteOrdered: routeMode === 'ordered',
      permalinkStopsInOrder: same(stopsShown.map((s) => s.split(' ')[0]), ORDERED),
      saved: !!saved.v,
      listedAfterReload: !!kept.v,
      renamed: !!renamed.v && !!renameKept.v,
      openedFromList: !!opened.v,
      exportCarriesRoute: same(exported?.route, { mode: 'ordered', stops: ORDERED.map((s) => ({ station: s })) }),
      importSameHash: !!imp.v,
      deleted: !!gone.v && goneAfterReload,
      noUncaught: uncaught('e') === 0,
    }
    await p.close()
    return { pass: verdict(criteria), criteria, hash, permalinkMs, permalink: perm.v, stopsShown, routeLine, saveMs, importMs, exportBytes: exportText?.length ?? 0 }
  })

  // ---------- g. official permalink keeps the official numbers ----------
  await scenario('g', 'official permalink shows the official numbers (23 %, 15.2 %, 28.7 %)', async () => {
    if (!R.official) return { skipped: 'no --official-hash given (real mode)', pass: null }
    const p = await newPage('g')
    if (!staticHeadline) {
      await p.page.goto(`${CTX.web}/#/`)
      staticHeadline = (await until(async () => { const h = await txt(p.page, S.headline); return h && /(^|\D)23\s*%/.test(h) ? h : null }, 30000)).v
      await sleep(1500) // H2 finding 1: leaving the console within ~1 s of its headline throws a map-layer error
    }
    await p.page.goto(`${CTX.web}/#/plan/${R.official}`)
    const r = await until(async () => {
      const o = await attr(p.page, S.planLabel, 'data-origin')
      const h = await txt(p.page, S.planHeadline)
      return o === 'precomputed' && h ? { origin: o, label: await txt(p.page, S.planLabel), headline: h } : null
    }, 20000)
    await sleep(800)
    await shot(p.page, 'g-official')
    const a = nums(staticHeadline).slice(0, 3), b = nums(r.v?.headline).slice(0, 3)
    const withheld = await p.page.evaluate(() => document.querySelectorAll('.live-plan-page .num-withheld').length)
    const criteria = { precomputedLabel: !!r.v?.label?.includes(PRE_LABEL), sameAsStatic: a.length === 3 && same(a, b), official23: a[0] === '23', noneWithheld: withheld === 0, routeModeAuto: (await attr(p.page, S.routeMode, 'data-route-mode')) === 'auto' || null, noUncaught: uncaught('g') === 0 }
    await p.close()
    return { pass: verdict(criteria), criteria, ms: r.ms, ...r.v, staticNums: a, planNums: b }
  })
} catch (e) {
  R.fatal = String(e?.stack ?? e)
  log('FATAL', R.fatal)
} finally {
  R.errors = errors
  R.warnings = warnings
  R.netlog = netlog
  if (mock) R.mockInfo = await fetch(`${mock.url}/__mock/info`).then((r) => r.json()).catch(() => null)
  writeFileSync(`${OUT}/route-e2e-result.json`, JSON.stringify(R, null, 2))
  log('errors (uncaught + console.error):', errors.length); for (const e of errors.slice(0, 30)) log('  ', JSON.stringify(e).slice(0, 300))
  log('console warnings:', warnings.length); for (const e of warnings.slice(0, 15)) log('  ', JSON.stringify(e).slice(0, 300))
  const summary = Object.fromEntries(Object.entries(R.scenarios).map(([k, v]) => [k, v.skipped ? 'SKIP' : v.pass ? 'PASS' : 'FAIL']))
  log('RESULT per scenario:', JSON.stringify(summary), '->', `${OUT}/route-e2e-result.json`)
  await browser?.close()
  for (const c of children) c.kill('SIGTERM')
  await mock?.close()
  process.exit(R.fatal ? 2 : Object.values(R.scenarios).some((v) => !v.skipped && !v.pass) ? 1 : 0)
}
