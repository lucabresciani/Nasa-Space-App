// D21 "Rover parking options" (user 2026-11-14 16:14; C file layout 16:17). The official pad is the
// candidate with the most feasible EVAs (pad.json, existing paths). The picker offers the next
// candidates (+ pad_default if not chosen) at nominal 104 kg only:
//   scenarios/pads/index.json            ranking table incl. the official pad (rank, score = feasible-EVA
//                                        count, tiebreak values, official true/false)
//   scenarios/pads/{id}/summary.json     pad, rank, score, headline at 30 and 60 min, route summary
//   scenarios/pads/{id}/bands_{suit}.geojson, edges.geojson, partner.geojson,
//   scenarios/pads/{id}/route_{sid}.geojson, timeline_{sid}.json   (same shapes as the existing files)
// No isochrones for picker pads. Manifest keys pads.{id}.*. The index is optional: without it (or
// before C's contract rows cover it) the picker is hidden and the console works as before.
import { DataError, type Loader } from './loader'
import type { ScenarioEntry } from './types'

export const PADS_INDEX = 'scenarios/pads/index.json'

/**
 * The SCHEMA_MAP rows the picker needs (for C): pattern -> the existing pattern whose schema it
 * reuses, or null where C writes a new contract (index, summary).
 */
export const PAD_SCHEMA_PATTERNS: { pattern: string; shape: string | null }[] = [
  { pattern: 'scenarios/pads/index.json', shape: null },
  { pattern: 'scenarios/pads/*/summary.json', shape: null },
  { pattern: 'scenarios/pads/*/bands_*.geojson', shape: 'scenarios/bands_*.geojson' },
  { pattern: 'scenarios/pads/*/edges.geojson', shape: 'scenarios/*/edges.geojson' },
  { pattern: 'scenarios/pads/*/partner.geojson', shape: 'scenarios/*/partner.geojson' },
  { pattern: 'scenarios/pads/*/route_*.geojson', shape: 'route_*.geojson' },
  { pattern: 'scenarios/pads/*/timeline_*.json', shape: 'timeline_*.json' },
]

const ID_RE = /^[A-Za-z0-9_.-]+$/
function checkId(id: string): string {
  if (!ID_RE.test(id) || id === '.' || id === '..') throw new Error(`pad id "${id}" is not a plain file name`)
  return id
}

export interface PadFiles {
  summary: string
  bands: string
  edges: string
  partner: string
  route: string
  timeline: string
}

/** The files of one parking option; suit and scenario id from the default scenario (nominal, 104 kg). */
export function padFiles(id: string, nominal: ScenarioEntry): PadFiles {
  const d = `scenarios/pads/${checkId(id)}`
  return {
    summary: `${d}/summary.json`,
    bands: `${d}/bands_${nominal.suit_kg}.geojson`,
    edges: `${d}/edges.geojson`,
    partner: `${d}/partner.geojson`,
    route: `${d}/route_${nominal.id}.geojson`,
    timeline: `${d}/timeline_${nominal.id}.json`,
  }
}

/** Manifest key under pads.{id}.* (C 16:17). */
export function padKey(id: string, ...parts: (string | number)[]): string {
  return ['pads', id, ...parts].join('.')
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

export interface PadOption {
  id: string
  label: string
  lon: number | null
  lat: number | null
  elevM: number | null
  rank: number | null
  /** Feasible-EVA count (D21 score). */
  score: number | null
  official: boolean
  /** Tiebreak values as written: [name, value]. */
  tiebreak: [string, number | null][]
  /** D45 (WS2 session 8): screening count minus the full-run count (upper bound of what the effort-cap O₂ rule excludes). */
  excluded: number | null
  /** Screening count (walking time only, no margin check). */
  screenCount: number | null
}

/** `feasible` block of an index row or summary (WS2 session 8). */
function feasibleOf(r: Record<string, unknown>): { excluded: number | null; screenCount: number | null } {
  const f = obj(r.feasible)
  return { excluded: f ? num(f.excluded_by_effort_cap_rule) : null, screenCount: f ? num(f.screen_count) : null }
}

export interface PadsIndexView {
  official: PadOption
  /** Every row, by rank (the official pad included). */
  options: PadOption[]
}

function tiebreaks(r: Record<string, unknown>): [string, number | null][] {
  const t = obj(r.tiebreak)
  if (t) return Object.entries(t).filter(([, v]) => v === null || typeof v === 'number') as [string, number | null][]
  return Object.entries(r).filter(([k, v]) => k.startsWith('tiebreak') && (v === null || typeof v === 'number')) as [string, number | null][]
}

/** Reads scenarios/pads/index.json (rows under `pads`, or `rows`); throws when it cannot drive a picker. */
export function parsePadsIndex(raw: unknown): PadsIndexView {
  const o = obj(raw) ?? {}
  const rows = (Array.isArray(o.pads) ? o.pads : Array.isArray(o.rows) ? o.rows : []).map(obj).filter((r): r is Record<string, unknown> => !!r)
  if (!rows.length) throw new Error('no pad rows in scenarios/pads/index.json')
  const topOfficial = typeof o.official === 'string' ? o.official : null
  const options: PadOption[] = rows.map((r) => {
    if (typeof r.id !== 'string') throw new Error('a pad row has no id')
    const id = checkId(r.id)
    const official = r.official === true || (r.official === undefined && id === topOfficial)
    const rank = num(r.rank)
    return {
      id,
      label: typeof r.label === 'string' && r.label ? r.label : official ? 'Official pad' : id === 'pad_default' ? 'pad_default' : rank !== null ? `#${rank}` : id,
      lon: num(r.lon),
      lat: num(r.lat),
      elevM: num(r.elev_m),
      rank,
      score: num(r.score),
      official,
      tiebreak: tiebreaks(r),
      ...feasibleOf(r),
    }
  })
  options.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))
  const off = options.filter((x) => x.official)
  if (off.length !== 1) throw new Error(`scenarios/pads/index.json must mark exactly one official pad (found ${off.length})`)
  return { official: off[0], options }
}

