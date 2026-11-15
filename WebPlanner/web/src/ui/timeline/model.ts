// Timeline dock model (DESIGN U5; WS15 task 7, package A7). Pure: turns the published files into what
// the dock draws, with every position taken from a stored value (no interpolation into new numbers):
//   timeline_{scenario}.json  dwell blocks (arrive -> leave), turn-back markers (turn_back rows),
//                             O2 checkpoints, the margin curve and its binding term (margin_min,
//                             margin_binding at each row)
//   conditions/rad.json       storm window and tripwire, placed on the EVA clock by the shared D39
//                             rule (hud/storm.ts: tripwire at the route's largest T_home; "hypothetical timing")
//   conditions/clock.json     daylight end (eva.t_dark_min)
// The margin curve is the published rows joined by straight lines. Between rows the true margin is
// not published (notes/M3.md: it can differ from a straight line), so the dock marks every row and
// reads numbers only at rows.
import { evaMinOf, stormReplay } from '../../hud/storm'
import type { Rad } from '../../hud/types'
import type { Binding } from '../../map/field/margin'

export interface TimelineFileRow {
  t_min: number
  event: string
  station: string | null
  margin_min?: number | null
  margin_binding?: string | null
  t_home_min?: number | null
}

/** A row of the timeline file with its index in the file (the manifest key is timeline.{scenario}.{i}.*). */
export interface Row {
  i: number
  t: number
  event: string
  station: string | null
  margin: number | null
  binding: Binding | null
}

export interface Dwell {
  station: string
  t0: number
  t1: number
  /** file indices of the arrive and leave rows */
  i0: number
  i1: number
}

export interface Marker {
  t: number
  i: number
  station: string | null
}

export interface BindingRun {
  binding: Binding
  t0: number
  t1: number
}

export interface StormWindow {
  /** EVA minutes of onset, tripwire (t*) and window end; the window is drawn clipped to the axis */
  onset: number | null
  tripwire: number
  end: number | null
  halfwidthLabel: string | null
}

export interface TimelineModel {
  scenario: string
  file: string
  tMax: number
  /** flown rows (turn_back annotations excluded), in time order */
  rows: Row[]
  dwells: Dwell[]
  turnBacks: Marker[]
  checkpoints: Marker[]
  /** rows with a margin value: the curve's vertices */
  curve: Row[]
  /** runs of consecutive curve rows with the same binding term; a change between two rows is a gap */
  bindingRuns: BindingRun[]
  storm: StormWindow | null
  daylightEnd: number | null
  /** y domain of the margin curve (min) */
  yMin: number
  yMax: number
}

const BINDINGS: readonly string[] = ['O2', 'daylight', 'dose', 'EVA duration']
const asBinding = (b: string | null | undefined): Binding | null => (b && BINDINGS.includes(b) ? (b as Binding) : null)

/** turn_back rows are annotations (latest start home per station), not steps of the walk (hud/plan.ts). */
const ANNOTATION = 'turn_back'

export interface ModelInputs {
  scenario: string
  timeline: readonly TimelineFileRow[]
  tMax: number
  rad?: Rad | null
  tDarkMin?: number | null
}

