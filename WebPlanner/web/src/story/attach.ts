// WS16 task 10 (M10): story mode on the planning map (DESIGN U6), loaded lazily by ConsoleMap only
// when a story runs (story/query.ts). Three runs:
//   intro    intro.json once, live (rAF); any key, click, wheel or touch skips at once (U6: skip delay 0 s)
//   demo     kiosk.json in a loop, live; any input exits and leaves the app as it was
//   capture  ?capture=<id>: the storyboard at its fixed frame step under virtual time (vtime.ts), no
//            wall clock; a recorder drives it through window.__capture (see notes/M10.md)
import type { ConsoleMap } from '../map/consoleMap'
import { loadLabels } from '../map/labels/layer'
import { loadFlightPath } from '../map/flythrough/route'
import { missionClock, ui } from '../state'
import { Director, type DirectorState } from './director'
import { storyParams, storyRequest, type StoryRequest } from './query'
import { StoryStage, type ChromePolicy } from './stage'
import { FOLLOW_TARGET, loadStoryboard, type Storyboard } from './storyboard'
import { setVirtualTime, virtualTimeInstalled } from './vtime'
import { basemapSources } from '../map/basemap'
import { demSource, parseTerrainTiles } from '../map/terrain/tiles'
import { exaggeration } from '../map/terrain/state'
import { data } from '../data/loader'
import { DATA_MODE, dataUrl } from '../env'
import { ELEVATION_FACTOR, FIRST_FRAME_MAX_MS, WARMUP_MAX_MS } from './config'
import { after, descentTiles, mapIdle, prefetch, storyPoses, until, type TileSet } from './warm'

const INPUTS = ['keydown', 'pointerdown', 'wheel', 'touchstart'] as const

async function makeDirector(sb: Storyboard, reduced: boolean): Promise<Director> {
  const labels = (await loadLabels()) ?? []
  const needsFollow = sb.steps.some((s) => s.camera?.target === FOLLOW_TARGET)
  const fp = needsFollow ? await loadFlightPath() : null
  return new Director(sb, {
    targets: (code) => {
      const l = labels.find((x) => x.code === code)
      return l ? [l.lon, l.lat] : null
    },
    follow: fp ? (t) => fp.poseAt(t) : undefined,
    tMax: missionClock.tMax,
    reduced,
  })
}

/** Remove ?demo / ?capture / ?intro from the address (replace) once the run is over. */
function dropStoryParams(): void {
  const u = new URL(location.href)
  for (const k of ['demo', 'capture', 'intro', 'chrome']) u.searchParams.delete(k)
  const [path, q] = u.hash.split('?')
  if (q) {
    const h = new URLSearchParams(q)
    for (const k of ['demo', 'capture', 'intro', 'chrome']) h.delete(k)
    u.hash = h.toString() ? `${path}?${h}` : path
  }
  history.replaceState(history.state, '', u.toString())
}

