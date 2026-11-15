// Data behind the selection cards (U14). Everything is read from the validated, manifest-backed files
// through the app loader (data/loader.ts, contract-checked) or from the field lookup (map/field
// fieldAt); nothing is computed here except picking rows (e.g. the lowest margin of a leg is the
// smallest timeline row inside the leg, quoted with that row's manifest key).
import type { Loader } from '../../data/loader'
import { padFiles, parsePadsIndex, parsePadSummary, type PadsIndexView, type PadSummaryView } from '../../data/pads'
import type { Card, PadFile, RouteFC, ScenarioEntry, ScenariosIndex, Station, TimelineEvent } from '../../data/types'
import type { SelectionRef } from '../../state/selection'
import { routeSummary, type RouteSummary } from '../../views/route'
import { activeField, type FieldSample } from '../../map/field'

/** labels.json row (contracts/labels.schema.json). */
export interface LabelRow {
  code: string
  name: string
  kind: string
  status: string | null
  lon: number
  lat: number
  ref?: string
  bearing_deg?: number
  dist_m?: number
}

/** A route plus its timeline and their manifest key prefixes (official: route.{sid}/timeline.{sid}; option: pads.{id}.route/timeline). */
export interface RouteData {
  route: RouteSummary | null
  timeline: TimelineEvent[] | null
  routeFile: string
  timelineFile: string
  routeKey: string
  timelineKey: string
}

/** Field lookup used by cell cards (injected in tests; default = the planning map's active field). */
export type CellLookup = (lon: number, lat: number) => { sample: FieldSample; suitKg: number } | null

export const activeFieldLookup: CellLookup = (lon, lat) => {
  const f = activeField()
  return f ? { sample: f.at(lon, lat), suitKg: f.suitKg } : null
}

export interface CardData {
  scenario: ScenarioEntry
  stations: Station[]
  pad: PadFile | null
  pads: PadsIndexView | null
  labels: LabelRow[]
  /** Official route (default scenario). */
  official: RouteData
  /** Loaded on demand per ref (ensureFor). */
  stationCards: Map<string, Card | null>
  padSummaries: Map<string, PadSummaryView | null>
  padRoutes: Map<string, RouteData>
  cell: CellLookup
}

export const OFFICIAL_PAD = 'rank1'

export async function loadCardData(L: Loader, cell: CellLookup = activeFieldLookup): Promise<CardData> {
  const idx = await L.scenarios()
  const scenario = pickDefault(idx)
  const sid = scenario.id
  const [stations, pad, padsRaw, labels, route, timeline] = await Promise.all([
    L.stations(),
    L.optional(() => L.pad()),
    L.optional(() => L.json<unknown>('scenarios/pads/index.json')),
    L.optional(() => L.json<{ labels: LabelRow[] }>('labels.json')),
    L.optional(() => L.route(sid)),
    L.optional(() => L.timeline(sid)),
  ])
  let pads: PadsIndexView | null = null
  try {
    pads = padsRaw ? parsePadsIndex(padsRaw) : null
  } catch {
    pads = null
  }
  return {
    scenario,
    stations,
    pad,
    pads,
    labels: labels?.labels ?? [],
    official: {
      route: routeSummary(route),
      timeline,
      routeFile: `route_${sid}.geojson`,
      timelineFile: `timeline_${sid}.json`,
      routeKey: `route.${sid}`,
      timelineKey: `timeline.${sid}`,
    },
    stationCards: new Map(),
    padSummaries: new Map(),
    padRoutes: new Map(),
    cell,
  }
}

function pickDefault(idx: ScenariosIndex): ScenarioEntry {
  const s = idx.scenarios.find((x) => x.id === idx.default) ?? idx.scenarios[0]
  if (!s) throw new Error('scenarios/index.json lists no scenario')
  return s
}

/** True when the card for `ref` can render from `d` without another file. */
export function isReady(d: CardData, ref: SelectionRef | null): boolean {
  if (!ref) return true
  if (ref.kind === 'station') return d.stationCards.has(ref.id)
  if (ref.kind === 'pad') return ref.id === OFFICIAL_PAD || d.padSummaries.has(ref.id)
  if (ref.kind === 'leg') return !ref.pad || ref.pad === OFFICIAL_PAD || d.padRoutes.has(ref.pad)
  return true
}

/** Load the per-object files a ref needs (station card, parking option summary or route). */
export async function ensureFor(L: Loader, d: CardData, ref: SelectionRef | null): Promise<void> {
  if (!ref || isReady(d, ref)) return
  if (ref.kind === 'station') {
    const s = d.stations.find((x) => x.id === ref.id)
    d.stationCards.set(ref.id, s ? await L.optional(() => L.card(s)) : null)
  } else if (ref.kind === 'pad') {
    const raw = await L.optional(() => L.json<unknown>(padFiles(ref.id, d.scenario).summary))
    let v: PadSummaryView | null = null
    try {
      v = raw ? parsePadSummary(raw, ref.id) : null
    } catch {
      v = null
    }
    d.padSummaries.set(ref.id, v)
  } else if (ref.kind === 'leg' && ref.pad) {
    const f = padFiles(ref.pad, d.scenario)
    const [route, timeline] = await Promise.all([L.optional(() => L.json<RouteFC>(f.route)), L.optional(() => L.json<TimelineEvent[]>(f.timeline))])
    d.padRoutes.set(ref.pad, {
      route: routeSummary(route),
      timeline,
      routeFile: f.route,
      timelineFile: f.timeline,
      routeKey: `pads.${ref.pad}.route`,
      timelineKey: `pads.${ref.pad}.timeline`,
    })
  }
}

/** Timeline row with the smallest margin in [from, to] min (turn-back rows sit at 0 by definition and are left out). */
export function lowestMarginRow(tl: TimelineEvent[] | null, from = -Infinity, to = Infinity): { i: number; e: TimelineEvent } | null {
  let best: { i: number; e: TimelineEvent } | null = null
  ;(tl ?? []).forEach((e, i) => {
    if (e.event === 'turn_back' || typeof e.margin_min !== 'number' || e.t_min < from || e.t_min > to) return
    if (!best || e.margin_min < (best.e.margin_min as number)) best = { i, e }
  })
  return best
}

/** Timeline row index of an event (arrive/leave/turn_back) at a station. */
export function timelineRow(tl: TimelineEvent[] | null, event: string, station: string | null): number {
  return (tl ?? []).findIndex((e) => e.event === event && e.station === station)
}
