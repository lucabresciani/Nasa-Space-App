// WS16 task 8 (M8): U1 acceptance (briefs/WS16.md "Terrain: a reference ridge's height-to-width ratio
// at 1× matches the 1 m model within 5%"; DESIGN U1, §5.4). Written before the implementation. CPU
// only: the 3D picture itself is never judged headless (RR checks in notes/M8.md).
//
// Data: web/public/data/terrain/ (P2 export) when this branch has it; the M3 → M6 stack predates P2,
// so until the rebase onto design the test reads fixtures/terrain/, verbatim copies of origin/design
// web/public/data/terrain/tiles.json and two z16 tiles. fixtures/ridge_profile.json is the 1 m DEM
// (git-ignored, ~/hl-data) sampled along one tile row across a ridge, made once for this test.
/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MercatorCoordinate } from 'maplibre-gl'
import { parse } from 'yaml'
import { beforeEach, describe, expect, it } from 'vitest'
import { parseClockSun, sunAt, type ClockFile } from '../../hud/sun'
import { REPO } from '../../hud/testutil'
import { ui } from '../../state'
import { LABELS, LEADER_LIFT_PX } from '../labels/config'
import { leaderLift } from '../labels/model'
import { factorText, t, TERRAIN, TERRAIN_PENDING } from './config'
import { FpsWatch, type FpsState } from './fps'
import { clampExaggeration, exaggeration, reliefAzimuth, reliefMinute, setExaggeration, setView, toggleView } from './state'
import { tileClipMatrix } from './terrain'
import { readPng } from './testutil'
import { demSource, parseTerrainTiles, pixelCentre, terrariumHeight, tilePixel } from './tiles'

const PUBLISHED = resolve(REPO, 'web/public/data/terrain')
const FIXTURE = resolve(REPO, 'web/src/map/terrain/fixtures/terrain')
const TERRAIN_DIR = existsSync(resolve(PUBLISHED, 'tiles.json')) ? PUBLISHED : FIXTURE
const tilesRaw = JSON.parse(readFileSync(resolve(TERRAIN_DIR, 'tiles.json'), 'utf8')) as { vertical_offset_m?: number }
const tiles = parseTerrainTiles(tilesRaw)
/** P2c: metres added after scaling (h = elevation × factor + offset) so the site sits near 0 m in MapLibre; absent = 0 (pre-P2c fixtures). */
const OFFSET_M = tilesRaw.vertical_offset_m ?? 0
const design = parse(readFileSync(resolve(REPO, 'config/design.yaml'), 'utf8')) as { terrain_tiles: { vertical_offset_m: number } }
const site = parse(readFileSync(resolve(REPO, 'config/site.yaml'), 'utf8')) as { pad_default: { lon: number; lat: number }; crs: { mars_radius_m: number } }

/** P2's known value: the 1 m DEM bilinear at the centre of the z16 pixel holding pad_default (m, true). */
const PAD_DEM_M = -3627.7293
/** MapLibre's Earth radius (maplibre-gl earthRadius; docs/web-architecture.md D4 caveats). */
const ML_EARTH_RADIUS_M = 6371008.8

function tileHeights(z: number, x: number, y: number): (i: number, j: number) => number {
  const { px, w, bpp } = readPng(resolve(TERRAIN_DIR, String(z), String(x), `${y}.png`))
  return (i, j) => {
    const k = (i * w + j) * bpp
    return terrariumHeight(px[k], px[k + 1], px[k + 2])
  }
}

