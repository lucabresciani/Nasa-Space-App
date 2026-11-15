// Labels and small readers for the decisions since session 5 (SPEC §11 D21–D39 and set A of
// D40–D47). Structure only: every number shown still goes through <Num> with its manifest key.
import { CITED, CONFIG } from '../config'
import { isEntry } from '../prov/provenance'
import type { Card, Manifest, Station, TimelineEvent } from '../data/types'

export const MARGIN_LABEL: Record<string, string> = { O2: 'oxygen', daylight: 'daylight', dose: 'radiation dose', 'EVA duration': 'EVA duration' }

/** Binding margin term for display; null = the station has no route (contract v1.1.1). D28 adds "EVA duration". */
export function marginLabel(b: string | null | undefined): string {
  if (b === null) return 'none: no route to this station'
  if (b === undefined || b === '') return 'unknown'
  return MARGIN_LABEL[b] ?? b
}

/** D47 / D39: the storm is placed on the EVA clock so its tripwire fires where time home is largest. */
export const STORM_TIMING_NOTE = 'hypothetical storm timing (tripwire placed where time home is largest)'

/** D45: the route DP's O₂ rule (the rate is passed in, derived from config). */
export function planningRuleNote(rate: string): string {
  return `Route planning counts O₂ before each leg at the effort-cap rate (${rate}), a conservative rule; the HUD and timeline show the modelled use.`
}

/** D45: what the excluded-combination count is. */
export const EXCLUDED_NOTE =
  'station combinations that fit the EVA by walking time but fail the full margin check: an upper bound for what the conservative O₂ planning rule excludes (D45; the count also holds the daylight / EVA-duration checks)'

export interface TurnBack {
  /** Row index in the timeline file (manifest key timeline.{sid}.{i}.*). */
  i: number
  station: string | null
  t_min: number
  binding: string | null
}

/** D28: the timeline's `turn_back` rows (latest departure per station) with their binding term. */
export function turnBacks(tl: TimelineEvent[] | null | undefined): TurnBack[] {
  return (tl ?? []).flatMap((e, i) => (e.event === 'turn_back' ? [{ i, station: e.station, t_min: e.t_min, binding: e.margin_binding ?? null }] : []))
}

/** D47: the lowest margin on the route (turn-back rows sit at 0 by definition and are left out). */
export function tightestMargin(tl: TimelineEvent[] | null | undefined): { i: number; e: TimelineEvent; dose: boolean } | null {
  let best: { i: number; e: TimelineEvent } | null = null
  ;(tl ?? []).forEach((e, i) => {
    if (e.event === 'turn_back' || typeof e.margin_min !== 'number') return
    if (!best || e.margin_min < best.e.margin_min!) best = { i, e }
  })
  if (!best) return null
  const b = best as { i: number; e: TimelineEvent }
  return { ...b, dose: b.e.margin_binding === 'dose' }
}

export interface Headline60 {
  budget: number
  reachablePct: number | null
  range: [number | null, number | null] | null
  /** Share of the 60-min flat circle inside the terrain data (D43). */
  inDataPct: number | null
  /** The share is over the part inside the data (basis "in_data"). */
  inData: boolean
}

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** D43: scenarios/index.json `headline_60` (WS2 session 8); null on trees without it. */
export function headline60(entry: { headline_60?: unknown }): Headline60 | null {
  const h = entry.headline_60
  if (!h || typeof h !== 'object') return null
  const o = h as Record<string, unknown>
  const r = Array.isArray(o.range_pct) && o.range_pct.length === 2 ? ([n(o.range_pct[0]), n(o.range_pct[1])] as [number | null, number | null]) : null
  return { budget: n(o.budget_min) ?? 60, reachablePct: n(o.reachable_pct), range: r, inDataPct: n(o.in_data_pct), inData: o.basis === 'in_data' }
}

/** D44: full name (as written, with the compass suffix), plus base and suffix when WS1 wrote them. */
export function stationNameParts(s: Station): { full: string; base: string; suffix: string | null } {
  const sx = s.name_suffix
  const suffix = sx && typeof sx === 'object' ? [sx.compass, sx.distance_rank].filter((x): x is string => typeof x === 'string' && !!x).join(', ') || null : null
  return { full: s.name, base: typeof s.name_base === 'string' && s.name_base ? s.name_base : s.name, suffix }
}

export type HomeView = { kind: 'time'; v: number } | { kind: 'unreachable'; label: string; reason: string | null } | { kind: 'unknown' }

/** D26 / D46: a null walk home is "not reachable on foot" (config label), shown with WS2's reason. */
export function homeFor(s: Station, scenarioId: string): HomeView {
  if (!(scenarioId in s.t_home_min)) return { kind: 'unknown' }
  const v = s.t_home_min[scenarioId]
  if (typeof v === 'number') return { kind: 'time', v }
  return { kind: 'unreachable', label: CITED.unreachableLabel.value, reason: s.access?.[scenarioId]?.reason ?? null }
}

export type Landmark = Card['landmarks'][number]

/** D33: a landmark below the computed skyline (bearing-only tick). */
export function isHiddenLandmark(lm: Landmark): boolean {
  return lm.display === 'bearing_tick' || (lm.display === undefined && lm.above_skyline === false)
}

/** D33: "below skyline" for hidden landmarks; replaces the stale "(within 5 km, below the skyline)". */
export function landmarkNote(lm: Landmark): string | null {
  return isHiddenLandmark(lm) ? 'below skyline' : null
}

/** End points of a compass tick at `bearing` (deg from north, clockwise) between radii r0 and r0 + len. */
export function compassTick(bearing: number, c: number, r0: number, len: number): [[number, number], [number, number]] {
  const a = (bearing * Math.PI) / 180
  const p = (r: number): [number, number] => [c + r * Math.sin(a), c - r * Math.cos(a)]
  return [p(r0), p(r0 + len)]
}

export interface Ist2Row {
  variant: string
  grade: number
  pass: boolean | null
  bandLo: number | null
  bandHi: number | null
  reported: number | null
  keyPrefix: string
  file: string
}

/** D30: IST-2 pass/miss per variant and grade, read from the manifest keys physio.ist2.{variant}.{grade}.* (WS2). */
export function ist2Rows(m: Manifest | null | undefined): Ist2Row[] {
  if (!m) return []
  const rows = new Map<string, Ist2Row>()
  for (const [k, e] of Object.entries(m)) {
    const mm = /^physio\.ist2\.([^.]+)\.(\d+)\.(pass|band_lo|band_hi|reported)$/.exec(k)
    if (!mm || !isEntry(e)) continue
    const [, variant, g, f] = mm
    const id = `${variant}.${g}`
    let r = rows.get(id)
    if (!r) rows.set(id, (r = { variant, grade: +g, pass: null, bandLo: null, bandHi: null, reported: null, keyPrefix: `physio.ist2.${id}`, file: e.file }))
    if (f === 'pass') r.pass = typeof e.value === 'boolean' ? e.value : null
    else if (f === 'band_lo') r.bandLo = n(e.value)
    else if (f === 'band_hi') r.bandHi = n(e.value)
    else r.reported = n(e.value)
  }
  const order = (v: string) => {
    const i = CONFIG.variantNames.indexOf(v)
    return i < 0 ? Infinity : i
  }
  return [...rows.values()].sort((a, b) => order(a.variant) - order(b.variant) || a.variant.localeCompare(b.variant) || a.grade - b.grade)
}
