/**
 * Value snapshot (design rule 1 "No validated number changes", readiness R5, DESIGN §9 "Numbers unchanged").
 *
 * Renders every view of a *built* web app in headless Chromium (Playwright), waits until the data
 * has loaded and the DOM is stable, and records every rendered number:
 *   - `num:<manifest key>`         every backed <Num> (`a.num.num-ok`, key from its `#/scorecard?key=` link)
 *   - `num-unbacked:<title>` etc.  every other `.num` (unbacked, unknown, config, derived, nav row),
 *                                  keyed by its class and the first line of its tooltip (no DOM paths)
 *   - `manifest:<key>`             the scorecard's manifest table (row id `k-<key>`, value cell `td.r`)
 *   - `hud:<data-manifest-key or data-source-files>` the HUD panel rows (`.hl-hud-v`, `.hl-hud-sub`)
 * A key rendered several times with different texts stores the distinct texts, sorted, joined by " | "
 * (so moving or duplicating a number in a layout does not count as a change; changing it does).
 * Output: {"<view state>": {"<key>": "<rendered text>"}}, keys sorted, no timestamps. The page clock
 * is pinned (FIXED_NOW / HL_SNAPSHOT_NOW), locale en-US, time zone UTC.
 *
 * View states (from web/src/router.ts): #/ (console) for every variant × suit × walkback budget and
 * every D21 parking option × budget; #/station/<id> for every station linked from the app; #/trade;
 * #/conditions (+ every dose-allowance slider step); #/cuff; #/hud (panel expanded, EVA clock
 * scrubbed to 0/25/50/75/100 %); #/scorecard; #/about. (#/nav and #/hud3d are removed, D98/D99.)
 * Not covered: the console budget slider (its only number is the isochrone step, already shown),
 * HUD drag/storm modes, #/spike, live (WS13) numbers.
 *
 * Run (Node ≥ 24 runs the .ts directly; build first: `cd web && npm run build`):
 *   cd web && npm run values:snapshot -- --check             # compare with tests/fixtures/values_baseline.json
 *   cd web && npm run values:snapshot -- --write             # (re)write the baseline
 *   node tools/values_snapshot.ts [--url http://host:port/] [--dist web/dist] [--write [file] | --check [file]] [--only <regex>] [-v]
 * Without --url it starts `vite preview` on a free port serving web/dist (or --dist).
 * Without --write/--check it prints the JSON to stdout. --check exits 1 with a readable diff on any
 * changed, missing or extra value (or view state); 2 on a tool error.
 * Browser: Playwright's Chromium (`cd web && npx playwright install chromium`); if it cannot start
 * (e.g. NixOS) set HL_CHROMIUM=/path/to/chromium, else a system chromium on PATH is tried.
 *
 * CI (D5 adds the job): build the real-data app (`npm ci && npm run build` in web/), install the
 * browser (`npx playwright install --with-deps chromium`), then `npm run values:snapshot -- --check`.
 * A design PR must keep it green; a PR that is meant to change a number (not a design PR) re-runs
 * `--write` and commits the new baseline, so the diff is reviewed.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, Page } from 'playwright'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WEB = resolve(ROOT, 'web')
const DEFAULT_BASELINE = resolve(ROOT, 'tests/fixtures/values_baseline.json')
const SETTLE_TIMEOUT_MS = 90_000
const POLL_MS = 250
const STABLE_POLLS = 3
/** Date.now()/new Date() in the page are pinned here (timers keep running), so no rendered text can
 * drift with the wall clock (defensive: no view reads it today). Override with HL_SNAPSHOT_NOW (ISO UTC). */
const FIXED_NOW = process.env.HL_SNAPSHOT_NOW ?? '2026-11-15T11:00:00Z'

type Values = Record<string, string>
type Snapshot = Record<string, Values>

interface Args {
  url: string | null
  dist: string
  mode: 'print' | 'write' | 'check'
  file: string
  only: RegExp | null
  verbose: boolean
}