describe('U1 tiles: the factor is baked in, exaggeration 1 = true shape', () => {
  it('decoding the tile pixel at the pad equals the 1 m DEM × 1.878 + vertical_offset_m (P2/P2c known value, ± 0.1 m × factor)', () => {
    const { lon, lat } = site.pad_default
    const z = tiles.focus!.maxzoom
    const p = tilePixel(lon, lat, z)
    const h = tileHeights(z, p.x, p.y)(p.i, p.j)
    expect(tiles.factor).toBe(TERRAIN.elevationFactor)
    if (TERRAIN_DIR === PUBLISHED) expect(OFFSET_M).toBe(design.terrain_tiles.vertical_offset_m)
    expect(Math.abs(h - (PAD_DEM_M * tiles.factor + OFFSET_M))).toBeLessThanOrEqual(0.1 * tiles.factor)
    // and the published pad.json elevation of the same point (rounded to 0.1 m)
    const pad = JSON.parse(readFileSync(resolve(REPO, 'web/public/data/pad.json'), 'utf8')) as { alternatives: { id: string; elev_m: number }[] }
    const elev = pad.alternatives.find((a) => a.id === 'pad_default')!.elev_m
    expect(Math.abs((h - OFFSET_M) / tiles.factor - elev)).toBeLessThanOrEqual(0.15)
  })

  it('the factor is Earth / Mars radius (DESIGN U1 item 2) and only in the tiles', () => {
    expect(TERRAIN.elevationFactor).toBeCloseTo(6378.137 / 3396.19, 3)
    expect(TERRAIN.exaggeration.default).toBe(1)
  })

  describe('reference ridge: on-screen height-to-width ratio at 1× = the 1 m model within 5 %', () => {
    const prof = JSON.parse(readFileSync(resolve(REPO, 'web/src/map/terrain/fixtures/ridge_profile.json'), 'utf8')) as {
      tile: [number, number, number]
      row: number
      cols: number[]
      dem_m: number[]
      mars_radius_m: number
    }
    const [z, x, y] = prof.tile
    const H = tileHeights(z, x, y)
    const scaled = prof.cols.map((j) => H(prof.row, j))
    const lonlat = prof.cols.map((j) => pixelCentre(z, x, y, prof.row, j))
    const peak = prof.dem_m.indexOf(Math.max(...prof.dem_m))
    const feet = [0, prof.cols.length - 1]

    /** Model: true metres on Mars (1 m DEM; ground distance on the Mars sphere). */
    function modelRatio(f: number): number {
      const [lonP, lat] = lonlat[peak]
      const [lonF] = lonlat[f]
      const dx = prof.mars_radius_m * (Math.abs(lonP - lonF) * Math.PI / 180) * Math.cos(lat * Math.PI / 180)
      return (prof.dem_m[peak] - prof.dem_m[f]) / dx
    }
    /** Screen: MapLibre's own Mercator maths (Earth radius), tile heights × exaggeration as setTerrain draws them. */
    function screenRatio(f: number, exag: number): number {
      const a = MercatorCoordinate.fromLngLat(lonlat[peak], scaled[peak] * exag)
      const b = MercatorCoordinate.fromLngLat(lonlat[f], scaled[f] * exag)
      return (a.z - b.z) / Math.abs(a.x - b.x)
    }

    it('is a real ridge (≥ 10 m above both feet, peak inside the profile)', () => {
      expect(peak).toBeGreaterThan(4)
      expect(peak).toBeLessThan(prof.cols.length - 5)
      for (const f of feet) expect(prof.dem_m[peak] - prof.dem_m[f]).toBeGreaterThan(10)
      expect(prof.mars_radius_m).toBe(site.crs.mars_radius_m)
    })

    for (const f of feet) {
      it(`flank to ${f === 0 ? 'west' : 'east'} foot: 1× within 5 %, 2× doubles it`, () => {
        const m = modelRatio(f)
        const s1 = screenRatio(f, 1)
        expect(Math.abs(s1 / m - 1)).toBeLessThan(0.05)
        expect(screenRatio(f, 2) / s1).toBeCloseTo(2, 6)
        // guard: applying web-architecture.md's runtime ×1.876 on top of the baked factor would fail
        const twice = screenRatio(f, ML_EARTH_RADIUS_M / site.crs.mars_radius_m)
        expect(Math.abs(twice / m - 1)).toBeGreaterThan(0.05)
      })
    }

    it('MapLibre Earth radius is the one the maths assumes', () => {
      const c = MercatorCoordinate.fromLngLat([0, 0], 0)
      expect(1 / c.meterInMercatorCoordinateUnits() / (2 * Math.PI)).toBeCloseTo(ML_EARTH_RADIUS_M, 0)
    })
  })

  it('sources: terrarium raster-dem, z minzoom..15 on the planning extent (no 404s), data-root prefix', () => {
    const s = demSource(tiles, (p) => `./data/${p}`)
    expect(s.type).toBe('raster-dem')
    expect(s.encoding).toBe('terrarium')
    expect(s.tileSize).toBe(256)
    expect(s.minzoom).toBe(tiles.minzoom)
    expect(s.maxzoom).toBe(tiles.focus!.minzoom - 1)
    expect(s.bounds).toEqual(tiles.bounds)
    expect(s.tiles).toEqual(['./data/terrain/{z}/{x}/{y}.png'])
  })

  it('field drape matrix: Mercator corners of a tile land on its clip-space corners (SW -1,-1; NE 1,1)', () => {
    const [z, x, y] = [15, 28888, 16821]
    const m = tileClipMatrix(z, x, y)
    const apply = (mx: number, my: number): [number, number] => [m[0] * mx + m[4] * my + m[12], m[1] * mx + m[5] * my + m[13]]
    const n = 2 ** z
    const sw = apply(x / n, (y + 1) / n)
    const ne = apply((x + 1) / n, y / n)
    expect(sw[0]).toBeCloseTo(-1, 9)
    expect(sw[1]).toBeCloseTo(-1, 9)
    expect(ne[0]).toBeCloseTo(1, 9)
    expect(ne[1]).toBeCloseTo(1, 9)
  })
})

