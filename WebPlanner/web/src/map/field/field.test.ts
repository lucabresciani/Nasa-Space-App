// WS16 task 2 (M2) acceptance tests, CPU side (brief WS16 "Acceptance tests", DESIGN U2 / §9
// "Field shader"). Everything runs on the REAL published tree (web/public/data, committed).
// Expected bytes of the known pixels were read independently with Pillow (M1, 2026-11-14).
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { decodeRGBA } from '../../hud/fields'
import { readJson, readPngRGBA, REPO } from '../../hud/testutil'
import type { FieldsIndex } from '../../hud/types'
import tokens from '../../ui/tokens.json'
import { VARIANTS, VARIANT_OF, type Variant } from './constants'
import {
  activeField,
  bandClass,
  bilinearXY,
  decodeGrid,
  decodeState,
  FieldData,
  fieldAt,
  hexToRgb01,
  setActiveField,
  valueAtPixel,
  type Bounds,
  type DecodedGrid,
} from './decode'
import { FS } from './shader'

const PUB = resolve(REPO, 'web/public/data')
const index = readJson<FieldsIndex>('fields/index.json', PUB)
const SUIT = 104

function grid(key: string): DecodedGrid {
  const meta = index.fields[key]
  const { rgba, width, height } = readPngRGBA(resolve(PUB, meta.file))
  return decodeGrid(rgba, width, height, meta.scale, index.bounds as Bounds)
}
const cs = readJson<{ image: string; bounds: Bounds; width: number; height: number; pct: Record<string, number> }>('terrain/cellstate.json', PUB)
const csPng = readPngRGBA(resolve(PUB, cs.image))
const state = decodeState(csPng.rgba, csPng.width, csPng.height, cs.bounds)
const t = { opt: grid(`opt_${SUIT}/t_home`), nom: grid(`nom_${SUIT}/t_home`), con: grid(`con_${SUIT}/t_home`) }
const field = new FieldData(SUIT, t, grid(`nom_${SUIT}/o2_home`), state, [])

/** Lon/lat of the centre of field pixel (row, col). */
function centre(row: number, col: number): [number, number] {
  const [w, s, e, n] = index.bounds
  return [w + ((col + 0.5) / index.width) * (e - w), n - ((row + 0.5) / index.height) * (n - s)]
}