export interface PadHeadline {
  budget: number
  reachablePct: number | null
  range: [number | null, number | null] | null
  /** D43: share of the flat circle inside the terrain data (null when not written). */
  inDataPct: number | null
  /** The share is over the part of the circle inside the data (basis "in_data"). */
  inData: boolean
}

export interface PadSummaryView {
  id: string
  rank: number | null
  score: number | null
  lon: number | null
  lat: number | null
  elevM: number | null
  headlines: PadHeadline[]
  route: { stops: string[] | null; totalMin: number | null } | null
  /** D45: excluded-combination count (WS2 session 8). */
  excluded: number | null
}

function headline(budget: number, h: Record<string, unknown>): PadHeadline {
  const r = Array.isArray(h.range_pct) && h.range_pct.length === 2 ? ([num(h.range_pct[0]), num(h.range_pct[1])] as [number | null, number | null]) : null
  return { budget, reachablePct: num(h.reachable_pct), range: r, inDataPct: num(h.in_data_pct), inData: h.basis === 'in_data' }
}

/** Reads scenarios/pads/{id}/summary.json; headline as {"30": {...}, "60": {...}} or [{budget_min, ...}]. */
export function parsePadSummary(raw: unknown, id: string): PadSummaryView {
  const o = obj(raw) ?? {}
  if (typeof o.id === 'string' && o.id !== id) throw new Error(`summary.json is for pad ${o.id}, not ${id}`)
  const pad = obj(o.pad) ?? {}
  const hs: PadHeadline[] = []
  if (Array.isArray(o.headline)) {
    for (const h of o.headline.map(obj)) if (h && num(h.budget_min) !== null) hs.push(headline(num(h.budget_min)!, h))
  } else {
    for (const [k, v] of Object.entries(obj(o.headline) ?? {})) {
      const h = obj(v)
      if (h && Number.isFinite(+k)) hs.push(headline(+k, h))
    }
  }
  hs.sort((a, b) => a.budget - b.budget)
  const r = obj(o.route)
  return {
    id,
    rank: num(o.rank),
    score: num(o.score),
    lon: num(pad.lon),
    lat: num(pad.lat),
    elevM: num(pad.elev_m),
    headlines: hs,
    route: r
      ? { stops: Array.isArray(r.stops) ? r.stops.filter((x): x is string => typeof x === 'string') : null, totalMin: num(r.total_min) }
      : null,
    excluded: feasibleOf(o).excluded,
  }
}

/** The headline at this budget, else the first one written. */
export function headlineFor(s: PadSummaryView, budget: number): PadHeadline | null {
  return s.headlines.find((h) => h.budget === budget) ?? s.headlines[0] ?? null
}

export type PadsIndexLoad =
  | { state: 'ok'; index: PadsIndexView }
  | { state: 'absent' }
  /** The file is there but no contract row covers it yet (C adds the rows after WS2): picker hidden. */
  | { state: 'no-contract' }
  | { state: 'error'; error: unknown }

export async function loadPadsIndex(L: Loader): Promise<PadsIndexLoad> {
  let raw: unknown
  try {
    raw = await L.json<unknown>(PADS_INDEX)
  } catch (e) {
    if (e instanceof DataError && e.kind === 'missing') return { state: 'absent' }
    if (e instanceof DataError && e.kind === 'no-contract') return { state: 'no-contract' }
    return { state: 'error', error: e }
  }
  try {
    return { state: 'ok', index: parsePadsIndex(raw) }
  } catch (e) {
    return { state: 'error', error: e }
  }
}

/** What the console offers while a pad is selected (null = the official pad). */
export function padViewMode(padId: string | null): { slider: boolean; scenarioPicker: boolean } {
  return padId === null ? { slider: true, scenarioPicker: true } : { slider: false, scenarioPicker: false }
}
