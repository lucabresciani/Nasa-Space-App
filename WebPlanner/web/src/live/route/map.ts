// The console map seen by the Edit-route panel (R5): staged results through the console map's OWN
// setters (setScenarioData / setRoute, one rendering path, kit rule 7, as the pad tool does), and the
// failing leg of an infeasible route as one extra line layer in the limit colour (DESIGN §3.1: limit
// = red). The failing leg was not planned (the engine stops there), so the line joins its two stops
// straight and dashed: it marks which leg, it is not a path.
import type { FeatureCollection } from 'geojson'
import type { RouteMap } from '../../edit/route/controller'
import type { BandsFC, EdgesFC, IsochroneFC, PartnerFC, RouteFC } from '../../data/types'
import { TOKENS } from '../../ui/tokens'
import type { ScenarioLayers } from '../mapPort'
import type { StageResult } from '../stage'

export const FAILING_LEG_ID = 'hl-route-failing-leg'

interface GeoJsonSourceLike {
  setData(d: unknown): unknown
}
/** The parts of maplibre-gl's Map used here (tests pass a fake). */
export interface RouteMlMap {
  getSource(id: string): unknown
  addSource(id: string, spec: { type: 'geojson'; data: FeatureCollection }): unknown
  addLayer(spec: Record<string, unknown>): unknown
  getLayer(id: string): unknown
  /** the map's container: carries data-failing-leg for tests and the e2e harness */
  getContainer?(): HTMLElement
}
/** The parts of ConsoleMap used here (ConsoleMap satisfies it). */
export interface RouteConsoleMap {
  readonly map: RouteMlMap
  whenReady(): Promise<void>
  setScenarioData(d: ScenarioLayers): Promise<void>
  setRoute(r: RouteFC | null): Promise<void>
}

const empty = <T>() => ({ type: 'FeatureCollection', features: [] }) as unknown as T

/** The failing-leg feature collection (empty = no highlight). */
export function failingLegData(coords: [number, number][] | null, label?: string): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: coords && coords.length >= 2 ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { label: label ?? '', state: 'failing' } }] : [],
  }
}

export function consoleRouteMap(cm: RouteConsoleMap, restore: () => void | Promise<void>, alive: () => boolean = () => true): RouteMap {
  let layer: Promise<void> | null = null
  const ensure = () =>
    (layer ??= cm.whenReady().then(() => {
      const m = cm.map
      if (!m.getSource(FAILING_LEG_ID)) m.addSource(FAILING_LEG_ID, { type: 'geojson', data: failingLegData(null) })
      if (!m.getLayer(FAILING_LEG_ID))
        m.addLayer({
          id: FAILING_LEG_ID,
          type: 'line',
          source: FAILING_LEG_ID,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': TOKENS.color.limit, 'line-width': TOKENS.line.threadPx * 2, 'line-dasharray': [2, 1.5] },
        })
    }))
  return {
    async showStage(data) {
      if (!alive()) return
      const r = data as StageResult
      if (r.bands || r.isochrones || r.edges || r.partner)
        await cm.setScenarioData({
          bands: r.bands ?? empty<BandsFC>(),
          isochrones: r.isochrones ?? empty<IsochroneFC>(),
          edges: r.edges ?? empty<EdgesFC>(),
          partner: r.partner ?? empty<PartnerFC>(),
          variant: r.scenario?.variant ?? 'nominal',
        })
      if (r.route) await cm.setRoute(r.route)
    },
    highlightLeg(coords, label, leg) {
      if (!alive()) return
      const box = cm.map.getContainer?.()
      if (box) {
        if (coords && leg !== undefined) box.dataset.failingLeg = String(leg)
        else delete box.dataset.failingLeg
      }
      if (!coords && !layer) return
      void ensure()
        .then(() => alive() && (cm.map.getSource(FAILING_LEG_ID) as GeoJsonSourceLike | undefined)?.setData(failingLegData(coords, label)))
        .catch(() => {}) // the map went away meanwhile
    },
    restore() {
      if (alive()) void restore()
    },
  }
}
