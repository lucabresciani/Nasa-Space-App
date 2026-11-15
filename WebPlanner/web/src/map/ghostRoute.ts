// WS16 task 5 (M5): the ghost route layer for WS18 (DESIGN U15 "ghost", §3.1 `select` = ghost route).
// A dashed yellow route with a "computing…" label while a live plan is being computed.
//
//   const ghost = ghostRouteLayer(map)            // add (empty)
//   ghost.update(routeOrCoords)                   // show / replace the ghost (FeatureCollection, Feature or [lon, lat][])
//   ghost.update(null)                            // hide it, keep the layer
//   ghost.remove()                                // remove layer, source and label
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl'
import { Marker } from 'maplibre-gl'
import { TOKENS } from '../ui/tokens'
import { t } from './furniture/text'

export type GhostInput = GeoJSON.FeatureCollection | GeoJSON.Feature | [number, number][] | null

export interface GhostRouteLayer {
  readonly id: string
  update(route: GhostInput): void
  remove(): void
}

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

/** Normalise the input to a FeatureCollection of its line geometries. */
export function ghostData(route: GhostInput): GeoJSON.FeatureCollection {
  if (!route) return EMPTY
  if (Array.isArray(route)) return route.length >= 2 ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: route }, properties: {} }] } : EMPTY
  const feats = route.type === 'FeatureCollection' ? route.features : [route]
  return { type: 'FeatureCollection', features: feats.filter((f) => f.geometry && (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString')) }
}

/** Where the label sits: the middle vertex of the longest line (null when there is none). */
export function ghostLabelAt(fc: GeoJSON.FeatureCollection): [number, number] | null {
  let best: GeoJSON.Position[] | null = null
  for (const f of fc.features) {
    const g = f.geometry
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []
    for (const l of lines) if (!best || l.length > best.length) best = l
  }
  if (!best || best.length === 0) return null
  const p = best[Math.floor(best.length / 2)]
  return [p[0], p[1]]
}

let seq = 0

/** Add a ghost route layer to `map` (above everything); returns its handle. */
export function ghostRouteLayer(map: MlMap, route: GhostInput = null, opts: { id?: string; beforeId?: string } = {}): GhostRouteLayer {
  const id = opts.id ?? `ghost-route-${++seq}`
  map.addSource(id, { type: 'geojson', data: ghostData(route) })
  map.addLayer(
    {
      id,
      type: 'line',
      source: id,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: { 'line-color': TOKENS.color.select, 'line-width': TOKENS.line.threadPx, 'line-dasharray': [2, 2] },
    },
    opts.beforeId,
  )
  const el = document.createElement('div')
  el.className = 'hl-ghost-label'
  el.textContent = t('edit.computing')
  el.title = t('edit.ghost')
  el.setAttribute('data-trust', 'live') // computed on request (DESIGN §3.6 ◆ Live)
  let marker: Marker | null = null
  const place = (fc: GeoJSON.FeatureCollection): void => {
    const at = ghostLabelAt(fc)
    if (!at) {
      marker?.remove()
      marker = null
      return
    }
    marker ??= new Marker({ element: el, anchor: 'bottom', offset: [0, -6] })
    marker.setLngLat(at).addTo(map)
  }
  place(ghostData(route))
  return {
    id,
    update(r: GhostInput): void {
      const fc = ghostData(r)
      ;(map.getSource(id) as GeoJSONSource | undefined)?.setData(fc)
      place(fc)
    },
    remove(): void {
      marker?.remove()
      marker = null
      if (map.getLayer(id)) map.removeLayer(id)
      if (map.getSource(id)) map.removeSource(id)
    },
  }
}