/** Live playback with the rAF clock; resolves 'end' or 'cancel'. */
function playLive(stage: StoryStage, d: Director, o: { loop: boolean; signal: { stopped: boolean } }): Promise<'end' | 'cancel'> {
  return new Promise((resolve) => {
    let t0 = -1
    let raf = 0
    const finish = (why: 'end' | 'cancel'): void => {
      cancelAnimationFrame(raf)
      for (const ev of INPUTS) window.removeEventListener(ev, onInput, true)
      resolve(why)
    }
    const onInput = (): void => {
      o.signal.stopped = true
      finish('cancel')
    }
    for (const ev of INPUTS) window.addEventListener(ev, onInput, { capture: true, passive: true })
    const frame = (now: number): void => {
      if (o.signal.stopped) return finish('cancel')
      if (t0 < 0) t0 = now
      const st = d.stateAt((now - t0) / 1000)
      stage.apply(st)
      if (st.done) {
        if (!o.loop) return finish('end')
        t0 = now
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
  })
}

/** Tile sets the descent draws: the relief_low and terrain DEMs and the HiRISE basemap (each optional). */
async function descentTileSets(): Promise<TileSet[]> {
  const json = async (p: string): Promise<unknown> => {
    const r = await fetch(dataUrl(p, DATA_MODE))
    const ct = r.headers.get('content-type') ?? ''
    return r.ok && (!ct || ct.includes('json')) ? r.json() : null
  }
  const dem = async (p: string): Promise<TileSet[]> => {
    const raw = await json(p).catch(() => null)
    if (!raw) return []
    const s = demSource(parseTerrainTiles(raw), (x) => x)
    return [{ tiles: s.tiles ?? [], minzoom: s.minzoom ?? 0, maxzoom: s.maxzoom ?? 22, bounds: s.bounds as TileSet['bounds'], tileSize: s.tileSize ?? 256 }]
  }
  const base = async (): Promise<TileSet[]> => {
    const tj = await data()
      .optional(() => data().tilejson())
      .catch(() => null)
    return tj ? basemapSources(tj, (x) => x).map((b) => ({ tiles: b.tiles, minzoom: b.minzoom, maxzoom: b.maxzoom, bounds: b.bounds, tileSize: b.tileSize })) : []
  }
  return (await Promise.all([dem('terrain_low/tiles.json'), dem('terrain/tiles.json'), base()])).flat()
}

/**
 * M10c warm-up before a live story's t = 0 (warm.ts): every layer the storyboard shows is drawn once
 * under a cover (programs link, the field uploads its textures), the tiles along the camera
 * path go into the HTTP cache, then frame 0 is applied and its tiles awaited. Bounded by
 * WARMUP_MAX_MS + FIRST_FRAME_MAX_MS; input during it skips the story as usual.
 */
async function warmUp(stage: StoryStage, d: Director, signal: { stopped: boolean }): Promise<void> {
  const map = stage.map
  const s0 = d.stateAt(0)
  const all: Record<string, boolean> = {}
  for (const st of d.sb.steps) for (const [id, on] of Object.entries(st.layers ?? {})) if (on) all[id] = true
  stage.setCanvasHidden(true)
  stage.apply({ ...s0, layers: { ...s0.layers, ...all }, camera: null })
  const c = map.getContainer()
  const url = (p: string): string => dataUrl(p, DATA_MODE)
  void descentTileSets()
    .then((sets) => prefetch(descentTiles(storyPoses(d), sets, { width: c.clientWidth, height: c.clientHeight }, { factor: ELEVATION_FACTOR, exaggeration: exaggeration() }, url)))
    .catch(() => 0)
  const terrainSettled = (): boolean => !['loading', 'off'].includes(c.getAttribute('data-terrain') ?? 'off') || !all.terrain
  const fieldSettled = (): boolean => c.getAttribute('data-bands-render') === 'gpu' || !all.homeline
  const end = performance.now() + WARMUP_MAX_MS
  const left = (): number => Math.max(0, end - performance.now())
  await until(map, () => signal.stopped || (terrainSettled() && fieldSettled()), left())
  await Promise.race([stage.pending, after(left())])
  if (!signal.stopped) await mapIdle(map, left())
  if (signal.stopped) return
  stage.apply(s0)
  const end0 = performance.now() + FIRST_FRAME_MAX_MS
  await Promise.race([stage.pending, after(FIRST_FRAME_MAX_MS)])
  await mapIdle(map, Math.max(0, end0 - performance.now()))
  stage.setCanvasHidden(false)
}

export interface CaptureApi {
  id: string
  fps: number
  size: [number, number]
  frames: number
  frame: number
  done: boolean
  /** frame 0 is applied and drawn */
  ready: Promise<void>
  /** advance one fixed frame step, apply, wait until drawn; resolves with the new frame */
  step(): Promise<{ frame: number; t: number; done: boolean }>
  /** jump to frame n (deterministic: a frame is a pure function of its index) */
  seek(n: number): Promise<{ frame: number; t: number; done: boolean }>
  state(): DirectorState
}

declare global {
  interface Window {
    __capture?: CaptureApi
  }
}

const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))