function parseArgs(argv: string[]): Args {
  const a: Args = { url: null, dist: resolve(WEB, 'dist'), mode: 'print', file: DEFAULT_BASELINE, only: null, verbose: false }
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${x} needs a value`)
      return v
    }
    const optFile = () => (argv[i + 1] && !argv[i + 1].startsWith('--') ? resolve(argv[++i]) : DEFAULT_BASELINE)
    if (x === '--url') a.url = next()
    else if (x === '--dist') a.dist = resolve(next())
    else if (x === '--write') (a.mode = 'write'), (a.file = optFile())
    else if (x === '--check') (a.mode = 'check'), (a.file = optFile())
    else if (x === '--only') a.only = new RegExp(next())
    else if (x === '-v' || x === '--verbose') a.verbose = true
    else if (x === '-h' || x === '--help') {
      console.log('usage: node tools/values_snapshot.ts [--url URL] [--dist DIR] [--write [FILE] | --check [FILE]] [--only REGEX] [-v]')
      process.exit(0)
    } else throw new Error(`unknown argument ${x}`)
  }
  return a
}

let VERBOSE = false
const log = (...xs: unknown[]) => console.error('[values]', ...xs)
const debug = (...xs: unknown[]) => VERBOSE && log(...xs)

// ---------------------------------------------------------------- server + browser

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => res(p))
    })
  })
}

async function startPreview(dist: string): Promise<{ url: string; proc: ChildProcess }> {
  if (!existsSync(resolve(dist, 'index.html'))) throw new Error(`${dist}/index.html not found: build first (cd web && npm run build)`)
  const port = await freePort()
  const vite = resolve(WEB, 'node_modules/vite/bin/vite.js')
  const proc = spawn(process.execPath, [vite, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--outDir', dist], {
    cwd: WEB,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const url = `http://127.0.0.1:${port}/`
  let out = ''
  proc.stdout?.on('data', (d) => (out += d))
  proc.stderr?.on('data', (d) => (out += d))
  const t0 = Date.now()
  while (Date.now() - t0 < 30_000) {
    if (proc.exitCode !== null) throw new Error(`vite preview exited: ${out}`)
    try {
      if ((await fetch(url)).ok) return { url, proc }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  proc.kill()
  throw new Error(`vite preview did not start on ${url}: ${out}`)
}

function systemChromium(): string | null {
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    try {
      const p = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (p) return p
    } catch {
      /* not on PATH */
    }
  }
  return null
}

async function launch(): Promise<Browser> {
  const { chromium } = createRequire(resolve(WEB, 'package.json'))('playwright') as typeof import('playwright')
  const opts = { headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }
  if (process.env.HL_CHROMIUM) return chromium.launch({ ...opts, executablePath: process.env.HL_CHROMIUM })
  try {
    return await chromium.launch(opts)
  } catch (e) {
    const sys = systemChromium()
    if (!sys) throw e
    log(`Playwright Chromium did not start (${(e as Error).message.split('\n')[0]}); using ${sys} (set HL_CHROMIUM to choose)`)
    return chromium.launch({ ...opts, executablePath: sys })
  }
}

// ---------------------------------------------------------------- collection (runs in the page)

/** Every rendered number in the outlet as [key, text] pairs. Kept self-contained: it is serialised into the page. */
function collectInPage(): [string, string][] {
  const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
  const root = document.querySelector('main.outlet') ?? document.body
  const out: [string, string][] = []
  for (const el of Array.from(root.querySelectorAll('.num'))) {
    const text = norm(el.textContent)
    if (el.classList.contains('num-ok')) {
      const m = /[?&]key=([^&]*)/.exec(el.getAttribute('href') ?? '')
      out.push([`num:${m ? decodeURIComponent(m[1]) : '(no key)'}`, text])
    } else {
      const kind = Array.from(el.classList).filter((c) => c.startsWith('num-')).sort().join('.') || 'num'
      out.push([`${kind}:${norm((el.getAttribute('title') ?? '').split('\n')[0])}`, text])
    }
  }
  for (const tr of Array.from(root.querySelectorAll('table.manifest tr[id^="k-"]'))) {
    out.push([`manifest:${tr.id.slice(2)}`, norm(tr.querySelector('td.r')?.textContent)])
  }
  for (const row of Array.from(root.querySelectorAll('.hl-hud-row'))) {
    const r = row as HTMLElement
    const id = r.dataset.manifestKey || r.dataset.sourceFiles || `label=${norm(r.querySelector('.hl-hud-k')?.textContent)}`
    const v = norm(r.querySelector('.hl-hud-v')?.textContent)
    const sub = norm(r.querySelector('.hl-hud-sub')?.textContent)
    if (v) out.push([`hud:${id}`, v])
    if (sub) out.push([`hud:${id} (sub)`, sub])
  }
  return out
}

function group(pairs: [string, string][]): Values {
  const m = new Map<string, Set<string>>()
  for (const [k, t] of pairs) {
    if (!m.has(k)) m.set(k, new Set())
    m.get(k)!.add(t)
  }
  const out: Values = {}
  for (const k of [...m.keys()].sort()) out[k] = [...m.get(k)!].sort().join(' | ')
  return out
}

/** Wait until nothing is loading and the collected values are unchanged for STABLE_POLLS polls. */
async function settle(page: Page, what: string): Promise<Values> {
  await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => undefined)
  let prev = ''
  let stable = 0
  const t0 = Date.now()
  while (Date.now() - t0 < SETTLE_TIMEOUT_MS) {
    const loading = await page.evaluate(() => {
      const o = document.querySelector('main.outlet')
      const t = o?.textContent ?? ''
      return !o || o.childElementCount === 0 || /Loading[^…]{0,80}…/.test(t) || !!document.querySelector('.hl-hud-loading')
    })
    const cur = JSON.stringify(group(await page.evaluate(collectInPage)))
    if (!loading && cur === prev) {
      if (++stable >= STABLE_POLLS) return JSON.parse(cur) as Values
    } else stable = 0
    prev = cur
    await page.waitForTimeout(POLL_MS)
  }
  throw new Error(`${what}: did not settle within ${SETTLE_TIMEOUT_MS / 1000} s (still loading or values changing)`)
}

