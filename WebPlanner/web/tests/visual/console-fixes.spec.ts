/**
 * Static console fixes (X3, D90) in a real browser against the built app. Not a screenshot test: it
 * lives here so the visual config runs it on both projects.
 *   1. Unmount race (fallback-drill finding 1): leaving `#/` early while the map's async layer work is
 *      still running must not log "Cannot add layer … before non-existing layer" nor throw
 *      "Cannot read properties of undefined (reading 'setData')" (consoleMap.setRoute).
 *   2. Rank markers (e2e-demo H5-3): the covered D21 parking-option square at the exact pad spot passes
 *      a mouse click through to the map (the live pad tool listens to map clicks), while the P2-P5 pill
 *      still selects the option.
 *   4. Provenance (e2e-demo H5-6): choosing "#3 rank 3" never renders the previous route/timeline under
 *      the rank-3 manifest keys (the 17 transient `[provenance] mismatch` numbers).
 * Run: cd web && npm run build && npx playwright test tests/visual/console-fixes.spec.ts
 */
import { expect, test, type Page } from 'playwright/test'

const RACE = /before non-existing layer|reading 'setData'|Cannot read properties of (undefined|null)/

function collectErrors(page: Page): string[] {
  const errs: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text())
  })
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`))
  return errs
}

test.describe('console unmount race', () => {
  test('leaving #/ early logs no layer or setData error', async ({ page }) => {
    test.setTimeout(240_000)
    const errs = collectErrors(page)
    // slow the page down (CPU x4) so the async layer work spans the navigation, then sweep the
    // navigation time across the first 1.5 s after the map canvas exists
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    for (let delay = 0; delay <= 1000; delay += 100) {
      await page.goto('/?intro=0#/')
      await page.locator('.console-panel .headline-value').waitFor({ timeout: 30_000 })
      await page.waitForTimeout(delay)
      await page.evaluate(() => (location.hash = '#/trade'))
      await page.waitForTimeout(1_000)
    }
    expect(errs.filter((e) => RACE.test(e))).toEqual([])
    expect(errs.filter((e) => e.startsWith('pageerror'))).toEqual([])
  })
})

/** Wait until the console has drawn its covered parking-option squares and placed them on the map. */
async function rankSquare(page: Page, id: string) {
  const sq = page.locator(`.console-map .pad-option.hl-label-covered[data-select-pad="${id}"]`)
  await sq.waitFor({ state: 'attached', timeout: 30_000 })
  await page.waitForTimeout(500) // fitTo + label layout settle
  const b = await sq.boundingBox()
  expect(b, `${id} square`).not.toBeNull()
  return { sq, x: b!.x + b!.width / 2, y: b!.y + b!.height / 2 }
}

test.describe('rank markers', () => {
  test('a click exactly on a rank square reaches the map', async ({ page }) => {
    await page.goto('/?intro=0#/')
    const { x, y } = await rankSquare(page, 'rank3')
    const hitMarker = await page.evaluate(([px, py]) => !!document.elementFromPoint(px, py)?.closest('.pad-option'), [x, y])
    expect(hitMarker, 'the square must not be the pointer target').toBe(false)
    // MapLibre listens for clicks on the map container: a bubble listener there sees what the map sees
    await page.evaluate(() => {
      const w = window as unknown as { __mapClicks: number }
      w.__mapClicks = 0
      document.querySelector('.console-map')!.addEventListener('click', () => w.__mapClicks++)
    })
    await page.mouse.click(x, y)
    expect(await page.evaluate(() => (window as unknown as { __mapClicks: number }).__mapClicks)).toBe(1)
  })

  test('the rank pill still selects the parking option', async ({ page }) => {
    await page.goto('/?intro=0#/')
    await rankSquare(page, 'rank3')
    const pill = page.locator('.console-map .hl-label[data-code="P3"] .hl-label__pill')
    test.skip((await pill.count()) === 0 || !(await pill.isVisible()), 'P3 pill not placed at this viewport')
    await pill.click()
    await expect(page.locator('.pad-picker tbody tr.on')).toContainText(/rank\s*3/)
  })
})

test.describe('parking option provenance', () => {
  test('choosing rank 3 never shows the old route under rank-3 keys', async ({ page }) => {
    await page.goto('/?intro=0#/')
    const legs = page.locator('.console-panel .route-legs')
    await legs.waitFor({ timeout: 30_000 })
    await page.evaluate(() => {
      const w = window as unknown as { __unbacked: string[] }
      w.__unbacked = []
      const panel = document.querySelector('.console-panel')!
      const seen = (n: Node) => {
        if (!(n instanceof Element)) return
        for (const el of [n, ...n.querySelectorAll('.num-unbacked')]) if (el.classList.contains('num-unbacked')) w.__unbacked.push(`${el.textContent} | ${el.getAttribute('title')}`)
      }
      new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach(seen))).observe(panel, { childList: true, subtree: true })
    })
    const before = await page.locator('.console-panel .num-unbacked').count()
    await page.locator('.pad-picker tbody tr', { hasText: /rank\s*3/ }).click()
    await expect(page.locator('.pad-picker tbody tr.on')).toContainText(/rank\s*3/)
    await expect(legs).toContainText('37.7') // rank 3's first leg, from its own route file
    await page.waitForTimeout(500)
    expect(await page.evaluate(() => (window as unknown as { __unbacked: string[] }).__unbacked)).toEqual([])
    expect(await page.locator('.console-panel .num-unbacked').count()).toBe(before)
  })
})
