// M10b acceptance (follow-ups from the headless promotion run D9 and M12), written first. CPU checks of
// the stylesheet rules and config reads; the real-browser half (the first click during the intro) is
// web/tests/visual/story-intro.spec.ts.
//   2. the Flythrough button group sits on the card surface (was MapLibre white: near-blank), 2 px focus ring
//   3. the drag-the-rover readout draws above the U13 label pills
//   5. during a live story the hidden chrome keeps the pointer (first click skips and reaches its target);
//      only a capture turns the pointer off
//   6. camera.flythrough.turn_deg_per_min and storm.ring_cell_m come from config/design.yaml (assumed)
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { REPO } from '../hud/testutil'
import { RING_CELL_M, ringStride } from '../map/storm/ring'
import { TOKENS } from '../ui/tokens'
import { FOLLOW_TURN_DEG_PER_MIN } from './config'

const css = (p: string): string => readFileSync(resolve(REPO, 'web/src', p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** CSS rules as [selector list, declarations] (flat stylesheets only: no nesting, no @media here). */
function rules(text: string): [string[], Record<string, string>][] {
  const out: [string[], Record<string, string>][] = []
  for (const m of text.matchAll(/([^{}@;]+)\{([^{}]*)\}/g)) {
    const sels = m[1].split(',').map((s) => s.trim()).filter(Boolean)
    const decl: Record<string, string> = {}
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':')
      if (i > 0) decl[d.slice(0, i).trim()] = d.slice(i + 1).trim()
    }
    out.push([sels, decl])
  }
  return out
}
const declOf = (text: string, sel: string): Record<string, string> =>
  Object.assign({}, ...rules(text).filter(([s]) => s.includes(sel)).map(([, d]) => d)) as Record<string, string>

describe('2. Flythrough button styled like the other map controls', () => {
  const fly = css('map/flythrough/flythrough.css')
  it('the control group has the card surface and border (tokens), not MapLibre white', () => {
    const g = declOf(fly, '.maplibregl-ctrl-group.hl-fly')
    expect(g.background).toBe('var(--color-card)')
    expect(g.border).toBe('1px solid var(--color-card-border)')
    // the same as the "Flat vs real" toggle group (M4)
    const col = declOf(css('map/field/collapse.css'), '.maplibregl-ctrl-group.collapse-toggle')
    expect(g.background).toBe(col.background)
    // the storm switch (M12: "same look as the flythrough button") shares it
    expect(declOf(fly, '.maplibregl-ctrl-group.hl-storm-ctrl').background).toBe('var(--color-card)')
  })
  it('text in the text token; focus ring 2 px (tokens line.focusRingPx) in the select colour', () => {
    expect(declOf(fly, '.maplibregl-ctrl-group .hl-fly-btn').color).toBe('var(--color-text)')
    const f = declOf(fly, '.maplibregl-ctrl-group .hl-fly-btn:focus-visible')
    expect(f.outline).toBe('var(--line-focus-ring) solid var(--color-select)')
    expect(TOKENS.line.focusRingPx).toBe(2)
    expect(css('ui/tokens.css')).toMatch(/--line-focus-ring:\s*2px/)
  })
})

describe('3. the drag-the-rover readout sits above the label pills', () => {
  it('readout host z-index > every .hl-label z-index (hover / focus / selected included)', () => {
    const z = (decl: Record<string, string>): number => Number(decl['z-index'] ?? NaN)
    const labelZ = rules(css('map/labels/labels.css'))
      .filter(([s, d]) => s.some((x) => x.startsWith('.hl-label')) && d['z-index'] !== undefined)
      .map(([, d]) => z(d))
    expect(labelZ.length).toBeGreaterThan(0)
    const readout = z(declOf(css('edit/edit.css'), '.hl-edit-drag-host'))
    expect(readout).toBeGreaterThan(Math.max(...labelZ))
  })
})

describe('5. the first click during the intro reaches its target', () => {
  const story = css('story/story.css')
  it('live story: the hidden chrome is transparent but keeps the pointer', () => {
    for (const [sels, d] of rules(story)) {
      if (!sels.some((s) => s.includes("data-story-chrome='hide'"))) continue
      if (d['pointer-events'] === 'none') for (const s of sels) expect(s).toContain('html[data-story-capture]')
    }
    const hide = declOf(story, "html[data-story-chrome='hide'] .hl-ui")
    expect(hide.opacity).toBe('0')
    expect(hide['pointer-events']).toBeUndefined()
  })
  it('capture (no input): the hidden chrome takes no pointer', () => {
    for (const part of ['.hl-ui', '.maplibregl-control-container', '.console-panel'])
      expect(declOf(story, `html[data-story-capture][data-story-chrome='hide'] ${part}`)['pointer-events']).toBe('none')
  })
})

describe('6. config/design.yaml keys (assumed) replace the inline constants', () => {
  const yml = readFileSync(resolve(REPO, 'config/design.yaml'), 'utf8')
  const d = parse(yml) as { camera: { flythrough: { turn_deg_per_min: number } }; storm: { ring_cell_m: number; assumed: string[] } }
  it('camera.flythrough.turn_deg_per_min = 12 (M10), marked assumed', () => {
    expect(d.camera.flythrough.turn_deg_per_min).toBe(12)
    expect(FOLLOW_TURN_DEG_PER_MIN).toBe(d.camera.flythrough.turn_deg_per_min)
    expect(yml.split('\n').find((l) => l.includes('turn_deg_per_min'))).toMatch(/assumed: true/)
  })
  it('storm.ring_cell_m = 20 (M12), marked assumed; the lattice stride follows it', () => {
    expect(d.storm.ring_cell_m).toBe(20)
    expect(d.storm.assumed).toContain('ring_cell_m')
    expect(RING_CELL_M).toBe(20)
    const fi = JSON.parse(readFileSync(resolve(REPO, 'web/public/data/fields/index.json'), 'utf8')) as { res_m: number }
    expect(fi.res_m).toBe(5)
    const grid = { height: 1480, bounds: [137.38, -4.8, 137.45, -4.68] as [number, number, number, number] }
    expect(ringStride({ ...grid, resM: fi.res_m })).toBe(4) // 20 m cells on the 5 m field (M12's stride 4)
    expect(ringStride({ ...grid, resM: 10 })).toBe(2)
  })
})
