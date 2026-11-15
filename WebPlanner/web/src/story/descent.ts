// WS16 task 10 (M10): low-zoom relief for the descent intro (DESIGN U6 item 3): the P2 terrain_low
// tiles (z6-10 over Gale, CTX 20 m + MOLA-HRSC 200 m, Terrarium) as a relief-shading layer under the
// basemap, so Gale crater and Mount Sharp read from high above where no HiRISE basemap exists.
// P2 notes: 17.4 % of the pixels (mostly z6-8, south-east of Gale) are edge-extended fill; it is a
// visual backdrop only, never a number. Shading colours are the M8 relief tokens.
import type { Map as MlMap } from 'maplibre-gl'
import { DATA_MODE, dataUrl } from '../env'
import { demSource, parseTerrainTiles } from '../map/terrain/tiles'
import { TOKENS } from '../ui/tokens'

export const RELIEF_LOW = { source: 'relief-low-dem', layer: 'relief-low' } as const

/** Add (once) the low-zoom relief; false when the data tree has no terrain_low/. */
export async function addReliefLow(map: MlMap): Promise<boolean> {
  if (map.getLayer(RELIEF_LOW.layer)) return true
  const res = await fetch(dataUrl('terrain_low/tiles.json', DATA_MODE))
  const ct = res.headers.get('content-type') ?? ''
  if (!res.ok || (ct && !ct.includes('json'))) return false
  const tj = parseTerrainTiles(await res.json())
  if (map.getLayer(RELIEF_LOW.layer)) return true
  if (!map.getSource(RELIEF_LOW.source)) map.addSource(RELIEF_LOW.source, demSource(tj, (p) => dataUrl(p, DATA_MODE)))
  const c = TOKENS.color
  // under the basemap (HiRISE covers it where it exists) and under everything else
  const first = map.getStyle().layers.find((l) => l.id.startsWith('basemap-') || l.id === 'iso-fill')
  map.addLayer(
    {
      id: RELIEF_LOW.layer,
      type: 'hillshade',
      source: RELIEF_LOW.source,
      paint: { 'hillshade-shadow-color': c.shadow, 'hillshade-highlight-color': c.light, 'hillshade-accent-color': c.shadow },
    },
    first?.id,
  )
  return true
}

export function setReliefLowVisible(map: MlMap, on: boolean): void {
  if (map.getLayer(RELIEF_LOW.layer)) map.setLayoutProperty(RELIEF_LOW.layer, 'visibility', on ? 'visible' : 'none')
}

export function removeReliefLow(map: MlMap): void {
  if (map.getLayer(RELIEF_LOW.layer)) map.removeLayer(RELIEF_LOW.layer)
  if (map.getSource(RELIEF_LOW.source)) map.removeSource(RELIEF_LOW.source)
}
