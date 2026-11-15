// DESIGN §9 "Contrast" and "Colour vision" (U12, package Q1). Static: computed from tokens.json, the
// component CSS and the A2 components rendered into the fake DOM (src/ui/testing/dom.ts).
//   1. Contrast matrix: every text-capable colour token on every surface (bg, sidebar, card, cardBorder
//      hover fill, map label pill over the brightest and darkest imagery) ≥ 4.5:1, every colour token
//      as a UI part on bg/sidebar/card ≥ 3:1, unless declared in allowlist.ts with a justification.
//      Every pair the components use (contrast.ts USED_PAIRS) and every token pair a CSS rule sets
//      must pass; no allow-listed pair may be used.
//   2. Colour vision: safe / caution / limit / select pairwise ΔE00 ≥ CVD_MIN_DELTA_E under simulated
//      protanopia, deuteranopia, tritanopia (Machado 2009) and normal vision.
//   3. Second cue: where colour carries meaning in the A2 components (banner kinds, legend swatches,
//      trust chips, selected card / row), a non-colour cue (icon, shape, pattern, border, ARIA) exists.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { h, render, type VNode } from 'preact'
import { act } from 'preact/test-utils'
import { parse as parseYaml } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { contrastRatio, MIN_RATIO, USED_PAIRS } from '../../src/ui/contrast'
import { TOKENS, type ColorToken } from '../../src/ui/tokens'
import { Banner, Card, CHIP_KINDS, LegendRow, ListRow, TrustChip } from '../../src/ui/components'
import { all, byTag, installDom, type FakeNode } from '../../src/ui/testing/dom'
import { CONTRAST_EXCEPTIONS, CVD_EXCEPTIONS, SECOND_CUE_GAPS, type Surface, type Use } from './allowlist'
import { simulatedDeltaE, type Vision } from './cvd'

const WEB = new URL('../../', import.meta.url)
const C = TOKENS.color as Record<ColorToken, string>

/**
 * Minimum CIEDE2000 difference for state colours to count as distinguishable at a glance on map-sized
 * marks: config/design.yaml `quality.cvd_min_delta_e00` (assumed: true, Q1; the rationale is there).
 */
export const CVD_MIN_DELTA_E = readCvdMinDeltaE()

function readCvdMinDeltaE(): number {
  const design = parseYaml(readFileSync(new URL('../config/design.yaml', WEB), 'utf8')) as { quality?: { cvd_min_delta_e00?: unknown } }
  const v = design.quality?.cvd_min_delta_e00
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`config/design.yaml quality.cvd_min_delta_e00 must be a positive number, got ${JSON.stringify(v)}`)
  return v
}
const STATE_COLOURS: readonly ColorToken[] = ['safe', 'caution', 'limit', 'select']
const VISIONS: readonly Vision[] = ['normal', 'protanopia', 'deuteranopia', 'tritanopia']

/** Alpha-composite an rgba() token over an opaque #RRGGBB backdrop. */
function composite(rgba: string, under: string): string {
  const m = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(rgba)
  if (!m) throw new Error(`not rgba(): ${rgba}`)
  const a = Number(m[4])
  const u = /^#(..)(..)(..)$/.exec(under)!.slice(1).map((x) => parseInt(x, 16))
  return '#' + [1, 2, 3].map((i) => Math.round(Number(m[i]) * a + u[i - 1] * (1 - a)).toString(16).padStart(2, '0')).join('')
}

const SURFACE_HEX: Record<Surface, string> = {
  ...C,
  // The basemap is greyscale imagery (§3.1): pure white and pure black bound every pixel under a label pill.
  pillOverWhite: composite(C.labelPill, '#FFFFFF'),
  pillOverBlack: composite(C.labelPill, '#000000'),
}
const TEXT_FG: readonly ColorToken[] = ['text', 'textMuted', 'textFaint', 'select', 'safe', 'caution', 'limit', 'science', 'live']
const TEXT_BG: readonly Surface[] = ['bg', 'sidebar', 'card', 'cardBorder', 'pillOverWhite', 'pillOverBlack']
const UI_FG: readonly ColorToken[] = ['text', 'textMuted', 'textFaint', 'cardBorder', 'select', 'safe', 'caution', 'limit', 'science', 'live', 'unknown']
const UI_BG: readonly Surface[] = ['bg', 'sidebar', 'card']
// cardBorder is a 1 px divider next to the card, not a control boundary that must reach 3:1 on its own
// (the control is identified by its text/icon); it is listed so a future use as a UI part is checked.
const UI_DECORATIVE = new Set<ColorToken>(['cardBorder'])