/** Wait until the map has drawn the current state with every tile, terrain and relief loaded. */
async function settle(stage: StoryStage): Promise<void> {
  const map = stage.map
  await stage.pending
  for (let i = 0; i < 400; i++) {
    await new Promise<void>((r) => {
      const to = setTimeout(r, 50)
      map.once('render', () => {
        clearTimeout(to)
        r()
      })
      map.triggerRepaint()
    })
    const terrain = map.getContainer().getAttribute('data-terrain')
    if (map.loaded() && map.areTilesLoaded() && terrain !== 'loading') break
  }
  await nextFrame()
  await nextFrame()
}

function runCapture(stage: StoryStage, d: Director, sb: Storyboard): CaptureApi {
  let frame = 0
  const go = async (n: number): Promise<{ frame: number; t: number; done: boolean }> => {
    frame = Math.max(0, Math.min(d.frames - 1, n))
    const t = d.frameTime(frame)
    setVirtualTime(t * 1000)
    stage.apply(d.stateAtFrame(frame))
    await settle(stage)
    // a 2D/3D switch or a terrain load may have moved the pitch limit or the ground: apply again
    stage.apply(d.stateAtFrame(frame))
    await settle(stage)
    api.frame = frame
    api.done = frame >= d.frames - 1
    document.documentElement.dataset.storyFrame = String(frame)
    return { frame, t, done: api.done }
  }
  const api: CaptureApi = {
    id: sb.id,
    fps: sb.fps,
    size: sb.size,
    frames: d.frames,
    frame: 0,
    done: false,
    ready: document.fonts.ready.then(() => go(0)).then(() => undefined),
    step: () => go(frame + 1),
    seek: (n) => go(n),
    state: () => d.stateAtFrame(frame),
  }
  return api
}

/** Start the story the page asks for, if any; returns a stop function. */
export function attachStory(cmap: ConsoleMap, req: StoryRequest = storyRequest(storyParams(location.search, location.hash), { reduced: ui.reducedMotion.peek(), introSeen: ui.introSeen.peek(), legacy: false })): () => void {
  const signal = { stopped: false }
  if (!req) return () => undefined
  if (req.kind === 'intro') ui.introSeen.value = true // in memory: once per page session (no browser storage)
  let stage: StoryStage | null = null
  void (async () => {
    const id = req.kind === 'capture' ? req.id : req.kind === 'demo' ? 'kiosk' : 'intro'
    const reduced = req.kind === 'capture' ? false : ui.reducedMotion.peek()
    const [sb] = await Promise.all([loadStoryboard(id), cmap.whenReady()])
    const d = await makeDirector(sb, reduced)
    if (signal.stopped) return
    const chrome: ChromePolicy = req.kind === 'capture' ? (req.chrome ? 'shown' : 'hidden') : 'story'
    stage = new StoryStage(cmap, chrome)
    if (req.kind === 'capture') {
      if (!virtualTimeInstalled()) console.warn('capture without virtual time: frames follow the wall clock')
      window.__capture = runCapture(stage, d, sb)
      return
    }
    // input during the warm-up skips the story like input during it: the app is restored in the
    // input's own microtasks, before its click lands (the click acts on the restored app, D9)
    let skipped = (): void => undefined
    const onSkip = new Promise<void>((r) => (skipped = r))
    const skip = (): void => {
      signal.stopped = true
      skipped()
    }
    for (const ev of INPUTS) window.addEventListener(ev, skip, { capture: true, passive: true })
    await Promise.race([warmUp(stage, d, signal), onSkip]).finally(() => {
      for (const ev of INPUTS) window.removeEventListener(ev, skip, true)
    })
    if (signal.stopped) {
      stage.restore(false)
      stage = null
      if (req.kind === 'demo') dropStoryParams()
      return
    }
    const why = await playLive(stage, d, { loop: req.kind === 'demo', signal })
    stage.restore(why === 'end')
    stage = null
    if (req.kind === 'demo') dropStoryParams()
  })().catch((e) => {
    console.warn('story unavailable:', e)
    stage?.restore(false)
    stage = null
  })
  return () => {
    signal.stopped = true
    if (req.kind === 'capture') delete window.__capture
  }
}
