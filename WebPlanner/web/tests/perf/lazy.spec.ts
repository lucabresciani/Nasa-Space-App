/**
 * Performance checks on the production build (DESIGN §5.4 "Lazy loading" and "Fonts", kit rule 11;
 * U12; package Q1). The first-load size budget itself is tools/bundle_budget.ts (D5, job bundle-budget).
 *   1. First-load graph: the 3D scene (src/fp3d, Three.js), the field shader (src/map/spike, future
 *      src/map/field, any GLSL), /styleguide and the M1 spike are NOT in the chunks index.html loads
 *      before any dynamic import() — by the Vite manifest (source → chunk) and by content markers
 *      (Three.js renderer, GLSL sources) so code hoisted into a shared chunk is caught as well.
 *   2. At runtime, opening each 2D route never requests those chunks (network log).
 *   3. Fonts: shipped font files and the font bytes any route downloads ≤ config/design.yaml
 *      performance.fonts_kb (120 kB, kB = 1000 B).
 * Frame rate (60 fps 2D scrub, ≥ 30 fps 3D) is NOT measured here: headless WebGL is software-rendered
 * (R7); the RR lane measures it on the integrated-GPU laptop (DESIGN §9 "Performance").
 * Needs `npm run build -- --manifest` (writes dist/.vite/manifest.json; chunks are identical).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { expect, test } from 'playwright/test'
import { execFileSync } from 'node:child_process'

const WEB = new URL('../../', import.meta.url)
const DIST = new URL('dist/', WEB).pathname
const MANIFEST = new URL('dist/.vite/manifest.json', WEB).pathname
const { parse } = createRequire(new URL('package.json', WEB).pathname)('yaml') as typeof import('yaml')
const PERF = parse(readFileSync(new URL('../config/design.yaml', WEB), 'utf8')).performance as { fonts_kb: number }
const FONT_BUDGET_B = PERF.fonts_kb * 1000

interface Measurement {
  first_load: { files: { file: string }[] }
  fonts: { files: { file: string; bytes: number }[]; total: number }
}
/** tools/bundle_budget.ts (D5) measurement of dist, run as its own process (it is a Node ESM script). */
function measure(dist: string): Measurement {
  const out = execFileSync(process.execPath, [new URL('../tools/bundle_budget.ts', WEB).pathname, '--dist', dist, '--json'], { encoding: 'utf8' })
  const j = JSON.parse(out)
  return (j.measurement ?? j) as Measurement
}

interface Chunk {
  file: string
  src?: string
  isEntry?: boolean
  imports?: string[]
  dynamicImports?: string[]
  css?: string[]
}

