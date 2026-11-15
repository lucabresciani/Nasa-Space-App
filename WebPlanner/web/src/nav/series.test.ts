// KATs for time lookups (step-hold minute rows, positions along timed lines) and fix filtering.
import { describe, expect, it } from 'vitest'
import { ellipsesUpTo, filterFixes, fixesUpTo, interpAlong, lastFix, lineWithTimes, nextFix, routeKnots, rowAt, trackLine } from './series'
import type { Fix, PerMinute, TracksFC } from './types'

const row = (t: number, a: number, d = 0): PerMinute => ({ t_eva_min: t, dist_since_fix_m: d, ellipse: { a_m: a, b_m: a / 2, theta_deg: 0 }, r95_m: a })

describe('rowAt: the per-minute row in force at time t (held, never interpolated)', () => {
  const rows = [row(0, 5), row(1, 6), row(2, 7), row(3, 2)]
  it('holds the last row at or before t', () => {
    expect(rowAt(rows, 0)?.r95_m).toBe(5)
    expect(rowAt(rows, 0.99)?.r95_m).toBe(5)
    expect(rowAt(rows, 1)?.r95_m).toBe(6)
    expect(rowAt(rows, 2.5)?.r95_m).toBe(7)
  })
  it('clamps before the first and after the last row; empty -> null', () => {
    expect(rowAt(rows, -3)?.r95_m).toBe(5)
    expect(rowAt(rows, 99)?.r95_m).toBe(2)
    expect(rowAt([], 1)).toBeNull()
  })
  it('works on unsorted input', () => {
    expect(rowAt([row(2, 7), row(0, 5), row(1, 6)], 1.5)?.r95_m).toBe(6)
  })
})

describe('interpAlong: position along a timed line', () => {
  const coords: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 20],
  ]
  const times = [0, 10, 30]
  it('interpolates linearly in time between vertices', () => {
    expect(interpAlong(coords, times, 5)).toEqual([5, 0])
    expect(interpAlong(coords, times, 20)).toEqual([10, 10])
    expect(interpAlong(coords, times, 10)).toEqual([10, 0])
  })
  it('clamps at the ends', () => {
    expect(interpAlong(coords, times, -1)).toEqual([0, 0])
    expect(interpAlong(coords, times, 99)).toEqual([10, 20])
  })
  it('a repeated time (dwell or jump) returns the later vertex', () => {
    expect(interpAlong([[0, 0], [1, 1], [2, 2]], [0, 5, 5], 5)).toEqual([2, 2])
  })
})

describe('tracks: line features with per-vertex times', () => {
  const fc: TracksFC = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 0], [2, 0]] }, properties: { kind: 'true', t_eva_min: 2, t_eva_min_vertices: [0, 1, 2] } },
      { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[1, 0], [2, 1]]] }, properties: { kind: 'estimated', t_eva_min: 3 } },
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 1], [0, 0]]] }, properties: { kind: 'ellipse95', t_eva_min: 10, a_m: 3, b_m: 1, theta_deg: 0 } },
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 1], [0, 0]]] }, properties: { kind: 'ellipse95', t_eva_min: 5, a_m: 2, b_m: 1, theta_deg: 0 } },
    ],
  }
  it('finds tracks by kind; vertex times only when they match the vertex count', () => {
    const t = trackLine(fc, 'true')!
    expect(t.parts.length).toBe(1)
    expect(lineWithTimes(t)).toEqual({ coords: [[0, 0], [1, 0], [2, 0]], times: [0, 1, 2] })
    const e = trackLine(fc, 'estimated')!
    expect(e.parts.length).toBe(2)
    expect(lineWithTimes(e)).toBeNull() // dummy: no per-vertex times
    expect(trackLine(fc, 'nope')).toBeNull()
  })
  it('ellipse polygons up to t, sorted by time', () => {
    expect(ellipsesUpTo(fc, 4).length).toBe(0)
    expect(ellipsesUpTo(fc, 5).map((f) => f.properties.t_eva_min)).toEqual([5])
    expect(ellipsesUpTo(fc, 99).map((f) => f.properties.t_eva_min)).toEqual([5, 10])
  })
})

describe('fix events (contracts/fixes.schema.json)', () => {
  const fixes: Fix[] = [
    { t_eva_min: 61.1, station: 'S2', type: 'skyline', sigma_m: 40, error_m: 40, image_id: 'NLB_1' },
    { t_eva_min: 0, station: null, type: 'rover', sigma_m: 2, error_m: null, image_id: null },
    { t_eva_min: 11.1, station: 'S1', type: 'station', sigma_m: 5, error_m: null, image_id: null },
    { t_eva_min: 177.9, station: null, type: 'rover', sigma_m: 2, error_m: null, image_id: null },
  ]
  it('filters by type, keeps time order', () => {
    expect(filterFixes(fixes, new Set(['rover'])).map((f) => f.t_eva_min)).toEqual([0, 177.9])
    expect(filterFixes(fixes, new Set(['station', 'skyline'])).map((f) => f.station)).toEqual(['S1', 'S2'])
    expect(filterFixes(fixes, new Set()).length).toBe(0)
  })
  it('last fix at or before t; next fix strictly after t', () => {
    expect(lastFix(fixes, -1)).toBeNull()
    expect(lastFix(fixes, 0)?.type).toBe('rover')
    expect(lastFix(fixes, 11.1)?.station).toBe('S1')
    expect(lastFix(fixes, 61)?.station).toBe('S1')
    expect(nextFix(fixes, 11.1)?.station).toBe('S2')
    expect(nextFix(fixes, 177.9)).toBeNull()
    expect(fixesUpTo(fixes, 61.1).length).toBe(3)
  })
})

describe('routeKnots: planned route legs (WS2 format) -> timed knots', () => {
  const metric = { mPerDegLon: 1, mPerDegLat: 1 } // 1 m per degree keeps the arithmetic exact
  const legs = [
    { geometry: { type: 'LineString', coordinates: [[0, 0], [30, 0], [30, 10]] }, properties: { t_start_min: 0, t_end_min: 4 } },
    { geometry: { type: 'LineString', coordinates: [[30, 10], [0, 0]] }, properties: { t_start_min: 10, t_end_min: 12, times_min: [10, 12] } },
  ]
  it('uniform speed along a leg without times_min; times_min used as given; dwell between legs', () => {
    const k = routeKnots(legs, metric)
    expect(k.times).toEqual([0, 3, 4, 10, 12])
    expect(interpAlong(k.coords, k.times, 1.5)).toEqual([15, 0])
    expect(interpAlong(k.coords, k.times, 7)).toEqual([30, 10]) // dwelling at the station
    expect(interpAlong(k.coords, k.times, 11)).toEqual([15, 5])
  })
  it('legs are sorted by start time and non-lines are skipped', () => {
    const k = routeKnots([legs[1], { geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} }, legs[0]], metric)
    expect(k.times[0]).toBe(0)
    expect(k.coords.length).toBe(5)
  })
})
