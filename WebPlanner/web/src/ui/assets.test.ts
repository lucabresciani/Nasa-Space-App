// WS15 task 1 acceptance: self-hosted fonts within budget, icon sprite in sync, licences recorded.
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import tokens from './tokens.json'
import licences from './licences.json'
import { ICON_NAMES } from './icons/names.gen'

const UI = dirname(fileURLToPath(import.meta.url))
const REPO = join(UI, '..', '..', '..')
const FONTS = join(UI, 'fonts')
const ICONS = join(UI, 'icons')

// DESIGN §5.4 "Fonts ≤ 120 kB"; config/design.yaml performance.fonts_kb once merged.
function fontBudgetKb(): number {
  const p = join(REPO, 'config', 'design.yaml')
  if (existsSync(p)) {
    const m = readFileSync(p, 'utf8').match(/^\s*fonts_kb:\s*(\d+)/m)
    if (m) return Number(m[1])
  }
  return 120
}

describe('fonts', () => {
  const fontsCss = readFileSync(join(FONTS, 'fonts.css'), 'utf8')
  const faces = [...fontsCss.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1])

  it('are WOFF2 files referenced by fonts.css, total within the budget', () => {
    const files = readdirSync(FONTS).filter((f) => f.endsWith('.woff2'))
    expect(files.length).toBe(faces.length)
    let total = 0
    for (const f of files) {
      const buf = readFileSync(join(FONTS, f))
      expect(buf.subarray(0, 4).toString('latin1'), f).toBe('wOF2')
      expect(fontsCss).toContain(`url("./${f}")`)
      total += statSync(join(FONTS, f)).size
    }
    expect(total).toBeLessThanOrEqual(fontBudgetKb() * 1000)
  })

  it('cover exactly the weights in tokens.json, with font-display: swap and no remote URL', () => {
    const weightsOf = (fam: string) =>
      faces.filter((f) => f.includes(`font-family: "${fam}"`)).map((f) => Number(f.match(/font-weight:\s*(\d+)/)![1])).sort()
    const textWeights = [...new Set(Object.values(tokens.font.weight))].sort()
    expect(weightsOf(tokens.font.text)).toEqual(textWeights)
    // Mono: readouts 500 and map labels 600 (DESIGN §3.2).
    expect(weightsOf(tokens.font.mono)).toEqual([500, 600])
    for (const f of faces) expect(f).toMatch(/font-display:\s*swap/)
    expect(fontsCss).not.toMatch(/https?:/)
  })
})

describe('icon sprite', () => {
  const sprite = readFileSync(join(ICONS, 'sprite.svg'), 'utf8')

  it('is in sync with lucide/ and custom/ sources', () => {
    const r = spawnSync(process.execPath, [join(ICONS, 'build-sprite.mjs'), '--check'], { encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  it('has one currentColor symbol per name, no colour literal', () => {
    const ids = [...sprite.matchAll(/<symbol id="i-([\w-]+)"/g)].map((m) => m[1])
    expect(ids).toEqual([...ICON_NAMES])
    expect(sprite).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)
    expect(sprite.match(/stroke="currentColor"/g)?.length).toBe(ids.length)
  })

  it('contains the icons the design needs and the custom marks', () => {
    const need = [
      'map', 'compass', 'file-text', 'shield-check', // modes PLAN / FLY / REPORT / EVIDENCE
      'layers', 'play', 'pause', 'undo-2', 'redo-2', 'search', 'x', 'info', 'chevron-left', 'chevron-right',
      'chevron-up', 'chevron-down', 'triangle-alert', 'locate-fixed', 'box', 'download', 'wifi-off', 'radiation',
      'pad', 'station', 'scored-site', 'user-point', 'turn-back', 'tripwire', 'fix', 'thread-home', 'rover', 'crew',
    ]
    for (const n of need) expect(ICON_NAMES as readonly string[], n).toContain(n)
  })
})

describe('licences.json', () => {
  const ok = new Set(['OFL-1.1', 'ISC', 'MIT', 'Apache-2.0', 'CC0-1.0', 'CC-BY-4.0'])
  it('records every font and icon set with an allowed licence and a source', () => {
    const ids = licences.assets.map((a) => a.id)
    expect(ids).toEqual(expect.arrayContaining(['font-inter', 'font-jetbrains-mono', 'icons-lucide', 'icons-homeline-marks']))
    for (const a of licences.assets) {
      for (const part of String(a.spdx).split(' AND ')) expect(ok.has(part), `${a.id}: ${a.spdx}`).toBe(true)
      expect(a.source).toBeTruthy()
      if ('licence_file' in a && a.licence_file) expect(existsSync(join(REPO, a.licence_file)), a.licence_file).toBe(true)
    }
  })
  it('lists every shipped font file', () => {
    const listed = licences.assets.flatMap((a) => a.files)
    for (const f of readdirSync(FONTS).filter((x) => x.endsWith('.woff2'))) expect(listed).toContain(`web/src/ui/fonts/${f}`)
  })
})
