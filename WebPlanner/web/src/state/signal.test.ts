// WS15 task 3 (A3): store semantics.
import { describe, expect, it, vi } from 'vitest'
import { batch, computed, effect, signal } from './signal'

describe('signal', () => {
  it('reads, writes, notifies subscribers on change only, unsubscribes', () => {
    const s = signal(1)
    const seen: number[] = []
    const off = s.subscribe((v) => seen.push(v))
    expect(seen).toEqual([]) // never called on subscribe
    s.value = 2
    s.value = 2 // same value: no call
    s.value = 3
    off()
    s.value = 4
    expect(seen).toEqual([2, 3])
    expect(s.value).toBe(4)
    expect(s.peek()).toBe(4)
  })
  it('uses Object.is (NaN is stable, objects by identity)', () => {
    const s = signal(Number.NaN)
    const f = vi.fn()
    s.subscribe(f)
    s.value = Number.NaN
    expect(f).not.toHaveBeenCalled()
    const o = signal({ a: 1 })
    o.subscribe(f)
    o.value = { a: 1 }
    expect(f).toHaveBeenCalledTimes(1)
  })
})

describe('computed', () => {
  it('derives, follows dynamic dependencies, notifies only when its value changes', () => {
    const a = signal(1)
    const b = signal(10)
    const pick = signal<'a' | 'b'>('a')
    const c = computed(() => (pick.value === 'a' ? a.value : b.value))
    const seen: number[] = []
    c.subscribe((v) => seen.push(v))
    expect(c.value).toBe(1)
    b.value = 11 // not a dependency now
    expect(seen).toEqual([])
    pick.value = 'b'
    expect(c.value).toBe(11)
    a.value = 2 // dropped dependency
    b.value = 12
    expect(seen).toEqual([11, 12])
    const parity = computed(() => b.value % 2)
    const p = vi.fn()
    parity.subscribe(p)
    b.value = 14 // still even
    expect(p).not.toHaveBeenCalled()
  })
  it('has no glitches: a diamond notifies once with consistent values', () => {
    const a = signal(1)
    const double = computed(() => a.value * 2)
    const plus = computed(() => a.value + 1)
    const seen: [number, number][] = []
    effect(() => {
      seen.push([double.value, plus.value])
    })
    a.value = 5
    expect(seen).toEqual([
      [2, 2],
      [10, 6],
    ])
  })
})

describe('effect', () => {
  it('runs now and on change, runs the cleanup, stops after dispose', () => {
    const s = signal(1)
    const log: string[] = []
    const dispose = effect(() => {
      const v = s.value
      log.push(`run ${v}`)
      return () => log.push(`clean ${v}`)
    })
    s.value = 2
    dispose()
    s.value = 3
    expect(log).toEqual(['run 1', 'clean 1', 'run 2', 'clean 2'])
  })
})

describe('batch', () => {
  it('applies values at once, notifies once at the end, nests', () => {
    const a = signal(1)
    const b = signal(2)
    const sum = computed(() => a.value + b.value)
    const runs: number[] = []
    effect(() => {
      runs.push(sum.value)
    })
    const f = vi.fn()
    a.subscribe(f)
    const r = batch(() => {
      a.value = 10
      expect(a.value).toBe(10)
      expect(sum.value).toBe(12) // computed is fresh inside the batch
      batch(() => {
        b.value = 20
        a.value = 11
      })
      expect(runs).toEqual([3]) // nothing ran yet
      return 'done'
    })
    expect(r).toBe('done')
    expect(runs).toEqual([3, 31])
    expect(f).toHaveBeenCalledTimes(1)
  })
  it('flushes even when the batch throws', () => {
    const a = signal(0)
    const f = vi.fn()
    a.subscribe(f)
    expect(() =>
      batch(() => {
        a.value = 1
        throw new Error('x')
      }),
    ).toThrow('x')
    expect(f).toHaveBeenCalledTimes(1)
    a.value = 2
    expect(f).toHaveBeenCalledTimes(2)
  })
})