describe('decoded field vs known pixels (counts = R*256 + G, A = 0 no value)', () => {
  // [variant, row, col, RGBA (Pillow), value min | null]
  const known: [Variant, number, number, number[], number | null][] = [
    ['nom', 401, 973, [0, 1, 0, 255], 0.1], // the official pad's pixel
    ['nom', 401, 1173, [1, 146, 0, 255], 40.2],
    ['opt', 401, 1173, [1, 123, 0, 255], 37.9],
    ['con', 401, 1173, [2, 141, 0, 255], 65.3],
    ['nom', 0, 0, [7, 140, 0, 255], 193.2],
    ['nom', 689, 171, [7, 204, 0, 255], 199.6],
    ['con', 492, 373, [10, 88, 0, 255], 264.8],
    ['nom', 740, 740, [1, 120, 0, 255], 37.6],
    ['nom', 701, 873, [0, 0, 0, 0], null],
  ]
  it.each(known)('%s px (%i, %i)', (v, row, col, px, want) => {
    const { rgba } = readPngRGBA(resolve(PUB, index.fields[`${v}_${SUIT}/t_home`].file))
    const j = (row * index.width + col) * 4
    expect(Array.from(rgba.slice(j, j + 4))).toEqual(px)
    const got = valueAtPixel(t[v], row, col)
    if (want === null) expect(got).toBeNull()
    else expect(got).toBeCloseTo(want, 9)
    // fieldAt at the pixel centre returns the same value (nearest) and the shader value there (bilinear)
    const s = field.at(...centre(row, col))
    expect(s.tHome[v]).toBe(got)
    if (want !== null && s.drawn[v] !== null) expect(s.drawn[v]).toBeCloseTo(want, 9)
  })
  it('agrees with the WS7 reference decoder (hud/fields.ts) on every pixel of all three variants', () => {
    for (const v of VARIANTS) {
      const meta = index.fields[`${v}_${SUIT}/t_home`]
      const { rgba, width, height } = readPngRGBA(resolve(PUB, meta.file))
      const ref = decodeRGBA(rgba, width, height, meta.scale)
      let bad = 0
      for (let i = 0; i < width * height; i++) if (ref.known[i] !== t[v].known[i] || (ref.known[i] && ref.counts[i] !== t[v].counts[i])) bad++
      expect(bad, v).toBe(0)
    }
  })
  it('cell state decodes to the published shares (cellstate.json pct)', () => {
    const n = state.code.length
    const share = (c: number) => (100 * state.code.filter((x) => x === c).length) / n
    expect(share(0)).toBeCloseTo(cs.pct.assessed, 1)
    expect(share(1)).toBeCloseTo(cs.pct.blocked, 1)
    expect(share(2)).toBeCloseTo(cs.pct.unknown, 1)
  })
  it('the shader samples texels only (texelFetch, no filtered texture())', () => {
    expect(FS).toMatch(/texelFetch/)
    expect(FS).not.toMatch(/\btexture\s*\(/)
  })
})

describe('manual bilinear on decoded values; unknown if any neighbour unknown', () => {
  // 3 x 2 synthetic grid: counts 0 10 20 / 30 40 (A=0), scale 0.1
  const rgba = [0, 0, 0, 255, 0, 10, 0, 255, 0, 20, 0, 255, 0, 30, 0, 255, 0, 40, 0, 255, 0, 0, 0, 0]
  const g = decodeGrid(rgba, 3, 2, 0.1, [0, 0, 3, 2])
  it('exact at a pixel centre', () => {
    expect(bilinearXY(g, 0.5, 0.5)).toBe(0)
    expect(bilinearXY(g, 0.5, 1.5)).toBeCloseTo(3, 12) // bottom-left; clamped row below
    // (row 1, col 1) is known, but its 2x2 footprint includes (1, 2) with A = 0 -> unknown (shader rule)
    expect(bilinearXY(g, 1.5, 1.5)).toBeNull()
  })
  it('interpolates decoded values (not bytes) between centres', () => {
    expect(bilinearXY(g, 1.0, 0.5)).toBeCloseTo(0.5, 12)
    expect(bilinearXY(g, 1.0, 1.0)).toBeCloseTo((0 + 1 + 3 + 4) / 4, 12)
    // across a byte carry: 255 and 256 counts interpolate to 255.5, not a byte mix
    const h = decodeGrid([0, 255, 0, 255, 1, 0, 0, 255], 2, 1, 1, [0, 0, 2, 1])
    expect(bilinearXY(h, 1.0, 0.5)).toBe(255.5)
  })
  it('any of the four neighbours without a value -> unknown', () => {
    expect(bilinearXY(g, 2.0, 1.0)).toBeNull() // touches (1, 2) with A = 0
    expect(bilinearXY(g, 1.6, 0.6)).toBeNull()
    expect(bilinearXY(g, 1.4, 0.6)).not.toBeNull()
  })
  it('real grid: (701, 873) has no value, so every sample whose 2x2 footprint touches it is null', () => {
    expect(bilinearXY(t.nom, 873.5, 701.5)).toBeNull()
    expect(bilinearXY(t.nom, 873.9, 701.9)).toBeNull()
    expect(bilinearXY(t.nom, 873.1, 701.1)).toBeNull()
    expect(bilinearXY(t.nom, 1173.5, 401.5)).toBeCloseTo(40.2, 9)
  })
  it('outside the grid -> null (nothing drawn)', () => {
    expect(bilinearXY(g, -0.01, 0.5)).toBeNull()
    expect(bilinearXY(g, 3.01, 0.5)).toBeNull()
  })
})

describe('band classification (bands mode)', () => {
  const d = (opt: number | null, nom: number | null, con: number | null) => ({ opt, nom, con })
  it.each([
    [d(20, 25, 29.9), 30, 'con'],
    [d(20, 25, 30.0), 30, 'con'],
    [d(20, 25, 30.1), 30, 'nom'],
    [d(20, 30.1, 40), 30, 'opt'],
    [d(30.1, 35, 40), 30, 'none'],
    [d(30.1, 35, 40), 60, 'con'],
    [d(20, null, null), 30, 'opt'],
    [d(null, null, null), 60, 'none'],
  ] as const)('%o budget %i -> %s', (drawn, budget, want) => {
    expect(bandClass(drawn, false, budget)).toBe(want)
  })
  it('unknown terrain is always the hatch class, never a band colour', () => {
    expect(bandClass(d(1, 1, 1), true, 30)).toBe('unknown')
    expect(bandClass(d(null, null, null), true, 30)).toBe('unknown')
  })
  it('known terrain with no route home (t_home A = 0) is unfilled, not hatched', () => {
    const s = field.at(...centre(701, 873))
    expect(s.inside).toBe(true)
    expect(s.state).not.toBe('unknown')
    expect(s.unknown).toBe(false)
    expect(s.tHome.nom).toBeNull()
    expect(s.noRouteHome.nom).toBe(true)
    expect(bandClass(s.drawn, s.unknown, 60)).toBe('none')
  })
  it('the published tree: no cell is unknown (cellstate pct.unknown = 0), so nothing is hatched inside the grid', () => {
    expect(cs.pct.unknown).toBe(0)
    let hatched = 0
    for (let row = 0; row < index.height; row += 37) for (let col = 0; col < index.width; col += 37) if (field.at(...centre(row, col)).unknown) hatched++
    expect(hatched).toBe(0)
  })
  it('variant names of scenarios/index.json map to the field keys', () => {
    expect(VARIANT_OF).toEqual({ optimistic: 'opt', nominal: 'nom', conservative: 'con' })
  })
  it('band colours come from tokens.json', () => {
    expect(hexToRgb01(tokens.color.safe)).toEqual([0x3d / 255, 0xd6 / 255, 0x8c / 255])
    expect(() => hexToRgb01(tokens.color.labelPill)).toThrow()
  })
})

describe('with the precomputed band inputs, the drawn edge lies within one 5 m cell of the published band contour', () => {
  // scenarios/bands_104.geojson: polygons of {T_home <= budget} on WS2's 3 m cell edges, simplified by
  // config/variants.yaml outputs.simplify_tolerance_m (pipeline/engine/envelope.py). The field PNG is
  // the same T_home sampled at 5 m pixel centres (pipeline/export/fields_png.py), i.e. the band input.
  const simplifyM: number = (parse(readFileSync(resolve(REPO, 'config/variants.yaml'), 'utf8')) as { outputs: { simplify_tolerance_m: number } }).outputs.simplify_tolerance_m
  const cell = index.res_m
  const bands = readJson<{ features: { properties: { budget: number; variant: string }; geometry: { type: string; coordinates: unknown } }[] }>(`scenarios/bands_${SUIT}.geojson`, PUB)
  const [w, s, e, n] = index.bounds
  const mx = (index.width * cell) / (e - w)
  const my = (index.height * cell) / (n - s)

  /** Segments of every ring in grid metres (x east, y south from the NW corner), bucketed by 10 m. */
  function segmentIndex(geom: { type: string; coordinates: unknown }) {
    const polys = (geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates]) as number[][][][]
    const B = 10
    const buckets = new Map<string, number[]>()
    const segs: number[] = []
    for (const poly of polys)
      for (const ring of poly)
        for (let i = 0; i + 1 < ring.length; i++) {
          const x0 = (ring[i][0] - w) * mx
          const y0 = (n - ring[i][1]) * my
          const x1 = (ring[i + 1][0] - w) * mx
          const y1 = (n - ring[i + 1][1]) * my
          const k = segs.length
          segs.push(x0, y0, x1, y1)
          for (let bx = Math.floor(Math.min(x0, x1) / B); bx <= Math.floor(Math.max(x0, x1) / B); bx++)
            for (let by = Math.floor(Math.min(y0, y1) / B); by <= Math.floor(Math.max(y0, y1) / B); by++) {
              const key = `${bx},${by}`
              const l = buckets.get(key)
              if (l) l.push(k)
              else buckets.set(key, [k])
            }
        }
    return (x: number, y: number): number => {
      let best = Infinity
      for (let bx = Math.floor(x / B) - 1; bx <= Math.floor(x / B) + 1; bx++)
        for (let by = Math.floor(y / B) - 1; by <= Math.floor(y / B) + 1; by++)
          for (const k of buckets.get(`${bx},${by}`) ?? []) {
            const [x0, y0, x1, y1] = [segs[k], segs[k + 1], segs[k + 2], segs[k + 3]]
            const dx = x1 - x0
            const dy = y1 - y0
            const L = dx * dx + dy * dy
            const u = L > 0 ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / L)) : 0
            best = Math.min(best, Math.hypot(x0 + u * dx - x, y0 + u * dy - y))
          }
      return best // Infinity = farther than 10 m
    }
  }

  /** Points where the drawn edge crosses the pixel-centre lines (the shader's bilinear along them). */
  function drawnEdgePoints(g: DecodedGrid, budget: number): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = []
    for (let row = 0; row < g.height; row++)
      for (let col = 0; col < g.width; col++) {
        const a = valueAtPixel(g, row, col)
        if (a === null) continue
        for (const [dr, dc] of [
          [0, 1],
          [1, 0],
        ]) {
          const b = valueAtPixel(g, row + dr, col + dc)
          if (b === null || a <= budget === b <= budget) continue
          const f = (budget - a) / (b - a)
          const px = col + 0.5 + dc * f
          const py = row + 0.5 + dr * f
          if (bilinearXY(g, px, py) === null) continue // not drawn (a neighbour has no value)
          out.push({ x: px * cell, y: py * cell })
        }
      }
    return out
  }

  for (const f of bands.features) {
    const v = VARIANT_OF[f.properties.variant]
    const budget = f.properties.budget
    it(`${f.properties.variant} ${budget} min`, () => {
      const dist = segmentIndex(f.geometry)
      const pts = drawnEdgePoints(t[v], budget)
      expect(pts.length).toBeGreaterThan(100)
      const d = pts.map((p) => dist(p.x, p.y))
      const within = d.filter((x) => x <= cell).length / d.length
      const worst = Math.max(...d)
      // one 5 m cell; the published polygon itself is simplified by simplify_tolerance_m on top
      expect(within, `share within ${cell} m`).toBeGreaterThanOrEqual(0.99)
      expect(worst, `worst distance (m)`).toBeLessThanOrEqual(cell + simplifyM)
    })
  }
})