// ---------------------------------------------------------------- views

interface Ctx {
  base: string
  context: BrowserContext
  snap: Snapshot
  only: RegExp | null
  stationLinks: Set<string>
}

const want = (c: Ctx, state: string) => !c.only || c.only.test(state)

async function record(c: Ctx, page: Page, state: string): Promise<void> {
  const v = await settle(page, state)
  for (const h of await page.evaluate(() => Array.from(document.querySelectorAll('a[href^="#/station/"]')).map((a) => a.getAttribute('href') ?? ''))) c.stationLinks.add(h)
  if (!want(c, state)) return
  if (c.snap[state]) throw new Error(`view state recorded twice: ${state}`)
  c.snap[state] = v
  log(`${state}: ${Object.keys(v).length} values`)
}

async function open(c: Ctx, hash: string): Promise<Page> {
  const page = await c.context.newPage()
  page.on('pageerror', (e) => debug(`${hash} page error: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && debug(`${hash} console: ${m.text()}`))
  await page.goto(c.base + hash, { waitUntil: 'load' })
  return page
}

const digits = (s: string) => (s.match(/\d+(\.\d+)?/) ?? [s.trim()])[0]

type Loc = ReturnType<Page['locator']>

/** Run one named step; a failure is re-thrown as `step "<name>": <cause>` so a CI log says which control and view broke. */
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.startsWith('step "')) throw e
    throw new Error(`step "${name}": ${msg}`, { cause: e })
  }
}

/** Poll `cond` every POLL_MS (no requestAnimationFrame, so a busy software-GL page cannot stall it) up to SETTLE_TIMEOUT_MS. */
async function waitUntil(page: Page, cond: () => Promise<boolean>, what: string): Promise<void> {
  const t0 = Date.now()
  while (!(await cond())) {
    if (Date.now() - t0 > SETTLE_TIMEOUT_MS) throw new Error(`timed out after ${SETTLE_TIMEOUT_MS / 1000} s waiting for ${what}`)
    await page.waitForTimeout(POLL_MS)
  }
}

/**
 * Select a control deterministically. Fixes a CI flake: the walkback radio was clicked right after a
 * suit-mass click, while the console was still loading and re-rendering the new scenario, and
 * Playwright's "visible, enabled and stable" check ran out of its 30 s default on a slow runner.
 * Precondition: the view has settled (`settle`) since the last change. Every caller guarantees this:
 * each `select` and `record` ends with a settle. Then:
 *   1. the control is attached, visible and enabled (bounded waits, not retries);
 *   2. one real click (full actionability checks; timeout = SETTLE_TIMEOUT_MS like every other wait);
 *   3. wait for the DOM change the click causes (`isOn()` true), then settle again (unless the
 *      caller records next, which settles anyway).
 * Any failure names the step. Nothing is retried; nothing compared is relaxed.
 */
async function select(page: Page, ctl: Loc, name: string, isOn: () => Promise<boolean>, act: 'click' | 'check' = 'click', settleAfter = true): Promise<void> {
  await step(name, async () => {
    await ctl.waitFor({ state: 'visible', timeout: SETTLE_TIMEOUT_MS })
    if (await isOn()) return
    await waitUntil(page, () => ctl.isEnabled(), 'the control to be enabled')
    if (act === 'check') await ctl.check({ timeout: SETTLE_TIMEOUT_MS })
    else await ctl.click({ timeout: SETTLE_TIMEOUT_MS })
    await waitUntil(page, isOn, 'the click to take effect')
    if (settleAfter) await settle(page, `${name} (after)`)
  })
}

const ariaChecked = (b: Loc) => async () => (await b.getAttribute('aria-checked')) === 'true'

async function clickAndRecord(c: Ctx, page: Page, btn: Loc, state: string): Promise<void> {
  await select(page, btn, `${state}: select ${JSON.stringify(((await btn.textContent()) ?? '').trim())}`, ariaChecked(btn), 'click', false)
  await record(c, page, state)
}

async function consoleView(c: Ctx): Promise<void> {
  const page = await open(c, '#/')
  await settle(page, '#/ (initial)')
  const radios = (label: string) => page.locator(`[role="radiogroup"][aria-label="${label}"] button`)
  const budgets = radios('Walkback budget')
  const nb = await budgets.count()
  // every scenario (variant × suit) × budget
  const nv = await radios('Variant').count()
  for (let i = 0; i < nv; i++) {
    const vb = radios('Variant').nth(i)
    if (await vb.isDisabled()) continue
    const variant = (await vb.textContent())!.trim()
    await select(page, vb, `#/ variant=${variant}`, ariaChecked(vb))
    const ns = await radios('Suit mass').count()
    for (let j = 0; j < ns; j++) {
      const sb = radios('Suit mass').nth(j)
      if (await sb.isDisabled()) continue
      const suit = digits((await sb.textContent())!)
      await select(page, sb, `#/ variant=${variant} suit=${suit}kg`, ariaChecked(sb))
      for (let k = 0; k < nb; k++) {
        const bb = budgets.nth(k)
        await clickAndRecord(c, page, bb, `#/ variant=${variant} suit=${suit}kg budget=${digits((await bb.textContent())!)}min`)
      }
    }
  }
  // every D21 parking option × budget (selecting one locks the scenario)
  const pads = page.locator('.pad-picker input[name="pad-option"]')
  const np = await pads.count()
  for (let i = 0; i < np; i++) {
    const r = pads.nth(i)
    const label = (await r.getAttribute('aria-label')) ?? `option ${i + 1}`
    await select(page, r, `#/ pad=${label}`, () => r.isChecked(), 'check')
    for (let k = 0; k < nb; k++) {
      const bb = budgets.nth(k)
      await clickAndRecord(c, page, bb, `#/ pad=${label} budget=${digits((await bb.textContent())!)}min`)
    }
  }
  await page.close()
}

async function simpleView(c: Ctx, hash: string): Promise<void> {
  const page = await open(c, hash)
  await record(c, page, hash)
  await page.close()
}

async function conditionsView(c: Ctx): Promise<void> {
  const page = await open(c, '#/conditions')
  await record(c, page, '#/conditions')
  const slider = page.locator('input[type="range"][aria-label="Dose allowance per EVA"]')
  if (await slider.count()) {
    const max = Number(await slider.getAttribute('max'))
    for (let i = 0; i <= max; i++) {
      await slider.evaluate((el, v) => {
        const inp = el as HTMLInputElement
        inp.value = String(v)
        inp.dispatchEvent(new Event('input', { bubbles: true }))
      }, i)
      await page.waitForTimeout(POLL_MS)
      await record(c, page, `#/conditions leash=${(await slider.getAttribute('aria-valuetext')) ?? i}`)
    }
  }
  await page.close()
}

async function hudView(c: Ctx): Promise<void> {
  const page = await open(c, '#/hud')
  await page.waitForSelector('.hl-hud-row[data-manifest-key], .hl-hud-row[data-source-files]', { timeout: SETTLE_TIMEOUT_MS })
  await settle(page, '#/hud (initial)')
  const exp = page.locator('.hl-hud-exp')
  if (await exp.isHidden()) await select(page, page.locator('.hl-hud-toggle'), '#/hud: expand the panel', () => exp.isVisible())
  const scrub = page.locator('input.hl-hud-scrub')
  const max = Number(await scrub.getAttribute('max'))
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    const t = Math.round(max * f * 10) / 10
    await scrub.evaluate((el, v) => {
      const inp = el as HTMLInputElement
      inp.value = String(v)
      inp.dispatchEvent(new Event('input', { bubbles: true }))
    }, t)
    await record(c, page, `#/hud t=${t}min`)
  }
  await page.close()
}

