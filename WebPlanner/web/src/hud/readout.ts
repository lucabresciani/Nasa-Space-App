// One HUD frame: every number the panel shows, from the position object (F19), field lookups
// and the plan. Lookups and arithmetic on looked-up values only (brief WS7 "Don't").
//
// Margin (D89, X2): the exact margin function, the same one the field draws (map/field/margin.ts,
// M3's port of WS2 physio_core.margin), with the same inputs as the field at the position and minute:
//   margin, binding = marginAt(resolveMarginInputs(t), T_home, O2_home)   (worst case within sigma)
//   inputs: O2 left and task O2 from the timeline at t, the D39 dose leash tau(t) (rad.json storm
//   series placed at t*; after the storm tripwire the dose budget left, as M12's tauOverride),
//   clock.json t_dark, the crew EVA length, the O2 reserve and rate (mission-state defaults).
//   After the return (crew back at the pad; playback / drift, not a dragged spot) the margin and its
//   binding are held at their value at arrival and no alarm fires (user decision, X2).
//   turn-back in = margin (standing still, the clock terms fall one minute per minute).
// Without margin inputs in the context (ctx.margin unset: dummy tree, callers with their own context)
// the old reading stays (assumption A-WS7-3): margin = H(t) - T_home, H = timeline margin_min +
// t_home_min interpolated in t; binding = the timeline row in force (D28, contract v1.1.3).
import { DoseTiming, marginAt, PlanTimeline, resolveMarginInputs, type RadStorm, type TimelineRow } from '../map/field/margin'
import { evaluateAlarm, marginBand, type Alarm } from './alarms'
import { vSafeAt, type HudConfig } from './config'
import type { FieldGrid } from './fields'
import type { Plan } from './plan'
import type { Binding, HudPosition, LonLat, PolygonFC, Rad } from './types'

/** Inputs of the exact margin function (D89) that the plan and the HUD position do not carry. */
export interface HudMarginInputs {
  /** the flown plan's timeline: O2 left, task O2 still to do, t* (map/field/margin.ts) */
  timeline: PlanTimeline
  /** D39 dose leash tau(t) (rad.json storm series placed at t*); null = dose term left out */
  dose: DoseTiming | null
  dAllowMgy: number // mission.budgets.doseAllowMgy (conditions.yaml leash.d_allow_mgy)
  reserveL: number // mission.budgets.o2ReserveL (D24)
  tDarkMin: number | null // conditions/clock.json eva.t_dark_min; null = daylight term left out
  tEvaMin: number // crew.yaml eva_h x 60
}

/** Build the margin inputs as map/field/drive.ts does for the field (same files, same rules). */
export function hudMarginInputs(plan: Plan, rad: Rad | null, tDarkMin: number | null | undefined, cfg: HudConfig, budgets: { reserveL: number; dAllowMgy: number }): HudMarginInputs {
  const timeline = new PlanTimeline(plan.events as unknown as TimelineRow[])
  const dose = rad && timeline.tStarMin !== null ? DoseTiming.fromRad(rad as unknown as RadStorm, timeline.tStarMin) : null
  return { timeline, dose, dAllowMgy: budgets.dAllowMgy, reserveL: budgets.reserveL, tDarkMin: typeof tDarkMin === 'number' ? tDarkMin : null, tEvaMin: cfg.evaMin }
}

export interface HudFields {
  tHome: FieldGrid // nominal T_home of the active scenario
  tHomeCons?: FieldGrid // conservative variant, same suit mass
  o2Home?: FieldGrid
  homeBearing?: FieldGrid
  slope?: FieldGrid
  /** worst-case fields by radius (m), nominal 104 kg only (F19) */
  worst?: Map<number, { tHome?: FieldGrid; o2Home?: FieldGrid }>
}

export interface HudContext {
  cfg: HudConfig
  fields: HudFields
  plan: Plan
  budgetMin: number // homeline budget for the circle test (crew.yaml walkback_budgets_min)
  pad: LonLat
  partner?: PolygonFC | null
  /** storm switch: tripwire state on the EVA clock and tau_dose; absent = never fires */
  radiation?: { tripwireFired: boolean; tauDoseMin: number | null }
  /** inputs of the exact margin function (D89); absent = the timeline headroom reading (A-WS7-3) */
  margin?: HudMarginInputs
}

