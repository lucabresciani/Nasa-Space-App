import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONFIG } from '../config'
import type { Manifest } from '../data/types'
import { manifestEntries, o2Reserve, preH0 } from './scorecard'

const m = JSON.parse(readFileSync(resolve(__dirname, '../../public/data-dummy/manifest.json'), 'utf8')) as Manifest
const e = (utc: string) => ({ value: 1, units: null, file: 'f', script: 's', commit: 'c', utc })

describe('scorecard manifest checks (SPEC F16)', () => {
  it('lists every entry except the dummy flag, sorted', () => {
    const all = manifestEntries(m)
    expect(all.length).toBe(Object.keys(m).length - 1)
    expect(all.map(([k]) => k)).toEqual([...all.map(([k]) => k)].sort((a, b) => a.localeCompare(b)))
  })
  it('flags entries before H0 (config/event.yaml h0_utc), passes those after', () => {
    expect(CONFIG.h0Utc).toBe('2026-11-14T08:00:00Z')
    expect(preH0([['a', e('2026-11-14T07:59:59Z')], ['b', e('2026-11-14T08:00:00Z')], ['c', e('garbage')]], CONFIG.h0Utc)).toEqual(['a', 'c'])
    expect(preH0(manifestEntries(m), CONFIG.h0Utc)).toEqual([])
  })
})

describe('O2 reserve row (WS2 Q9: crew.o2_margin.reserve_min_at_effort_cap, not o2_reserve_frac)', () => {
  it('30 min at the effort cap = 40.5 L at 1.35 L/min', () => {
    const r = o2Reserve()
    expect(r.min).toBe(30)
    expect(r.rateLMin).toBe(1.35)
    expect(r.litres).toBe(40.5)
  })
})
