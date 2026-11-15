import { describe, expect, it } from 'vitest'
import { decodePlan, encodePlan, type SharedWaypoint } from './share'

const wp = (o: Partial<SharedWaypoint> = {}): SharedWaypoint => ({ lon: 137.3812345, lat: -4.8061234, stopMin: 0, tags: [], note: '', ...o })

describe('plan link encoding', () => {
  it('round-trips position (6 decimals, ~0.1 m), stop, tags, note and station', () => {
    const plan = [wp({ stopMin: 30, tags: ['Sample', 'Photo'], note: 'ice? check the ridge', station: 'S1' }), wp({ lon: 137.4, lat: -4.79 })]
    const back = decodePlan(encodePlan(plan))!
    expect(back).toHaveLength(2)
    expect(back[0]).toEqual({ lon: 137.381235, lat: -4.806123, stopMin: 30, tags: ['Sample', 'Photo'], note: 'ice? check the ridge', station: 'S1' })
    expect(back[1]).toEqual({ lon: 137.4, lat: -4.79, stopMin: 0, tags: [], note: '' })
  })

  it('is URL-safe and keeps non-ASCII notes', () => {
    const s = encodePlan([wp({ note: 'Probe für O₂ — größer als 5 cm 🙂' })])
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodePlan(s)![0].note).toBe('Probe für O₂ — größer als 5 cm 🙂')
  })

  it('an empty plan encodes to the empty string', () => {
    expect(encodePlan([])).toBe('')
    expect(decodePlan('')).toEqual([])
  })

  it('unknown tags are dropped; bad stop times become 0', () => {
    const back = decodePlan(encodePlan([wp({ tags: ['Drill', 'Bogus'], stopMin: -3 })]))!
    expect(back[0].tags).toEqual(['Drill'])
    expect(back[0].stopMin).toBe(0)
  })

  it('garbage, wrong version or wrong shape gives null (never throws)', () => {
    expect(decodePlan('not base64 !!')).toBeNull()
    expect(decodePlan(btoa('{"a":1}').replace(/=+$/, ''))).toBeNull()
    expect(decodePlan(btoa('[9,[]]').replace(/=+$/, ''))).toBeNull()
    expect(decodePlan(btoa('[1,[["x",1]]]').replace(/=+$/, ''))).toBeNull()
  })
})
