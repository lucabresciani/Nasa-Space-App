// M10d (follow-up to M10c): the story stage suspends the 3D frame-rate watch for every story (live and
// capture) at its start hook and resumes it at restore(); the M10c warm-up caps come from
// config/design.yaml (intro.warmup_max_ms, intro.warmup_extra_ms). Written before the implementation.
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REPO } from '../hud/testutil'
import { fpsWatchSuspended, setFpsWatchSuspended } from '../map/terrain/fps'
import { FIRST_FRAME_MAX_MS, WARMUP_MAX_MS } from './config'

describe('M10d: the stage start/end hooks suspend and resume the 3D fps watch', () => {
  const html = { dataset: {} as Record<string, string> }
  const el = () => ({ className: '', hidden: false, textContent: '', style: {} as Record<string, string>, setAttribute() {}, remove() {}, append() {} })
  beforeEach(() => {
    ;(globalThis as { document?: unknown }).document = { documentElement: html, createElement: el }
  })
  afterEach(() => {
    delete (globalThis as { document?: unknown }).document
    setFpsWatchSuspended(false)
  })

  function fakeCmap() {
    const calls: boolean[] = []
    const map = { getCenter: () => ({ lng: 137.4, lat: -4.8 }), getZoom: () => 13, getBearing: () => 0, getPitch: () => 0, getContainer: () => el(), getCanvasContainer: () => el(), jumpTo: vi.fn(), easeTo: vi.fn() }
    return { calls, cmap: { map, layerVisible: () => true, setVisible: () => undefined, setStoryPaused: (on: boolean) => void calls.push(on) } }
  }

  for (const policy of ['story', 'hidden', 'shown'] as const) {
    it(`${policy === 'story' ? 'live story (intro, kiosk)' : `capture (${policy} chrome)`}: suspended from the constructor to restore()`, async () => {
      const { StoryStage } = await import('./stage')
      const { calls, cmap } = fakeCmap()
      expect(fpsWatchSuspended()).toBe(false)
      const stage = new StoryStage(cmap as never, policy)
      expect(fpsWatchSuspended()).toBe(true)
      stage.restore(false)
      expect(fpsWatchSuspended()).toBe(false)
      // the M10c label / furniture pause is unchanged: live stories only
      expect(calls).toEqual(policy === 'story' ? [true, false] : [])
    })
  }
})

describe('M10d: html[data-story-chrome] is written when the clock starts, not under the warm-up cover', () => {
  const html = { dataset: {} as Record<string, string> }
  const el = () => ({ className: '', hidden: false, textContent: '', style: {} as Record<string, string>, setAttribute() {}, remove() {}, append() {} })
  beforeEach(() => {
    html.dataset = {}
    ;(globalThis as { document?: unknown }).document = { documentElement: html, createElement: el }
  })
  afterEach(() => {
    delete (globalThis as { document?: unknown }).document
    setFpsWatchSuspended(false)
  })

  it('frame 0 hides the chrome during the warm-up: the marker waits for the cover to lift', async () => {
    const { StoryStage } = await import('./stage')
    const map = { getCenter: () => ({ lng: 137.4, lat: -4.8 }), getZoom: () => 13, getBearing: () => 0, getPitch: () => 0, getContainer: () => el(), jumpTo: vi.fn(), easeTo: vi.fn() }
    const stage = new StoryStage({ map, layerVisible: () => true, setVisible: () => undefined, setStoryPaused: () => undefined } as never, 'story')
    expect(html.dataset.storyChrome).toBe('show')
    stage.setCanvasHidden(true)
    ;(stage as unknown as { setChrome(v: 'hide'): void }).setChrome('hide') // warm-up apply of frame 0 (ui: hide)
    expect(html.dataset.storyWarm).toBe('on')
    expect(html.dataset.storyChrome).toBe('show')
    stage.setCanvasHidden(false) // t = 0
    expect(html.dataset.storyWarm).toBeUndefined()
    expect(html.dataset.storyChrome).toBe('hide')
    stage.restore(false)
    expect(html.dataset.storyChrome).toBeUndefined()
  })

  it('story.css hides the chrome under the warm-up cover exactly as html[data-story-chrome=hide] does', () => {
    const css = readFileSync(resolve(REPO, 'web/src/story/story.css'), 'utf8')
    const rule = css.slice(0, css.indexOf('opacity: 0;'))
    const sel = rule.slice(rule.lastIndexOf('}') + 1)
    for (const part of ['.hl-ui', '.maplibregl-control-container', '.console-panel']) {
      expect(sel).toContain(`html[data-story-chrome='hide'] ${part}`)
      expect(sel).toContain(`html[data-story-warm] ${part}`)
    }
  })
})

describe('M10d: warm-up caps come from config/design.yaml', () => {
  const design = parse(readFileSync(resolve(REPO, 'config/design.yaml'), 'utf8')) as { intro: { warmup_max_ms: number; warmup_extra_ms: number } }

  it('intro.warmup_max_ms and intro.warmup_extra_ms (2500 + 1000 ms, assumed) are the caps attach.ts uses', () => {
    expect(design.intro.warmup_max_ms).toBe(2500)
    expect(design.intro.warmup_extra_ms).toBe(1000)
    expect(WARMUP_MAX_MS).toBe(design.intro.warmup_max_ms)
    expect(FIRST_FRAME_MAX_MS).toBe(design.intro.warmup_extra_ms)
  })

  it('read with cfg(), not typed in story/config.ts', () => {
    const src = readFileSync(resolve(REPO, 'web/src/story/config.ts'), 'utf8')
    expect(src).toMatch(/WARMUP_MAX_MS = cfg<number>\(designRaw, 'intro\.warmup_max_ms'\)/)
    expect(src).toMatch(/FIRST_FRAME_MAX_MS = cfg<number>\(designRaw, 'intro\.warmup_extra_ms'\)/)
    expect(src).not.toMatch(/= 2500|= 1000/)
  })
})
