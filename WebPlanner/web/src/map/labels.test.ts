import { describe, expect, it } from 'vitest'
import type { EdgesFC } from '../data/types'
import { edgeLabelPoints, lineMidpoint } from './labels'

describe('edge-cause label placement (presentation only)', () => {
  it('midpoint of a straight line by length', () => {
    expect(lineMidpoint([[0, 0], [2, 0]])).toEqual([1, 0])
    expect(lineMidpoint([[0, 0], [1, 0], [1, 3]])).toEqual([1, 1])
  })

  it('degenerate lines have no midpoint', () => {
    expect(lineMidpoint([[0, 0]])).toBeNull()
    expect(lineMidpoint([[0, 0], [0, 0]])).toBeNull()
  })

  const fc: EdgesFC = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { budget: 30, cause: 'slope' },
        geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [0, 0.1]], [[1, 0], [1, 1]], [[2, 0], [2, 0.5]]] },
      },
      { type: 'Feature', properties: { budget: 60, cause: 'data' }, geometry: { type: 'LineString', coordinates: [[5, 5], [6, 5]] } },
    ],
  }

  it('labels the longest parts first, capped per feature, for the selected budget only', () => {
    const pts = edgeLabelPoints(fc, 30, 2)
    expect(pts).toEqual([
      { lng: 1, lat: 0.5, cause: 'slope' },
      { lng: 2, lat: 0.25, cause: 'slope' },
    ])
    expect(edgeLabelPoints(fc, 60, 2)).toEqual([{ lng: 5.5, lat: 5, cause: 'data' }])
  })

  // Real edges may come as thousands of small features; without a global cap every feature would
  // get an HTML label marker.
  const many = (n: number, cause: 'slope' | 'physiology', x0: number, len: (i: number) => number): EdgesFC['features'] =>
    Array.from({ length: n }, (_, i) => ({
      type: 'Feature' as const,
      properties: { budget: 30, cause },
      geometry: { type: 'LineString' as const, coordinates: [[x0 + i * 0.001, 0], [x0 + i * 0.001, len(i)]] },
    }))

  it('caps the total, keeps labels apart, and labels every cause present', () => {
    const big: EdgesFC = {
      type: 'FeatureCollection',
      features: [...many(2000, 'slope', 0, (i) => 0.001 + (i % 50) * 0.0001), ...many(40, 'physiology', 10, () => 0.0005)],
    }
    const pts = edgeLabelPoints(big, 30, 2, { maxTotal: 12, minSepDeg: 0.01 })
    expect(pts.length).toBeLessThanOrEqual(12)
    expect(pts.some((p) => p.cause === 'physiology')).toBe(true)
    expect(pts.some((p) => p.cause === 'slope')).toBe(true)
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++) expect(Math.hypot(pts[i].lng - pts[j].lng, pts[i].lat - pts[j].lat)).toBeGreaterThanOrEqual(0.01)
  })

  it('the longest part wins when labels compete for the same spot', () => {
    const fc2: EdgesFC = {
      type: 'FeatureCollection',
      features: [...many(1, 'slope', 0, () => 0.002), ...many(1, 'slope', 0.0005, () => 0.004)],
    }
    expect(edgeLabelPoints(fc2, 30, 2, { maxTotal: 5, minSepDeg: 0.01 })).toEqual([{ lng: 0.0005, lat: 0.002, cause: 'slope' }])
  })
})
