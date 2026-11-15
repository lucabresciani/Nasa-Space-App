import { describe, expect, it } from 'vitest'
import { f22Rows, f22Verdict } from './f22'

// WS9 real run 11:20Z: station frames S1 788 m, S2 280 m, S4 966 m; gate tolerance 10 m.
const frames = [
  { station: 'S1', image_id: 'A' },
  { station: 'S2', image_id: 'B' },
  { station: 'S4', image_id: 'C' },
  { station: 'S5', image_id: null },
]
const locs = { A: { error_m: 788 }, B: { error_m: 280 }, C: { error_m: 965.79 } }

describe('F22 skyline-fix gate on the scorecard (C 11:58)', () => {
  it('a frame passes only if error_m <= tolerance', () => {
    const rows = f22Rows(frames, locs, 10)
    expect(rows.map((r) => r.pass)).toEqual([false, false, false, null])
    expect(f22Rows(frames, { ...locs, B: { error_m: 10 } }, 10)[1].pass).toBe(true)
  })
  it('missing frame or result: pass unknown (null), not a fail', () => {
    const rows = f22Rows(frames, { A: null }, 10)
    expect(rows[0].pass).toBeNull()
    expect(rows[3].error_m).toBeNull()
  })
  it('verdict: none pass -> station fixes; some pass -> those stations; nothing evaluated -> unknown', () => {
    expect(f22Verdict(f22Rows(frames, locs, 10))).toEqual({ kind: 'none-pass', evaluated: 3, passed: [] })
    expect(f22Verdict(f22Rows(frames, { ...locs, B: { error_m: 5 } }, 10))).toEqual({ kind: 'some-pass', evaluated: 3, passed: ['S2'] })
    expect(f22Verdict(f22Rows(frames, {}, 10)).kind).toBe('unknown')
  })
})