const ratio = (fg: ColorToken, bg: Surface) => contrastRatio(C[fg], SURFACE_HEX[bg])
const exception = (fg: ColorToken, bg: Surface, use: Use) => CONTRAST_EXCEPTIONS.find((e) => e.fg === fg && e.bg === bg && e.use === use)

describe('contrast matrix (DESIGN §9: text ≥ 4.5:1, UI parts ≥ 3:1)', () => {
  for (const fg of TEXT_FG) {
    for (const bg of TEXT_BG) {
      const ex = exception(fg, bg, 'text')
      it(`text ${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}:1${ex ? ' (allow-listed)' : ''}`, () => {
        if (ex) expect(ratio(fg, bg), `stale allow-list entry ${fg}/${bg}: it passes now, remove it`).toBeLessThan(MIN_RATIO.text)
        else expect(ratio(fg, bg)).toBeGreaterThanOrEqual(MIN_RATIO.text)
      })
    }
  }
  for (const fg of UI_FG.filter((f) => !UI_DECORATIVE.has(f))) {
    for (const bg of UI_BG) {
      const ex = exception(fg, bg, 'ui')
      it(`UI part ${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}:1${ex ? ' (allow-listed)' : ''}`, () => {
        if (ex) expect(ratio(fg, bg)).toBeLessThan(MIN_RATIO.ui)
        else expect(ratio(fg, bg)).toBeGreaterThanOrEqual(MIN_RATIO.ui)
      })
    }
  }
  it('every allow-list entry has a justification and names a known surface', () => {
    for (const e of CONTRAST_EXCEPTIONS) {
      expect(e.why.length, `${e.fg}/${e.bg}`).toBeGreaterThan(20)
      expect(SURFACE_HEX[e.bg], e.bg).toBeDefined()
    }
  })
  it('map label pill: select and text labels ≥ 4.5:1 over any imagery', () => {
    for (const fg of ['select', 'text'] as const) {
      for (const bg of ['pillOverWhite', 'pillOverBlack'] as const) expect(ratio(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(MIN_RATIO.text)
    }
  })
  it('no pair the components use (contrast.ts USED_PAIRS) is allow-listed or below its minimum', () => {
    const bad = USED_PAIRS.filter((p) => exception(p.fg, p.bg, p.use === 'ui' ? 'ui' : 'text') || contrastRatio(C[p.fg], C[p.bg]) < MIN_RATIO[p.use])
    expect(bad.map((p) => `${p.fg} on ${p.bg} (${p.where})`)).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------
// CSS scan: every rule in the token-based stylesheets that sets both a token `color` and a token
// background (or that is a known restricted colour) must be a passing pair.
function cssFiles(dir: URL): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.css')) out.push(p)
    }
  }
  walk(dir.pathname)
  return out
}
const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
const TOKEN_BY_VAR = new Map((Object.keys(C) as ColorToken[]).map((k) => [`--color-${kebab(k)}`, k]))
const tokenOf = (decl: string | undefined): ColorToken | undefined => {
  const m = decl && /^var\((--color-[a-z-]+)\)$/.exec(decl.trim())
  return m ? TOKEN_BY_VAR.get(m[1]) : undefined
}

interface Rule {
  file: string
  sel: string
  color?: ColorToken
  background?: ColorToken
}
function tokenRules(): Rule[] {
  const rules: Rule[] = []
  for (const f of cssFiles(new URL('src/', WEB))) {
    const css = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    if (!css.includes('var(--color-')) continue // legacy stylesheet (style.css): covered by the browser check
    for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const color = tokenOf(/(?:^|[;\s])color\s*:\s*([^;]+)/.exec(body)?.[1])
      const background = tokenOf(/(?:^|[;\s])background(?:-color)?\s*:\s*([^;]+)/.exec(body)?.[1])
      if (color || background) rules.push({ file: relative(WEB.pathname, f), sel: sel.trim(), color, background })
    }
  }
  return rules
}

describe('component stylesheets use only passing pairs', () => {
  const rules = tokenRules()
  it('finds the token stylesheets', () => {
    expect(rules.some((r) => r.file.endsWith('components/components.css'))).toBe(true)
  })
  it('no rule sets an allow-listed or failing text colour on a token background (disabled controls exempt)', () => {
    const bad = rules
      .filter((r) => r.color && r.background && r.color !== r.background)
      // Inactive controls are exempt (WCAG 1.4.3): the allow-list's textFaint rule.
      .filter((r) => !r.sel.split(',').every((s) => /:disabled|\[disabled\]|\[aria-disabled/.test(s)))
      .filter((r) => {
        // A translucent background (the label pill) is checked at both composites that bound it (§3.1 basemap).
        const bgs: Surface[] = r.background === 'labelPill' ? ['pillOverWhite', 'pillOverBlack'] : [r.background as Surface]
        return bgs.some((bg) => exception(r.color!, bg, 'text') || contrastRatio(C[r.color!], SURFACE_HEX[bg]) < MIN_RATIO.text)
      })
      .map((r) => `${r.file}: ${r.sel} (${r.color} on ${r.background})`)
    expect(bad).toEqual([])
  })
  it('textFaint is text only on disabled / placeholder selectors (allow-list rule)', () => {
    const bad = rules.filter((r) => r.color === 'textFaint' && !/disabled|placeholder|\.hl-sg/.test(r.sel)).map((r) => `${r.file}: ${r.sel}`)
    expect(bad).toEqual([])
  })
  it('limit text never on a card background', () => {
    const bad = rules.filter((r) => r.color === 'limit' && (r.background === 'card' || r.background === 'cardBorder')).map((r) => `${r.file}: ${r.sel}`)
    expect(bad).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------
describe('colour vision (DESIGN §9: safe, caution, limit, select distinguishable)', () => {
  for (const vision of VISIONS) {
    for (let i = 0; i < STATE_COLOURS.length; i++) {
      for (let j = i + 1; j < STATE_COLOURS.length; j++) {
        const [a, b] = [STATE_COLOURS[i], STATE_COLOURS[j]]
        const d = simulatedDeltaE(C[a], C[b], vision)
        const ex = CVD_EXCEPTIONS.find((e) => e.vision === vision && ((e.a === a && e.b === b) || (e.a === b && e.b === a)))
        it(`${vision}: ${a} vs ${b} ΔE00 = ${d.toFixed(1)}${ex ? ' (allow-listed)' : ''}`, () => {
          if (ex) expect(d).toBeLessThan(CVD_MIN_DELTA_E)
          else expect(d).toBeGreaterThanOrEqual(CVD_MIN_DELTA_E)
        })
      }
    }
  }
  it('the simulation is sane: protanopia/deuteranopia collapse pure red vs green, tritanopia keeps them apart', () => {
    expect(simulatedDeltaE('#FF0000', '#00FF00', 'normal')).toBeGreaterThan(70)
    expect(simulatedDeltaE('#CC3300', '#669900', 'deuteranopia')).toBeLessThan(simulatedDeltaE('#CC3300', '#669900', 'tritanopia'))
    expect(simulatedDeltaE('#3DD68C', '#3DD68C', 'protanopia')).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------------
let root: FakeNode
beforeEach(() => {
  ;({ container: root } = installDom())
})
afterEach(() => {
  act(() => render(null, root as unknown as Element))
})
function mount(v: VNode): FakeNode {
  act(() => render(v, root as unknown as Element))
  return root
}
const iconsIn = (n: FakeNode): string[] =>
  byTag(n, 'svg')
    .map((s) => (s.getAttribute('class') ?? '').split(/\s+/).find((c) => c.startsWith('icon-')))
    .filter((x): x is string => !!x)
const markup = (n: FakeNode): string =>
  all(n, () => true)
    .map((e) => `${e.localName}[${['d', 'r', 'fill', 'stroke', 'points'].map((a) => e.getAttribute(a) ?? '').join(',')}]`)
    .join(' ')
const componentsCss = readFileSync(new URL('src/ui/components/components.css', WEB), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const CSS_RULES = [...componentsCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }))
/** Declarations of every components.css rule whose selector list contains `selector` exactly. */
const cssBody = (selector: string): string =>
  CSS_RULES.filter((r) => r.sel.split(',').some((s) => s.trim() === selector)).map((r) => r.body).join(';')

describe('second cue where colour carries meaning (DESIGN §3.1, static check over the A2 components)', () => {
  it('banners: caution / limit / offline / info each carry a distinct icon; the alarm is announced (role=alert)', () => {
    const icons: Record<string, string[]> = {}
    for (const kind of ['info', 'caution', 'offline', 'limit'] as const) {
      const n = mount(h(Banner, { kind, title: 'x' }))
      icons[kind] = iconsIn(n)
      expect(icons[kind].length, kind).toBeGreaterThan(0)
      if (kind === 'limit') expect(all(n, (e) => e.getAttribute('role') === 'alert').length).toBe(1)
    }
    expect(new Set(Object.values(icons).map((i) => i.join())).size).toBe(4)
  })
  it('trust chips: every kind has a distinct mark shape (not colour alone)', () => {
    const shapes = CHIP_KINDS.map((kind) => markup(mount(h(TrustChip, { kind }))))
    expect(new Set(shapes).size).toBe(CHIP_KINDS.length)
  })
  it('legend swatches: fill / dense / dashed / line / hatch differ by pattern, opacity or line style', () => {
    const kinds = ['fill', 'dense', 'dashed', 'line', 'hatch'] as const
    for (const swatch of kinds) {
      const n = mount(h(LegendRow, { swatch, color: 'safe', label: 'x' }))
      expect(all(n, (e) => (e.getAttribute('class') ?? '').includes(`hl-swatch--${swatch}`)).length, swatch).toBe(1)
    }
    expect(cssBody('.hl-swatch--dashed')).toMatch(/dashed/)
    expect(cssBody('.hl-swatch--hatch')).toMatch(/repeating-linear-gradient/)
    expect(cssBody('.hl-swatch--dense::before')).toMatch(/opacity:\s*var\(--overlay-opacity-max\)/)
    expect(cssBody('.hl-swatch--fill::before')).toMatch(/opacity:\s*var\(--overlay-opacity-min\)/)
    expect(cssBody('.hl-swatch--line')).toMatch(/solid/)
  })
  it('selection (yellow) is also exposed as aria-current and a heavier outline', () => {
    const card = mount(h(Card, { title: 'x', state: 'selected' }, 'body'))
    expect(all(card, (e) => e.getAttribute('aria-current') === 'true').length).toBe(1)
    expect(cssBody('.hl-card[data-state=selected]')).toMatch(/box-shadow:\s*inset/)
    const row = mount(h(ListRow, { label: 'x', selected: true, onClick: () => {} }))
    expect(all(row, (e) => e.getAttribute('aria-current') === 'true').length).toBe(1)
  })
  it('readout tones: a second cue exists, or the gap is declared in allowlist.ts SECOND_CUE_GAPS', () => {
    const tonesWithCue = (['safe', 'caution', 'limit'] as const).filter((tone) => {
      const body = cssBody(`.hl-readout[data-tone=${tone}]`)
      return /border-style|background-image|::before|::after/.test(body)
    })
    const gap = SECOND_CUE_GAPS.find((g) => g.component === 'Readout')
    if (tonesWithCue.length === 3 && gap) console.warn('[Q1] Readout tones now have a second cue: remove the SECOND_CUE_GAPS entry')
    if (tonesWithCue.length < 3) expect(gap, 'Readout tone has no second cue and no declared gap').toBeDefined()
  })
})
