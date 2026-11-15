// mission.json export (contracts/bundle/mission.schema.json, v1.1.0 draft): the Mission Planer's
// plan for the simulator. Pure: every planner number is passed in (legs from router.ts, totals
// from budget.ts, the margin from margin.ts) and only copied, converted to the pad-local frame
// (contracts/bundle/README.md: analysis-projection metres minus the pad's, z = areoid - pad
// elevation) and rounded. Nothing is recomputed except running sums along the legs. Unknown = null.
import { lonLatToXY, parseEqc } from './heights'
import type { MissionBudget } from './budget'
import type { Rad } from '../data/types'
import { doseTimingFromRad, type MarginProfile, type Term } from './margin'
import type { LonLat, Waypoint } from './plan'
import type { Leg } from './router'

export const MISSION_SCHEMA_VERSION = '1.1.0'
export const ORIGIN_LABEL = 'Mission Planer: browser estimate on the 5 m grid, not part of the validated scorecard'

export interface HomeValues {
  tHomeMin: number | null
  o2HomeL: number | null
}

export interface MissionExportInput {
  title?: string
  proj: string
  pad: { kind: 'official' | 'custom' | 'config_default'; id: string | null; lon: number; lat: number; elevM: number | null; source: string }
  scenario: { id: string; variant: string; suit_kg: number }
  planner: { gridResM: number; elevationResM: number; files: Record<string, string | null>; appCommit?: string | null; configHash?: string | null }
  constants: { o2CapacityL: number; effortRateLMin: number; stationRateLMin: number; reserveL: number; evaLimitMin: number; marginAmberMin: number }
  conditions: {
    evaStartLmst: string | null
    tDarkMin: number | null
    storm: boolean
    /** EVA start instant (clock.json eva.start_utc) and MSL sol; optional for older callers */
    evaStartUtc?: string | null
    mslSol?: number | null
    /** WS4 rad.json: the D39 storm series, exported on the EVA clock when the storm switch is on */
    rad?: Rad | null
  }
  wps: Waypoint[]
  legs: (Leg | null)[]
  /** WS2 pointer path from the last waypoint to the pad (first point = the waypoint), or null */
  homePath: LonLat[] | null
  homeReachesPad: boolean
  budget: MissionBudget
  margin: MarginProfile | null
  /** routing-grid cell -> centre lon/lat */
  cellLonLat: (cell: number) => LonLat
  /** areoid height (m) under a point, null = unknown */
  elevAt: (lon: number, lat: number) => number | null
  /** WS2 T_home / O2_home at a point (nearest cell) */
  homeAt: (lon: number, lat: number) => HomeValues
  label: string
  dummy: boolean
}

type Num = number | null
const r = (v: Num | undefined, d: number): Num => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d)
const add = (a: Num, b: Num): Num => (a === null || b === null ? null : a + b)

/** D39 storm series on the EVA clock (margin.ts doseTimingFromRad at this mission's t*), or null when the storm is off. */
function doseBlock(inp: MissionExportInput, m: MarginProfile | null): Record<string, unknown> | null {
  if (!inp.conditions.storm || !m?.dose || !inp.conditions.rad) return null
  const dt = doseTimingFromRad(m.dose.tStarMin, inp.conditions.rad)
  return {
    d_allow_mgy: dt.dAllowMgy,
    series: dt.evaMin.map((t, i) => [r(t, 3), r(dt.rateMgyH[i], 6)]),
    source: dt.source,
  }
}