describe('fieldAt at the pad and at each station equals the published value', () => {
  type Access = { lon: number | null; lat: number | null; t_home_min: number | null; o2_home_L: number | null }
  const stations = readJson<{ id: string; access: Record<string, Access> }[]>('stations.json', PUB)
  const pad = readJson<{ pad: { lon: number; lat: number } }>('pad.json', PUB).pad
  const timeline = readJson<{ event: string; t_home_min: number | null }[]>(`timeline_nom_${SUIT}.json`, PUB)
  const T_COUNT = index.fields[`nom_${SUIT}/t_home`].scale // 0.1 min: the field's resolution
  const O2_TOL = 0.1 // L; o2_home is 0.01 L per count, but the 5 m pixel samples the 3 m cell under its centre

  it('pad: T_home within one count of the timeline depart value, all variants; terrain assessed', () => {
    const s = field.at(pad.lon, pad.lat)
    const depart = timeline.find((e) => e.event === 'depart')!.t_home_min!
    for (const v of VARIANTS) expect(Math.abs(s.tHome[v]! - depart), v).toBeLessThanOrEqual(T_COUNT + 1e-9)
    expect(s.state).toBe('assessed')
    expect(s.unknown).toBe(false)
  })

  // The published station values are WS2's 3 m access cell; the 5 m field pixel samples the 3 m cell
  // under its centre (fields_png.py). Where that sampled cell has no route home, the field has no
  // value: listed here explicitly (never skipped silently).
  const NO_VALUE_AT_5M = new Set(['S1/con', 'S2/con', 'S8/con'])
  const rows = stations.flatMap((st) => VARIANTS.map((v) => [st.id, v, st.access[`${v}_${SUIT}`]] as const)).filter(([, , a]) => a && a.lon !== null && a.t_home_min !== null)
  it.each(rows)('%s %s', (id, v, a) => {
    const s = fieldAt(a.lon!, a.lat!) ?? field.at(a.lon!, a.lat!)
    expect(s.inside).toBe(true)
    expect(s.unknown).toBe(false)
    if (NO_VALUE_AT_5M.has(`${id}/${v}`)) {
      expect(s.tHome[v]).toBeNull()
      expect(s.noRouteHome[v]).toBe(true)
      return
    }
    expect(Math.abs(s.tHome[v]! - a.t_home_min!), `t_home ${s.tHome[v]} vs ${a.t_home_min}`).toBeLessThanOrEqual(T_COUNT + 1e-9)
    if (v === 'nom') expect(Math.abs(s.o2Home! - a.o2_home_L!), `o2_home ${s.o2Home} vs ${a.o2_home_L}`).toBeLessThanOrEqual(O2_TOL + 1e-9)
  })
  it('covers six stations, nominal at every one', () => {
    expect(new Set(rows.map((r) => r[0])).size).toBe(6)
    expect(rows.filter((r) => r[1] === 'nom').length).toBe(6)
  })
})

