import { describe, expect, it } from 'vitest'
import { CONFIG } from '../config'
import { formatLength, marsDistanceM, niceLength, scaleBar } from './scale'

const R = CONFIG.marsRadiusM

describe('Mars scale bar (D4: Mars radius from config/site.yaml, not Earth)', () => {
  it('reads R = 3,396,190 m from config/site.yaml', () => {
    expect(R).toBe(3396190)
  })

  it('1 degree of longitude on the equator = R*pi/180 = 59,274.70 m', () => {
    expect(marsDistanceM(0, 0, 1, 0, R)).toBeCloseTo(59274.698, 2)
  })

  it('quarter meridian = pi*R/2', () => {
    expect(marsDistanceM(137.39, 0, 137.39, 90, R)).toBeCloseTo((Math.PI * R) / 2, 3)
  })

  it('0.01 deg of longitude at the site latitude (4.8 S) shrinks by cos(lat)', () => {
    const d = marsDistanceM(137.38, -4.8, 137.39, -4.8, R)
    expect(d).toBeCloseTo(((R * Math.PI) / 180) * 0.01 * Math.cos((4.8 * Math.PI) / 180), 2)
  })

  it('is ~1.88x shorter than the Earth distance MapLibre would show', () => {
    const earth = marsDistanceM(0, 0, 1, 0, 6371008.8)
    expect(earth / marsDistanceM(0, 0, 1, 0, R)).toBeCloseTo(6371008.8 / 3396190, 9)
  })

  it.each([
    [0.9, 0.5],
    [1, 1],
    [7, 5],
    [180, 100],
    [250, 200],
    [999, 500],
    [1000, 1000],
    [4200, 2000],
  ])('niceLength(%d) = %d', (max, nice) => {
    expect(niceLength(max)).toBeCloseTo(nice, 9)
  })

  it.each([
    [500, '500 m'],
    [1000, '1 km'],
    [2000, '2 km'],
    [0.5, '0.5 m'],
  ])('formatLength(%d) = %s', (m, s) => {
    expect(formatLength(m)).toBe(s)
  })

  it('bar width is the nice length in pixels', () => {
    // 100 px spanning 0.01 deg at the equator = 592.75 m -> nice 500 m -> 84.35 px
    const b = scaleBar({ lng: 137.38, lat: 0 }, { lng: 137.39, lat: 0 }, 100, R)
    expect(b.meters).toBe(500)
    expect(b.label).toBe('500 m')
    expect(b.px).toBeCloseTo((500 / 592.74698) * 100, 1)
  })
})
