// WP6: leg cache KATs, ported from origin/waypoint-routing web/src/mission/plan.test.ts (N0CEO), plus
// the walk back to the pad (closedPairs).
import { describe, expect, it } from 'vitest'
import { closedPairs, legPairs, routeLegs } from './legs'
import type { Leg } from './router'

describe('legs (ported)', () => {
  it('pad -> w1 -> w2', () => {
    expect(legPairs(7, [{ cell: 3 }, { cell: 9 }])).toEqual([
      [7, 3],
      [3, 9],
    ])
    expect(legPairs(7, [])).toEqual([])
  })
  it('cached legs are not routed again; a moved waypoint re-routes only its legs', () => {
    const calls: string[] = []
    const route = (a: number, b: number): Leg => {
      calls.push(`${a}-${b}`)
      return { cells: [a, b], timeS: 1, o2L: 1, distM: 1, tauS: [0, 1], o2CumL: [0, 1] }
    }
    const cache = new Map<string, Leg | null>()
    routeLegs(legPairs(0, [{ cell: 1 }, { cell: 2 }, { cell: 3 }]), route, cache)
    expect(calls).toEqual(['0-1', '1-2', '2-3'])
    calls.length = 0
    routeLegs(legPairs(0, [{ cell: 1 }, { cell: 5 }, { cell: 3 }]), route, cache)
    expect(calls).toEqual(['1-5', '5-3'])
  })
  it('closed route: pad -> w1 -> w2 -> pad (contract leg numbering); no stop, no leg', () => {
    expect(closedPairs(7, [{ cell: 3 }, { cell: 9 }])).toEqual([
      [7, 3],
      [3, 9],
      [9, 7],
    ])
    expect(closedPairs(7, [])).toEqual([])
  })
})
