// The pad tool's view of the map (F24). The console map lives in src/map/ (not WS13's), so the pad
// tool is written against this small injected port and tested with a fake. Drawing a live result
// uses the console map's OWN layer setters (ConsoleMap.setScenarioData / setRoute): one rendering
// path, no second renderer (kit rule 7). consoleMapPort() adapts a ConsoleMap; the one-line wiring
// in the console view belongs to WS5/C (see /tmp/hl-orch/notes/U2.md).
import type { CircleLayerSpecification } from '@maplibre/maplibre-gl-style-spec'
import type { FeatureCollection } from 'geojson'
import type { BandsFC, EdgesFC, IsochroneFC, PartnerFC, RouteFC } from '../data/types'
import type { LonLat } from './types'

export interface ScenarioLayers {
  bands: BandsFC
  isochrones: IsochroneFC
  edges: EdgesFC
  partner: PartnerFC
  variant: string
}

export interface LivePadMark extends LonLat {
  /** true valid, false refused, null still checking */
  valid: boolean | null
}

export interface MapPort {
  /** Map clicks as lon/lat; returns unsubscribe. */
  onClick(cb: (p: LonLat) => void): () => void
  /** The clicked live pad (null removes it). */
  setLivePad(p: LivePadMark | null): void
  /** Same signature as ConsoleMap.setScenarioData. */
  setScenarioData(d: ScenarioLayers): Promise<void>
  /** Same signature as ConsoleMap.setRoute. */
  setRoute(r: RouteFC | null): Promise<void>
  /** Give the map back to the static scenario (the console re-applies its own data). */
  restoreStatic(): void
}

// --- adapter for src/map/consoleMap.ts (structural, so tests need no MapLibre) ---

interface ClickEvent {
  lngLat: { lng: number; lat: number }
}
interface GeoJsonSourceLike {
  setData(d: unknown): unknown
}
/** The parts of maplibre-gl's Map the adapter uses. */
export interface MlMapLike {
  on(type: 'click', fn: (e: ClickEvent) => void): unknown
  off(type: 'click', fn: (e: ClickEvent) => void): unknown
  getSource(id: string): unknown
  addSource(id: string, spec: { type: 'geojson'; data: FeatureCollection }): unknown
  addLayer(spec: CircleLayerSpecification): unknown
  getLayer(id: string): unknown
}
/** The parts of ConsoleMap the adapter uses (ConsoleMap satisfies it; checked by tsc in mapPort.check.ts). */
export interface ConsoleMapLike {
  readonly map: MlMapLike
  whenReady(): Promise<void>
  setScenarioData(d: ScenarioLayers): Promise<void>
  setRoute(r: RouteFC | null): Promise<void>
}

export const LIVE_PAD_SOURCE = 'live-pad'
export const LIVE_PAD_COLORS = { valid: '#7fd18b', invalid: '#e5534b', checking: '#cccccc' } as const

/**
 * MapPort over a ConsoleMap. `restore` re-applies the console's static scenario (the console view
 * owns that state; without it restoreStatic only removes the live pad).
 */
export function consoleMapPort(cm: ConsoleMapLike, restore?: () => void): MapPort {
  let padReady: Promise<void> | null = null
  const ensurePadLayer = () =>
    (padReady ??= cm.whenReady().then(() => {
      const m = cm.map
      if (!m.getSource(LIVE_PAD_SOURCE)) m.addSource(LIVE_PAD_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      if (!m.getLayer(LIVE_PAD_SOURCE)) {
        m.addLayer({
          id: LIVE_PAD_SOURCE,
          type: 'circle',
          source: LIVE_PAD_SOURCE,
          paint: {
            'circle-radius': 7,
            'circle-color': ['match', ['get', 'state'], 'valid', LIVE_PAD_COLORS.valid, 'invalid', LIVE_PAD_COLORS.invalid, LIVE_PAD_COLORS.checking],
            'circle-stroke-color': '#000000',
            'circle-stroke-width': 1.5,
          },
        })
      }
    }))
  const setPad = async (p: LivePadMark | null) => {
    await ensurePadLayer()
    const features = p
      ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { state: p.valid === null ? 'checking' : p.valid ? 'valid' : 'invalid' } }]
      : []
    ;(cm.map.getSource(LIVE_PAD_SOURCE) as GeoJsonSourceLike).setData({ type: 'FeatureCollection', features })
  }
  return {
    onClick(cb) {
      const h = (e: ClickEvent) => cb({ lon: e.lngLat.lng, lat: e.lngLat.lat })
      cm.map.on('click', h)
      return () => {
        cm.map.off('click', h)
      }
    },
    setLivePad(p) {
      void setPad(p)
    },
    setScenarioData: (d) => cm.setScenarioData(d),
    setRoute: (r) => cm.setRoute(r),
    restoreStatic() {
      void setPad(null)
      restore?.()
    },
  }
}
