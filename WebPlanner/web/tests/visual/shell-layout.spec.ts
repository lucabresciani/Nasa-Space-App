/**
 * Shell layout and the timeline dock's Play button in a real browser (DESIGN §4.3 layout, U5 dock; A7b).
 * Not a screenshot test: it lives here so the visual config (../../playwright.config.ts) runs it on
 * both projects (1440×900 desktop, 1024×768 tablet) against the built app. Found by the headless
 * promotion run (D9): a Playwright click on the dock's Play timed out (30 s) on `#/`, and at 1024×768
 * the rail and the selection card stacked under the map.
 *   - Play takes a real click (Playwright actionability: visible, stable, receives the pointer), also
 *     while the descent intro (M10) hides the chrome, and pauses again while the clock runs.
 *   - Tablet (768–1279): the map region keeps the full width beside a 56 px icon rail and everything
 *     above the 96 px dock; the selection card overlays the map and never covers the dock or the rail.
 *   - Desktop: 320 rail | map | 360 sidebar, 120 dock, as before.
 * Run: cd web && npm run build && npx playwright test tests/visual/shell-layout.spec.ts
 */
import { expect, test, type Page } from 'playwright/test'

const TOP_BAR = 48
type Box = { x: number; y: number; width: number; height: number }

async function box(page: Page, sel: string): Promise<Box> {
  const b = await page.locator(sel).first().boundingBox()
  expect(b, sel).not.toBeNull()
  return b!
}
const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

async function clickPlayAndPause(page: Page): Promise<void> {
  const play = page.locator('.hl-tl__play')
  const clock = page.locator('.hl-tl__clockvalue').first()
  const t0 = await clock.innerText()
  await play.click({ timeout: 5_000 })
  await expect(play).toHaveAttribute('aria-pressed', 'true')
  await expect(clock).not.toHaveText(t0, { timeout: 10_000 }) // the shared mission clock runs
  await play.click({ timeout: 5_000 }) // the dock re-renders on every tick: still one stable target
  await expect(play).toHaveAttribute('aria-pressed', 'false')
}

test.describe('timeline dock Play', () => {
  test('a real click plays and pauses on the plan map', async ({ page }) => {
    await page.goto('/?intro=0#/')
    await page.locator('.hl-tl__play').waitFor({ timeout: 30_000 })
    await clickPlayAndPause(page)
  })

  test.describe('with the descent intro playing', () => {
    test.use({ reducedMotion: 'no-preference' }) // the intro never plays under reduced motion
    test('the first click on Play skips the intro and plays', async ({ page }) => {
      await page.goto('/#/')
      await page.locator('.hl-tl__play').waitFor({ timeout: 30_000 })
      await page.locator('html[data-story-chrome="hide"]').waitFor({ state: 'attached', timeout: 30_000 })
      const play = page.locator('.hl-tl__play')
      await play.click({ timeout: 5_000 })
      await expect(play).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('html')).not.toHaveAttribute('data-story-chrome', 'hide')
    })
  })
})

test.describe('shell layout (§4.3)', () => {
  test('the map region keeps the viewport; a selection never covers the dock', async ({ page }) => {
    const vp = page.viewportSize()!
    const tablet = vp.width < 1280
    await page.goto('/?intro=0#/')
    await page.locator('.hl-tl__play').waitFor({ timeout: 30_000 })
    const main = await box(page, 'main.outlet')
    const rail = await box(page, '.hl-rail')
    const dock = await box(page, '.hl-dock')
    const dockH = tablet ? 96 : 120
    const railW = tablet ? 56 : 320
    expect(Math.round(rail.width)).toBe(railW)
    expect(Math.round(dock.height)).toBe(dockH)
    expect(Math.round(main.x)).toBe(railW)
    expect(Math.round(main.width)).toBe(vp.width - railW)
    expect(Math.round(main.height)).toBe(vp.height - TOP_BAR - dockH)
    expect(Math.round(dock.y)).toBe(vp.height - dockH)

    // select station S7 through the search palette (U17: Enter opens the same card as a map click)
    await page.keyboard.press('Control+k')
    const search = page.getByRole('combobox', { name: 'Search' })
    await search.fill('S7')
    await expect(page.getByRole('option', { selected: true })).toContainText('S7')
    await search.press('Enter')
    await page.locator('.hl-shell[data-sidebar="open"]').waitFor({ state: 'attached', timeout: 30_000 })
    await page.locator('.hl-sidebar .hl-card').first().waitFor({ timeout: 30_000 })
    const side = await box(page, '.hl-sidebar')
    const main2 = await box(page, 'main.outlet')
    expect(Math.round(side.width)).toBe(360)
    expect(overlaps(side, await box(page, '.hl-dock'))).toBe(false)
    expect(overlaps(side, await box(page, '.hl-rail'))).toBe(false)
    if (tablet) {
      // overlay on the right of the map region: the map region itself keeps its size
      expect(Math.round(main2.width)).toBe(vp.width - railW)
      expect(Math.round(side.x + side.width)).toBe(vp.width)
      expect(Math.round(side.height)).toBe(Math.round(main2.height))
    } else {
      expect(Math.round(main2.width)).toBe(vp.width - railW - 360)
    }
    await clickPlayAndPause(page)
  })

  test('tablet: the rail toggle opens the full rail over the map and a rail link closes it', async ({ page }) => {
    test.skip(page.viewportSize()!.width >= 1280, 'tablet only')
    await page.goto('/?intro=0#/')
    await page.locator('.hl-tl__play').waitFor({ timeout: 30_000 })
    const toggle = page.locator('.hl-rail__toggle')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await toggle.click()
    await expect(page.locator('.hl-shell')).toHaveAttribute('data-rail', 'open')
    expect(Math.round((await box(page, '.hl-rail')).width)).toBe(320)
    expect(Math.round((await box(page, 'main.outlet')).x)).toBe(56) // overlay: the map does not move
    await page.locator('.hl-rail__view', { hasText: 'Trade table' }).click()
    await expect(page.locator('.hl-shell')).toHaveAttribute('data-rail', 'collapsed')
  })
})
