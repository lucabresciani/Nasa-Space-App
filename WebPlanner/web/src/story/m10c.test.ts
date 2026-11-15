// M10c: the live descent intro runs smoothly (team lead request; notes/M10c.md). Acceptance:
// 1. the label placement does not run per frame during a story camera move (≤ 4 Hz) and runs once
//    more when it ends;
// 2. the prefetch helper lists the relief / terrain tiles the intro's camera path needs (and only tiles
//    that exist);
// 3. the pause hooks are called at intro start and end (live runs; a capture places labels per frame);
// 4. the storyboard (content, duration) is unchanged by the warm-up.
/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('maplibre-gl', () => ({
  Marker: class {
    setLngLat() {
      return this
    }
    addTo() {
      return this
    }
    remove() {}
  },
  LngLat: class {
    lng: number
    lat: number
    constructor(lng: number, lat: number) {
      this.lng = lng
      this.lat = lat
    }
  },
}))

const DATA = new URL('../../public/data/', import.meta.url)
const STORY = new URL('../../public/story/', import.meta.url)
const readData = (p: string) => JSON.parse(readFileSync(new URL(p, DATA), 'utf8'))
const haveData = existsSync(new URL('labels.json', DATA)) && existsSync(new URL('terrain_low/tiles.json', DATA)) && existsSync(new URL('terrain/tiles.json', DATA))

/** A map stand-in: events, a container, the reads the label layer makes. */
function fakeMap() {
  const on = new Map<string, Set<(e?: unknown) => void>>()
  const el = { setAttribute() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }), querySelectorAll: () => [], append() {} }
  return {
    on: (ev: string, f: () => void) => void (on.get(ev) ?? on.set(ev, new Set()).get(ev)!).add(f),
    off: (ev: string, f: () => void) => void on.get(ev)?.delete(f),
    fire: (ev: string) => on.get(ev)?.forEach((f) => f()),
    getContainer: () => el,
    getCanvasContainer: () => el,
    project: () => ({ x: 0, y: 0 }),
    getZoom: () => 13,
    getPitch: () => 0,
  }
}

describe('label placement during a story camera move', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const g = globalThis as Record<string, unknown>
    g.window ??= globalThis
    // a 60 Hz frame clock on the fake timers (node has no rAF)
    g.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 1000 / 60)
    g.cancelAnimationFrame = (id: number) => clearTimeout(id)
  })
  afterEach(async () => {
    const { setLabelPlacementPaused } = await import('../map/labels/layer')
    setLabelPlacementPaused(false)
    vi.useRealTimers()
  })

  /** 60 map 'move' events, one per 60 Hz frame (what jumpTo per frame fires), over 1 s. */
  async function oneSecondOfMoves(paused: boolean) {
    const { LabelLayer, setLabelPlacementPaused, PLACEMENT_PAUSED_HZ } = await import('../map/labels/layer')
    const map = fakeMap()
    const layer = new LabelLayer(map as never)
    vi.advanceTimersByTime(100)
    setLabelPlacementPaused(paused)
    const before = layer.layouts
    for (let i = 0; i < 60; i++) {
      map.fire('move')
      vi.advanceTimersByTime(1000 / 60)
    }
    const during = layer.layouts - before
    setLabelPlacementPaused(false)
    vi.advanceTimersByTime(100)
    const afterEnd = layer.layouts - before - during
    layer.destroy()
    return { during, afterEnd, hz: PLACEMENT_PAUSED_HZ }
  }

  it('runs on every frame of a normal camera move (unchanged outside stories)', async () => {
    const r = await oneSecondOfMoves(false)
    expect(r.during).toBeGreaterThanOrEqual(55)
  })

  it('runs at most 4 Hz while a story moves the camera, and once more when the story ends', async () => {
    const r = await oneSecondOfMoves(true)
    expect(r.hz).toBe(4)
    expect(r.during).toBeLessThanOrEqual(r.hz + 1)
    expect(r.during).toBeGreaterThanOrEqual(r.hz - 1)
    expect(r.afterEnd).toBe(1)
  })
})

