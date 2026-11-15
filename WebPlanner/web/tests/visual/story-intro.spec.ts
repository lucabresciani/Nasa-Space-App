/**
 * The descent intro (M10) and the first click (M10b, D9 promotion run). While the intro hides the chrome
 * (story/story.css, `html[data-story-chrome=hide]`) any input skips it. A7b let the dock take that first
 * click; the rest of the chrome (top bar, rail, map controls) still swallowed it, so a control needed
 * a second click. Now the first click both skips the intro and reaches its target, wherever it is.
 * Not a screenshot test: it lives here so the visual config (../../playwright.config.ts) runs it on
 * both projects against the built app.
 * Run: cd web && npm run build && npx playwright test tests/visual/story-intro.spec.ts
 */
import { expect, test, type Page } from 'playwright/test'

/** Load `#/` with the intro playing and its chrome hidden. */
async function introPlaying(page: Page): Promise<void> {
  await page.goto('/#/')
  await page.locator('html[data-story-chrome="hide"]').waitFor({ state: 'attached', timeout: 30_000 })
}

/** Count the clicks that reach `sel` (the element itself, not a covering layer). */
async function watch(page: Page, sel: string): Promise<void> {
  await page.locator(sel).first().waitFor({ state: 'attached', timeout: 30_000 })
  await page.evaluate((s) => {
    const el = document.querySelector(s)!
    ;(window as unknown as { __hits: number }).__hits = 0
    el.addEventListener('click', () => ((window as unknown as { __hits: number }).__hits += 1))
  }, sel)
}
const hits = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { __hits: number }).__hits)

test.describe('descent intro: the first click skips it and reaches its target', () => {
  test.use({ reducedMotion: 'no-preference' }) // the intro never plays under reduced motion

  const targets = [
    { name: 'top bar mode tab (Report)', sel: '.hl-modes__tab[href="#/report/cuff"]', after: (page: Page) => expect(page).toHaveURL(/#\/report\/cuff/) },
    { name: 'map zoom-in control', sel: '.maplibregl-ctrl-zoom-in', after: async () => undefined },
    { name: 'map Flythrough button', sel: '.hl-fly-btn:not(.hl-fly-speed)', after: async () => undefined },
  ]
  for (const tg of targets) {
    test(tg.name, async ({ page }) => {
      await introPlaying(page)
      await watch(page, tg.sel)
      await page.locator(tg.sel).first().click({ timeout: 5_000 })
      expect(await hits(page)).toBe(1)
      await expect(page.locator('html')).not.toHaveAttribute('data-story-chrome', 'hide')
      await tg.after(page)
    })
  }
})
