// Everything the Mission Planer reads, for one scenario (default: scenarios/index.json "default").
//   - routing grid: the shared 5 m field grid (fields/index.json). A cell is walkable iff WS2's
//     T_home field is known there (WS2 reached it from the pad within its no-go limit: blocked,
//     unknown and unreached cells have A = 0), so a waypoint can always walk home.
//   - elevation: fp3d/far.f32.gz (WS8, 8 m, built from WS1's 1 m DEM where it exists), sampled
//     bilinearly at every cell centre. This is coarser than WS2's 3 m graph, so leg times and O2 are
//     browser estimates, labelled as such; T_home and O2 home stay WS2's own numbers.
//   - way home: WS2's pointer field (same path as the HUD's drag-anywhere).
import { CONFIG } from '../config'
import { data } from '../data/loader'
import type { BandsFC, EdgesFC, IsochroneFC, Rad, ScenarioEntry, TileJson } from '../data/types'
import { dataUrl } from '../env'
// fp3d/{format,geo,terrain} were removed on main (D99): the functions the planner needs are in ./heights
import { codecOf, decodeHeights, farOrigin, gunzipIfNeeded, HeightGrid, lonLatToXY, parseEqc, parseIndex } from './heights'
import { FieldGrid, loadField } from '../hud/fields'
import type { FieldsIndex as HudFieldsIndex } from '../hud/types'
import { loadPointer, type PointerField } from '../hud/wayhome'
import { citesD21, padMarker, type PadMarkerInfo } from '../map/pad'
import { gradeModel, scenarioParams, type GradeModel } from './physio'
import type { RouteGrid } from './router'

export interface MissionData {
  scenario: ScenarioEntry
  scenarios: ScenarioEntry[]
  pad: PadMarkerInfo
  tHome: FieldGrid
  o2Home: FieldGrid | null
  pointer: PointerField | null
  grid: RouteGrid
  model: GradeModel
  tilejson: TileJson | null
  bands: BandsFC | null
  isochrones: IsochroneFC | null
  edges: EdgesFC | null
  /** file each layer came from, for the captions */
  files: { tHome: string; o2Home: string | null; pointer: string | null; elevation: string; bands: string; isochrones: string; edges: string }
  elevationResM: number
  /** WS4 conditions for the margin (mission/margin.ts): the RAD storm series (D39) and the
   *  minutes from EVA start to darkness; null when the file is missing */
  rad: Rad | null
  tDarkMin: number | null
  /** pad.json pad id and areoid elevation (null without pad.json / when unknown): the mission export's frame */
  padId: string | null
  /** official = pad.json cites D21; config_default = no pad.json (site.yaml pad_default); custom = any other pad.json pad */
  padKind: 'official' | 'custom' | 'config_default'
  padElevM: number | null
  /** clock.json eva.start_lmst (D31), or null */
  evaStartLmst: string | null
  /** clock.json eva.start_utc and msl_sol (WS4): the EVA start as an instant, for the simulator's sky; null when missing */
  evaStartUtc: string | null
  mslSol: number | null
}

/** clock.json eva.start_utc (WS4), or null. */
export function evaStartUtcOf(clock: unknown): string | null {
  const v = (clock as { eva?: { start_utc?: unknown } } | null)?.eva?.start_utc
  return typeof v === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(v) ? v : null
}

/** clock.json eva.msl_sol (WS4), or null. */
export function mslSolOf(clock: unknown): number | null {
  const v = (clock as { eva?: { msl_sol?: unknown } } | null)?.eva?.msl_sol
  return typeof v === 'number' && Number.isInteger(v) ? v : null
}

/** clock.json eva.start_lmst (WS4), or null. */
export function evaStartLmstOf(clock: unknown): string | null {
  const v = (clock as { eva?: { start_lmst?: unknown } } | null)?.eva?.start_lmst
  return typeof v === 'string' && /^[0-9]{2}:[0-9]{2}:[0-9]{2}$/.test(v) ? v : null
}