describe('fieldAt (app-wide lookup)', () => {
  it('is null until a field is active, then reads the active field', () => {
    setActiveField(null)
    expect(fieldAt(0, 0)).toBeNull()
    setActiveField(field)
    expect(activeField()).toBe(field)
    const [lon, lat] = centre(401, 1173)
    expect(fieldAt(lon, lat)!.tHome).toEqual({ opt: valueAtPixel(t.opt, 401, 1173), nom: valueAtPixel(t.nom, 401, 1173), con: valueAtPixel(t.con, 401, 1173) })
  })
  it('outside the grid: not inside, no values', () => {
    const s = field.at(index.bounds[0] - 0.01, index.bounds[3] + 0.01)
    expect(s.inside).toBe(false)
    expect(s.tHome).toEqual({ opt: null, nom: null, con: null })
    expect(s.drawn).toEqual({ opt: null, nom: null, con: null })
  })
})

describe('lazy loading and fallback wiring', () => {
  const src = readFileSync(resolve(REPO, 'web/src/map/consoleMap.ts'), 'utf8')
  it('the shader and GL layer load only dynamically (field/index.ts loadFieldLayer)', () => {
    const idx = readFileSync(resolve(REPO, 'web/src/map/field/index.ts'), 'utf8')
    expect(idx).toMatch(/import\('\.\/layer'\)/)
    expect(idx).not.toMatch(/^(import|export) .*from '\.\/(layer|shader)'/m)
    expect(src).toMatch(/loadFieldLayer\(\)/)
    expect(src).not.toMatch(/^import .*field\/(layer|shader)/m)
    for (const f of ['decode.ts', 'load.ts', 'constants.ts']) expect(readFileSync(resolve(REPO, 'web/src/map/field', f), 'utf8'), f).not.toMatch(/from '\.\/(layer|shader)'/)
  })
  it('the polygon band layers stay in the map (no-WebGL2 fallback)', () => {
    for (const id of ['band-opt', 'band-con', 'band-lines']) expect(src).toContain(`'${id}'`)
  })
})
