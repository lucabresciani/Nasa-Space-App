// Tiny signal store (DESIGN §5.2: no signals library is installed, docs/web-architecture.md §1).
// signal / computed / effect / batch, plus useSignalValue for Preact components.
// subscribe(fn) calls fn on every change of the value (Object.is), never immediately.
// Inside batch() values update at once; subscriber and effect calls run once at the end.
import { useLayoutEffect, useState } from 'preact/hooks'

type Listener = () => void
let tracking: Set<Source<unknown>> | null = null
let depth = 0
const queued = new Set<Listener>()

export class Source<T> {
  protected v: T
  /** computed nodes: recompute at once, so reads inside a batch are fresh */
  readonly nodes = new Set<Listener>()
  readonly subs = new Set<Listener>()
  constructor(v: T) {
    this.v = v
  }
  get value(): T {
    tracking?.add(this as Source<unknown>)
    return this.v
  }
  peek(): T {
    return this.v
  }
  subscribe(fn: (v: T) => void): () => void {
    const l = () => fn(this.v)
    this.subs.add(l)
    return () => void this.subs.delete(l)
  }
  protected put(v: T): void {
    if (Object.is(v, this.v)) return
    this.v = v
    // one implicit batch: dependent computeds settle before any listener sees them (no glitches)
    batch(() => {
      for (const n of [...this.nodes]) n()
      for (const l of this.subs) queued.add(l)
    })
  }
}
export type ReadSignal<T> = Source<T>

export class Signal<T> extends Source<T> {
  override get value(): T {
    return super.value
  }
  override set value(v: T) {
    this.put(v)
  }
}

/** Run fn while recording the sources it reads; (re)attach `on` to exactly those. */
function tracked<T>(fn: () => T, on: Listener, deps: Set<Source<unknown>>, set: 'nodes' | 'subs'): T {
  for (const d of deps) d[set].delete(on)
  deps.clear()
  const prev = tracking
  tracking = deps
  try {
    return fn()
  } finally {
    tracking = prev
    for (const d of deps) d[set].add(on)
  }
}

export class Computed<T> extends Source<T> {
  constructor(fn: () => T) {
    super(undefined as T)
    const deps = new Set<Source<unknown>>()
    const update = () => this.put(tracked(fn, update, deps, 'nodes'))
    this.v = tracked(fn, update, deps, 'nodes')
  }
}

export const signal = <T>(v: T): Signal<T> => new Signal(v)
export const computed = <T>(fn: () => T): Computed<T> => new Computed(fn)

/** Run fn now and again whenever a value it read changes; fn may return a cleanup. Returns dispose. */
export function effect(fn: () => void | (() => void)): () => void {
  const deps = new Set<Source<unknown>>()
  let cleanup: void | (() => void)
  let live = true
  const run = () => {
    if (!live) return
    if (cleanup) cleanup()
    cleanup = tracked(fn, run, deps, 'subs')
  }
  run()
  return () => {
    live = false
    for (const d of deps) d.subs.delete(run)
    if (cleanup) cleanup()
  }
}

export function batch<T>(fn: () => T): T {
  depth++
  try {
    return fn()
  } finally {
    if (--depth === 0) {
      while (queued.size) {
        const fns = [...queued]
        queued.clear()
        for (const f of fns) f()
      }
    }
  }
}

/** Preact: the current value; re-renders the component when it changes. */
export function useSignalValue<T>(s: ReadSignal<T>): T {
  const v = s.peek()
  const [, force] = useState(0)
  useLayoutEffect(() => {
    const bump = () => force((n) => n + 1)
    if (!Object.is(s.peek(), v)) bump() // changed between render and subscribe
    return s.subscribe(bump)
  }, [s])
  return v
}
