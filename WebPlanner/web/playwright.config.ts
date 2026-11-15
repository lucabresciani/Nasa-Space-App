// Playwright config for the visual-regression screenshots (DESIGN §9 "Visual regression", kit R7, D5).
// Runs against the *built* app (web/dist) served by `vite preview`; build first (`npm run build`).
// Only 2D views and /styleguide are judged (R7: headless WebGL is software-rendered); map canvases are
// masked. Baselines live in tests/visual/__screenshots__/ and must be produced on CI (ubuntu-latest,
// Playwright's bundled Chromium): see the header of tests/visual/screens.spec.ts.
// Run: npm run test:visual   (HL_CHROMIUM=/path/to/chromium where the bundled one cannot start, e.g. NixOS)
import { defineConfig, type Project } from 'playwright/test'

const PORT = Number(process.env.HL_VISUAL_PORT ?? 4179)

// Click-sensitive specs: real mouse clicks while the map animates (descent intro camera, mission clock
// playing). In software GL every animated frame blocks the page's main thread while the WebGL canvas is
// read back for the compositor, and each mouse event of a click waits for a frame; under parallel load a
// click then outlasts its 5 s timeout (issue #131, notes/M10d.md). These specs run in their own
// projects, one worker, after the screenshot projects, so nothing else competes for the CPU.
const CLICK_SPECS = /(shell-layout|story-intro|map-input|rover-click|console-fixes)\.spec\.ts$/
const VIEWPORTS: [string, { width: number; height: number }][] = [
  ['1440x900', { width: 1440, height: 900 }],
  ['1024x768', { width: 1024, height: 768 }],
]
const screenshotProjects: Project[] = VIEWPORTS.map(([name, viewport]) => ({ name, use: { viewport }, testIgnore: CLICK_SPECS }))
const clickProjects: Project[] = VIEWPORTS.map(([name, viewport], i) => ({
  name: `clicks-${name}`,
  use: { viewport },
  testMatch: CLICK_SPECS,
  workers: 1,
  fullyParallel: false,
  // after every screenshot project, and one viewport after the other: never two click specs at once
  dependencies: i === 0 ? VIEWPORTS.map(([n]) => n) : [`clicks-${VIEWPORTS[i - 1][0]}`],
}))
// GPU compositing (still software GL): the page no longer waits for the canvas read-back on every
// animated frame, which roughly halves the input delay measured in headless Chromium (M10d).
const CHROMIUM_ARGS = ['--enable-gpu-compositing']

export default defineConfig({
  testDir: './tests/visual',
  outputDir: './test-results/visual',
  // One fixed name per screen and viewport, no platform suffix: CI (linux) is the only reference.
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}-{projectName}{ext}',
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 90_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : 'list',
  // Never write a baseline implicitly: a missing baseline is handled by the spec (saved for upload).
  updateSnapshots: 'none',
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      threshold: 0.2, // per-pixel colour distance (0..1), absorbs anti-aliasing noise
      maxDiffPixelRatio: 0.002, // at most 0.2 % of the pixels may differ
    },
  },
  use: {
    baseURL: `http://127.0.0.1:${PORT}/`,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
    launchOptions: { args: CHROMIUM_ARGS, ...(process.env.HL_CHROMIUM ? { executablePath: process.env.HL_CHROMIUM } : {}) },
  },
  projects: [...screenshotProjects, ...clickProjects],
  webServer: {
    command: `node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
