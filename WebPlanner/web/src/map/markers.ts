// WS16 task 5 (M5): map markers (DESIGN U4 "Markers"), pure part.
// Stations: a ring whose thickness encodes the science value (stations.json `value`, 0..1) and a
// fill that encodes state: on the route, reachable on foot, not reachable on foot (stations.json
// `reachable_on_foot`, WS2's D26 decision). Scored sites (config/stations.yaml extras.ids, the F7
// scoring picks) get a second thin halo ring. Only the next station on the route pulses, once every
// tokens motion.pulseEveryMs (3 s); reduced motion: no pulse.
import stationsCfg from '../../../config/stations.yaml'
import { TOKENS } from '../ui/tokens'
import { t } from './furniture/text'

export type StationState = 'route' | 'reachable' | 'unreachable'

export interface MarkerStation {
  id: string
  lon: number
  lat: number
  value: number | null
  reachable_on_foot?: boolean
}

export interface StationProps {
  id: string
  /** science value 0..1 (null = not scored) */
  value: number
  state: StationState
  scored: boolean
  next: boolean
  /** ring width in px (science value) */
  ring: number
  fill: string
  stroke: string
  /** copy text of the state, for titles and the legend */
  stateText: string
}

/** config/stations.yaml extras.ids: the stations picked by the F7 scoring rule ("scored sites"). */
export const SCORED_SITE_IDS: readonly string[] = ((stationsCfg as { extras?: { ids?: string[] } }).extras?.ids ?? []).slice()

/** Ring width range in px for science value 0..1 (thin = low value, thick = high value). */
export const RING_PX = { min: 1, max: 6 } as const

export function ringWidth(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return RING_PX.min
  const v = Math.min(1, Math.max(0, value))
  return RING_PX.min + (RING_PX.max - RING_PX.min) * v
}

/** State -> fill / ring colours (DESIGN §3.1: science blue for science targets; no warning colour). */
export function stateStyle(s: StationState): { fill: string; stroke: string; text: string } {
  const c = TOKENS.color
  if (s === 'route') return { fill: c.science, stroke: c.science, text: t('cards.station.onRoute') }
  if (s === 'reachable') return { fill: c.bg, stroke: c.science, text: t('cards.station.reachable') }
  return { fill: c.bg, stroke: c.textFaint, text: t('cards.station.notReachable') }
}

export function stationState(s: MarkerStation, onRoute: ReadonlySet<string>): StationState {
  if (onRoute.has(s.id)) return 'route'
  return s.reachable_on_foot === false ? 'unreachable' : 'reachable'
}

export function stationFeatures(
  stations: readonly MarkerStation[],
  onRoute: ReadonlySet<string>,
  nextId: string | null,
): GeoJSON.FeatureCollection<GeoJSON.Point, StationProps> {
  return {
    type: 'FeatureCollection',
    features: stations.map((s) => {
      const state = stationState(s, onRoute)
      const st = stateStyle(state)
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
        properties: {
          id: s.id,
          value: s.value ?? 0,
          state,
          scored: SCORED_SITE_IDS.includes(s.id),
          next: s.id === nextId && state === 'route',
          ring: ringWidth(s.value),
          fill: st.fill,
          stroke: st.stroke,
          stateText: st.text,
        },
      }
    }),
  }
}

/**
 * Pulse of the next station at time `nowMs`: one ring that grows and fades during the first third
 * of every pulseEveryMs period, nothing for the rest. Reduced motion: never active.
 */
export function pulseFrame(nowMs: number, reduced: boolean, everyMs: number = TOKENS.motion.pulseEveryMs): { active: boolean; grow: number; opacity: number } {
  if (reduced || !(everyMs > 0)) return { active: false, grow: 0, opacity: 0 }
  const f = (((nowMs % everyMs) + everyMs) % everyMs) / (everyMs / 3)
  if (f >= 1) return { active: false, grow: 0, opacity: 0 }
  return { active: true, grow: f, opacity: 1 - f }
}

/** Trust-chip hook for the marker group (DESIGN §3.6): positions and values are WS2/WS1 outputs. */
export const MARKERS_TRUST = { attr: 'data-trust-markers', chip: 'modelled', sourceAttr: 'data-trust-markers-source', source: 'stations.json pad.json timeline' } as const
