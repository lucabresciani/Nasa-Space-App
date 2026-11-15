/**
 * H2b (WS18 regression, found by X3): in the shell frame the rover drag handle on the official Pad
 * marker must not swallow a plain click. Not a screenshot test: it lives here so the visual config
 * runs it on both projects against the built app.
 *   - A click without movement, and a click with 3 px of hand jitter (MapLibre starts its marker drag
 *     at 3 px), open the official pad card (U14) and open no "What this change costs" strip (no draft).
 *   - A press that moves well beyond the click slop (4 px) still drags the rover: on release the
 *     delta strip opens; Escape discards it.
 * Run: cd web && npm run build && npx playwright test tests/visual/rover-click.spec.ts
 */
import { expect, test, type Page } from 'playwright/test'

const card = (page: Page) => page.locator('.hl-sidebar__body')

async function rover(page: Page): Promise<{ x: number; y: number }> {
  await page.goto('/?intro=0#/')
  const el = page.locator('.hl-edit-rover')
  await el.waitFor({ timeout: 60_000 })
  await expect(el).toHaveAttribute('data-select-pad', 'rank1')
  const b = (await el.boundingBox())!
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

async function press(page: Page, at: { x: number; y: number }, dx: number, dy: number): Promise<void> {
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  if (dx || dy) await page.mouse.move(at.x + dx, at.y + dy, { steps: 4 })
  await page.mouse.up()
}

for (const [name, dx, dy] of [
  ['still click', 0, 0],
  ['click with 3 px jitter', 3, 0],
] as const) {
  test(`rover pad marker: a ${name} opens the official pad card, no edit`, async ({ page }) => {
    const at = await rover(page)
    await expect(card(page)).not.toContainText('Official rover pad')
    await press(page, at, dx, dy)
    await expect(card(page)).toContainText('Official rover pad', { timeout: 5_000 })
    await expect(card(page)).not.toContainText('What this change costs')
    await expect(page.locator('.hl-edit-rover')).not.toHaveClass(/is-dragging/)
  })
}

test('rover pad marker: a press moving beyond the slop still drags (delta strip on release)', async ({ page }) => {
  const at = await rover(page)
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.move(at.x - 60, at.y + 10, { steps: 12 })
  await expect(page.locator('.hl-edit-rover')).toHaveClass(/is-dragging/)
  await page.mouse.up()
  await expect(card(page)).toContainText('What this change costs', { timeout: 10_000 })
  await page.keyboard.press('Escape')
  await expect(card(page)).not.toContainText('What this change costs', { timeout: 5_000 })
})