/** The mission document without mission_id / created_utc (see finalizeMission). */
export function buildMission(inp: MissionExportInput): Record<string, unknown> {
  const eqc = parseEqc(inp.proj)
  const [px, py] = lonLatToXY(eqc, inp.pad.lon, inp.pad.lat)
  const local = (lon: number, lat: number) => {
    const [x, y] = lonLatToXY(eqc, lon, lat)
    const h = inp.elevAt(lon, lat)
    return { x: x - px, y: y - py, z: h === null || inp.pad.elevM === null ? null : h - inp.pad.elevM }
  }
  const sr = inp.constants.stationRateLMin
  const n = inp.wps.length

  const rows: Num[][] = []
  const legsOut: Record<string, unknown>[] = []
  const wpsOut: Record<string, unknown>[] = []
  let t: Num = 0
  let o2: Num = 0

  const pushRows = (leg: number, pts: LonLat[], tAt: (k: number) => Num, o2At: (k: number) => Num, hv: HomeValues[]) => {
    const first = rows.length
    let s = 0
    let prev: { x: number; y: number } | null = null
    pts.forEach(([lon, lat], k) => {
      const p = local(lon, lat)
      if (prev) s += Math.hypot(p.x - prev.x, p.y - prev.y)
      prev = p
      rows.push([leg, r(s, 2), r(p.x, 2), r(p.y, 2), r(p.z, 2), r(tAt(k), 3), r(o2At(k), 3), r(hv[k].tHomeMin, 2), r(hv[k].o2HomeL, 3)])
    })
    return { first, n: pts.length, s }
  }

  for (let i = 0; i < n; i++) {
    const w = inp.wps[i]
    const l = inp.legs[i] ?? null
    const from = i === 0 ? 'pad' : `wp${i}`
    const tStart = t
    const o2Start = o2
    let first: number | null = null
    let nRows = 0
    let lengthM: Num = null
    if (l) {
      const pts = l.cells.map(inp.cellLonLat)
      const hv = pts.map(([lon, lat]) => inp.homeAt(lon, lat))
      const res = pushRows(i + 1, pts, (k) => add(tStart, l.tauS[k] / 60), (k) => add(o2Start, l.o2CumL[k]), hv)
      first = res.first
      nRows = res.n
      lengthM = l.distM
    }
    t = l ? add(t, l.timeS / 60) : null
    o2 = l ? add(o2, l.o2L) : null
    legsOut.push({ leg: i + 1, kind: 'out', from, to: `wp${i + 1}`, routed: !!l, length_m: r(lengthM, 2), time_min: r(l ? l.timeS / 60 : null, 3), o2_l: r(l ? l.o2L : null, 3), t_start_min: r(tStart, 3), t_end_min: r(t, 3), first_row: first, n_rows: nRows })
    const arrive = t
    t = add(t, w.stopMin)
    o2 = add(o2, w.stopMin * sr)
    const p = local(w.lon, w.lat)
    const hv = inp.homeAt(w.lon, w.lat)
    wpsOut.push({
      index: i + 1,
      id: w.id,
      lonlat: [w.lon, w.lat],
      x_m: r(p.x, 2),
      y_m: r(p.y, 2),
      z_m: r(p.z, 2),
      note: w.note,
      tags: w.tags,
      stop_min: w.stopMin,
      arrive_t_min: r(arrive, 3),
      leave_t_min: r(t, 3),
      o2_used_at_leave_l: r(o2, 3),
      t_home_min: r(hv.tHomeMin, 2),
      o2_home_l: r(hv.o2HomeL, 3),
    })
  }

  if (n > 0) {
    const tLeave = t
    const o2Leave = o2
    const b = inp.budget
    let first: number | null = null
    let nRows = 0
    let lengthM: Num = null
    const routed = !!inp.homePath && inp.homePath.length > 1 && inp.homeReachesPad
    if (inp.homePath && inp.homePath.length > 1) {
      const pts = inp.homePath
      const hv = pts.map(([lon, lat]) => inp.homeAt(lon, lat))
      const t0 = hv[0].tHomeMin
      const o0 = hv[0].o2HomeL
      const res = pushRows(
        n + 1,
        pts,
        (k) => (t0 === null || hv[k].tHomeMin === null ? null : add(tLeave, t0 - hv[k].tHomeMin!)),
        (k) => (o0 === null || hv[k].o2HomeL === null ? null : add(o2Leave, o0 - hv[k].o2HomeL!)),
        hv,
      )
      first = res.first
      nRows = res.n
      lengthM = res.s
    }
    legsOut.push({
      leg: n + 1,
      kind: 'home',
      from: `wp${n}`,
      to: 'pad',
      routed,
      length_m: r(lengthM, 2),
      time_min: r(b.tHomeMin, 3),
      o2_l: r(b.o2HomeL, 3),
      t_start_min: r(tLeave, 3),
      t_end_min: r(add(tLeave, b.tHomeMin), 3),
      first_row: first,
      n_rows: nRows,
    })
  }

  const m = inp.margin
  const timeline = m
    ? {
        columns: ['t_min', 'phase', 'wp', 'o2_used_l', 't_home_min', 'o2_home_l', 'tasks_left_l', 'margin_min', 'binding'],
        phases: { depart: 't = 0 at the pad', walk: 'a route vertex', arrive: 'at waypoint wp, stop starts', stop: 'inside a stop (dose candidate)', leave: 'stop over', home: 'inside the walk home (dose candidate)', return: 'back at the pad' },
        terms: m.terms,
        rows: m.points.map((p) => [r(p.tMin, 3), p.phase, p.wp === null ? null : p.wp + 1, r(p.o2UsedL, 3), r(p.tHomeMin, 2), r(p.o2HomeL, 3), r(p.tasksLeftL, 3), r(p.marginMin, 2), p.binding as Term]),
        lowest: { margin_min: r(m.lowest.marginMin, 2), binding: m.lowest.binding, t_min: r(m.lowest.tMin, 3) },
      }
    : null

  const b = inp.budget
  const checks = [m?.lowest.marginMin ?? null, b.timeMarginMin, b.o2MarginL]
  const feasible = n === 0 || !b.legsKnown ? (n === 0 ? null : false) : checks.some((v) => v === null) ? null : checks.every((v) => v! >= 0)

  return {
    schema_version: MISSION_SCHEMA_VERSION,
    kind: 'homeline_mission',
    mission_id: '',
    title: inp.title ?? `Mission · ${n} waypoint${n === 1 ? '' : 's'} · ${inp.scenario.id}`,
    created_utc: '',
    origin: 'mission_planer',
    origin_label: ORIGIN_LABEL,
    planner: {
      app_commit: inp.planner.appCommit ?? null,
      config_hash: inp.planner.configHash ?? null,
      routing_grid_res_m: inp.planner.gridResM,
      elevation_res_m: inp.planner.elevationResM,
      files: inp.planner.files,
    },
    frame: {
      kind: 'pad-local',
      axes: { x: 'east', y: 'north', z: 'up' },
      projection: { proj: inp.proj, pad_xy_m: [r(px, 4), r(py, 4)] },
      pad: { kind: inp.pad.kind, id: inp.pad.id, lon: inp.pad.lon, lat: inp.pad.lat, elev_m: inp.pad.elevM, source: inp.pad.source },
    },
    scenario: inp.scenario,
    world: { version: null, plan_bundle_id: inp.pad.kind === 'official' && inp.pad.id ? `${inp.pad.id}.${inp.scenario.id}` : null },
    constants: {
      o2_capacity_l: r(inp.constants.o2CapacityL, 4),
      effort_rate_l_min: r(inp.constants.effortRateLMin, 5),
      station_rate_l_min: r(inp.constants.stationRateLMin, 5),
      reserve_l: r(inp.constants.reserveL, 4),
      eva_limit_min: inp.constants.evaLimitMin,
      margin_amber_min: inp.constants.marginAmberMin,
    },
    conditions: {
      eva_start_lmst: inp.conditions.evaStartLmst,
      t_dark_min: inp.conditions.tDarkMin,
      storm_replay: inp.conditions.storm && !!m?.dose,
      t_star_min: m?.dose ? r(m.dose.tStarMin, 3) : null,
      eva_start_utc: inp.conditions.evaStartUtc ?? null,
      msl_sol: inp.conditions.mslSol ?? null,
      dose: doseBlock(inp, m),
    },
    waypoints: wpsOut,
    legs: legsOut,
    path: {
      columns: ['leg', 's_m', 'x_m', 'y_m', 'z_m', 't_eva_min', 'o2_used_l', 't_home_min', 'o2_home_l'],
      units: { s_m: 'm (horizontal arc length from the leg start)', x_m: 'm', y_m: 'm', z_m: 'm (pad-local)', t_eva_min: 'min since EVA start', o2_used_l: 'L since EVA start', t_home_min: 'min', o2_home_l: 'L' },
      rows,
    },
    timeline,
    summary: {
      feasible,
      walk_min: r(b.walkMin, 3),
      stop_min: b.stopMin,
      t_home_min: r(b.tHomeMin, 3),
      eva_min: r(b.evaMin, 3),
      time_margin_min: r(b.timeMarginMin, 3),
      o2_used_l: r(b.o2UsedL, 3),
      o2_home_l: r(b.o2HomeL, 3),
      o2_need_l: r(b.o2NeedL, 3),
      o2_margin_l: r(b.o2MarginL, 3),
      o2_margin_min: r(b.o2MarginMin, 3),
    },
    label: inp.label,
    dummy: inp.dummy,
  }
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Fill mission_id ('m-' + 12 hex of the sha256 of the doc without id and time) and created_utc. */
export async function finalizeMission(doc: Record<string, unknown>, now: Date = new Date()): Promise<Record<string, unknown>> {
  const id = `m-${(await sha256Hex(JSON.stringify({ ...doc, mission_id: '', created_utc: '' }))).slice(0, 12)}`
  return { ...doc, mission_id: id, created_utc: now.toISOString().replace(/\.\d{3}Z$/, 'Z') }
}

/** Save a JSON document as a file (browser download). */
export function downloadJson(doc: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