describe('fps fallback state machine (below 30 fps for 3 s in 3D -> flat + notice)', () => {
  function run(w: FpsWatch, fps: number, fromMs: number, forMs: number): { state: FpsState; end: number } {
    let state: FpsState = 'ok'
    let t = fromMs
    const dt = 1000 / fps
    for (; t <= fromMs + forMs; t += dt) state = w.frame(t)
    return { state, end: t }
  }

  it('20 fps for 3 s trips; not before 3 s', () => {
    const w = new FpsWatch()
    expect(run(w, 20, 0, 2800).state).toBe('slow')
    expect(run(new FpsWatch(), 20, 0, TERRAIN_PENDING.slowWindowMs + 100).state).toBe('tripped')
  })
  it('40 fps never trips; exactly the config minimum is not slow', () => {
    expect(run(new FpsWatch(), 40, 0, 10000).state).toBe('ok')
    expect(run(new FpsWatch(), TERRAIN.fps3dMin, 0, 10000).state).toBe('ok')
  })
  it('a 2.5 s dip that recovers does not trip, and the clock restarts after it', () => {
    const w = new FpsWatch()
    const a = run(w, 20, 0, 2500)
    expect(a.state).toBe('slow')
    const b = run(w, 50, a.end, 1000)
    expect(b.state).toBe('ok')
    expect(run(w, 20, b.end, 2500).state).toBe('slow')
  })
  it('idle gaps (on-demand rendering) are not slow frames', () => {
    const w = new FpsWatch()
    let s: FpsState = 'ok'
    for (let t = 0; t < 10000; t += 1500) s = w.frame(t) // one frame every 1.5 s: an idle map
    expect(s).toBe('ok')
  })
  it('once tripped it stays tripped until re-armed (the user asks for 3D again)', () => {
    const w = new FpsWatch()
    run(w, 10, 0, 4000)
    expect(w.isTripped).toBe(true)
    expect(w.frame(5000)).toBe('tripped')
    w.rearm()
    expect(w.isTripped).toBe(false)
    expect(run(w, 60, 6000, 4000).state).toBe('ok')
  })
})

describe('2D/3D toggle and exaggeration slider update the A3 ui store', () => {
  beforeEach(() => {
    ui.view.value = '2d'
    ui.exaggeration.value = undefined
  })
  it('toggle: 2D <-> 3D in ui.view; 3D fills the design.yaml default exaggeration', () => {
    expect(toggleView()).toBe('3d')
    expect(ui.view.value).toBe('3d')
    expect(ui.exaggeration.value).toBe(TERRAIN.exaggeration.default)
    expect(toggleView()).toBe('2d')
    expect(ui.view.value).toBe('2d')
    setView('3d')
    expect(ui.view.value).toBe('3d')
  })
  it('slider: clamped to 1–3, one decimal, factor text shows it', () => {
    setExaggeration(2.04)
    expect(ui.exaggeration.value).toBe(2)
    expect(exaggeration()).toBe(2)
    setExaggeration(9)
    expect(ui.exaggeration.value).toBe(TERRAIN.exaggeration.max)
    setExaggeration(0.2)
    expect(ui.exaggeration.value).toBe(TERRAIN.exaggeration.min)
    expect(clampExaggeration(Number.NaN)).toBe(TERRAIN.exaggeration.default)
    expect(clampExaggeration(1.26)).toBe(1.3)
    expect(factorText(1)).toBe('1.0×')
    expect(factorText(2.5)).toBe('2.5×')
    expect(t('tooltips.exaggeration', { factor: '1.0' })).toBe('Vertical exaggeration 1.0× (true shape at one times)')
  })
  it('exaggeration() is the default until the store holds a value', () => {
    expect(exaggeration()).toBe(TERRAIN.exaggeration.default)
  })
})

