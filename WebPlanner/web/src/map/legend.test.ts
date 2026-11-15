import { describe, expect, it } from 'vitest'
import { binEdges, binIndex, binLabels, binLabelsFor, stepColorExpression } from './legend'

// Evaluate a MapLibre ['step', ['get', p], c0, s1, c1, ...] expression for an input value.
function evalStep(expr: unknown[], v: number): unknown {
  let out = expr[2]
  for (let i = 3; i < expr.length; i += 2) if (v >= (expr[i] as number)) out = expr[i + 1]
  return out
}

describe('legend binning for the budget-slider isochrones (integer minutes)', () => {
  it('edges cover 0..max in steps', () => {
    expect(binEdges(60, 10)).toEqual([0, 10, 20, 30, 40, 50, 60])
    expect(binEdges(60, 15)).toEqual([0, 15, 30, 45, 60])
    expect(binEdges(55, 10)).toEqual([0, 10, 20, 30, 40, 50, 55])
  })

  it('bins are (lo, hi]: 10 min belongs to the first bin, 11 to the second', () => {
    const e = binEdges(60, 10)
    expect(binIndex(1, e)).toBe(0)
    expect(binIndex(10, e)).toBe(0)
    expect(binIndex(11, e)).toBe(1)
    expect(binIndex(30, e)).toBe(2)
    expect(binIndex(60, e)).toBe(5)
    expect(binIndex(0, e)).toBe(-1)
    expect(binIndex(61, e)).toBe(-1)
  })

  it('labels match the bins', () => {
    expect(binLabels(binEdges(30, 10))).toEqual(['1–10 min', '11–20 min', '21–30 min'])
  })

  it('labels follow the contours present: 5-min data reads 5–10, 15–20 …; empty bins are dropped', () => {
    const e = binEdges(60, 10)
    const five = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60]
    expect(binLabelsFor(e, five)).toEqual([
      { i: 0, label: '5–10 min' },
      { i: 1, label: '15–20 min' },
      { i: 2, label: '25–30 min' },
      { i: 3, label: '35–40 min' },
      { i: 4, label: '45–50 min' },
      { i: 5, label: '55–60 min' },
    ])
    const one = Array.from({ length: 30 }, (_, k) => k + 1)
    expect(binLabelsFor(binEdges(30, 10), one).map((b) => b.label)).toEqual(binLabels(binEdges(30, 10)))
    expect(binLabelsFor(e, [10, 30])).toEqual([
      { i: 0, label: '10 min' },
      { i: 2, label: '30 min' },
    ])
  })

  it('the MapLibre step expression colours every minute like binIndex', () => {
    const e = binEdges(60, 10)
    const colors = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5']
    const expr = stepColorExpression('minutes', e, colors)
    for (let m = 1; m <= 60; m++) expect(evalStep(expr, m), `minute ${m}`).toBe(colors[binIndex(m, e)])
  })

  it('needs one colour per bin', () => {
    expect(() => stepColorExpression('minutes', binEdges(60, 10), ['a'])).toThrow()
  })
})
