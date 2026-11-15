// WP6 (D97): the browser's route grid for the ghost route, ported from origin/waypoint-routing
// web/src/mission/data.ts (N0CEO, Mission Planer), reduced to the routing grid:
//   - grid: the shared 5 m field grid (fields/index.json). A cell is walkable iff WS2's T_home field
//     is known there (WS2 reached it from the pad within its no-go limit: blocked, unknown and
//     unreached cells have A = 0), so every routed leg can walk home.
//   - elevation: fp3d/far.f32.gz (8 m, built from WS1's 1 m DEM where it exists), sampled
//     bilinearly at every cell centre. Coarser than WS2's 3 m graph, so leg times are browser
//     estimates and are labelled "estimate"; the live job's run record is the answer.
// Loaded lazily (first ordered route with a stop), once per scenario; the heights once per page.
import { data } from '../../../data/loader'
import { dataUrl } from '../../../env'
import { FieldGrid, loadField } from '../../../hud/fields'
import type { FieldsIndex as HudFieldsIndex } from '../../../hud/types'
import { codecOf, decodeHeights, farOrigin, gunzipIfNeeded, HeightGrid, lonLatToXY, parseEqc, parseIndex } from './heights'
import { gradeModel, scenarioParams, type GradeModel } from './physio'
import type { RouteGrid } from './router'

export interface RouteGridData {
  scenario: string
  tHome: FieldGrid
  grid: RouteGrid
  model: GradeModel
}

/** Elevation of every cell centre of `g` from a height grid in the analysis CRS (ported). */
export function sampleElevation(g: FieldGrid, heights: HeightGrid, toXY: (lon: number, lat: number) => [number, number]): Float32Array {
  const out = new Float32Array(g.width * g.height)
  for (let r = 0; r < g.height; r++) {
    for (let c = 0; c < g.width; c++) {
      const [lon, lat] = g.lonLatOf(r, c)
      const [x, y] = toXY(lon, lat)
      out[r * g.width + c] = heights.bilinear(x, y)
    }
  }
  return out
}

/** Walkable cells = T_home known (ported rule). */
export function routeGridOf(tHome: FieldGrid, elev: Float32Array): RouteGrid {
  const passable = new Uint8Array(tHome.width * tHome.height)
  passable.set(tHome.data.known)
  return { width: tHome.width, height: tHome.height, resM: tHome.resM, elev, passable }
}

/** Cell index of (lon, lat) on the grid, or null outside it. */
export function cellOf(g: FieldGrid, lon: number, lat: number): number | null {
  const p = g.pixelOf(lon, lat)
  return p ? p.row * g.width + p.col : null
}

/** Centre of a cell as [lon, lat]. */
export function lonLatOfCell(g: FieldGrid, cell: number): [number, number] {
  const r = Math.floor(cell / g.width)
  return g.lonLatOf(r, cell - r * g.width)
}

/**
 * The cell a stop is routed from: its own cell when walkable, else the nearest walkable cell within
 * `radiusM` (the engine's access radius, D27 = route.min_stop_spacing_m); null when there is none.
 */
export function accessCell(g: RouteGrid, cell: number | null, radiusM: number): number | null {
  if (cell === null || cell < 0 || cell >= g.width * g.height) return null
  if (g.passable[cell]) return cell
  const R = Math.floor(radiusM / g.resM)
  const r0 = Math.floor(cell / g.width)
  const c0 = cell - r0 * g.width
  let best: number | null = null
  let bestD = Infinity
  for (let dr = -R; dr <= R; dr++) {
    const r = r0 + dr
    if (r < 0 || r >= g.height) continue
    for (let dc = -R; dc <= R; dc++) {
      const c = c0 + dc
      if (c < 0 || c >= g.width) continue
      const d = dr * dr + dc * dc
      if (d > R * R || d >= bestD) continue
      if (g.passable[r * g.width + c]) {
        best = r * g.width + c
        bestD = d
      }
    }
  }
  return best
}

async function fetchBuf(path: string): Promise<ArrayBuffer> {
  const res = await fetch(dataUrl(path))
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return res.arrayBuffer()
}

let heightsOnce: Promise<{ heights: HeightGrid; toXY: (lon: number, lat: number) => [number, number] }> | null = null
function loadHeights() {
  return (heightsOnce ??= (async () => {
    const fp = parseIndex(JSON.parse(new TextDecoder().decode(await fetchBuf('fp3d/index.json'))))
    const farBuf = await gunzipIfNeeded(await fetchBuf(fp.far.file))
    const [west, north] = farOrigin(fp)
    const heights = new HeightGrid(west, north, fp.far.res_m, fp.far.width, fp.far.height, decodeHeights(farBuf, fp.far.width, fp.far.height, codecOf(fp)))
    const eqc = parseEqc(fp.chunk_grid.crs)
    return { heights, toXY: (lon: number, lat: number) => lonLatToXY(eqc, lon, lat) }
  })().catch((e) => {
    heightsOnce = null
    throw e
  }))
}

const grids = new Map<string, Promise<RouteGridData>>()

/** The route grid of a scenario (e.g. nom_104): T_home of fields/index.json + far heights. Cached. */
export function loadRouteGrid(scenario: string): Promise<RouteGridData> {
  let p = grids.get(scenario)
  if (!p) {
    p = (async () => {
      const fi = (await data().fieldsIndex()) as unknown as HudFieldsIndex
      const key = `${scenario}/t_home`
      if (!fi.fields[key]) throw new Error(`fields/index.json has no ${key}`)
      const [tHome, h] = await Promise.all([loadField(fi, key, dataUrl), loadHeights()])
      const elev = sampleElevation(tHome, h.heights, h.toXY)
      return { scenario, tHome, grid: routeGridOf(tHome, elev), model: gradeModel(scenarioParams(scenario)) }
    })()
    p.catch(() => grids.delete(scenario))
    grids.set(scenario, p)
  }
  return p
}
