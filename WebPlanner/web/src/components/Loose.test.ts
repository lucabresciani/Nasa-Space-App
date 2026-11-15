import { describe, expect, it } from 'vitest'
import { scalarLeaves } from './Loose'

describe('scalarLeaves (loose-contract files)', () => {
  it('flattens scalars with dotted paths, skips arrays and the dummy flag', () => {
    expect(scalarLeaves({ dummy: true, a: 1, b: { c: 'x', d: null, e: [1, 2] } })).toEqual([
      { path: 'a', v: 1 },
      { path: 'b.c', v: 'x' },
      { path: 'b.d', v: null },
    ])
  })
  it('respects depth and row limits', () => {
    expect(scalarLeaves({ a: { b: { c: { d: 1 } } } }, 3)).toEqual([])
    expect(scalarLeaves({ a: 1, b: 2, c: 3 }, 3, 2)).toHaveLength(2)
  })
})
