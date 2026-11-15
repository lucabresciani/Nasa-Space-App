/**
 * Bundle budget (DESIGN §5.4, design kit rule 11, config/design.yaml `performance`).
 *
 * Measures a *built* web app (web/dist) and checks two budgets:
 *   1. First load: the compressed (gzip -9) size of the JavaScript and CSS a cold visit loads before
 *      any lazy chunk: every `<script type="module" src>`, `<link rel="modulepreload">` and
 *      `<link rel="stylesheet">` in dist/index.html, plus every chunk reachable from those scripts
 *      through *static* `import … from "./x.js"` / `export … from "./x.js"` / `import "./x.js"`
 *      (dynamic `import()` is lazy and does not count). The total may grow by at most
 *      `performance.first_load_added_kb_gz` kB over the committed baseline (taken on main).
 *   2. Fonts: every font file shipped in dist (.woff2/.woff/.ttf/.otf, outside data/ and data-dummy/),
 *      counted as raw bytes (WOFF2 is already compressed), at most `performance.fonts_kb` kB.
 * kB = 1000 bytes. Budgets come from config/design.yaml, never from this file.
 *
 * Run (Node ≥ 24 runs the .ts directly; build first: `cd web && npm run build`):
 *   cd web && npm run bundle:budget                 # check against tests/fixtures/bundle_baseline.json
 *   cd web && npm run bundle:budget -- --write      # (re)write the baseline (only from a main build)
 *   node tools/bundle_budget.ts [--dist web/dist] [--baseline FILE] [--write] [--json]
 * Exit 0 within budget, 1 over budget, 2 tool error. Prints a table either way.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WEB = resolve(ROOT, 'web')
const DEFAULT_BASELINE = resolve(ROOT, 'tests/fixtures/bundle_baseline.json')
const KB = 1000
const FONT_EXT = /\.(woff2?|ttf|otf)$/i

interface FileSize {
  file: string // path relative to dist, posix
  kind: 'js' | 'css'
  raw: number
  gzip: number
}
interface Measurement {
  first_load: { files: FileSize[]; js_gzip: number; css_gzip: number; total_gzip: number }
  fonts: { files: { file: string; bytes: number }[]; total: number }
}
interface Baseline {
  note: string
  commit: string
  first_load_total_gzip: number
  first_load_js_gzip: number
  first_load_css_gzip: number
  first_load_files: string[]
}

function parseArgs(argv: string[]) {
  const a = { dist: resolve(WEB, 'dist'), baseline: DEFAULT_BASELINE, write: false, json: false }
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${x} needs a value`)
      return resolve(v)
    }
    if (x === '--dist') a.dist = next()
    else if (x === '--baseline') a.baseline = next()
    else if (x === '--write') a.write = true
    else if (x === '--json') a.json = true
    else if (x === '-h' || x === '--help') {
      console.log('usage: node tools/bundle_budget.ts [--dist DIR] [--baseline FILE] [--write] [--json]')
      process.exit(0)
    } else throw new Error(`unknown argument ${x}`)
  }
  return a
}

function budgets(): { addedKb: number; fontsKb: number } {
  const { parse } = createRequire(resolve(WEB, 'package.json'))('yaml') as typeof import('yaml')
  const cfg = parse(readFileSync(resolve(ROOT, 'config/design.yaml'), 'utf8'))
  const p = cfg?.performance ?? {}
  if (typeof p.first_load_added_kb_gz !== 'number' || typeof p.fonts_kb !== 'number') {
    throw new Error('config/design.yaml performance.first_load_added_kb_gz / fonts_kb missing')
  }
  return { addedKb: p.first_load_added_kb_gz, fontsKb: p.fonts_kb }
}

/** Local asset URLs (relative to dist) from index.html for one tag/attribute pattern. */
function htmlRefs(html: string, tag: RegExp): string[] {
  const out: string[] = []
  for (const m of html.matchAll(tag)) {
    const attrs = m[0]
    const href = /\b(?:src|href)\s*=\s*["']([^"']+)["']/.exec(attrs)?.[1]
    if (href && !/^(?:[a-z]+:)?\/\//i.test(href)) out.push(posix.normalize(href.replace(/^\.?\//, '')))
  }
  return out
}

/** Static import/export specifiers of an ES module chunk (not `import(…)`, which is lazy). */
export function staticImports(code: string): string[] {
  const out = new Set<string>()
  const re = /(?:^|[^\w$.])(?:import|export)\s*(?:[\w$*{}\s,]*?\s*from\s*)?["']([^"'\s]+\.(?:m?js|css))["']/g
  for (const m of code.matchAll(re)) out.add(m[1])
  return [...out]
}

export function measure(dist: string): Measurement {
  const indexPath = resolve(dist, 'index.html')
  if (!existsSync(indexPath)) throw new Error(`${indexPath} not found: build first (cd web && npm run build)`)
  const html = readFileSync(indexPath, 'utf8')
  const scripts = [
    ...htmlRefs(html, /<script\b[^>]*\btype\s*=\s*["']module["'][^>]*>/gi),
    ...htmlRefs(html, /<link\b[^>]*\brel\s*=\s*["']modulepreload["'][^>]*>/gi),
  ]
  const styles = htmlRefs(html, /<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/gi)

  const seen = new Set<string>()
  const queue = [...scripts]
  while (queue.length) {
    const f = queue.shift()!
    if (seen.has(f)) continue
    const abs = resolve(dist, f)
    if (!existsSync(abs)) {
      if (scripts.includes(f)) throw new Error(`index.html references ${f}, which is missing in dist`)
      console.error(`[bundle_budget] warning: static import ${f} not found in dist; skipped`)
      continue
    }
    seen.add(f)
    for (const spec of staticImports(readFileSync(abs, 'utf8'))) {
      if (!spec.startsWith('.') && !spec.startsWith('/')) continue // bare/external: not in dist
      const target = spec.startsWith('/') ? spec.slice(1) : posix.join(posix.dirname(f), spec)
      if (target.endsWith('.css')) styles.push(posix.normalize(target))
      else queue.push(posix.normalize(target))
    }
  }
  const files: FileSize[] = []
  const add = (file: string, kind: 'js' | 'css') => {
    const buf = readFileSync(resolve(dist, file))
    files.push({ file, kind, raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length })
  }
  for (const f of [...seen].sort()) add(f, 'js')
  for (const f of [...new Set(styles)].sort()) add(f, 'css')
  const sum = (k: 'js' | 'css' | null) => files.filter((x) => !k || x.kind === k).reduce((s, x) => s + x.gzip, 0)

  const fonts: { file: string; bytes: number }[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = resolve(dir, name)
      const rel = relative(dist, abs).split('\\').join('/')
      if (rel === 'data' || rel === 'data-dummy') continue
      const st = statSync(abs)
      if (st.isDirectory()) walk(abs)
      else if (FONT_EXT.test(name)) fonts.push({ file: rel, bytes: st.size })
    }
  }
  walk(dist)
  fonts.sort((a, b) => a.file.localeCompare(b.file))

  return {
    first_load: { files, js_gzip: sum('js'), css_gzip: sum('css'), total_gzip: sum(null) },
    fonts: { files: fonts, total: fonts.reduce((s, x) => s + x.bytes, 0) },
  }
}

const kb = (n: number) => `${(n / KB).toFixed(2)} kB`
const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length))
const lpad = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s)

function table(rows: string[][]): string {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)))
  return rows.map((r) => r.map((c, i) => (i === 0 ? pad(c, w[i]) : lpad(c, w[i]))).join('  ')).join('\n')
}

function gitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

function main(): number {
  const a = parseArgs(process.argv.slice(2))
  const b = budgets()
  const m = measure(a.dist)

  if (a.write) {
    const base: Baseline = {
      note: 'First-load JS+CSS gzip (-9) sizes of web/dist on main; tools/bundle_budget.ts allows config/design.yaml performance.first_load_added_kb_gz kB over first_load_total_gzip. Rewrite only from a main build: cd web && npm run build && npm run bundle:budget -- --write',
      commit: gitCommit(),
      first_load_total_gzip: m.first_load.total_gzip,
      first_load_js_gzip: m.first_load.js_gzip,
      first_load_css_gzip: m.first_load.css_gzip,
      first_load_files: m.first_load.files.map((f) => f.file.replace(/-[A-Za-z0-9_-]{8}(\.\w+)$/, '$1')),
    }
    writeFileSync(a.baseline, JSON.stringify(base, null, 2) + '\n')
    console.log(`wrote ${relative(process.cwd(), a.baseline)} (first load ${kb(base.first_load_total_gzip)} gzip, commit ${base.commit})`)
  }
  if (!existsSync(a.baseline)) throw new Error(`baseline ${a.baseline} not found (run with --write on main)`)
  const base = JSON.parse(readFileSync(a.baseline, 'utf8')) as Baseline

  const added = m.first_load.total_gzip - base.first_load_total_gzip
  const firstOk = added <= b.addedKb * KB
  const fontsOk = m.fonts.total <= b.fontsKb * KB

  if (a.json) {
    console.log(JSON.stringify({ measurement: m, baseline: base, budgets: b, added_gzip: added, ok: firstOk && fontsOk }, null, 2))
    return firstOk && fontsOk ? 0 : 1
  }

  console.log(`First-load JS + CSS (dist/index.html entry + static imports + stylesheets), gzip -9:`)
  console.log(
    table([
      ['file', 'raw', 'gzip'],
      ...m.first_load.files.map((f) => [f.file, kb(f.raw), kb(f.gzip)]),
      ['JS total', '', kb(m.first_load.js_gzip)],
      ['CSS total', '', kb(m.first_load.css_gzip)],
    ]),
  )
  console.log(`\nFonts shipped in dist (raw bytes):`)
  console.log(
    m.fonts.files.length
      ? table([['file', 'bytes'], ...m.fonts.files.map((f) => [f.file, kb(f.bytes)])])
      : '(none: fonts are not wired into the app yet)',
  )
  console.log(`\nBudgets (DESIGN §5.4, config/design.yaml performance; baseline ${base.commit}):`)
  console.log(
    table([
      ['budget', 'baseline', 'now', 'change', 'limit', 'result'],
      [
        'first load JS+CSS gzip',
        kb(base.first_load_total_gzip),
        kb(m.first_load.total_gzip),
        `${added >= 0 ? '+' : ''}${kb(added)}`,
        `+${b.addedKb} kB`,
        firstOk ? 'OK' : 'OVER',
      ],
      ['fonts', '', kb(m.fonts.total), '', `${b.fontsKb} kB`, fontsOk ? 'OK' : 'OVER'],
    ]),
  )
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [
      '### Bundle budget (DESIGN §5.4)',
      '',
      '| budget | baseline | now | change | limit | result |',
      '| --- | ---: | ---: | ---: | ---: | --- |',
      `| first load JS+CSS gzip | ${kb(base.first_load_total_gzip)} | ${kb(m.first_load.total_gzip)} | ${added >= 0 ? '+' : ''}${kb(added)} | +${b.addedKb} kB | ${firstOk ? 'OK' : '**OVER**'} |`,
      `| fonts | | ${kb(m.fonts.total)} | | ${b.fontsKb} kB | ${fontsOk ? 'OK' : '**OVER**'} |`,
      '',
    ].join('\n')
    try {
      writeFileSync(process.env.GITHUB_STEP_SUMMARY, md, { flag: 'a' })
    } catch {
      /* summary is optional */
    }
  }
  if (!firstOk) console.log(`\nOVER BUDGET: first load grew by ${kb(added)} (limit ${b.addedKb} kB). Lazy-load the new code (DESIGN §5.4).`)
  if (!fontsOk) console.log(`\nOVER BUDGET: fonts ${kb(m.fonts.total)} (limit ${b.fontsKb} kB). Subset or drop a weight.`)
  return firstOk && fontsOk ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main())
  } catch (e) {
    console.error(`[bundle_budget] ${(e as Error).message}`)
    process.exit(2)
  }
}