export interface Readout {
  t: number
  tHomeMin: number | null
  tHomeConsMin: number | null
  worstRadiusM: number | null // 0 = point value; null = sigma beyond the largest radius
  marginMin: number | null
  turnBackInMin: number | null
  o2LeftL: number | null
  o2NeededL: number | null
  bearingDeg: number | null
  distanceM: number
  slopeDeg: number | null
  vSafeMs: number | null
  outsidePartner: boolean | null
  circleCrossesHomeline: boolean
  nextStation: { station: string; etaMin: number } | null
  band: 'green' | 'amber' | 'red' | 'unknown'
  alarm: Alarm | null
  /** binding term of the margin (exact function; else the timeline row in force; undefined = timeline has none) */
  binding: Binding | undefined
  /** how the margin was computed: 'exact' (D89), 'held' (after the return, value at arrival), 'timeline' (A-WS7-3) */
  marginSource: 'exact' | 'held' | 'timeline'
  /** during a station dwell: WS2's turn_back row for that station (latest leave, binding; D28) */
  latestLeave: { station: string; t_min: number; binding: Binding } | null
}

/** Smallest precomputed radius >= sigma (F19); 0 for an exact position; null if none is large enough. */
export function pickWorstRadius(sigmaM: number, radiiM: readonly number[]): number | null {
  if (!(sigmaM > 0)) return 0
  for (const r of [...radiiM].sort((a, b) => a - b)) if (r >= sigmaM) return r
  return null
}

/**
 * Does the uncertainty circle reach past the homeline? True when a reachable pixel within sigma
 * has T_home > budget, or when nothing is known there (disc off the grid / no reachable pixel).
 */
export function circleCrossesHomeline(tHome: FieldGrid, lon: number, lat: number, sigmaM: number, budgetMin: number): boolean {
  if (!(sigmaM > 0)) return false
  const m = tHome.discMax(lon, lat, sigmaM)
  return m === null || m > budgetMin
}

