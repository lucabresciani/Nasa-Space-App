// WS16 task 6 (M6): U13 label acceptance (briefs/WS16.md "Labels: no overlap on the six key screens
// at five zooms; route stations always visible"; DESIGN U13). Written before the implementation.
//
// Data: web/public/data/labels.json (P1 export) when this branch has it; the M2 → M5 stack predates
// P1, so until the rebase onto design the test reads fixtures/labels.P1.json, a verbatim copy of
// origin/design web/public/data/labels.json (15 labels, P1 #48).
/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { REPO } from '../../hud/testutil'
import { COLLISION_GAP_PX, LABELS, LEADER_LIFT_PX, MARKER_CLEARANCE_PX } from './config'
import { configMinzoom, configPriority, labelFeatures, layoutLabels, leaderLift, overlaps, parseLabels, pillSize, projectWorld, yieldOverlays, type Box, type LayoutInput, type MapLabel } from './model'

const PUBLISHED = resolve(REPO, 'web/public/data/labels.json')
const FIXTURE = resolve(REPO, 'web/src/map/labels/fixtures/labels.P1.json')
const raw = JSON.parse(readFileSync(existsSync(PUBLISHED) ? PUBLISHED : FIXTURE, 'utf8')) as { labels: MapLabel[] }
const labels = parseLabels(raw)
const fc = labelFeatures(labels)

/** The six key screens' map zooms (Plan default ≈ the AOI fit, station selected / drag ≈ focus, Fly ≈ close, Report overview). */
const KEY_ZOOMS = [12, 13, 14, 15, 16]
const VIEWPORTS = [
  [1440, 900],
  [1024, 768],
] as const

/** Screen positions at a zoom, centred on the label set (as the console's fitTo does). */
function screen(zoom: number, [W, H]: readonly [number, number]): LayoutInput[] {
  const pts = fc.features.map((f) => projectWorld(f.geometry.coordinates[0], f.geometry.coordinates[1], zoom))
  const route = fc.features.filter((f) => f.properties.alwaysVisible).map((f) => pts[fc.features.indexOf(f)])
  const cx = route.reduce((s, p) => s + p[0], 0) / route.length
  const cy = route.reduce((s, p) => s + p[1], 0) / route.length
  return fc.features.map((f, i) => ({ props: f.properties, x: pts[i][0] - cx + W / 2, y: pts[i][1] - cy + H / 2 }))
}

function assertNoOverlap(zoom: number, selected: string | null = null, pitch = 0) {
  const { placed } = layoutLabels(screen(zoom, VIEWPORTS[0]), { zoom, selected, pitch })
  for (let i = 0; i < placed.length; i++)
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]
      const b = placed[j]
      expect(overlaps(a.box, b.box, 0), `z${zoom} sel=${selected}: ${a.code} overlaps ${b.code}`).toBe(false)
    }
  return placed
}