describe('tile prefetch along the intro camera path', () => {
  it.skipIf(!haveData)('lists the relief_low (z6-10) and terrain (z10+) tiles the descent needs, coarse to fine, all existing', async () => {
    const { Director } = await import('./director')
    const { parseStoryboard } = await import('./storyboard')
    const { descentTiles, poseZoom, storyPoses } = await import('./warm')
    const { demSource, parseTerrainTiles, tilePixel } = await import('../map/terrain/tiles')
    const { ELEVATION_FACTOR } = await import('./config')
    const labels = readData('labels.json').labels as { code: string; lon: number; lat: number }[]
    const sb = parseStoryboard(JSON.parse(readFileSync(new URL('intro.json', STORY), 'utf8')))
    const at = (c: string): [number, number] | null => {
      const l = labels.find((x) => x.code === c)
      return l ? [l.lon, l.lat] : null
    }
    const d = new Director(sb, { targets: at, tMax: 360, reduced: false })
    const poses = storyPoses(d)
    // one pose every 0.25 s over the whole storyboard
    expect(poses.length).toBe(Math.floor(d.duration / 0.25) + 1)
    const sets = ['terrain_low/tiles.json', 'terrain/tiles.json'].map((p) => {
      const s = demSource(parseTerrainTiles(readData(p)), (x) => x)
      return { tiles: s.tiles!, minzoom: s.minzoom!, maxzoom: s.maxzoom!, bounds: s.bounds as [number, number, number, number], tileSize: s.tileSize! }
    })
    const vp = { width: 1440, height: 900 }
    const scale = { factor: ELEVATION_FACTOR, exaggeration: 1 }
    const urls = descentTiles(poses, sets, vp, scale)
    // every listed tile exists (no 404s) and is unique
    expect(new Set(urls).size).toBe(urls.length)
    for (const u of urls) expect(existsSync(new URL(u, DATA)), u).toBe(true)
    const z = (u: string) => Number(u.split('/')[1])
    // coarse to fine
    for (let i = 1; i < urls.length; i++) expect(z(urls[i])).toBeGreaterThanOrEqual(z(urls[i - 1]))
    // 180 km -> about z8; 9 km over the pad (t = 12 s) -> about z12-13 (MapLibre's own zoom for the pose)
    const z0 = poseZoom(poses[0], vp, scale)
    expect(z0).toBeGreaterThan(7.5)
    expect(z0).toBeLessThan(9)
    // frame 0 (Gale from 180 km): the relief_low tile under Mount Sharp at the zoom MapLibre asks for
    // (256 px tiles: round(z + 1)) and one coarser
    const msh = poses[0].target
    for (const zz of [Math.round(z0 + 1), Math.round(z0)]) {
      const tt = tilePixel(msh[0], msh[1], zz)
      expect(urls).toContain(`terrain_low/${zz}/${tt.x}/${tt.y}.png`)
    }
    const pad = d.stateAt(12).camera!
    const zp = poseZoom(pad, vp, scale)
    expect(zp).toBeGreaterThan(11)
    expect(zp).toBeLessThan(14)
    // the pad: the terrain tile under it at the zoom MapLibre asks for (256 px tiles: round(z + 1))
    const zt = Math.min(15, Math.round(zp + 1))
    const tp = tilePixel(pad.target[0], pad.target[1], zt)
    expect(urls).toContain(`terrain/${zt}/${tp.x}/${tp.y}.png`)
    // both sets are used, and not the whole pyramid (the z15 terrain tiles are only needed below ~5 km)
    expect(urls.some((u) => u.startsWith('terrain_low/'))).toBe(true)
    expect(urls.some((u) => u.startsWith('terrain/'))).toBe(true)
    expect(urls.filter((u) => u.startsWith('terrain/15/')).length).toBe(0)
  })

  it('prefetch fetches every URL once and survives failures', async () => {
    const { prefetch } = await import('./warm')
    const seen: string[] = []
    const fetcher = (async (u: string) => {
      seen.push(u)
      if (u === 'b') throw new Error('offline')
      return { ok: u !== 'c', arrayBuffer: async () => new ArrayBuffer(0) }
    }) as unknown as typeof fetch
    expect(await prefetch(['a', 'b', 'c', 'd'], { fetcher, concurrency: 2 })).toBe(2)
    expect(seen.sort()).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('pause hooks at intro start and end', () => {
  const html = { dataset: {} as Record<string, string> }
  const el = () => ({ className: '', hidden: false, textContent: '', style: {} as Record<string, string>, setAttribute() {}, remove() {}, append() {} })
  beforeEach(() => {
    ;(globalThis as { document?: unknown }).document = { documentElement: html, createElement: el }
  })
  afterEach(() => {
    delete (globalThis as { document?: unknown }).document
  })

  function fakeCmap() {
    const calls: boolean[] = []
    const map = { getCenter: () => ({ lng: 137.4, lat: -4.8 }), getZoom: () => 13, getBearing: () => 0, getPitch: () => 0, getContainer: () => el(), getCanvasContainer: () => el(), jumpTo: vi.fn(), easeTo: vi.fn() }
    return { calls, cmap: { map, layerVisible: () => true, setVisible: () => undefined, setStoryPaused: (on: boolean) => void calls.push(on) } }
  }

  it('a live story (intro, kiosk) pauses the labels and furniture at start and resumes them at the end', async () => {
    const { StoryStage } = await import('./stage')
    const { calls, cmap } = fakeCmap()
    const stage = new StoryStage(cmap as never, 'story')
    expect(calls).toEqual([true])
    stage.restore(false)
    expect(calls).toEqual([true, false])
  })

  it('a capture never pauses them (labels are placed on every captured frame)', async () => {
    const { StoryStage } = await import('./stage')
    for (const policy of ['hidden', 'shown'] as const) {
      const { calls, cmap } = fakeCmap()
      new StoryStage(cmap as never, policy).restore(false)
      expect(calls).toEqual([])
    }
  })

  it('the console map forwards the hook to the label layer and the furniture', () => {
    const src = readFileSync(new URL('../map/consoleMap.ts', import.meta.url), 'utf8')
    const body = src.slice(src.indexOf('setStoryPaused(on: boolean)'), src.indexOf('layerVisible(group'))
    expect(body).toContain('setLabelPlacementPaused(on)')
    expect(body).toContain('this.furniture?.setPaused(on)')
    const furn = readFileSync(new URL('../map/furniture/index.ts', import.meta.url), 'utf8')
    // paused: no dash-flow / pulse frame loop, no throttled thread recompute
    expect(furn).toMatch(/const want = !reduced && !this\.paused/)
    expect(furn).toMatch(/if \(this\.timer \|\| this\.paused\) return/)
  })
})

describe('intro content and timing unchanged', () => {
  it('intro.json is the M10 storyboard: 20 s, the same keyframes', () => {
    const sb = JSON.parse(readFileSync(new URL('intro.json', STORY), 'utf8')) as { steps: { t: number; camera?: unknown }[] }
    expect(sb.steps.map((s) => s.t)).toEqual([0, 4, 9, 12, 14.5, 18, 20])
    expect(sb.steps[0].camera).toEqual({ target: 'MSH', alt_m: 180000, bearing: 0, pitch: 0 })
  })

  it('the warm-up is bounded and the live runner starts t = 0 after it (capture does not warm)', () => {
    const src = readFileSync(new URL('./attach.ts', import.meta.url), 'utf8')
    expect(src.indexOf('warmUp(stage, d, signal)')).toBeGreaterThan(src.indexOf("if (req.kind === 'capture')"))
    expect(src.indexOf('warmUp(stage, d, signal)')).toBeLessThan(src.indexOf('await playLive('))
  })
})