async function snapshot(base: string, only: RegExp | null): Promise<Snapshot> {
  const browser = await launch()
  try {
    const context = await browser.newContext({ locale: 'en-US', timezoneId: 'UTC', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
    await context.clock.setFixedTime(new Date(FIXED_NOW))
    const c: Ctx = { base, context, snap: {}, only, stationLinks: new Set() }
    await consoleView(c)
    for (const h of ['#/trade', '#/cuff', '#/scorecard', '#/about']) await simpleView(c, h)
    await conditionsView(c)
    await hudView(c)
    if (c.stationLinks.size === 0) throw new Error('no #/station/<id> link found in any view')
    for (const h of [...c.stationLinks].sort()) await simpleView(c, h)
    return c.snap
  } finally {
    await browser.close()
  }
}

// ---------------------------------------------------------------- output + check

function sorted(s: Snapshot): Snapshot {
  const out: Snapshot = {}
  for (const r of Object.keys(s).sort()) {
    out[r] = {}
    for (const k of Object.keys(s[r]).sort()) out[r][k] = s[r][k]
  }
  return out
}

const serialise = (s: Snapshot) => JSON.stringify(sorted(s), null, 2) + '\n'

function diff(base: Snapshot, cur: Snapshot): string[] {
  const lines: string[] = []
  for (const r of [...new Set([...Object.keys(base), ...Object.keys(cur)])].sort()) {
    const b = base[r]
    const c = cur[r]
    if (!b) {
      lines.push(`+ ${r}: extra view state (${Object.keys(c).length} values)`)
      continue
    }
    if (!c) {
      lines.push(`- ${r}: missing view state (${Object.keys(b).length} values)`)
      continue
    }
    for (const k of [...new Set([...Object.keys(b), ...Object.keys(c)])].sort()) {
      if (!(k in c)) lines.push(`- ${r} :: ${k}: missing (was ${JSON.stringify(b[k])})`)
      else if (!(k in b)) lines.push(`+ ${r} :: ${k}: extra ${JSON.stringify(c[k])}`)
      else if (b[k] !== c[k]) lines.push(`~ ${r} :: ${k}: ${JSON.stringify(b[k])} -> ${JSON.stringify(c[k])}`)
    }
  }
  return lines
}

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2))
  VERBOSE = a.verbose
  let proc: ChildProcess | null = null
  let url = a.url
  try {
    if (!url) {
      const p = await startPreview(a.dist)
      proc = p.proc
      url = p.url
      log(`serving ${a.dist} at ${url}`)
    }
    const base = url.replace(/#.*$/, '')
    const snap = sorted(await snapshot(base, a.only))
    const total = Object.values(snap).reduce((n, v) => n + Object.keys(v).length, 0)
    log(`${Object.keys(snap).length} view states, ${total} values`)
    if (a.mode === 'print') process.stdout.write(serialise(snap))
    else if (a.mode === 'write') {
      mkdirSync(dirname(a.file), { recursive: true })
      writeFileSync(a.file, serialise(snap))
      log(`wrote ${a.file}`)
    } else {
      let baseline = JSON.parse(readFileSync(a.file, 'utf8')) as Snapshot
      if (a.only) baseline = Object.fromEntries(Object.entries(baseline).filter(([r]) => a.only!.test(r)))
      const d = diff(baseline, snap)
      if (d.length) {
        console.log(`VALUE SNAPSHOT CHANGED: ${d.length} difference(s) against ${a.file}`)
        console.log('(- missing, + extra, ~ changed; design rule 1: no validated number may change)')
        for (const l of d) console.log(l)
        return 1
      }
      console.log(`value snapshot unchanged: ${Object.keys(snap).length} view states, ${total} values match ${a.file}`)
    }
    return 0
  } finally {
    proc?.kill()
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`values_snapshot: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
    process.exit(2)
  },
)