describe('label features from labels.json', () => {
  it('equal the file: codes, coordinates, priority, minzoom (same order)', () => {
    expect(fc.features.map((f) => f.properties.code)).toEqual(raw.labels.map((l) => l.code))
    expect(fc.features.map((f) => f.geometry.coordinates)).toEqual(raw.labels.map((l) => [l.lon, l.lat]))
    expect(fc.features.map((f) => f.properties.priority)).toEqual(raw.labels.map((l) => l.priority))
    expect(fc.features.map((f) => f.properties.minzoom)).toEqual(raw.labels.map((l) => l.minzoom))
    expect(fc.features.map((f) => f.properties.name)).toEqual(raw.labels.map((l) => l.name))
    expect(fc.features.map((f) => f.properties.status)).toEqual(raw.labels.map((l) => l.status))
  })

  it('P1 file: 15 labels, the four route stations in route order', () => {
    expect(labels).toHaveLength(15)
    expect(labels.filter((l) => l.kind === 'route_station').map((l) => l.code)).toEqual(['S7', 'S6', 'S1', 'S4'])
  })

  it('route stations, and only they, are flagged always visible', () => {
    for (const f of fc.features) expect(f.properties.alwaysVisible).toBe(f.properties.kind === 'route_station')
    expect(fc.features.filter((f) => f.properties.alwaysVisible).map((f) => f.properties.code)).toEqual(['S7', 'S6', 'S1', 'S4'])
  })

  it('a route from the active plan re-ranks: on-route stations become route stations, the rest plain stations', () => {
    const re = labelFeatures(labels, new Set(['S2', 'S7']))
    const by = Object.fromEntries(re.features.map((f) => [f.properties.code, f.properties]))
    expect(by.S2.alwaysVisible).toBe(true)
    expect(by.S2.priority).toBe(configPriority('route_station'))
    expect(by.S6.alwaysVisible).toBe(false)
    expect(by.S6.kind).toBe('station')
    expect(by.S6.priority).toBe(configPriority('station'))
    expect(by.PAD.alwaysVisible).toBe(false)
  })

  it('sort order matches config/design.yaml labels.priority; route stations keep route order', () => {
    for (const f of fc.features) expect(f.properties.priority).toBe(configPriority(f.properties.kind))
    const sorted = [...fc.features].sort((a, b) => a.properties.sortKey - b.properties.sortKey)
    const rank = (k: string) => LABELS.priority.indexOf(k as (typeof LABELS.priority)[number])
    for (let i = 1; i < sorted.length; i++) expect(rank(sorted[i].properties.kind)).toBeGreaterThanOrEqual(rank(sorted[i - 1].properties.kind))
    expect(sorted.filter((f) => f.properties.kind === 'route_station').map((f) => f.properties.code)).toEqual(['S7', 'S6', 'S1', 'S4'])
  })

  it('zoom ranges match config/design.yaml labels.minzoom', () => {
    for (const f of fc.features) expect(f.properties.minzoom).toBe(configMinzoom(f.properties.kind))
  })

  it('rejects a file with duplicate codes or a bad kind', () => {
    expect(() => parseLabels({ version: '1', labels: [labels[0], labels[0]] })).toThrow(/duplicate/)
    expect(() => parseLabels({ version: '1', labels: [{ ...labels[0], kind: 'ufo' }] })).toThrow(/bad label/)
    expect(() => parseLabels({ version: '2', labels: [] })).toThrow()
  })
})

