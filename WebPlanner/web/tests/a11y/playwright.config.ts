// Playwright config for the accessibility and performance checks (DESIGN §9 "Accessibility",
// "Performance", §5.4; U12; package Q1). Same server, browser settings and viewports as the visual
// regression config (../../playwright.config.ts, D5); only the test files and output folder differ.
// Runs against the *built* app; build first with the Vite manifest (the perf spec reads it):
//   cd web && npm run build -- --manifest && npm run test:a11y-perf
// HL_CHROMIUM=/path/to/chromium where Playwright's bundled browser cannot start (NixOS).
// HL_A11Y_UPDATE=1 rewrites tests/a11y/baseline.json from the current run (see keyboard.spec.ts).
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'playwright/test'
import visual from '../../playwright.config.ts'

const web = fileURLToPath(new URL('../..', import.meta.url))

export default defineConfig({
  ...visual,
  testDir: '..',
  testMatch: ['a11y/**/*.spec.ts', 'perf/**/*.spec.ts'],
  outputDir: '../../test-results/a11y',
  snapshotPathTemplate: undefined,
  // The baseline update mode writes one shared JSON file: one worker then.
  workers: process.env.HL_A11Y_UPDATE ? 1 : visual.workers,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-a11y' }]] : 'list',
  webServer: { ...(visual.webServer as object), cwd: web } as typeof visual.webServer,
})
