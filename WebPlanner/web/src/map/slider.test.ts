import { describe, expect, it } from 'vitest'
import { isochroneMinutes, keyStep, snapMinutes, uniformStep } from './slider'

const fc = (mins: number[]) => ({
  type: 'FeatureCollection' as const,
  features: mins.map((m) => ({ type: 'Feature' as const, geometry: null, properties: { minutes: m } })),
})
const range = (a: number, b: number, s: number) => Array.from({ length: Math.floor((b - a) / s) + 1 }, (_, i) => a + i * s)

const ONE = range(1, 60, 1) // D2 default: 1-min contours (config/variants.yaml outputs.isochrone_minutes)
const FIVE = range(5, 60, 5) // any coarser producer step still works

describe('budget slider steps come from the minutes in isochrones.geojson (F5)', () => {
  it('reads the distinct minutes, sorted, ignoring junk', () => {
    expect(isochroneMinutes(fc([10, 5, 5, 60, 30]))).toEqual([5, 10, 30, 60])
    expect(isochroneMinutes(fc([]))).toEqual([])
    const bad = { type: 'FeatureCollection' as const, features: [{ properties: { minutes: Number.NaN } }, { properties: null }, { properties: { minutes: 5 } }] }
    expect(isochroneMinutes(bad as never)).toEqual([5])
  })

  it('finds the common step: 1 min (D2), 2 min (fallback), none when uneven', () => {
    expect(uniformStep(ONE)).toBe(1)
    expect(uniformStep(FIVE)).toBe(5)
    expect(uniformStep(range(2, 60, 2))).toBe(2)
    expect(uniformStep([5, 10, 30])).toBeNull()
    expect(uniformStep([30])).toBeNull()
    expect(uniformStep([])).toBeNull()
  })

  it('snaps any value to a contour that exists', () => {
    expect(snapMinutes(FIVE, 30)).toBe(30)
    expect(snapMinutes(FIVE, 1)).toBe(5)
    expect(snapMinutes(FIVE, 33)).toBe(35)
    expect(snapMinutes(FIVE, 32)).toBe(30)
    expect(snapMinutes(FIVE, 32.5)).toBe(30) // tie: the shorter budget
    expect(snapMinutes(FIVE, 99)).toBe(60)
    expect(snapMinutes(ONE, 17)).toBe(17)
    expect(snapMinutes([], 30)).toBeNull()
  })

  it('arrow keys move one contour; Home/End go to the ends', () => {
    expect(keyStep(FIVE, 30, 'ArrowRight')).toBe(35)
    expect(keyStep(FIVE, 30, 'ArrowUp')).toBe(35)
    expect(keyStep(FIVE, 30, 'ArrowLeft')).toBe(25)
    expect(keyStep(FIVE, 30, 'ArrowDown')).toBe(25)
    expect(keyStep(FIVE, 60, 'ArrowRight')).toBe(60)
    expect(keyStep(FIVE, 5, 'ArrowLeft')).toBe(5)
    expect(keyStep(FIVE, 30, 'Home')).toBe(5)
    expect(keyStep(FIVE, 30, 'End')).toBe(60)
    expect(keyStep(ONE, 30, 'ArrowRight')).toBe(31)
    expect(keyStep(ONE, 1, 'ArrowLeft')).toBe(1)
  })

  it('PageUp/PageDown jump to the next legend bin edge present in the data', () => {
    expect(keyStep(FIVE, 30, 'PageUp', 10)).toBe(40)
    expect(keyStep(FIVE, 35, 'PageUp', 10)).toBe(40)
    expect(keyStep(FIVE, 35, 'PageDown', 10)).toBe(30)
    expect(keyStep(FIVE, 30, 'PageDown', 10)).toBe(20)
    expect(keyStep(ONE, 17, 'PageUp', 10)).toBe(20)
    expect(keyStep(ONE, 17, 'PageDown', 10)).toBe(10)
    expect(keyStep(ONE, 5, 'PageDown', 10)).toBe(1) // no multiple of 10 below: first contour
    expect(keyStep(FIVE, 60, 'PageUp', 10)).toBe(60)
  })

  it('unhandled keys and empty data return null (browser default)', () => {
    expect(keyStep(FIVE, 30, 'Tab')).toBeNull()
    expect(keyStep([], 30, 'ArrowRight')).toBeNull()
  })

  it('off-contour current values are snapped before stepping', () => {
    expect(keyStep(FIVE, 31, 'ArrowRight')).toBe(35)
    expect(keyStep(FIVE, 31, 'ArrowLeft')).toBe(30)
    expect(keyStep(FIVE, 29, 'ArrowRight')).toBe(30)
    expect(keyStep(FIVE, 29, 'ArrowLeft')).toBe(25)
  })
})

describe('the dummy isochrones give the D2 1-min slider (config/variants.yaml outputs.isochrone_minutes)', () => {
  it('1..60 in 1-min steps', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const { CONFIG } = await import('../config')
    const fc = JSON.parse(readFileSync(resolve(__dirname, '../../public/data-dummy/scenarios/nom_104/isochrones.geojson'), 'utf8'))
    const mins = isochroneMinutes(fc)
    const { min, max, step } = CONFIG.isochroneMinutes
    expect(mins).toEqual(range(min, max, step))
    expect(uniformStep(mins)).toBe(1)
  })
})