describe('placement: collision, zoom ranges, selected layer (CPU check over projected pill boxes)', () => {
  it('pill width comes from the monospace metric: 0.6 em × 11 px per character + 2 × 4 px', () => {
    expect(pillSize('PAD')).toEqual({ w: Math.ceil(3 * 0.6 * 11) + 8, h: 14 + 4 })
    expect(pillSize('MSH').w).toBe(pillSize('PAD').w)
  })

  it.each(KEY_ZOOMS)('z%s: no two placed labels overlap and every route station is placed (both key viewports)', (zoom) => {
    for (const vp of VIEWPORTS) {
      const { placed, hidden } = layoutLabels(screen(zoom, vp), { zoom })
      for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(overlaps(placed[i].box, placed[j].box, 0), `${placed[i].code}/${placed[j].code}`).toBe(false)
      for (const c of ['S7', 'S6', 'S1', 'S4']) expect(placed.map((p) => p.code)).toContain(c)
      expect(hidden.filter((h) => h.reason === 'collision').map((h) => h.code)).not.toContain('S7')
    }
  })

  it('no overlap and no dropped route station anywhere from z5 to z18 (quarter steps)', () => {
    for (let z = 5; z <= 18; z += 0.25) {
      const placed = assertNoOverlap(z)
      for (const c of ['S7', 'S6', 'S1', 'S4']) expect(placed.map((p) => p.code), `z${z}`).toContain(c)
    }
  })

  it('landmarks only from their minzoom; pads from theirs; stations off the route from theirs', () => {
    const at = (z: number) => {
      const r = layoutLabels(screen(z, VIEWPORTS[0]), { zoom: z })
      return { placed: new Set(r.placed.map((p) => p.code)), zoomHidden: new Set(r.hidden.filter((h) => h.reason === 'zoom').map((h) => h.code)) }
    }
    const z5 = at(5)
    for (const c of ['MSH', 'APL', 'GDV', 'PCV', 'PAD', 'P2', 'S2', 'S8']) expect(z5.zoomHidden.has(c), c).toBe(true)
    const z6 = at(6)
    for (const c of ['MSH', 'APL', 'GDV', 'PCV']) expect(z6.zoomHidden.has(c), c).toBe(false)
    expect(z6.placed.has('MSH')).toBe(true)
    expect(at(9.9).zoomHidden.has('PAD')).toBe(true)
    expect(at(10).placed.has('PAD')).toBe(true)
    expect(at(12.9).zoomHidden.has('S2')).toBe(true)
    expect(at(13).zoomHidden.has('S2')).toBe(false)
  })

  it('the lower sort key wins a collision; the loser takes another anchor or drops, never on top', () => {
    const at = (code: string, sortKey: number): LayoutInput => ({ props: { ...fc.features[1].properties, code, sortKey }, x: 0, y: 0 })
    const single = (k: number) => ({ ...at('P9', k), props: { ...at('P9', k).props, marker: false } })
    // two centred (no-marker) pills on one spot: only the first survives
    const r = layoutLabels([single(5), { ...single(3), props: { ...single(3).props, code: 'P8' } }], { zoom: 14 })
    expect(r.placed.map((p) => p.code)).toEqual(['P8'])
    expect(r.hidden).toEqual([{ code: 'P9', reason: 'collision' }])
    // marker pills on one spot: the second moves to the next anchor (left of the point)
    const m = layoutLabels([at('P9', 5), at('P8', 3)], { zoom: 14 })
    expect(m.placed.map((p) => [p.code, p.anchor])).toEqual([
      ['P8', 'left'],
      ['P9', 'right'],
    ])
  })

  it('P2 and P3 (0.000354° apart) never sit on top of each other; P2 (earlier) is placed at z14-16', () => {
    for (const z of [14, 15, 16]) {
      const r = layoutLabels(screen(z, VIEWPORTS[0]), { zoom: z })
      const p2 = r.placed.find((p) => p.code === 'P2')
      expect(p2, `z${z}`).toBeDefined()
      const p3 = r.placed.find((p) => p.code === 'P3')
      if (p3) expect(overlaps(p2!.box, p3.box, 0)).toBe(false)
    }
  })

  it('the selected label is always placed (any zoom, ignores collisions), first anchor, flagged', () => {
    for (const z of [5, ...KEY_ZOOMS]) {
      for (const l of labels) {
        const r = layoutLabels(screen(z, VIEWPORTS[0]), { zoom: z, selected: l.code })
        const s = r.placed.find((p) => p.code === l.code)
        expect(s, `${l.code} at z${z}`).toBeDefined()
        expect(s!.selected).toBe(true)
        expect(r.placed[0].code).toBe(l.code)
      }
    }
  })

  it('with a label selected, the rest still avoid it at the key zooms; route stations are never dropped', () => {
    for (const z of KEY_ZOOMS)
      for (const l of labels) {
        const placed = assertNoOverlap(z, l.code)
        for (const c of ['S7', 'S6', 'S1', 'S4']) expect(placed.map((p) => p.code)).toContain(c)
      }
  })

  it('marker labels sit beside their point (clear of the station ring); landmarks centre on theirs', () => {
    const r = layoutLabels(screen(16, VIEWPORTS[0]), { zoom: 16 })
    const inp = Object.fromEntries(screen(16, VIEWPORTS[0]).map((i) => [i.props.code, i]))
    const s7 = r.placed.find((p) => p.code === 'S7')!
    expect(s7.anchor).toBe('left')
    expect(s7.box.x).toBeCloseTo(inp.S7.x + MARKER_CLEARANCE_PX)
    const r6 = layoutLabels(screen(8, VIEWPORTS[0]), { zoom: 8 })
    const msh = r6.placed.find((p) => p.code === 'MSH')!
    expect(msh.anchor).toBe('center')
  })

  it('leader lines: above the config pitch every label floats above its point (tilt unlocked in 3D, M8)', () => {
    expect(leaderLift(0)).toBe(0)
    expect(leaderLift(LABELS.leaderLineMinPitchDeg)).toBe(0)
    expect(leaderLift(LABELS.leaderLineMinPitchDeg + 1)).toBe(LEADER_LIFT_PX)
    const inp = screen(15, VIEWPORTS[0])
    const r = layoutLabels(inp, { zoom: 15, pitch: 45 })
    for (const p of r.placed) {
      const pt = inp.find((i) => i.props.code === p.code)!
      expect(p.lift).toBe(LEADER_LIFT_PX)
      expect(p.box.y + p.box.h).toBeCloseTo(pt.y - LEADER_LIFT_PX)
    }
    assertNoOverlap(15, null, 45)
  })
})

