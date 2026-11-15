import { describe, expect, it } from 'vitest'
import { BASE_GREY, contourInterval, coverage, pickUnit, RAMP, renderRelief, unitBands, UNITS_FILE } from './relief'

const flat = (w: number, h: number, z = -4100) => new Float32Array(w * h).fill(z)
/** Plane rising east at grade theta (deg), cell size mpp. */
const ramp = (w: number, h: number, deg: number, mpp: number) => {
  const e = new Float32Array(w * h)
  const t = Math.tan((deg * Math.PI) / 180)
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) e[r * w + c] = -4100 + c * mpp * t
  return e
}

describe('contour interval (Unity MarsElevationMap rule)', () => {
  it('flat ground: the finest interval, 5 m', () => {
    expect(contourInterval(flat(20, 20), 20, 20, 5)).toBe(5)
  })
  it('10 deg everywhere at 5 m cells: 5 m gives 5.67 cells < 6, so 10 m', () => {
    expect(contourInterval(ramp(40, 40, 10, 5), 40, 40, 5)).toBe(10)
  })
  it('30 deg at 5 m cells: 20 m gives 6.9 cells', () => {
    expect(contourInterval(ramp(40, 40, 30, 5), 40, 40, 5)).toBe(20)
  })
})

describe('contour line coverage', () => {
  it('on a level: full; half an interval away: none', () => {
    expect(coverage(3, 5, 1, 1)).toBe(1)
    expect(coverage(3.5, 5, 1, 1)).toBe(0)
    expect(coverage(-3, 5, 1, 1)).toBe(1) // negative elevations (Mars areoid) too
  })
})

describe('geologic units by elevation band (Curiosity samples, Unity rule)', () => {
  const units = unitBands(-4600, -3700)
  const id = (e: number) => {
    const p = pickUnit(units, e)
    return p.index < 0 ? null : units[p.index].id
  }

  it('bands come from the sample elevations; caprock and meteorites are left out', () => {
    const ids = units.map((u) => u.id)
    expect(ids).toEqual(['murray-mudstone', 'vera-rubin-ridge', 'glen-torridon-clay', 'mirador-sulfate', 'amapari-iron'])
    const murray = units[0]
    expect(murray.lo).toBeCloseTo(-4459.6, 6)
    expect(murray.hi).toBeCloseTo(-4192.46, 6)
    expect(UNITS_FILE.band_margin_m).toBe(15)
  })

  it('inside a band: that unit at full weight', () => {
    expect(id(-4300)).toBe('murray-mudstone')
    expect(pickUnit(units, -4300).fade).toBe(1)
    expect(id(-4100)).toBe('glen-torridon-clay')
    expect(id(-3950)).toBe('mirador-sulfate')
  })

  it('overlap: the more abundant unit wins (Murray 0.3 over Vera Rubin 0.12 at -4180 m)', () => {
    expect(id(-4180)).toBe('murray-mudstone')
  })

  it('below every band: fades by e per 20 m beyond the 15 m margin, then nothing', () => {
    const p = pickUnit(units, -4500) // 25.4 m below -4474.6
    expect(units[p.index].id).toBe('murray-mudstone')
    expect(p.fade).toBeCloseTo(Math.exp(-25.4 / 20), 6)
    expect(pickUnit(units, -4520).fade).toBeLessThan(UNITS_FILE.min_fade)
  })

  it('a band that cannot reach the terrain range is dropped', () => {
    expect(unitBands(-4100, -4050).map((u) => u.id)).not.toContain('murray-mudstone')
  })
})

describe('relief rendering', () => {
  it('topography on flat ground: the ramp colour at that height, unshaded, opaque', () => {
    const w = 8
    const e = flat(w, w)
    e[0] = -4200 // sets the range so -4100 sits mid-ramp
    e[w * w - 1] = -4000
    const img = renderRelief(e, w, w, 5, 'topo', null)
    const i = (4 * w + 4) * 4
    // t = 0.5 between RAMP stops 0.30 and 0.65; contours: -4100 is a 5 m level, so blend toward contour ink
    expect(img.rgba[i + 3]).toBe(255)
    expect(img.contourM).toBe(5)
  })

  it('material base on flat ground is the neutral grey; a unit tints it at half alpha', () => {
    const w = 6
    const e = flat(w, w, -4300)
    const img = renderRelief(e, w, w, 5, 'material', unitBands(-4310, -4290))
    const i = (3 * w + 3) * 4
    const murray = unitBands(-4310, -4290)[0].rgb
    for (let k = 0; k < 3; k++) expect(img.rgba[i + k]).toBe(Math.round(BASE_GREY + (murray[k] - BASE_GREY) * 0.5))
    expect(img.unitCells.get('murray-mudstone')).toBeGreaterThan(0)
  })

  it('edge cells have no slope estimate and stay transparent (as Unity)', () => {
    const img = renderRelief(flat(5, 5), 5, 5, 5, 'topo', null)
    expect(img.rgba[3]).toBe(0)
  })

  it('ramp stops are those of Unity', () => {
    expect(RAMP.map((s) => s.t)).toEqual([0, 0.3, 0.65, 1])
  })
})
