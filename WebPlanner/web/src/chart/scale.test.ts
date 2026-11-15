import { describe, expect, it } from 'vitest'
import { linear, log10Scale, niceTicks, logTicks, polyline } from './scale'

describe('chart scales (drawing only, no data values are derived)', () => {
  it('linear maps domain ends to range ends', () => {
    const s = linear([0, 10], [100, 300])
    expect(s(0)).toBe(100)
    expect(s(10)).toBe(300)
    expect(s(5)).toBe(200)
  })

  it('linear handles a zero-width domain', () => {
    expect(linear([5, 5], [0, 100])(5)).toBe(50)
  })

  it('log scale puts decades evenly', () => {
    const s = log10Scale([10, 1000], [0, 200])
    expect(s(10)).toBe(0)
    expect(s(100)).toBeCloseTo(100, 9)
    expect(s(1000)).toBeCloseTo(200, 9)
  })

  it('nice ticks', () => {
    expect(niceTicks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10])
    expect(niceTicks(0.3, 0.92, 4)).toEqual([0.4, 0.6, 0.8])
  })

  it('log ticks are powers of ten inside the domain', () => {
    expect(logTicks(150, 9000)).toEqual([1000])
    expect(logTicks(100, 10000)).toEqual([100, 1000, 10000])
  })

  it('polyline skips nulls by breaking the line', () => {
    const p = polyline([[0, 1], [1, null], [2, 3], [3, 4]], (x) => x, (y) => y)
    expect(p).toEqual(['0,1', '2,3 3,4'])
  })
})
