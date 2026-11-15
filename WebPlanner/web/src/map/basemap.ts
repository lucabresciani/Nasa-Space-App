// Basemap (F17): the HiRISE colour ortho as XYZ WebP tiles, described by
// tiles/basemap/tilejson.json (contract v1.1.0, written by make web). Tile URLs in the file are
// relative to the data root; the app prefixes its data base URL. Mars lon/lat go straight through
// the XYZ (Web Mercator tile) scheme (SPEC §4.2, D4); distances on screen come only from the Mars
// scale bar (scale.ts), never from MapLibre's Earth metres.
import type { TileJson } from '../data/types'

/** A MapLibre raster source description for (part of) the basemap. */
export interface BasemapSource {
  tiles: string[]
  tileSize: number
  minzoom: number
  maxzoom: number
  bounds: [number, number, number, number]
  attribution?: string
  /** Layer minzoom: a partial-zoom source draws only from its own zoom up. */
  layerMinzoom?: number
}

/**
 * Sources without 404s (contracts/README "Basemap tiles"): one for minzoom..(first zoom_bounds key
 * − 1) on `bounds`, then one per partial zoom on its `zoom_bounds`. Lower zooms overzoom where a
 * partial zoom has no tiles, so the whole window always has imagery.
 */
export function basemapSources(tj: TileJson, prefix: (path: string) => string): BasemapSource[] {
  const partial = Object.keys(tj.zoom_bounds ?? {})
    .map(Number)
    .filter((z) => Number.isInteger(z) && z > tj.minzoom && z <= tj.maxzoom)
    .sort((a, b) => a - b)
  const common = { tiles: tj.tiles.map(prefix), tileSize: tj.tileSize, attribution: tj.attribution }
  const out: BasemapSource[] = [{ ...common, minzoom: tj.minzoom, maxzoom: partial.length ? partial[0] - 1 : tj.maxzoom, bounds: tj.bounds }]
  for (const z of partial) out.push({ ...common, minzoom: z, maxzoom: z, bounds: tj.zoom_bounds![String(z)], layerMinzoom: z })
  return out
}

/** Credit line for the HiRISE basemap (HiRISE image-use policy), when tilejson.json has none. */
export const BASEMAP_CREDIT = 'HiRISE: NASA/JPL/University of Arizona'
