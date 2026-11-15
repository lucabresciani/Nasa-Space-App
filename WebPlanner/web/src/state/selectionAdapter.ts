// Map → selection adapter (U14 "Picking uses the map's feature queries for objects and field lookups
// for cells"). web/src/map/ is WS16's; it calls these functions from its click / mousemove handlers:
//
//   import { pickToRef, selectFromMap, hoverFromMap } from '../state/selectionAdapter'
//   map.on('click', (e) => selectFromMap(map.queryRenderedFeatures(e.point), e.lngLat))
//   map.on('mousemove', (e) => hoverFromMap(map.queryRenderedFeatures(e.point), e.lngLat))
//
// Features are read by their data properties (the files' own fields), never by layer id, so the
// adapter keeps working when WS16 renames layers. The first feature that names an object wins
// (MapLibre returns the top-most first); with none, the click is a terrain cell at lngLat.
import { hover, select, type EdgeCauseRef, type SelectionRef } from './selection'

/** The part of a MapLibre feature the adapter reads. */
export interface PickedFeature {
  properties?: Record<string, unknown> | null
  /** MapLibre layer (optional; only `layer.id` is used, as a hint for leg vs station lines). */
  layer?: { id?: string } | null
}
export interface LngLatLike {
  lng: number
  lat: number
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const CAUSES: readonly EdgeCauseRef[] = ['physiology', 'slope', 'data']
const STATION_ID = /^S\d+$/

/** labels.json `ref` → object: "pad.json", "scenarios/pads/index.json#rank2", "stations.json#S7". */
export function refFromLabel(p: Record<string, unknown>): SelectionRef | null {
  const kind = str(p.kind)
  const ref = str(p.ref) ?? ''
  const code = str(p.code)
  if (kind === 'pad') {
    if (ref === 'pad.json') return { kind: 'pad', id: 'rank1' }
    const id = ref.split('#')[1]
    return id ? { kind: 'pad', id } : null
  }
  if (kind === 'route_station' || kind === 'station' || kind === 'scored_site') {
    const id = ref.split('#')[1] ?? code
    return id ? { kind: 'station', id } : null
  }
  if (kind === 'landmark' && code) return { kind: 'landmark', code }
  return null
}

/** One feature's properties → the object it names, or null (then the next feature is tried). */
export function refFromFeature(f: PickedFeature): SelectionRef | null {
  const p = f.properties ?? {}
  if (str(p.kind) && (str(p.ref) || str(p.code))) {
    const r = refFromLabel(p)
    if (r) return r
  }
  // route_{scenario}.geojson legs: {leg, from, to}
  const leg = num(p.leg)
  if (leg !== null && str(p.from) && str(p.to)) return { kind: 'leg', leg }
  // edges.geojson: {budget, cause}
  const cause = str(p.cause) as EdgeCauseRef | null
  const budget = num(p.budget)
  if (cause && CAUSES.includes(cause) && budget !== null) return { kind: 'edge', cause, budget }
  // station markers: {id: 'S7'} or {station: 'S7'}
  const sid = str(p.station) ?? str(p.id)
  if (sid && STATION_ID.test(sid)) return { kind: 'station', id: sid }
  return null
}

/** Features under the pointer (top-most first) plus the pointer position → the ref to select. */
export function pickToRef(features: readonly PickedFeature[], at: LngLatLike | null): SelectionRef | null {
  for (const f of features) {
    const r = refFromFeature(f)
    if (!r) continue
    // An edge is a segment: remember where it was picked, so two segments are two selections.
    if (r.kind === 'edge' && at) return { ...r, lon: at.lng, lat: at.lat }
    return r
  }
  return at ? { kind: 'cell', lon: at.lng, lat: at.lat } : null
}

export function selectFromMap(features: readonly PickedFeature[], at: LngLatLike | null): SelectionRef | null {
  const r = pickToRef(features, at)
  if (r) select(r, 'map')
  return r
}

/** Hover: objects only (a hovered cell would re-render on every mouse move). */
export function hoverFromMap(features: readonly PickedFeature[], at: LngLatLike | null): SelectionRef | null {
  const r = pickToRef(features, at)
  const h = r && r.kind !== 'cell' ? r : null
  hover(h)
  return h
}