describe('leader lines only above 30° tilt (U13 item 5, labels.leader_line_min_pitch_deg)', () => {
  it('none at 0–30°, a lift above 30° up to the 3D max pitch', () => {
    expect(LABELS.leaderLineMinPitchDeg).toBe(30)
    for (const p of [0, 10, 29.9, 30]) expect(leaderLift(p)).toBe(0)
    for (const p of [30.1, TERRAIN.pitch3d, 60, TERRAIN.maxPitch3d]) expect(leaderLift(p)).toBe(LEADER_LIFT_PX)
    // 3D opens above the leader pitch, so labels float on entering 3D
    expect(TERRAIN.pitch3d).toBeGreaterThan(LABELS.leaderLineMinPitchDeg)
  })
})

describe('relief light follows the sun (DESIGN U1 item 4)', () => {
  const clock = JSON.parse(readFileSync(resolve(REPO, 'web/public/data/conditions/clock.json'), 'utf8')) as ClockFile
  const sun = parseClockSun(clock)!
  it('= the sun azimuth at the plan start (minute 0) from conditions/clock.json', () => {
    expect(reliefAzimuth(sun, 0)).toBeCloseTo(sunAt(sun, 0).azDeg!, 9)
  })
  it('changes at most once per simulated minute', () => {
    expect(reliefMinute(12.0)).toBe(12)
    expect(reliefMinute(12.99)).toBe(12)
    expect(reliefAzimuth(sun, 12.1)).toBe(reliefAzimuth(sun, 12.9))
    expect(reliefAzimuth(sun, 12.9)).not.toBe(reliefAzimuth(sun, 13.0))
  })
  it('no sun data or outside the series -> null (MapLibre default light; never extrapolated)', () => {
    expect(reliefAzimuth(null, 0)).toBeNull()
    expect(reliefAzimuth(sun, sun.tMin[sun.tMin.length - 1] + 60)).toBeNull()
  })
})

describe('config/design.yaml and copy.json cross-check (when present on this branch)', () => {
  const yml = resolve(REPO, 'config/design.yaml')
  it.skipIf(!existsSync(yml))('TERRAIN equals config/design.yaml', () => {
    const d = parse(readFileSync(yml, 'utf8')) as {
      scale: { elevation_factor: number }
      exaggeration: { min: number; max: number; default: number; step: number }
      camera: { presets: { isometric: { pitch: number }; low: { pitch: number } } }
      performance: { fps_3d_min: number }
      terrain_3d: { max_pitch_deg: number }
    }
    expect(TERRAIN.elevationFactor).toBe(d.scale.elevation_factor)
    expect({ ...TERRAIN.exaggeration, step: TERRAIN_PENDING.exaggerationStep }).toEqual(d.exaggeration)
    expect(TERRAIN.pitch3d).toBe(d.camera.presets.isometric.pitch)
    expect(TERRAIN.maxPitch3d).toBe(d.terrain_3d.max_pitch_deg)
    expect(d.camera.presets.low.pitch).toBeLessThanOrEqual(TERRAIN.maxPitch3d)
    expect(TERRAIN.fps3dMin).toBe(d.performance.fps_3d_min)
  })
  it('the terrain text comes from the copy deck (ui/copy), no copied strings (T1)', () => {
    const c = JSON.parse(readFileSync(resolve(REPO, 'web/src/ui/copy.json'), 'utf8')) as { buttons: Record<string, string>; tooltips: Record<string, string> }
    expect(t('buttons.view3d')).toBe(c.buttons.view3d)
    expect(t('tooltips.view3d')).toBe(c.tooltips.view3d)
  })
})
