/**
 * Selection-card readouts fit their box (U14 card, DESIGN §3.2 readout type, §3.7 readout; A5b).
 * Not a screenshot test: it lives here so the visual config (../../playwright.config.ts) runs it on both
 * projects (1440×900: 360 px sidebar; 1024×768: 360 px overlay sidebar) against the built app, plus a
 * portrait tablet (768×1024: the half-height bottom sheet). Found by A7b: the S7 card showed "44.3" and
 * "41." because the map cursor readout's CSS (also class .hl-readout) turned card readouts into a
 * two-column grid.
 * For every card kind reachable from search with real data (official pad, the four parking options,
 * route stations, a station, a scored site, every landmark, a terrain cell by coordinates) and the
 * route summary (nothing selected), every readout must:
 *   - not overflow (scrollWidth ≤ clientWidth on the readout and its value; the card does not overflow);
 *   - keep every glyph of its label and value inside its own box (no clipping, no ellipsis);
 *   - never break inside a number (a value may wrap between number and unit, or after a range dash).
 * Leg and edge cards are not reachable from search; legs use the same <Readout> in the same grid, and the
 * edge card has no readout.
 * Run: cd web && npm run build && npx playwright test tests/visual/card-fit.spec.ts
 */
import { expect, test, type Page } from 'playwright/test'

/** Search queries, each one selecting a card (labels.json codes, plus coordinates for a terrain cell). */
const QUERIES: { q: string; option: string | RegExp }[] = [
  ...['PAD', 'P2', 'P3', 'P4', 'P5', 'S7', 'S6', 'S1', 'S4', 'S2', 'S8', 'MSH', 'APL', 'GDV', 'PCV'].map((c) => ({ q: c, option: new RegExp(`^${c}(?![0-9])`) })), // the option text starts with the code badge
  { q: '137.39, -4.79', option: /./ }, // the coordinates row (U17)
]

interface Problem {
  card: string
  readout: string
  why: string
}

/** Measures every readout of the open selection card in the page (see the header for the rules). */
async function measure(page: Page): Promise<{ readouts: number; problems: Problem[] }> {
  return page.evaluate(() => {
    const problems: Problem[] = []
    const card = document.querySelector<HTMLElement>('.hl-selection .hl-card')
    if (!card) return { readouts: 0, problems: [{ card: '', readout: '', why: 'no card' }] }
    const title = (card.querySelector('.hl-card__head')?.textContent ?? '').trim().slice(0, 40)
    const add = (ro: Element, why: string) => problems.push({ card: title, readout: (ro.textContent ?? '').replace(/\s+/g, ' ').trim(), why })
    if (card.scrollWidth > card.clientWidth) add(card, `card overflows: ${card.scrollWidth} > ${card.clientWidth}`)
    const cb = card.getBoundingClientRect()
    if (cb.right > window.innerWidth + 0.5) add(card, `card leaves the viewport: right ${cb.right}`)
    const ros = [...card.querySelectorAll<HTMLElement>('.hl-readout')]
    for (const ro of ros) {
      const v = ro.querySelector<HTMLElement>('.hl-readout__value')
      if (!v) {
        add(ro, 'no value element')
        continue
      }
      if (ro.scrollWidth > ro.clientWidth) add(ro, `readout overflows: ${ro.scrollWidth} > ${ro.clientWidth}`)
      if (v.scrollWidth > v.clientWidth) add(ro, `value overflows: ${v.scrollWidth} > ${v.clientWidth}`)
      const rb = ro.getBoundingClientRect()
      if (rb.left < cb.left - 0.5 || rb.right > cb.right + 0.5) add(ro, 'readout outside the card')
      const cs = getComputedStyle(ro)
      const left = rb.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft) - 0.5
      const right = rb.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight) + 0.5
      for (const el of [ro, ...ro.querySelectorAll<HTMLElement>('*')]) {
        const s = getComputedStyle(el)
        if (s.textOverflow === 'ellipsis' && s.overflowX !== 'visible') add(ro, `ellipsis on ${el.className}`)
      }
      const walker = document.createTreeWalker(ro, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.textContent ?? ''
        if (!text.trim()) continue
        const r = document.createRange()
        r.selectNodeContents(n)
        for (const g of r.getClientRects()) {
          if (g.width === 0) continue
          if (g.left < left || g.right > right) add(ro, `text "${text.trim()}" outside the box (${Math.round(g.left)}–${Math.round(g.right)} vs ${Math.round(left)}–${Math.round(right)})`)
        }
        if (!v.contains(n)) continue
        // a number (with sign / decimal point) is never split across lines
        for (const m of text.matchAll(/[−+-]?\d[\d.,]*/g)) {
          const nr = document.createRange()
          nr.setStart(n, m.index!)
          nr.setEnd(n, m.index! + m[0].length)
          const tops = new Set([...nr.getClientRects()].filter((g) => g.width > 0).map((g) => Math.round(g.top)))
          if (tops.size > 1) add(ro, `number "${m[0]}" broken over ${tops.size} lines`)
        }
      }
    }
    return { readouts: ros.length, problems }
  })
}

async function openCard(page: Page, q: string, option: string | RegExp): Promise<void> {
  // clear first, so the selected card measured below is the new one, never the previous one
  await page.keyboard.press('Escape')
  await expect(page.locator('.hl-selection .hl-card[data-state="selected"]')).toHaveCount(0)
  await page.keyboard.press('Control+k')
  const search = page.getByRole('combobox', { name: 'Search' })
  await search.fill(q)
  const row = page.getByRole('option').filter({ hasText: option }).first()
  await row.waitFor({ timeout: 10_000 })
  await row.click()
  await expect(search).toBeHidden()
  await page.locator('.hl-selection .hl-card[data-state="selected"]:not([aria-busy="true"])').first().waitFor({ timeout: 15_000 })
  await page.waitForLoadState('networkidle')
}

async function checkAllCards(page: Page): Promise<void> {
  await page.goto('/?intro=0#/')
  await page.locator('.hl-tl__play').waitFor({ timeout: 30_000 })
  const all: Problem[] = []
  let total = 0
  for (const { q, option } of QUERIES) {
    await openCard(page, q, option)
    const { readouts, problems } = await measure(page)
    total += readouts
    all.push(...problems.map((p) => ({ ...p, card: `${q}: ${p.card}` })))
  }
  // nothing selected: the route summary card
  await page.keyboard.press('Escape')
  await page.locator('.hl-selection .hl-card:not([data-state="selected"])').first().waitFor({ timeout: 10_000 })
  const summary = await measure(page)
  total += summary.readouts
  all.push(...summary.problems.map((p) => ({ ...p, card: `summary: ${p.card}` })))
  expect(total, 'readouts measured').toBeGreaterThan(40)
  expect(all).toEqual([])
}

test.describe('selection card readouts fit (U14, A5b)', () => {
  test('every readout on every card kind fits the sidebar width', async ({ page }) => {
    await checkAllCards(page)
    // the width under test: the 360 px sidebar (desktop column, tablet overlay)
    const sidebar = await page.locator('.hl-sidebar__body').locator('..').boundingBox()
    expect(Math.round(sidebar!.width)).toBe(360)
  })

  test.describe('portrait tablet bottom sheet', () => {
    test.use({ viewport: { width: 768, height: 1024 } })
    test('every readout fits the bottom sheet', async ({ page }, info) => {
      test.skip(info.project.name !== '1024x768', 'tablet-only layout, run once')
      await checkAllCards(page)
    })
  })
})
