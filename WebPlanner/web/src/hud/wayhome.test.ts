// Way-home path from the pointer field (F18 drag-anywhere; {scenario}/pointer, contracts v1.1.1).
// The browser follows the pointer pixel to pixel; it never routes. Same cases as
// tests/test_fields_png.py test_pointer_values_and_follow, plus the drag view and a real-data KAT.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeRGBA, FieldGrid, fieldGrid } from './fields'
import { readJson, readPngRGBA, REPO } from './testutil'
import type { FieldsIndex, LonLat, RouteFC } from './types'
import { PointerField, wayHomeView } from './wayhome'

const STENCIL: [number, number][] = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
  [-1, -1], [-1, 1], [1, -1], [1, 1],
  [-2, -1], [-2, 1], [2, -1], [2, 1],
  [-1, -2], [-1, 2], [1, -2], [1, 2],
]

/** Synthetic pointer field: move index per pixel, null = A = 0. 1 m pixels. */
function synth(rows: (number | null)[][]): FieldGrid {
  const H = rows.length
  const W = rows[0].length
  const rgba = new Uint8Array(W * H * 4)
  rows.forEach((r, i) =>
    r.forEach((v, j) => {
      const k = (i * W + j) * 4
      if (v === null) return
      rgba[k] = v >> 8
      rgba[k + 1] = v & 255
      rgba[k + 3] = 255
    }),
  )
  return new FieldGrid({ bounds: [0, 0, W, H], width: W, height: H, res_m: 1 }, decodeRGBA(rgba, W, H, 1), 'move')
}

describe('PointerField', () => {
  it('follows moves to a no-move pixel (as fields_png.follow_pointer)', () => {
    const g = synth([
      [null, null, null],
      [null, null, null],
      [3, 5, null], // (2,0) east -> (2,1) north-east -> (1,2) stop
    ])
    const pf = new PointerField(g, STENCIL)
    expect(pf.followPixels(2, 0)).toEqual({ pixels: [[2, 0], [2, 1], [1, 2]], end: 'stop' })
  })
  it('reports cycles and moves off the grid', () => {
    expect(new PointerField(synth([[3, 2]]), STENCIL).followPixels(0, 0).end).toBe('cycle')
    expect(new PointerField(synth([[0]]), STENCIL).followPixels(0, 0)).toEqual({ pixels: [[0, 0]], end: 'outside' })
  })
  it('pathFrom: starts at the position, reaches the pad pixel', () => {
    const g = synth([
      [null, null, null],
      [null, null, null],
      [3, 5, null],
    ])
    const pf = new PointerField(g, STENCIL)
    const start = g.lonLatOf(2, 0)
    const w = pf.pathFrom(start[0], start[1], g.lonLatOf(1, 2))!
    expect(w.coords[0]).toEqual(start)
    expect(w.coords.length).toBe(3)
    expect(w.reachesPad).toBe(true)
    expect(w.startKnown).toBe(true)
    const u = pf.pathFrom(...g.lonLatOf(0, 0), g.lonLatOf(1, 2))!
    expect(u.startKnown).toBe(false)
    expect(pf.pathFrom(-5, -5, g.lonLatOf(1, 2))).toBeNull()
  })
  it('refuses a move index beyond the stencil', () => {
    expect(() => new PointerField(synth([[16]]), STENCIL)).toThrow()
  })
})

describe('pad on a pixel corner (the real grids: pad = corner of the 3 m cells)', () => {
  // 4 x 4 at 1 m, pad at the corner (x 2, y 2): pixelOf(pad) = (2, 2), but WS2 may hold the pad in
  // any of the 4 cells touching the corner, here (2, 1): (3,0) -> NE (2,1) stop
  const g = synth([
    [null, null, null, null],
    [null, null, null, null],
    [null, null, null, null],
    [5, null, null, null],
  ])
  const pf = new PointerField(g, STENCIL)
  const pad: LonLat = [2, 2]
  it('reaches the pad when the path stops in a pixel touching the pad', () => {
    const w = pf.pathFrom(...g.lonLatOf(3, 0), pad)!
    expect(w.pixels).toEqual([[3, 0], [2, 1]])
    expect(w.reachesPad).toBe(true)
    // the drawn line ends on the pad itself
    expect(w.coords[w.coords.length - 1]).toEqual(pad)
  })
  it('a stop two pixels away is not the pad', () => {
    const far = synth([
      [null, null, null, null],
      [null, null, null, null],
      [null, null, null, null],
      [3, null, null, null], // (3,0) -> E (3,1) stop; pad (3.5, 3.5) is in pixel (0, 3)
    ])
    expect(new PointerField(far, STENCIL).pathFrom(...far.lonLatOf(3, 0), [3.5, 3.5])!.reachesPad).toBe(false)
  })
  it('the start pixel touching the pad counts as at the pad', () => {
    const w = pf.pathFrom(...g.lonLatOf(2, 1), pad)!
    expect(w.reachesPad).toBe(true)
    expect(w.startKnown).toBe(true)
  })
})