export function buildTimelineModel({ scenario, timeline, tMax, rad, tDarkMin }: ModelInputs): TimelineModel {
  const all: Row[] = timeline.map((r, i) => ({
    i,
    t: r.t_min,
    event: r.event,
    station: r.station,
    margin: r.margin_min ?? null,
    binding: asBinding(r.margin_binding),
  }))
  const rows = all.filter((r) => r.event !== ANNOTATION).sort((a, b) => a.t - b.t || a.i - b.i)
  const turnBacks = all.filter((r) => r.event === ANNOTATION).map((r) => ({ t: r.t, i: r.i, station: r.station }))
  const checkpoints = rows.filter((r) => r.event === 'o2_checkpoint').map((r) => ({ t: r.t, i: r.i, station: null }))

  const dwells: Dwell[] = []
  let open: Row | null = null
  for (const r of rows) {
    if (r.event === 'arrive') open = r
    else if (r.event === 'leave' && open && open.station === r.station && r.station) {
      dwells.push({
        station: r.station,
        t0: open.t,
        t1: r.t,
        i0: open.i,
        i1: r.i,
      })
      open = null
    }
  }

  const curve = rows.filter((r) => r.margin !== null)
  const bindingRuns: BindingRun[] = []
  for (let k = 0; k < curve.length; k++) {
    const r = curve[k]
    const prev = curve[k - 1]
    const run = bindingRuns[bindingRuns.length - 1]
    if (r.binding && prev && prev.binding === r.binding && run && run.binding === r.binding && run.t1 === prev.t) run.t1 = r.t
    else if (r.binding) bindingRuns.push({ binding: r.binding, t0: r.t, t1: r.t })
  }

  // D39 storm placement: the HUD's own function on the same rows (t* = largest T_home, first on a tie)
  let storm: StormWindow | null = null
  const walk = timeline.filter((r) => r.event !== ANNOTATION)
  const rep = rad
    ? stormReplay(
        rad,
        walk.map((r) => r.t_min),
        walk.map((r) => r.t_home_min ?? null),
      )
    : null
  if (rep && rad?.storm_2024?.tripwire_utc) {
    const trip = Date.parse(rad.storm_2024.tripwire_utc)
    const endIso = (rad.storm_2024 as { end_utc?: string | null }).end_utc
    const end = endIso ? evaMinOf(Date.parse(endIso), trip, rep.tripwireEvaMin) : null
    storm = {
      onset: rep.onsetEvaMin,
      tripwire: rep.tripwireEvaMin,
      end: end !== null && Number.isFinite(end) ? end : null,
      halfwidthLabel: rep.halfwidthLabel,
    }
  }

  const ms = curve.map((r) => r.margin as number)
  const yMin = Math.min(0, ...ms)
  const yMax = Math.max(0, ...ms)
  return {
    scenario,
    file: `timeline_${scenario}.json`,
    tMax,
    rows,
    dwells,
    turnBacks,
    checkpoints,
    curve,
    bindingRuns,
    storm,
    daylightEnd: typeof tDarkMin === 'number' && Number.isFinite(tDarkMin) ? tDarkMin : null,
    yMin,
    yMax: yMax > yMin ? yMax : yMin + 1,
  }
}

/** The last curve row at or before t (the margin the dock reads out); null before the first row. */
export function rowAt(m: TimelineModel, t: number): Row | null {
  let best: Row | null = null
  for (const r of m.curve) {
    if (r.t <= t + 1e-9) best = r
    else break
  }
  return best
}

/** The next turn-back at or after t (earliest first); null when every turn-back has passed. */
export function nextTurnBack(m: TimelineModel, t: number): Marker | null {
  let best: Marker | null = null
  for (const r of m.turnBacks) if (r.t >= t - 1e-9 && (!best || r.t < best.t)) best = r
  return best
}

/** The dwell the crew is in at t, if any. */
export function dwellAt(m: TimelineModel, t: number): Dwell | null {
  return m.dwells.find((d) => d.t0 <= t && t < d.t1) ?? null
}

/** "02:30" for 150 min (DESIGN §3.8 "02:30 EVA"). */
export function fmtEva(min: number): string {
  const m = Math.max(0, Math.floor(min + 1e-9))
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** copy.json binding.* key of a WS2 binding term. */
export const BINDING_COPY: Record<Binding, 'binding.oxygen' | 'binding.daylight' | 'binding.dose' | 'binding.evaDuration'> = {
  O2: 'binding.oxygen',
  daylight: 'binding.daylight',
  dose: 'binding.dose',
  'EVA duration': 'binding.evaDuration',
}
