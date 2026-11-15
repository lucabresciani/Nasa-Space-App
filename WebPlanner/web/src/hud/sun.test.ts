// Sun / time-to-dark row (C decision 12:20: no sun.json; WS7 reads WS4's conditions/clock.json
// eva.sun_series, eva.t_dark_min, eva.t_dark_min_by_observer). Lookups only: the browser
// interpolates WS4's 5-min series and subtracts the EVA clock; it computes no ephemeris.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readoutSources } from './provenance'
import type { Readout } from './readout'
import { parseClockSun, sunAt, sunRowText, sunSources, type ClockFile } from './sun'
import { readJson, REPO } from './testutil'

function clock(over: Partial<ClockFile['eva']> = {}): ClockFile {
  return {
    eva: {
      sun_series_columns: ['t_eva_min', 'lmst_h', 'sun_azimuth_deg', 'sun_elevation_deg'],
      sun_series: [
        [0, 9, 80, 30],
        [10, 9.2, 100, 40],
        [20, 9.4, 350, 50],
        [30, 9.6, 10, 60],
      ],
      t_dark_min: 500,
      t_dark_min_by_observer: { a: 480, b: null, c: 495.5, S2: 470 },
      ...over,
    },
  }
}

describe('parseClockSun', () => {
  it('reads columns by name, not position', () => {
    const c = clock({
      sun_series_columns: ['sun_elevation_deg', 't_eva_min', 'sun_azimuth_deg', 'lmst_h'],
      sun_series: [
        [30, 0, 80, 9],
        [40, 10, 100, 9.2],
      ],
    })
    const s = parseClockSun(c)!
    expect(s.tMin).toEqual([0, 10])
    expect(s.elDeg).toEqual([30, 40])
    expect(s.azDeg).toEqual([80, 100])
  })
  it('null without an eva block or without the series columns (unknown stays unknown)', () => {
    expect(parseClockSun({})).toBeNull()
    expect(parseClockSun(clock({ sun_series_columns: ['t_eva_min', 'lmst_h'] }))).toBeNull()
  })
  it('refuses a series that is not increasing in time', () => {
    expect(() => parseClockSun(clock({ sun_series: [[0, 9, 80, 30], [0, 9, 80, 30]] }))).toThrow()
  })
})

describe('sunAt', () => {
  const s = parseClockSun(clock())!
  it('series rows exactly; linear in between', () => {
    expect(sunAt(s, 10)).toMatchObject({ azDeg: 100, elDeg: 40, lmstH: 9.2 })
    const r = sunAt(s, 5)
    expect(r.elDeg).toBeCloseTo(35, 9)
    expect(r.azDeg).toBeCloseTo(90, 9)
  })
  it('azimuth interpolates across north (350 -> 10 passes 0, not 180)', () => {
    expect(sunAt(s, 25).azDeg).toBeCloseTo(0, 9)
    expect(sunAt(s, 22.5).azDeg).toBeCloseTo(355, 9)
  })
  it('outside the series: no sun position (never extrapolated)', () => {
    expect(sunAt(s, -1).elDeg).toBeNull()
    expect(sunAt(s, 31).azDeg).toBeNull()
  })
  it('dark in = t_dark_min - EVA time (flat horizon at the pad)', () => {
    expect(sunAt(s, 0).darkInMin).toBe(500)
    expect(sunAt(s, 120).darkInMin).toBe(380)
  })
  it('local horizons: range over the known observers, nulls counted apart', () => {
    const r = sunAt(s, 100)
    expect(r.local).toEqual({ minId: 'S2', min: 370, maxId: 'c', max: 395.5, n: 3, nUnknown: 1 })
  })
  it('at a station with its own horizon: that observer', () => {
    expect(sunAt(s, 100, 'S2').station).toEqual({ id: 'S2', darkInMin: 370 })
    expect(sunAt(s, 100, 'S4').station).toBeNull()
  })
  it('no observers: local null', () => {
    const e = parseClockSun(clock({ t_dark_min_by_observer: {} }))!
    expect(sunAt(e, 0).local).toBeNull()
  })
})

describe('row text and provenance', () => {
  const s = parseClockSun(clock())!
  it('formats value and sub line', () => {
    const t = sunRowText(sunAt(s, 100))
    expect(t.value).toBe('dark in 400 min')
    // minutes left are floored (never more time than WS4's number); beyond the series: no sun
    expect(t.sub).toBe('sun position — · flat horizon at pad · local horizons 370–395 min (3 stops, 1 unknown)')
    expect(sunRowText(sunAt(s, 5)).sub).toBe('sun el 35.0°, az 90° · flat horizon at pad · local horizons 465–490 min (3 stops, 1 unknown)')
  })
  it('after dark: DARK', () => {
    expect(sunRowText(sunAt(s, 600)).value).toBe('DARK')
  })
  it('station horizon is named when the HUD is at that station', () => {
    expect(sunRowText(sunAt(s, 10, 'S2')).sub).toContain('at S2: 460 min')
  })
  it('manifest keys: t_dark_min, sun_series and the two observers shown', () => {
    const src = sunSources(sunAt(s, 100, 'S2'))
    expect(src.files).toEqual(['conditions/clock.json'])
    expect(src.keys).toEqual([
      'clock.eva.t_dark_min',
      'clock.eva.sun_series',
      'clock.eva.t_dark_min_by_observer.S2',
      'clock.eva.t_dark_min_by_observer.c',
    ])
  })
  it('the panel row list carries the sun row', () => {
    const r = { worstRadiusM: 0 } as unknown as Readout
    expect(Object.keys(readoutSources(r, { scenario: 'nom_104' }))).toContain('sun')
  })
})

// Real KAT (skipped without data/interim): WS4's clock.json for the simulated EVA.
const CLOCK = resolve(REPO, 'data/interim/conditions/clock.json')
describe.skipIf(!existsSync(CLOCK))('real conditions/clock.json', () => {
  const c = existsSync(CLOCK) ? readJson<ClockFile>('conditions/clock.json', resolve(REPO, 'data/interim')) : ({} as ClockFile)
  const s = existsSync(CLOCK) ? parseClockSun(c)! : (null as never)
  it('EVA start equals the first series row and WS4 t_dark_min', () => {
    const row0 = c.eva!.sun_series[0]
    const cols = c.eva!.sun_series_columns
    const r = sunAt(s, 0)
    expect(r.elDeg).toBe(row0[cols.indexOf('sun_elevation_deg')])
    expect(r.azDeg).toBe(row0[cols.indexOf('sun_azimuth_deg')])
    expect(r.darkInMin).toBe(c.eva!.t_dark_min)
  })
  it('the sun stays up through the whole series (the EVA ends before dark)', () => {
    const last = s.tMin[s.tMin.length - 1]
    for (let t = 0; t <= last; t += 5) expect(sunAt(s, t).elDeg!).toBeGreaterThan(0)
    expect(c.eva!.t_dark_min!).toBeGreaterThan(last)
  })
  it('local range = min / max of the non-null observers', () => {
    const vals = Object.values(c.eva!.t_dark_min_by_observer ?? {}).filter((v): v is number => v !== null)
    const r = sunAt(s, 0)
    if (!vals.length) return expect(r.local).toBeNull()
    expect(r.local!.min).toBe(Math.min(...vals))
    expect(r.local!.max).toBe(Math.max(...vals))
    expect(r.local!.n).toBe(vals.length)
  })
})
