// WS16-map M10c: make the live descent intro smooth (DESIGN U6). Measured in headless Chromium
// (notes/M10c.md): the intro's hitches were one-off GPU work landing mid-descent, not the per-frame
// loop: 3D terrain programs (terrain depth, sky, clipping masks), the relief_low hillshade, the field
// layer being added (PNG decode + shader link) in the first 5 s, and the field textures plus the line
// and circle programs at t = 12 s, when the pad layers appear. So before the clock starts:
//   1. warm: with the map canvas hidden (the page is still loading), turn on every layer the storyboard
//      will show, in 3D, at the camera the page has, and let the map draw it; programs link and the
//      field uploads its textures there, not in the middle of the descent;
//   2. prefetch: fetch the relief, terrain and basemap tiles along the storyboard's camera path
//      (descentTiles) into the HTTP cache, so the descent does not wait for the network;
//   3. frame 0: apply the first frame, wait for its tiles, show the canvas and start the clock.
// Every wait is bounded (WARMUP_MAX_MS); the intro never stalls. The storyboard, its frames and its
// duration are unchanged: t = 0 starts after the warm-up. Capture mode does not use this (it waits for
// every frame's tiles itself).
import type { Map as MlMap } from 'maplibre-gl'
import { tilePixel } from '../map/terrain/tiles'
import type { CameraPose } from '../map/flythrough/path'
import { PREFETCH_STEP_S } from './config'

/** Camera poses along a storyboard every PREFETCH_STEP_S (the tile prefetch path). */
export function storyPoses(d: { duration: number; stateAt(t: number): { camera: CameraPose | null } }, stepS = PREFETCH_STEP_S): CameraPose[] {
  const out: CameraPose[] = []
  for (let i = 0; i * stepS <= d.duration + 1e-9; i++) {
    const c = d.stateAt(i * stepS).camera
    if (c) out.push(c)
  }
  return out
}

/** One tiled source to prefetch: URL templates ({z}/{x}/{y}), zoom range, lon/lat bounds, tile px. */
export interface TileSet {
  tiles: string[]
  minzoom: number
  maxzoom: number
  bounds: [number, number, number, number]
  tileSize: number
}

export interface Viewport {
  width: number
  height: number
}

export interface PathScale {
  /** scale.elevation_factor (map metres per true metre) */
  factor: number
  /** terrain exaggeration while terrain is on (1 when off) */
  exaggeration: number
}

/** MapLibre's field of view (deg) and its Earth radius (m): the map is Earth-sized (D4). */
const FOV_DEG = 36.87
const EARTH_RADIUS_M = 6371008.8
/** MapLibre's world tile size (px): zoom z is 512 * 2^z px around the world. */
const WORLD_TILE_PX = 512

/**
 * The map zoom MapLibre gives a story camera pose (jumpToPose): the camera sits altM (scaled) above
 * the target, `pitch` from straight down, at MapLibre's camera-to-centre distance.
 */
export function poseZoom(p: CameraPose, vp: Viewport, s: PathScale): number {
  const dist = (p.altM * s.factor * s.exaggeration) / Math.cos((Math.min(p.pitch, 85) * Math.PI) / 180)
  const camPx = (0.5 * vp.height) / Math.tan((FOV_DEG / 2) * (Math.PI / 180))
  const circ = 2 * Math.PI * EARTH_RADIUS_M * Math.cos((p.target[1] * Math.PI) / 180)
  return Math.log2((camPx * circ) / (WORLD_TILE_PX * dist))
}

/**
 * Tile URLs the camera path needs, coarse to fine: for every pose, the tiles of each set at the zoom
 * MapLibre asks for (round(z + log2(512 / tileSize)), clamped to the set) and one zoom coarser (the
 * fallback it draws while the finer tile loads), over the viewport around the target, stretched by
 * 1 / cos(pitch) for the tilted far side, and clipped to the set's bounds.
 */
export function descentTiles(poses: CameraPose[], sets: TileSet[], vp: Viewport, s: PathScale, url: (path: string) => string = (p) => p): string[] {
  const out = new Set<string>()
  const ordered: { z: number; u: string }[] = []
  for (const p of poses) {
    const z = poseZoom(p, vp, s)
    const stretch = 1 / Math.cos((Math.min(p.pitch, 80) * Math.PI) / 180)
    const halfPx = (Math.hypot(vp.width, vp.height) / 2) * stretch
    const degPerPx = 360 / (WORLD_TILE_PX * 2 ** z)
    const dLon = halfPx * degPerPx
    const dLat = dLon * Math.cos((p.target[1] * Math.PI) / 180)
    for (const ts of sets) {
      const zt = Math.round(z + Math.log2(WORLD_TILE_PX / ts.tileSize))
      if (zt < ts.minzoom - 1) continue
      const top = Math.min(ts.maxzoom, Math.max(ts.minzoom, zt))
      const [w, so, e, n] = ts.bounds
      const lo0 = Math.max(w, p.target[0] - dLon)
      const lo1 = Math.min(e, p.target[0] + dLon)
      const la0 = Math.max(so, p.target[1] - dLat)
      const la1 = Math.min(n, p.target[1] + dLat)
      if (lo0 > lo1 || la0 > la1) continue
      for (const zz of new Set([Math.max(ts.minzoom, top - 1), top])) {
        const a = tilePixel(lo0, la1, zz)
        const b = tilePixel(lo1, la0, zz)
        for (let x = a.x; x <= b.x; x++)
          for (let y = a.y; y <= b.y; y++)
            for (const tpl of ts.tiles) {
              const u = url(tpl.replace('{z}', String(zz)).replace('{x}', String(x)).replace('{y}', String(y)))
              if (out.has(u)) continue
              out.add(u)
              ordered.push({ z: zz, u })
            }
      }
    }
  }
  return ordered.sort((a, b) => a.z - b.z).map((o) => o.u)
}

/** Fetch URLs into the HTTP cache, a few at a time; resolves when all are done or `signal` aborts. */
export async function prefetch(urls: string[], o: { concurrency?: number; signal?: AbortSignal; fetcher?: typeof fetch } = {}): Promise<number> {
  const f = o.fetcher ?? fetch
  let next = 0
  let ok = 0
  const worker = async (): Promise<void> => {
    while (next < urls.length && !o.signal?.aborted) {
      const u = urls[next++]
      try {
        const r = await f(u, { signal: o.signal })
        if (r.ok) {
          await r.arrayBuffer()
          ok++
        }
      } catch {
        // a missing tile or an abort: MapLibre asks again on its own
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(o.concurrency ?? 6, urls.length) }, worker))
  return ok
}

/** Resolve after `ms` (or never when ms is not finite). */
export const after = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Resolve on the map's next 'idle' with every tile loaded, or after `maxMs`. */
export function mapIdle(map: MlMap, maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    let to = 0
    const done = (): void => {
      map.off('idle', check)
      clearTimeout(to)
      resolve()
    }
    const check = (): void => {
      if (map.loaded() && map.areTilesLoaded()) done()
    }
    to = window.setTimeout(done, maxMs)
    map.on('idle', check)
    map.triggerRepaint()
  })
}

/** Resolve once `pred` holds (checked on every map render and every 100 ms), or after `maxMs`. */
export function until(map: MlMap, pred: () => boolean, maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    const end = performance.now() + maxMs
    let iv = 0
    const check = (): void => {
      if (!pred() && performance.now() < end) return
      map.off('render', check)
      clearInterval(iv)
      resolve()
    }
    map.on('render', check)
    iv = window.setInterval(check, 100)
    check()
  })
}
