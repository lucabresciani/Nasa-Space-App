/**
 * Visual regression of the 2D views (DESIGN §9 "Visual regression", kit rule 12, R7; package D5).
 *
 * Screens: every 2D route of web/src/router.ts plus /styleguide (skipped while the route is not
 * registered, i.e. the app renders its "Not found" page). Viewports: 1440×900 and 1024×768
 * (projects in playwright.config.ts). Never judged here (R7, software WebGL in CI): #/spike (field
 * shader). #/nav and #/hud3d are removed (D98, D99). The MapLibre map and every other <canvas> are masked, so only the DOM
 * around them (panels, legends, chips, text) is compared; the RR lane judges what is drawn on canvases.
 *
 * Baselines: tests/visual/__screenshots__/<screen>-<viewport>.png, taken on CI only (ubuntu-latest,
 * Playwright's bundled Chromium; local browsers and fonts render differently).
 *   - Every run saves the current (masked) screenshot of each screen to
 *     test-results/visual-current/__screenshots__/, same file names as the baselines; CI uploads it as
 *     the artifact `visual-screenshots`.
 *   - No baseline for a screen: the test passes (annotation `no-baseline`). To adopt baselines:
 *     `gh run download <run-id> -n visual-screenshots -D web/tests/visual`, review the PNGs, commit.
 *   - Baseline present: compared with toHaveScreenshot (threshold 0.2, max 0.2 % differing pixels).
 *     On a failure the artifact `visual-diff` holds expected/actual/diff PNGs; if the change is intended,
 *     update the baseline the same way from `visual-screenshots` in the same PR (the RR report reviews it).
 * Run locally: cd web && npm run build && npm run test:visual  (HL_CHROMIUM=/path/to/chromium on NixOS).
 * Local runs never fail on a missing baseline and never write into __screenshots__.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { expect, test, type Page } from 'playwright/test'

/** Same pinned page clock as the value snapshot (tools/values_snapshot.ts). */
const FIXED_NOW = process.env.HL_SNAPSHOT_NOW ?? '2026-11-15T11:00:00Z'
const CURRENT_DIR = resolve(import.meta.dirname, '../../test-results/visual-current/__screenshots__')
const SETTLE_TIMEOUT_MS = 45_000
const POLL_MS = 250
const STABLE_POLLS = 4

interface Screen {
  name: string
  hash: string
  /** Extra selectors to mask beyond every <canvas> (also ignored while waiting for the page to settle). */
  mask?: string[]
  /** Skip when the route is not registered yet (the app shows "Not found"). */
  optional?: boolean
}

const SCREENS: Screen[] = [
  { name: 'plan', hash: '#/', mask: ['.maplibregl-map'] },
  { name: 'station-S1', hash: '#/station/S1' },
  { name: 'trade', hash: '#/trade' },
  { name: 'conditions', hash: '#/conditions' },
  { name: 'cuff', hash: '#/cuff' },
  { name: 'hud', hash: '#/hud', mask: ['.hl-hud-fps'] }, // measured frame rate: never stable
  { name: 'scorecard', hash: '#/scorecard' },
  { name: 'about', hash: '#/about' },
  { name: 'styleguide', hash: '#/styleguide', optional: true },
  // A4 (WS15 task 4): the app shell's mode routes (DESIGN §4.2) and the ?legacy switch (U0).
  { name: 'shell-fly', hash: '#/fly', mask: ['.hl-hud-fps'] },
  { name: 'shell-report', hash: '#/report' },
  { name: 'shell-evidence', hash: '#/evidence/about' },
  { name: 'legacy-trade', hash: '#/trade?legacy=1' },
]

/** Wait until the view has loaded its data: no "Loading" text, fonts ready, and the text stable. */
async function settle(page: Page, volatile: string[]): Promise<void> {
  await page.waitForLoadState('load')
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  const t0 = Date.now()
  let last = ''
  let stable = 0
  while (Date.now() - t0 < SETTLE_TIMEOUT_MS) {
    const text = await page.evaluate((sel) => {
      let t = document.body.innerText
      for (const e of sel.length ? document.querySelectorAll<HTMLElement>(sel.join(',')) : []) {
        if (e.innerText) t = t.split(e.innerText).join('')
      }
      return t
    }, volatile)
    const loading = /Loading/.test(text)
    if (!loading && text.length > 0 && text === last) {
      if (++stable >= STABLE_POLLS) return
    } else stable = 0
    last = text
    await page.waitForTimeout(POLL_MS)
  }
  throw new Error(`page did not settle within ${SETTLE_TIMEOUT_MS} ms (still loading or changing)`)
}

for (const s of SCREENS) {
  test(s.name, async ({ page }, info) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.clock.setFixedTime(new Date(FIXED_NOW))
    await page.goto(s.hash)
    await settle(page, s.mask ?? [])

    if (s.optional) {
      const notFound = await page.getByRole('heading', { name: 'Not found', exact: true }).count()
      test.skip(notFound > 0, `${s.hash} is not registered yet`)
    }
    expect(errors, 'uncaught page errors').toEqual([])

    const mask = [page.locator('canvas'), ...(s.mask ?? []).map((m) => page.locator(m))]
    const file = `${s.name}.png`
    const baseline = info.snapshotPath(file, { kind: 'screenshot' })
    const hasBaseline = existsSync(baseline)
    try {
      if (hasBaseline) await expect(page).toHaveScreenshot(file, { mask })
      else info.annotations.push({ type: 'no-baseline', description: `${basename(baseline)}: not compared` })
    } finally {
      // Keep the current screenshot (pass or fail) so a reviewed run can become the baseline.
      const png = await page.screenshot({ mask, animations: 'disabled', caret: 'hide', scale: 'css' })
      const out = resolve(CURRENT_DIR, basename(baseline))
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, png)
    }
  })
}
