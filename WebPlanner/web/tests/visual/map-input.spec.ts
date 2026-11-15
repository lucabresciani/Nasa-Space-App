/**
 * I1 (WS16-map, team lead Sun 10:50): the planning map's mouse model on the built app.
 *   - right drag moves the map (centre changes); no browser context menu on the map
 *   - a left drag on the empty map does nothing (centre unchanged, no selection)
 *   - a left drag on the rover moves the rover (drag readout appears)
 *   - a left click on the S7 pill opens its card
 *   - Ctrl + right drag in 3D changes the bearing
 * The camera is read from the map container's data-camera-* attributes (map/input). Not a screenshot
 * test: it lives here so the visual config runs it on both projects against the built app.
 * Run: cd web && npm run build && npx playwright test tests/visual/map-input.spec.ts
 */
import { expect, test, type Page } from 'playwright/test'

const card = (page: Page) => page.locator('.hl-sidebar__body')
const cam = (page: Page) => page.locator('[data-camera-center]').first()
const center = async (page: Page) => (await cam(page).getAttribute('data-camera-center'))!

/** The planning map, loaded, with the rover handle in place; returns the map box. */
async function open(page: Page) {
  await page.goto('/?intro=0#/')
  await page.locator('.hl-edit-rover').waitFor({ timeout: 60_000 })
  await expect(cam(page)).toHaveAttribute('data-camera-center', /,/)
  return (await page.locator('.maplibregl-canvas').boundingBox())!
}

/** A spot on the map with nothing on it (no marker, pill or control under the pointer). */
async function emptySpot(page: Page, box: { x: number; y: number; width: number; height: number }) {
  for (const [fx, fy] of [
    [0.5, 0.75],
    [0.3, 0.7],
    [0.7, 0.3],
    [0.35, 0.35],
    [0.65, 0.65],
    [0.5, 0.25],
  ]) {
    const x = box.x + box.width * fx
    const y = box.y + box.height * fy
    const free = await page.evaluate(
      ([x, y]) => {
        for (let dx = -70; dx <= 70; dx += 10)
          for (let dy = -30; dy <= 30; dy += 10) {
            const el = document.elementFromPoint(x + dx, y + dy)
            if (!el?.classList.contains('maplibregl-canvas')) return false
          }
        return true
      },
      [x, y],
    )
    if (free) return { x, y }
  }
  throw new Error('no empty spot on the map')
}

async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number, button: 'left' | 'right' | 'middle' = 'left') {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down({ button })
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 10 })
  await page.mouse.up({ button })
}

test('right drag moves the map; no context menu on the map', async ({ page }) => {
  const box = await open(page)
  const at = await emptySpot(page, box)
  await page.evaluate(() => document.addEventListener('contextmenu', (e) => ((window as unknown as { __cm: boolean[] }).__cm ??= []).push(e.defaultPrevented)))
  const before = await center(page)
  await drag(page, at, 60, 20, 'right')
  await expect(cam(page)).not.toHaveAttribute('data-camera-center', before, { timeout: 5_000 })
  // moving the pointer right drags the ground right: the centre goes west
  const [lng0] = before.split(',').map(Number)
  const [lng1] = (await center(page)).split(',').map(Number)
  expect(lng1).toBeLessThan(lng0)
  const cm = await page.evaluate(() => (window as unknown as { __cm?: boolean[] }).__cm ?? [])
  expect(cm.every((p) => p)).toBe(true)
})

test('a left drag on the empty map does nothing (no pan, no selection)', async ({ page }) => {
  const box = await open(page)
  const at = await emptySpot(page, box)
  const before = await center(page)
  const text = await card(page).innerText()
  await drag(page, at, 60, 20, 'left')
  await page.waitForTimeout(500)
  expect(await center(page)).toBe(before)
  expect(await card(page).innerText()).toBe(text)
})

test('a left drag on the rover moves the rover (drag readout appears)', async ({ page }) => {
  await open(page)
  const before = await center(page)
  const b = (await page.locator('.hl-edit-rover').boundingBox())!
  const at = { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.move(at.x - 60, at.y + 10, { steps: 12 })
  await expect(page.locator('.hl-edit-rover')).toHaveClass(/is-dragging/)
  await expect(page.locator('.hl-edit-drag-host')).not.toBeEmpty({ timeout: 5_000 })
  await page.mouse.up()
  expect(await center(page)).toBe(before) // the map did not move
  await expect(card(page)).toContainText('What this change costs', { timeout: 10_000 })
  await page.keyboard.press('Escape')
})

test('a left click on the S7 pill opens its card', async ({ page }) => {
  await open(page)
  const s7 = page.getByRole('button', { name: /^S7: / })
  await expect(s7).toBeVisible({ timeout: 10_000 })
  await expect(card(page)).not.toContainText('Science target')
  await s7.click()
  await expect(card(page)).toContainText('Science target', { timeout: 5_000 }) // copy cards.station.title
  await expect(card(page)).toContainText('S7')
})

test('Ctrl + right drag in 3D changes the bearing', async ({ page }) => {
  const box = await open(page)
  const at = await emptySpot(page, box)
  // headless WebGL is software-rendered: M8's FPS guard may drop back to 2D after ~3 s, so the drag
  // follows the switch at once, and a fallback gets a fresh try (M8: pressing 3D again retries)
  let bearing = 0
  for (let attempt = 0; attempt < 4 && bearing === 0; attempt++) {
    await page.locator('.maplibregl-canvas').focus()
    await page.keyboard.press('t') // 2D / 3D (shell shortcut; M8 lifts maxPitch and allows rotation)
    await expect(cam(page)).toHaveAttribute('data-terrain', /3d|flat/, { timeout: 20_000 })
    if ((await cam(page).getAttribute('data-terrain')) !== '3d') continue
    await page.keyboard.down('Control')
    await page.mouse.move(at.x, at.y)
    await page.mouse.down({ button: 'right' })
    await page.mouse.move(at.x + 80, at.y, { steps: 4 })
    await page.mouse.up({ button: 'right' })
    await page.keyboard.up('Control')
    await page.waitForTimeout(300)
    bearing = Number(await cam(page).getAttribute('data-camera-bearing'))
    if (bearing === 0 && (await cam(page).getAttribute('data-terrain')) === '3d') break
  }
  expect(bearing).not.toBe(0)
})