/** Lazy-only modules (source paths in the Vite manifest), with the routes allowed to load them. */
const LAZY: { what: string; re: RegExp; required?: string; allowedOn: string[] }[] = [
  // D99: the first-person 3D view (src/fp3d, the only Three.js user) is removed; neither may come back on any route.
  { what: '3D scene (fp3d)', re: /^src\/fp3d\//, allowedOn: [] },
  { what: 'Three.js', re: /node_modules\/three\//, allowedOn: [] },
  { what: 'field shader spike', re: /^src\/map\/spike\//, required: 'src/map/spike/view.ts', allowedOn: ['spike'] },
  { what: 'field shader (U2)', re: /^src\/map\/field\/|\.(glsl|vert|frag)$/, allowedOn: ['spike', 'plan'] },
  { what: 'styleguide', re: /^src\/ui\/styleguide\//, required: 'src/ui/styleguide/view.tsx', allowedOn: ['styleguide'] },
]
/** Content markers: Three.js renderer and GLSL shader sources. */
const MARKERS: { what: string; re: RegExp }[] = [
  { what: 'Three.js', re: /THREE\.WebGLRenderer/ },
  { what: 'GLSL shader source', re: /#version 300 es|gl_FragColor|gl_Position\s*=/ },
]

function loadManifest(): Record<string, Chunk> {
  if (!existsSync(MANIFEST)) throw new Error(`${MANIFEST} missing: build with \`npm run build -- --manifest\``)
  return JSON.parse(readFileSync(MANIFEST, 'utf8'))
}

/** Files index.html loads before any dynamic import (manifest graph ∪ tools/bundle_budget.ts graph). */
function firstLoad(m: Record<string, Chunk>): Set<string> {
  const files = new Set<string>()
  const visit = (key: string) => {
    const c = m[key]
    if (!c || files.has(c.file)) return
    files.add(c.file)
    for (const css of c.css ?? []) files.add(css)
    for (const k of c.imports ?? []) visit(k)
  }
  const entries = Object.entries(m).filter(([, c]) => c.isEntry)
  expect(entries.map(([k]) => k)).toContain('index.html')
  for (const [k] of entries) visit(k)
  for (const f of measure(DIST).first_load.files) files.add(f.file)
  return files
}

test.describe('perf: lazy loading and fonts (production build)', () => {
  test('first-load graph excludes 3D, Three.js, shaders, styleguide and spike', () => {
    const m = loadManifest()
    const first = firstLoad(m)
    for (const l of LAZY) if (l.required) expect(m[l.required], `${l.required} in the manifest (else this check is vacuous)`).toBeDefined()
    const bad: string[] = []
    for (const [key, c] of Object.entries(m)) for (const l of LAZY) if (l.re.test(key) && first.has(c.file)) bad.push(`${l.what}: ${key} → ${c.file}`)
    for (const f of first) {
      if (!f.endsWith('.js')) continue
      const code = readFileSync(DIST + f, 'utf8')
      for (const mk of MARKERS) if (mk.re.test(code)) bad.push(`${mk.what} marker in first-load chunk ${f}`)
    }
    expect(bad).toEqual([])
    test.info().annotations.push({ type: 'first-load', description: [...first].sort().join(', ') })
  })

  test(`fonts shipped in dist ≤ ${PERF.fonts_kb} kB`, () => {
    const fonts = measure(DIST).fonts
    test.info().annotations.push({ type: 'fonts', description: `${fonts.files.length} files, ${fonts.total} B` })
    expect(fonts.total).toBeLessThanOrEqual(FONT_BUDGET_B)
  })

  // Runtime: the chunks a route requests.
  const ROUTES = [
    { name: 'plan', hash: '#/' },
    { name: 'station-S1', hash: '#/station/S1' },
    { name: 'trade', hash: '#/trade' },
    { name: 'conditions', hash: '#/conditions' },
    { name: 'cuff', hash: '#/cuff' },
    { name: 'hud', hash: '#/hud' },
    { name: 'scorecard', hash: '#/scorecard' },
    { name: 'about', hash: '#/about' },
    { name: 'styleguide', hash: '#/styleguide' },
  ]
  for (const r of ROUTES) {
    test(`route ${r.name}: no lazy-only chunk requested, fonts ≤ ${PERF.fonts_kb} kB`, async ({ page }) => {
      const m = loadManifest()
      const forbidden = new Map<string, string>()
      for (const [key, c] of Object.entries(m)) for (const l of LAZY) if (l.re.test(key) && !l.allowedOn.includes(r.name)) forbidden.set(c.file, `${l.what} (${key})`)
      // Chunks with the Three.js marker (D99: no route may load Three.js).
      for (const f of readdirSync(DIST + 'assets')) {
        if (f.endsWith('.js') && MARKERS[0].re.test(readFileSync(DIST + 'assets/' + f, 'utf8'))) forbidden.set(`assets/${f}`, 'Three.js (marker)')
      }
      const requested: string[] = []
      let fontBytes = 0
      page.on('response', async (res) => {
        const path = new URL(res.url()).pathname.replace(/^\//, '')
        requested.push(path)
        if (/\.(woff2?|ttf|otf)$/i.test(path)) fontBytes += (await res.body().catch(() => Buffer.alloc(0))).length
      })
      await page.goto(r.hash)
      await page.waitForLoadState('networkidle')
      await page.evaluate(() => document.fonts.ready.then(() => undefined))
      const bad = requested.filter((p) => forbidden.has(p)).map((p) => `${p}: ${forbidden.get(p)}`)
      expect(bad).toEqual([])
      expect(fontBytes, 'font bytes downloaded').toBeLessThanOrEqual(FONT_BUDGET_B)
    })
  }
})