describe('config/design.yaml cross-check (when present on this branch)', () => {
  const yml = resolve(REPO, 'config/design.yaml')
  it.skipIf(!existsSync(yml))('labels block equals config/design.yaml', () => {
    const d = parse(readFileSync(yml, 'utf8')) as { labels: { priority: string[]; minzoom: Record<string, number>; leader_line_min_pitch_deg: number; pill_padding_px: number[] } }
    expect([...LABELS.priority]).toEqual(d.labels.priority)
    expect({ ...LABELS.minzoom }).toEqual(d.labels.minzoom)
    expect(LABELS.leaderLineMinPitchDeg).toBe(d.labels.leader_line_min_pitch_deg)
    expect([...LABELS.pillPaddingPx]).toEqual(d.labels.pill_padding_px)
  })
})

// M10b (D9 promotion run, 08-terrain-3d-early): in 3D the station pills float up on their leader lines
// into the edge-cause labels ("physiology" over S6, "slope" over S4). The overlay labels yield.
describe('overlay labels yield to the pills (edge causes, zero-margin bindings)', () => {
  const pill = (x: number, y: number, code = 'S4'): Box => ({ x, y, ...pillSize(code) })
  const word = (x: number, y: number): Box => ({ x, y, w: 80, h: 18 })

  it('keeps a clear overlay label where it is', () => {
    expect(yieldOverlays([word(0, 0)], [pill(300, 300)])).toEqual([0])
  })

  it('3D: the S4 pill lifted onto "slope" moves the overlay label off it by the smaller shift, never over a pill', () => {
    // S4 at (870, 355) on screen, pitch 60: the pill floats LEADER_LIFT_PX above it (as in the 3D screenshot)
    const pts: LayoutInput[] = screen(15, VIEWPORTS[0]).filter((i) => i.props.code === 'S4').map((i) => ({ ...i, x: 870, y: 355 }))
    const s4 = layoutLabels(pts, { zoom: 15, pitch: 60 }).placed[0].box
    const slope = word(s4.x - 20, s4.y + 4) // the edge label's own spot under the lifted pill
    expect(overlaps(slope, s4)).toBe(true)
    const [dy] = yieldOverlays([slope], [s4])
    expect(dy).not.toBeNull()
    const moved = { ...slope, y: slope.y + dy! }
    expect(overlaps(moved, s4)).toBe(false)
    // below the pill is the nearer clear spot here (the label sits low on it)
    expect(dy).toBe(s4.y + s4.h + COLLISION_GAP_PX - slope.y)
  })

  it('hides an overlay label boxed in by a column of pills (every nearby gap is too small)', () => {
    const col = Array.from({ length: 10 }, (_, i) => ({ ...pill(0, -120 + 30 * i), w: 200 })) // 12 px gaps: an 18 px label never fits
    expect(yieldOverlays([word(10, 10)], col)).toEqual([null])
  })

  it('never leaves an overlay label over a pill or over an earlier overlay label (random scenes)', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let scene = 0; scene < 200; scene++) {
      const pills = Array.from({ length: 6 }, () => pill(rnd() * 600, rnd() * 400))
      const words = Array.from({ length: 6 }, () => word(rnd() * 600, rnd() * 400))
      const out = yieldOverlays(words, pills)
      const shown = words.flatMap((w, i) => (out[i] === null ? [] : [{ ...w, y: w.y + out[i]! }]))
      for (const [i, a] of shown.entries()) {
        for (const p of pills) expect(overlaps(a, p)).toBe(false)
        for (const b of shown.slice(i + 1)) expect(overlaps(a, b)).toBe(false)
      }
      // a shift only clears a box the label hit where it was: at most one label plus one pill height (it stays by its line)
      for (const dy of out) if (dy !== null) expect(Math.abs(dy)).toBeLessThanOrEqual(18 + pills[0].h + 2 * COLLISION_GAP_PX)
    }
  })
})