describe('wayHomeView (drag-anywhere frame)', () => {
  const g = synth([
    [null, null, null],
    [null, null, null],
    [3, 5, null],
  ])
  const pf = new PointerField(g, STENCIL)
  const pad = g.lonLatOf(1, 2)
  it('nothing while playing (no drag)', () => {
    expect(wayHomeView(pf, null, pad)).toEqual({ map: null, panel: undefined })
  })
  it('no pointer exported: no path, the panel says nothing about it', () => {
    expect(wayHomeView(null, g.lonLatOf(2, 0), pad)).toEqual({ map: null, panel: undefined })
  })
  it('drag on a reached pixel: path for the map, status for the panel', () => {
    const v = wayHomeView(pf, g.lonLatOf(2, 0), pad)
    expect(v.map!.reachesPad).toBe(true)
    expect(v.map!.coords.length).toBe(3)
    expect(v.panel).toEqual({ reachesPad: true, startKnown: true })
  })
  it('drag outside the pointer grid: panel null, nothing drawn', () => {
    expect(wayHomeView(pf, [-5, -5], pad)).toEqual({ map: null, panel: null })
  })
  it('drag on unreached ground: no line, panel says no way home known', () => {
    const v = wayHomeView(pf, g.lonLatOf(0, 0), pad)
    expect(v.map).toBeNull()
    expect(v.panel).toEqual({ reachesPad: false, startKnown: false })
  })
})

// Real KAT (skipped without data/interim): WS2's nom_104 pointer exported by make fields; from
// every vertex of WS2's route the drag path reaches the pad in use (engine/public/pad.json, D21).
const INTERIM = resolve(REPO, 'data/interim')
const FIELDS = resolve(INTERIM, 'export')
const SC = 'nom_104'
const realIdx = resolve(FIELDS, 'fields/index.json')
const haveReal =
  existsSync(realIdx) &&
  !!readJson<FieldsIndex>('fields/index.json', FIELDS).fields[`${SC}/pointer`] &&
  existsSync(resolve(INTERIM, `engine/public/route_${SC}.geojson`)) &&
  existsSync(resolve(INTERIM, 'terrain/grid.json'))

describe.skipIf(!haveReal)(`real ${SC} pointer: way home from the route`, () => {
  const index = haveReal ? readJson<FieldsIndex>('fields/index.json', FIELDS) : (null as unknown as FieldsIndex)
  const meta = haveReal ? index.fields[`${SC}/pointer`] : (null as unknown as FieldsIndex['fields'][string])
  const pf = haveReal
    ? (() => {
        const { rgba, width, height } = readPngRGBA(resolve(FIELDS, meta.file))
        return new PointerField(new FieldGrid(fieldGrid(index, `${SC}/pointer`), decodeRGBA(rgba, width, height, meta.scale), meta.units), meta.stencil!)
      })()
    : (null as unknown as PointerField)
  // the pad in use: WS2's pad.json (D21 official pad), else grid.json's pad_default (grid anchor)
  const padRaw = !haveReal
    ? { lon: 0, lat: 0 }
    : existsSync(resolve(INTERIM, 'engine/public/pad.json'))
      ? readJson<{ pad: { lon: number; lat: number } }>('engine/public/pad.json', INTERIM).pad
      : readJson<{ pad: { lon: number; lat: number } }>('terrain/grid.json', INTERIM).pad
  const pad: LonLat = [padRaw.lon, padRaw.lat]
  const route = haveReal ? readJson<RouteFC>(`engine/public/route_${SC}.geojson`, INTERIM) : (null as unknown as RouteFC)

  it('own 3 m grid with the stencil (contracts v1.1.1)', () => {
    expect(meta.res_m).toBe(3)
    expect(meta.units).toBe('move')
    expect(pf.grid.width).toBe(meta.width)
  })
  it('every route vertex leads home to the pad, never a cycle', () => {
    let n = 0
    for (const f of route.features) {
      if (f.geometry.type !== 'LineString') continue
      for (const [lon, lat] of f.geometry.coordinates.filter((_, i) => i % 10 === 0)) {
        const w = pf.pathFrom(lon, lat, pad)!
        expect(w, `${lon},${lat}`).not.toBeNull()
        if (!w.startKnown) continue // a vertex in the pad-touching cells or at the access cell edge
        expect(w.end, `${lon},${lat}`).toBe('stop')
        expect(w.reachesPad, `${lon},${lat}`).toBe(true)
        n++
      }
    }
    expect(n).toBeGreaterThan(20)
  })
})
