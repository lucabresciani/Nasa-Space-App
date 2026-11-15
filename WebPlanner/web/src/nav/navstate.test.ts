/// <reference types="node" />
// KATs for the HUD position reading (SPEC §2.4): sigma held from the per-minute rows, reset at a
// fix, "next fix due in M m" = D_max - distance since fix, the position line text.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { navLine, navReading, fmtEva } from './navstate'
import type { Fix, MonteCarlo } from './types'

const DUMMY = resolve(__dirname, '../../public/data-dummy')
const mc = JSON.parse(readFileSync(resolve(DUMMY, 'nav/montecarlo_medium.json'), 'utf8')) as MonteCarlo
const fixes = JSON.parse(readFileSync(resolve(DUMMY, 'nav/fixes.json'), 'utf8')) as Fix[]

describe('navReading on the dummy Monte Carlo and fixes', () => {
  it('sigma is monotonic between fixes and drops at a fix', () => {
    const station = fixes.find((f) => f.type === 'station')!
    const before = navReading(Math.floor(station.t_eva_min), mc, fixes, null)
    const after = navReading(Math.ceil(station.t_eva_min), mc, fixes, null)
    expect(after.r95M!).toBeLessThan(before.r95M!)
    expect(after.distSinceFixM).toBe(0)
    expect(after.lastFix?.station).toBe(station.station)
    let prev = -1
    for (let t = 0; t < Math.floor(station.t_eva_min); t++) {
      const r = navReading(t, mc, fixes, null).r95M!
      expect(r).toBeGreaterThanOrEqual(prev)
      prev = r
    }
  })
  it('due distance = D_max - distance since fix; due when <= 0', () => {
    const r = navReading(5, mc, fixes, 1000)
    expect(r.dueInM).toBeCloseTo(1000 - r.distSinceFixM!, 9)
    expect(r.due).toBe(false)
    const z = navReading(5, mc, fixes, 0) // outside the homeline
    expect(z.due).toBe(true)
    expect(navReading(5, mc, fixes, null).dueInM).toBeNull()
  })
  it('without a Monte Carlo file every model number is unknown', () => {
    const r = navReading(5, null, fixes, 500)
    expect(r.r95M).toBeNull()
    expect(r.dueInM).toBeNull()
    expect(r.lastFix?.type).toBe('rover')
  })
})

describe('navLine', () => {
  it('formats the SPEC position line', () => {
    const r = navReading(5, mc, fixes, 1000)
    expect(navLine(r)).toBe(`Odometry ±${Math.round(r.r95M!)} m · next fix due in ${Math.round(r.dueInM!)} m · last fix: rover, 5 min ago`)
    expect(navLine(navReading(5, mc, fixes, 0))).toContain('fix due now')
    expect(navLine(navReading(-1, null, [], null))).toBe('Odometry ±? m · no fix yet')
  })
  it('fmtEva', () => {
    expect(fmtEva(0)).toBe('0:00')
    expect(fmtEva(125.9)).toBe('2:05')
  })
})
