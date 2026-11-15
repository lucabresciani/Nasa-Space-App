import { describe, expect, it } from 'vitest'
import type { BandsFC, EdgesFC, IsochroneFC } from '../data/types'
import { boundaryOptions, defaultBoundary, legPairs, moveWaypoint, removeWaypoint, replaceWaypoint, routeLegs, toggleTag } from './plan'
import type { Leg } from './router'

describe('waypoint list edits', () => {
  it('move up / down swaps neighbours, out of range is a no-op', () => {
    expect(moveWaypoint(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c'])
    expect(moveWaypoint(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b'])
    const l = ['a', 'b']
    expect(moveWaypoint(l, 0, -1)).toBe(l)
    expect(moveWaypoint(l, 1, 1)).toBe(l)
  })
  it('remove and replace', () => {
    expect(removeWaypoint(['a', 'b', 'c'], 1)).toEqual(['a', 'c'])
    expect(replaceWaypoint(['a', 'b', 'c'], 2, 'z')).toEqual(['a', 'b', 'z'])
  })
})

describe('legs', () => {
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
})

describe('boundary options', () => {
  const poly = { type: 'Polygon' as const, coordinates: [] }
  const bands = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: poly, properties: { budget: 60, variant: 'nominal' } },
      { type: 'Feature', geometry: poly, properties: { budget: 30, variant: 'optimistic' } },
      { type: 'Feature', geometry: poly, properties: { budget: 30, variant: 'nominal' } },
    ],
  } as unknown as BandsFC
  const iso = { type: 'FeatureCollection', features: [4, 2].map((m) => ({ type: 'Feature', geometry: poly, properties: { minutes: m } })) } as unknown as IsochroneFC
  const edges = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: poly, properties: { budget: 30, cause: 'slope' } }] } as unknown as EdgesFC

  it('lists none, bands (budget then variant), edges, isochrones (ascending)', () => {
    expect(boundaryOptions(bands, iso, edges).map((o) => o.id)).toEqual(['none', 'band:30:nominal', 'band:30:optimistic', 'band:60:nominal', 'edges:30', 'iso:2', 'iso:4'])
  })
  it('default is the 30-min nominal band (the Plan page default), else none', () => {
    expect(defaultBoundary(boundaryOptions(bands, iso, edges), 30)).toBe('band:30:nominal')
    expect(defaultBoundary(boundaryOptions(null, null, null), 30)).toBe('none')
  })
})

describe('waypoint tags', () => {
  it('toggle adds and removes, in the offered order', () => {
    expect(toggleTag([], 'Photo')).toEqual(['Photo'])
    expect(toggleTag(['Photo'], 'Sample')).toEqual(['Sample', 'Photo'])
    expect(toggleTag(['Sample', 'Photo'], 'Sample')).toEqual(['Photo'])
  })
})