/** clock.json eva.t_dark_min (WS4), or null. */
export function tDarkOf(clock: unknown): number | null {
  const v = (clock as { eva?: { t_dark_min?: unknown } } | null)?.eva?.t_dark_min
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

async function fetchBuf(path: string): Promise<ArrayBuffer> {
  const res = await fetch(dataUrl(path))
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return res.arrayBuffer()
}

/** Elevation of every cell centre of `g` from a height grid in the analysis CRS. */
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

export async function loadMissionData(scenarioId?: string, onStep?: (what: string) => void): Promise<MissionData> {
  const L = data()
  const step = (s: string) => onStep?.(s)
  step('scenarios and pad')
  const [idx, fiRaw, padFile, tilejson] = await Promise.all([L.scenarios(), L.fieldsIndex(), L.optional(() => L.pad()), L.optional(() => L.tilejson())])
  const sid = scenarioId ?? idx.default
  const scenario = idx.scenarios.find((s) => s.id === sid)
  if (!scenario) throw new Error(`scenario ${sid} not in scenarios/index.json`)
  const pad = padMarker(padFile, CONFIG.padDefault)
  // The HUD's view of the same file (adds the pointer entry's own grid and stencil, contracts v1.1.1).
  const fi = fiRaw as unknown as HudFieldsIndex

  const tKey = `${sid}/t_home`
  const oKey = `${sid}/o2_home`
  const pKey = `${sid}/pointer`
  if (!fi.fields[tKey]) throw new Error(`fields/index.json has no ${tKey}`)
  step('walk-home fields')
  const [tHome, o2Home, pointer] = await Promise.all([
    loadField(fi, tKey, dataUrl),
    fi.fields[oKey] ? loadField(fi, oKey, dataUrl) : Promise.resolve(null),
    fi.fields[pKey]?.stencil ? L.optional(() => loadPointer(fi, pKey, dataUrl)) : Promise.resolve(null),
  ])

  step('terrain heights')
  const fp = parseIndex(JSON.parse(new TextDecoder().decode(await fetchBuf('fp3d/index.json'))))
  const farBuf = await gunzipIfNeeded(await fetchBuf(fp.far.file))
  const [west, north] = farOrigin(fp)
  const heights = new HeightGrid(west, north, fp.far.res_m, fp.far.width, fp.far.height, decodeHeights(farBuf, fp.far.width, fp.far.height, codecOf(fp)))
  const eqc = parseEqc(fp.chunk_grid.crs)
  const elev = sampleElevation(tHome, heights, (lon, lat) => lonLatToXY(eqc, lon, lat))
  const passable = new Uint8Array(tHome.width * tHome.height)
  passable.set(tHome.data.known)

  step('reachable-area layers and conditions')
  const [bands, isochrones, edges, rad, clock] = await Promise.all([
    L.optional(() => L.bands(scenario)),
    L.optional(() => L.isochrones(scenario)),
    L.optional(() => L.edges(scenario)),
    L.optional(() => L.rad()),
    L.optional(() => L.clock()),
  ])

  return {
    scenario,
    scenarios: idx.scenarios,
    pad,
    tHome,
    o2Home,
    pointer,
    grid: { width: tHome.width, height: tHome.height, resM: tHome.resM, elev, passable },
    model: gradeModel(scenarioParams(sid)),
    tilejson,
    bands,
    isochrones,
    edges,
    files: {
      tHome: fi.fields[tKey].file,
      o2Home: fi.fields[oKey]?.file ?? null,
      pointer: pointer ? fi.fields[pKey].file : null,
      elevation: fp.far.file,
      bands: scenario.files.bands,
      isochrones: scenario.files.isochrones,
      edges: scenario.files.edges,
    },
    elevationResM: fp.far.res_m,
    rad,
    tDarkMin: tDarkOf(clock),
    padId: padFile ? (padFile.pad.id ?? null) : null,
    padKind: !padFile ? 'config_default' : citesD21(padFile.pad.source) ? 'official' : 'custom',
    padElevM: padFile && typeof padFile.pad.elev_m === 'number' ? padFile.pad.elev_m : null,
    evaStartLmst: evaStartLmstOf(clock),
    evaStartUtc: evaStartUtcOf(clock),
    mslSol: mslSolOf(clock),
  }
}
