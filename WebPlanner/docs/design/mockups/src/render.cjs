// Renders the D7 mockup drafts to PNG with headless Chromium (Playwright core, not a repo dependency).
// Usage (from the repo root):
//   npm i --prefix /tmp/hl-pw playwright-core@1.56.1
//   python3 -m http.server 8790 --bind 127.0.0.1 &      # the pages read web/public/data and web/src/ui over http
//   NODE_PATH=/tmp/hl-pw/node_modules CHROMIUM=$(which chromium) node docs/design/mockups/src/render.cjs [name ...]
// Output: docs/design/mockups/<name>.png
const path = require('path');
const { chromium } = require('playwright-core');

const BASE = process.env.MOCKUP_BASE || 'http://127.0.0.1:8790/docs/design/mockups/src/';
const OUT = path.resolve(__dirname, '..');
const SCREENS = [
  ['01-plan-default', 'plan-default.html', 1440, 900],
  ['01-plan-default-1024', 'plan-default.html', 1024, 768],
  ['02-station-selected', 'station-selected.html', 1440, 900],
  ['03-drag-rover-ghost', 'drag-rover.html', 1440, 900],
  ['04-fly-margin-storm', 'fly-storm.html', 1440, 900],
  ['05-report', 'report.html', 1440, 900],
  ['06-evidence', 'evidence.html', 1440, 900],
];

(async () => {
  const only = process.argv.slice(2);
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || undefined,
    args: ['--disable-gpu', '--force-color-profile=srgb'],
  });
  for (const [name, file, w, h] of SCREENS) {
    if (only.length && !only.includes(name)) continue;
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    page.on('console', (m) => console.log(`[${name}] ${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => console.log(`[${name}] pageerror: ${e.message}`));
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await page.goto(BASE + file, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 60000 });
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log(`wrote ${name}.png (${w}x${h})`);
    await page.close();
  }
  await browser.close();
})();
