// M10d (follow-up to M10c RR item 8): the 3D frame-rate watch (below 30 fps for 3 s -> flat, M8/T1) is
// suspended while a story plays (intro, kiosk, capture), so a slow GPU never drops the descent to 2D in
// the middle of the intro, and it resumes with a fresh window when the story ends. Written before the
// implementation. CPU only.
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Map as MlMap } from 'maplibre-gl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REPO } from '../../hud/testutil'
import { ui } from '../../state'
import { installDom, type FakeDocument, type FakeNode } from '../../ui/testing/dom'
import { TERRAIN_PENDING } from './config'
import { FpsWatch, fpsWatchSuspended, setFpsWatchSuspended, type FpsState } from './fps'
import { TerrainController } from './index'

/** Feed `fps` frames per second from `fromMs` for `forMs`; returns the last state and the next frame time. */
function run(w: FpsWatch, fps: number, fromMs: number, forMs: number): { state: FpsState; states: Set<FpsState>; end: number } {
  let state: FpsState = 'ok'
  const states = new Set<FpsState>()
  let t = fromMs
  const dt = 1000 / fps
  for (; t <= fromMs + forMs; t += dt) states.add((state = w.frame(t)))
  return { state, states, end: t }
}

afterEach(() => setFpsWatchSuspended(false))

describe('M10d: FpsWatch is suspended while a story plays', () => {
  it('10 fps for 10 s during a story never reports slow or tripped', () => {
    const w = new FpsWatch()
    setFpsWatchSuspended(true)
    expect(fpsWatchSuspended()).toBe(true)
    const r = run(w, 10, 0, 10000)
    expect([...r.states]).toEqual(['ok'])
    expect(w.isTripped).toBe(false)
  })

  it('resumes after the story with a fresh window: slow frames before or during the story do not count', () => {
    const w = new FpsWatch()
    // 2.5 s slow just before the story starts (slow, not yet tripped)
    const a = run(w, 20, 0, 2500)
    expect(a.state).toBe('slow')
    setFpsWatchSuspended(true)
    const b = run(w, 10, a.end, 8000)
    setFpsWatchSuspended(false)
    expect(fpsWatchSuspended()).toBe(false)
    // right after the story: still slow, but the window starts now, so it does not trip at once
    const c = run(w, 20, b.end, TERRAIN_PENDING.slowWindowMs - 500)
    expect(c.states.has('tripped')).toBe(false)
    // the watch is back: slow for the full window trips it
    const d = run(w, 20, c.end, 1000)
    expect(d.state).toBe('tripped')
  })

  it('the fresh window also applies to a watch that saw no frames during the story', () => {
    const w = new FpsWatch()
    const a = run(w, 20, 0, 2900)
    expect(a.state).toBe('slow')
    setFpsWatchSuspended(true)
    setFpsWatchSuspended(false)
    // contiguous frames (no idle gap): without the fresh window this would trip at 3 s
    expect(run(w, 20, a.end, 500).states.has('tripped')).toBe(false)
  })
})

describe('M10d: TerrainController keeps 3D during a story even with low fps', () => {
  function fakeMap(container: FakeNode) {
    const handlers: Record<string, ((...a: unknown[]) => void)[]> = {}
    const noop = (): undefined => undefined
    const handler = { enable: noop, disable: noop, enableRotation: noop, disableRotation: noop }
    const map = {
      addControl: (c: { onAdd: (m: unknown) => unknown }) => container.appendChild(c.onAdd(map) as FakeNode),
      removeControl: (c: { onRemove: () => void }) => c.onRemove(),
      getContainer: () => container,
      on: (ev: string, f: (...a: unknown[]) => void) => void (handlers[ev] ??= []).push(f),
      off: noop,
      once: noop,
      getSource: noop,
      addSource: noop,
      getLayer: noop,
      addLayer: noop,
      setTerrain: noop,
      setMaxPitch: noop,
      setPaintProperty: noop,
      triggerRepaint: noop,
      easeTo: noop,
      jumpTo: noop,
      dragRotate: handler,
      touchZoomRotate: handler,
      keyboard: handler,
    }
    return { map: map as unknown as MlMap, render: () => handlers.render?.forEach((f) => f()) }
  }

  let doc: FakeDocument
  let now = 0
  beforeEach(() => {
    ui.view.value = '2d'
    ui.reducedMotion.value = true
    doc = installDom().document
    const make = doc.createElement.bind(doc)
    doc.createElement = (name: string) => Object.assign(make(name), name === 'canvas' ? { getContext: () => ({}) } : {})
    const tilesJson = readFileSync(resolve(REPO, 'web/src/map/terrain/fixtures/terrain/tiles.json'), 'utf8')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string) => (String(u).includes('terrain/tiles.json') ? new Response(tilesJson, { headers: { 'content-type': 'application/json' } }) : new Response('', { status: 404 }))),
    )
    now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
  })
  afterEach(() => {
    ui.reducedMotion.value = false
    ui.view.value = '2d'
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  /** Render at `fps` for `forMs` (performance.now advances with the frames). */
  function frames(render: () => void, fps: number, forMs: number): void {
    const end = now + forMs
    for (; now <= end; now += 1000 / fps) render()
  }

  it('10 fps for 10 s while a story plays: stays 3D; after the story the watch trips after its full window', async () => {
    const container = doc.createElement('div')
    doc.body.appendChild(container)
    const { map, render } = fakeMap(container)
    const ctl = new TerrainController(map, 'iso-fill')
    setFpsWatchSuspended(true) // story start (StoryStage constructor)
    ui.view.value = '3d' // the storyboard turns terrain on
    await vi.waitFor(() => expect(container.getAttribute('data-terrain')).toBe('3d'))
    frames(render, 10, 10000)
    expect(container.getAttribute('data-terrain')).toBe('3d')
    expect(container.getAttribute('data-terrain-fallback')).toBeNull()
    expect(ui.view.value).toBe('3d')

    setFpsWatchSuspended(false) // story end (StoryStage.restore), the page was in 3D
    frames(render, 10, TERRAIN_PENDING.slowWindowMs - 600)
    expect(container.getAttribute('data-terrain')).toBe('3d')
    frames(render, 10, 1500)
    await vi.waitFor(() => expect(container.getAttribute('data-terrain-fallback')).toBe('slow3d'))
    expect(ui.view.value).toBe('2d')
    ctl.destroy()
  })
})
