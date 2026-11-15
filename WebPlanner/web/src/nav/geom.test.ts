/// <reference types="node" />
// KATs for the ellipse geometry: contract convention (WS9, STATUS Blocked 4) = a_m / b_m are the
// 95% semi-axes, theta_deg is the major-axis azimuth clockwise from grid north.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONFIG } from '../config'
import { ellipseBBox, ellipseRingENU, ellipseRingLonLat, ellipseValue, insideEllipse, majorAxis, sphereMetric, toENU } from './geom'
import type { TracksFC } from './types'

const DUMMY = resolve(__dirname, '../../public/data-dummy')
const az = (e: number, n: number) => ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360

describe('ellipse axis convention (azimuth clockwise from north)', () => {
  it('theta 0 points the major axis north, 90 east, 180 south, 270 west', () => {
    for (const [theta, e, n] of [
      [0, 0, 1],
      [90, 1, 0],
      [180, 0, -1],
      [270, -1, 0],
    ] as const) {
      const [ue, un] = majorAxis(theta)
      expect(ue).toBeCloseTo(e, 12)
      expect(un).toBeCloseTo(n, 12)
    }
  })

  it('ring starts at the major-axis tip and keeps both semi-axes', () => {
    const ring = ellipseRingENU(15, 7.5, 213.7, 72)
    expect(ring.length).toBe(73) // closed
    expect(ring[0]).toEqual(ring[72])
    const [e0, n0] = ring[0]
    expect(Math.hypot(e0, n0)).toBeCloseTo(15, 9)
    expect(az(e0, n0)).toBeCloseTo(213.7, 9)
    const [e1, n1] = ring[18] // quarter turn: minor-axis tip
    expect(Math.hypot(e1, n1)).toBeCloseTo(7.5, 9)
    // the minor axis is perpendicular to the major
    expect(e0 * e1 + n0 * n1).toBeCloseTo(0, 9)
  })

  it('every ring vertex lies on the ellipse; centre inside, beyond the tip outside', () => {
    const ell = { a_m: 20, b_m: 5, theta_deg: 30 }
    for (const [e, n] of ellipseRingENU(ell.a_m, ell.b_m, ell.theta_deg, 36)) expect(ellipseValue(e, n, ell)).toBeCloseTo(1, 9)
    expect(insideEllipse(0, 0, ell)).toBe(true)
    const [ue, un] = majorAxis(30)
    expect(insideEllipse(19.9 * ue, 19.9 * un, ell)).toBe(true)
    expect(insideEllipse(20.1 * ue, 20.1 * un, ell)).toBe(false)
    // 6 m along the minor axis is outside (b = 5) although well inside a 20 m circle
    expect(insideEllipse(6 * un, -6 * ue, ell)).toBe(false)
  })

  it('bounding box half-extents', () => {
    expect(ellipseBBox({ a_m: 10, b_m: 2, theta_deg: 0 })).toEqual({ halfE: 2, halfN: 10 })
    const bb = ellipseBBox({ a_m: 10, b_m: 2, theta_deg: 90 })
    expect(bb.halfE).toBeCloseTo(10, 12)
    expect(bb.halfN).toBeCloseTo(2, 12)
    const ring = ellipseRingENU(10, 2, 37, 3600)
    const r = ellipseBBox({ a_m: 10, b_m: 2, theta_deg: 37 })
    expect(Math.max(...ring.map((p) => Math.abs(p[0])))).toBeCloseTo(r.halfE, 4)
    expect(Math.max(...ring.map((p) => Math.abs(p[1])))).toBeCloseTo(r.halfN, 4)
  })

  it('degenerate ellipse (b = 0) and zero size never contain a point off the axis', () => {
    expect(insideEllipse(0, 0, { a_m: 0, b_m: 0, theta_deg: 0 })).toBe(true)
    expect(insideEllipse(0.1, 0, { a_m: 0, b_m: 0, theta_deg: 0 })).toBe(false)
    expect(insideEllipse(0, 3, { a_m: 5, b_m: 0, theta_deg: 0 })).toBe(true)
    expect(insideEllipse(0.01, 3, { a_m: 5, b_m: 0, theta_deg: 0 })).toBe(false)
  })
})

describe('lon/lat rings on the Mars sphere (config/site.yaml crs.mars_radius_m)', () => {
  it('round-trips through local metres', () => {
    const m = sphereMetric(-4.806, CONFIG.marsRadiusM)
    const c: [number, number] = [137.382, -4.806]
    const ring = ellipseRingLonLat(c, { a_m: 30, b_m: 12, theta_deg: 300 }, m, 24)
    const [e, n] = toENU(ring[0], c, m)
    expect(Math.hypot(e, n)).toBeCloseTo(30, 6)
    expect(az(e, n)).toBeCloseTo(300, 6)
  })

  it('matches the polygons in the dummy tracks file (theta convention shared with the pipeline)', () => {
    const fc = JSON.parse(readFileSync(resolve(DUMMY, 'nav/tracks_medium.geojson'), 'utf8')) as TracksFC
    const ells = fc.features.filter((f) => f.properties.kind === 'ellipse95' && f.geometry.type === 'Polygon')
    expect(ells.length).toBeGreaterThan(10)
    let checked = 0
    for (const f of ells) {
      const p = f.properties as unknown as { a_m: number; b_m: number; theta_deg: number }
      const ring = (f.geometry.coordinates as number[][][])[0].slice(0, -1)
      const c: [number, number] = [ring.reduce((s, q) => s + q[0], 0) / ring.length, ring.reduce((s, q) => s + q[1], 0) / ring.length]
      const m = sphereMetric(c[1], CONFIG.marsRadiusM)
      for (const q of ring) {
        const [e, n] = toENU([q[0], q[1]], c, m)
        // 6-decimal coordinates are ~6 cm on Mars: allow that on each semi-axis
        const v = ellipseValue(e, n, p)
        expect(Math.abs(Math.sqrt(v) - 1)).toBeLessThan(0.12 / p.b_m + 1e-3)
      }
      checked++
    }
    expect(checked).toBe(ells.length)
  })
})
