import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { decodeRGBA, FieldGrid, fieldGrid } from './fields'
import { DUMMY, readJson, readPngRGBA } from './testutil'
import type { FieldsIndex } from './types'

describe('decodeRGBA (contract: counts = R*256 + G, A = 0 unknown)', () => {
  it('decodes the byte layout of pipeline/export/fields_png.py test_rgba_layout', () => {
    // counts 0, 1, 256, 65535 at scale 0.1 -> 0, 0.1, 25.6, 6553.5
    const rgba = [0, 0, 0, 255, 0, 1, 0, 255, 1, 0, 0, 255, 255, 255, 0, 255]
    const f = decodeRGBA(rgba, 4, 1, 0.1)
    expect(Array.from(f.counts)).toEqual([0, 1, 256, 65535])
    const g = new FieldGrid({ bounds: [0, 0, 4, 1], width: 4, height: 1, res_m: 1 }, f)
    expect([0, 1, 2, 3].map((c) => g.valueAtPixel(0, c))).toEqual([0, 0.1, 25.6, 6553.5])
  })

  it('unknown pixels (A = 0) decode as null, whatever R and G hold', () => {
    const f = decodeRGBA([7, 9, 0, 0, 0, 5, 0, 255], 2, 1, 0.01)
    const g = new FieldGrid({ bounds: [0, 0, 2, 1], width: 2, height: 1, res_m: 1 }, f)
    expect(g.valueAtPixel(0, 0)).toBeNull()
    expect(g.valueAtPixel(0, 1)).toBeCloseTo(0.05, 12)
  })

  it('round trip of every count is exact (encode as fields_png.py, decode here)', () => {
    const n = 65536
    const rgba = new Uint8Array(n * 4)
    for (let c = 0; c < n; c++) {
      rgba[c * 4] = c >> 8
      rgba[c * 4 + 1] = c & 255
      rgba[c * 4 + 3] = 255
    }
    const f = decodeRGBA(rgba, n, 1, 0.1)
    for (let c = 0; c < n; c++) if (f.counts[c] !== c) throw new Error(`count ${c} -> ${f.counts[c]}`)
    const g = new FieldGrid({ bounds: [0, 0, n, 1], width: n, height: 1, res_m: 1 }, f)
    expect(g.valueAtPixel(0, 1234)).toBe(1234 * 0.1) // the same float64 product Python computes
  })

  it('rejects a wrong buffer length', () => {
    expect(() => decodeRGBA([0, 0, 0, 255], 2, 1, 1)).toThrow()
  })
})

// Same pixels and values as DUMMY_PIXELS in tests/test_fields_png.py (Python decode of the
// committed M0 dummy PNGs). Both decoders must agree exactly.
const DUMMY_PIXELS: [string, number, number, number][] = [
  ['nom_104/t_home', 740, 740, 0.0], // the pad
  ['nom_104/t_home', 620, 740, 11.1], // S1 (timeline t_home_min 11.1)
  ['nom_104/o2_home', 620, 740, 2.78],
  ['slope', 740, 740, 2.85],
  ['nom_104/home_bearing', 620, 740, 180.0], // S1 is due north of the pad
  ['nom_104/t_home_worst_50', 620, 740, 12.0],
]

