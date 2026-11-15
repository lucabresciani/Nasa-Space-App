// Shared helpers for Preact pages.
import { render, type ComponentChildren, type VNode } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { DataProblem } from '../components/labels'
import { ensureManifest } from './common'
import type { View } from './types'
import type { Route } from '../router'

export type Loaded<T> = { state: 'loading' } | { state: 'ok'; data: T } | { state: 'error'; error: unknown }

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []): Loaded<T> {
  const [s, setS] = useState<Loaded<T>>({ state: 'loading' })
  useEffect(() => {
    let alive = true
    setS({ state: 'loading' })
    fn().then(
      (data) => alive && setS({ state: 'ok', data }),
      (error) => alive && setS({ state: 'error', error }),
    )
    return () => {
      alive = false
    }
  }, deps)
  return s
}

/** Render a loaded value, a loading line, or the data problem. */
export function Show<T>({ l, what, children }: { l: Loaded<T>; what: string; children: (d: T) => ComponentChildren }) {
  if (l.state === 'loading') return <p class="muted">Loading {what}…</p>
  if (l.state === 'error') return <DataProblem error={l.error} what={what} />
  return <>{children(l.data)}</>
}

/** A View that renders a Preact component (after the manifest is loaded). */
export function preactView(make: (route: Route) => VNode): View {
  return async (el, route) => {
    await ensureManifest()
    const host = document.createElement('div')
    el.append(host)
    render(make(route), host)
    return () => render(null, host)
  }
}

export function Page({ title, children, wide }: { title: ComponentChildren; children: ComponentChildren; wide?: boolean }) {
  return (
    <div class={`page${wide ? ' page-wide' : ''}`}>
      <h1>{title}</h1>
      {children}
    </div>
  )
}