function ringContains(ring: number[][], x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Point in any polygon of a FeatureCollection (holes respected). */
export function insidePolygons(fc: PolygonFC, lon: number, lat: number): boolean {
  for (const f of fc.features) {
    const polys = (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates) as number[][][][]
    for (const poly of polys) {
      if (!poly.length || !ringContains(poly[0], lon, lat)) continue
      if (!poly.slice(1).some((hole) => ringContains(hole, lon, lat))) return true
    }
  }
  return false
}

export function computeReadout(pos: HudPosition, ctx: HudContext): Readout {
  const { cfg, fields, plan } = ctx
  const { lon, lat } = pos
  const r = pickWorstRadius(pos.sigma_m, cfg.worstCaseRadiiM)
  const worst = r && r > 0 ? fields.worst?.get(r) : undefined
  let tHome: number | null
  let o2Need: number | null
  if (r === 0) {
    tHome = fields.tHome.valueAt(lon, lat)
    o2Need = fields.o2Home?.valueAt(lon, lat) ?? null
  } else {
    // sigma > 0: only a precomputed worst case is honest; missing -> unknown
    tHome = worst?.tHome?.valueAt(lon, lat) ?? null
    o2Need = worst?.o2Home?.valueAt(lon, lat) ?? null
  }
  const exact = ctx.margin ? exactMargin(ctx, ctx.margin, pos, tHome, o2Need) : null
  let margin: number | null
  let binding: Binding | undefined
  if (exact) {
    margin = exact.margin
    binding = exact.binding
  } else {
    const H = plan.headroomAt(pos.t_eva_min)
    margin = H !== null && tHome !== null ? H - tHome : null
    binding = plan.bindingAt(pos.t_eva_min)
  }
  const held = exact?.held === true
  const crosses = circleCrossesHomeline(fields.tHome, lon, lat, pos.sigma_m, ctx.budgetMin)
  const outside = ctx.partner ? !insidePolygons(ctx.partner, lon, lat) : null
  const slope = fields.slope?.valueAt(lon, lat) ?? null
  const next = plan.nextArrival(pos.t_eva_min)
  const rad = ctx.radiation ?? { tripwireFired: false, tauDoseMin: null }
  // back at the pad (held): no alarm (user decision, X2)
  const alarm = held ? null : evaluateAlarm(
    { marginMin: margin, tripwireFired: rad.tripwireFired, tHomeMin: tHome, tauDoseMin: rad.tauDoseMin, circleCrossesHomeline: crosses, outsidePartner: outside },
    cfg.marginAmberMin,
  )
  return {
    t: pos.t_eva_min,
    tHomeMin: tHome,
    tHomeConsMin: fields.tHomeCons?.valueAt(lon, lat) ?? null,
    worstRadiusM: r,
    marginMin: margin,
    turnBackInMin: margin,
    o2LeftL: plan.o2LeftAt(pos.t_eva_min),
    o2NeededL: o2Need,
    bearingDeg: fields.homeBearing?.valueAt(lon, lat) ?? null,
    distanceM: fields.tHome.distanceM([lon, lat], ctx.pad),
    slopeDeg: slope,
    vSafeMs: slope === null ? null : vSafeAt(cfg, slope),
    outsidePartner: outside,
    circleCrossesHomeline: crosses,
    nextStation: next ? { station: next.station, etaMin: next.t_min - pos.t_eva_min } : null,
    band: marginBand(margin, cfg.marginAmberMin),
    alarm,
    binding,
    marginSource: exact ? (held ? 'held' : 'exact') : 'timeline',
    latestLeave: latestLeaveAt(plan, pos),
  }
}

/** EVA minute the crew is back at the pad (end of the last walk leg); null = no route. */
function returnMin(plan: Plan): number | null {
  return plan.legs.length ? plan.legs[plan.legs.length - 1].t1 : null
}

/**
 * The exact margin (D89) at the position: map/field/margin.ts marginAt with the field's inputs at t.
 * null = no O2 figure in the timeline (then the caller keeps the timeline reading). After the
 * return (not for a dragged spot) the clock is held at the arrival minute: the storm budget left is
 * taken back to that minute along hud/storm.ts's countdown (one minute per minute after the tripwire,
 * which fires at t* <= the return).
 */
function exactMargin(ctx: HudContext, m: HudMarginInputs, pos: HudPosition, tHome: number | null, o2Home: number | null): { margin: number | null; binding: Binding; held: boolean } | null {
  const tRet = returnMin(ctx.plan)
  const held = tRet !== null && pos.source !== 'drag' && pos.t_eva_min > tRet
  const t = held ? (tRet as number) : pos.t_eva_min
  const rad = ctx.radiation
  const tauOverride = rad?.tripwireFired && rad.tauDoseMin !== null ? rad.tauDoseMin + (pos.t_eva_min - t) : undefined
  const inp = resolveMarginInputs(
    { t, tDark: m.tDarkMin ?? undefined, tauDose: tauOverride, tEva: m.tEvaMin, o2Left: undefined, reserve: m.reserveL },
    { timeline: m.timeline, dose: m.dose, dAllowMgy: m.dAllowMgy },
  )
  if (!inp) return null
  if (tHome === null || o2Home === null) return { margin: null, binding: null, held }
  const r = marginAt(inp, tHome, o2Home)
  return { margin: r.margin, binding: r.binding, held }
}

/** The dwell station's turn_back row (playback / drift on the route only; not for a dragged spot). */
function latestLeaveAt(plan: Plan, pos: HudPosition): Readout['latestLeave'] {
  if (pos.source === 'drag') return null
  const s = plan.stateAt(pos.t_eva_min)
  return s.phase === 'dwell' && s.station ? plan.turnBackAt(s.station) : null
}

/** Playback position (F19 source "playback"): on the planned route, sigma 0. */
export function playbackPosition(plan: Plan, t: number): HudPosition {
  const s = plan.stateAt(t)
  return { lon: s.lon, lat: s.lat, sigma_m: 0, source: 'playback', t_eva_min: t, last_fix: null }
}