describe('dummy field PNGs decode to the Python values', () => {
  const index = readJson<FieldsIndex>('fields/index.json')
  const cache = new Map<string, FieldGrid>()
  const grid = (key: string) => {
    if (!cache.has(key)) {
      const meta = index.fields[key]
      const { rgba, width, height } = readPngRGBA(resolve(DUMMY, meta.file))
      cache.set(key, new FieldGrid(fieldGrid(index, key), decodeRGBA(rgba, width, height, meta.scale), meta.units))
    }
    return cache.get(key)!
  }

  it.each(DUMMY_PIXELS)('%s [%i, %i] = %f', (key, row, col, expected) => {
    const v = grid(key).valueAtPixel(row, col)
    expect(v).not.toBeNull()
    expect(Math.abs(v! - expected)).toBeLessThan(1e-9)
  })

  it('every field is on the index grid; a mismatched grid is refused', () => {
    for (const key of Object.keys(index.fields)) {
      expect(fieldGrid(index, key)).toEqual({ bounds: index.bounds, width: index.width, height: index.height, res_m: index.res_m })
    }
    const { rgba } = readPngRGBA(resolve(DUMMY, index.fields['slope'].file))
    expect(() => new FieldGrid({ ...index, width: index.width - 1 }, decodeRGBA(rgba, index.width, index.height, 1))).toThrow()
    expect(() => fieldGrid(index, 'no/such')).toThrow()
  })

  it('the nodata hole is unknown', () => {
    expect(grid('nom_104/t_home').valueAtPixel(740 + 71, 740 + 71)).toBeNull()
  })

  it('lon/lat lookup at the pad hits the pad pixel and gives T_home = 0', () => {
    const g = grid('nom_104/t_home')
    expect(g.pixelOf(137.382, -4.806)).toEqual({ row: 740, col: 740 })
    expect(g.valueAt(137.382, -4.806)).toBe(0)
    const [lon, lat] = g.lonLatOf(740, 740)
    expect(g.pixelOf(lon, lat)).toEqual({ row: 740, col: 740 })
  })

  it('pixel size matches res_m', () => {
    const g = grid('nom_104/t_home')
    const a = g.lonLatOf(100, 100)
    expect(g.distanceM(a, g.lonLatOf(100, 101))).toBeCloseTo(index.res_m, 6)
    expect(g.distanceM(a, g.lonLatOf(101, 100))).toBeCloseTo(index.res_m, 6)
  })

  it('worst-case fields >= point field wherever both are known', () => {
    const point = grid('nom_104/t_home').data
    for (const r of [10, 50, 100]) {
      const wc = grid(`nom_104/t_home_worst_${r}`).data
      for (let i = 0; i < point.counts.length; i++) {
        if (point.known[i] && wc.known[i] && wc.counts[i] < point.counts[i]) throw new Error(`worst_${r} < point at pixel ${i}`)
      }
    }
  })
})

describe('FieldGrid.discMax (alarm-3 circle test)', () => {
  // synthetic field: value = distance (m) from the centre pixel, 1 m pixels, 101 x 101
  const N = 101
  const rgba = new Uint8Array(N * N * 4)
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++) {
      const d = Math.round(Math.hypot(r - 50, c - 50) * 10) // scale 0.1
      const j = (r * N + c) * 4
      rgba[j] = d >> 8
      rgba[j + 1] = d & 255
      rgba[j + 3] = 255
    }
  const g = new FieldGrid({ bounds: [0, 0, N, N], width: N, height: N, res_m: 1 }, decodeRGBA(rgba, N, N, 0.1))
  const centre = g.lonLatOf(50, 50)

  it('sigma 0 returns the point value', () => {
    expect(g.discMax(centre[0], centre[1], 0)).toBe(0)
  })
  it('max over a disc of radius r around the centre is r (lattice points)', () => {
    for (const r of [3, 10, 25]) expect(g.discMax(centre[0], centre[1], r)).toBeCloseTo(r, 6)
  })
  it('a disc that leaves the extent is unknown', () => {
    expect(g.discMax(centre[0], centre[1], 60)).toBeNull()
  })
  it('unknown pixels inside the disc are skipped (unreachable), all-unknown is null', () => {
    const holed = new Uint8Array(rgba)
    holed[(50 * N + 53) * 4 + 3] = 0 // the 3 m pixel east of the centre: unknown
    const h = new FieldGrid({ bounds: [0, 0, N, N], width: N, height: N, res_m: 1 }, decodeRGBA(holed, N, N, 0.1))
    expect(h.discMax(centre[0], centre[1], 3)).toBeCloseTo(3, 6) // other lattice points at 3 m
    const none = new FieldGrid({ bounds: [0, 0, 3, 3], width: 3, height: 3, res_m: 1 }, decodeRGBA(new Uint8Array(36), 3, 3, 0.1))
    expect(none.discMax(1.5, 1.5, 1)).toBeNull()
  })
})
