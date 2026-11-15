// WS16 task 8 (M8): the P2 elevation tiles (terrain/tiles.json, contracts/terrain_tiles.schema.json)
// as MapLibre raster-dem sources. Pure: no map, no fetch (the loader is in index.ts).
//
// Tiles: 256 px Terrarium PNG, XYZ WebMercatorQuad with Mars lon/lat passed straight through (D4),
// height = true elevation × factor (1.878 = Earth / Mars radius, DESIGN U1 item 2), so exaggeration 1
// on screen is true shape. The factor is baked in: nothing here or in terrain.ts multiplies again.
// Pixel-is-area: a tile pixel holds the value at its centre (P2, as the gdal basemap).
import type { RasterDEMSourceSpecification } from '@maplibre/maplibre-gl-style-spec'

export interface TerrainTiles {
  name: string
  encoding: 'terrarium'
  tile_px: number
  /** Earth / Mars radius, multiplied into the heights by the exporter */
  factor: number
  /** URL templates relative to the data root */
  tiles: string[]
  minzoom: number
  maxzoom: number
  bounds: [number, number, number, number]
  focus: { minzoom: number; maxzoom: number; bounds: [number, number, number, number] } | null
  source: string[]
  source_hash: string
  attribution?: string
  precision_m?: number
}

/** Validate the fields M8 relies on (the contract has more); throws with the reason. */
export function parseTerrainTiles(raw: unknown): TerrainTiles {
  const j = raw as Partial<TerrainTiles>
  const bad = (why: string): never => {
    throw new Error(`terrain tiles.json: ${why}`)
  }
  if (!j || typeof j !== 'object') bad('not an object')
  if (j.encoding !== 'terrarium') bad(`encoding ${String(j.encoding)} (want terrarium)`)
  if (j.tile_px !== 256) bad(`tile_px ${String(j.tile_px)} (want 256)`)
  if (typeof j.factor !== 'number' || !(j.factor > 0)) bad('factor missing')
  if (!Array.isArray(j.tiles) || !j.tiles.length) bad('tiles missing')
  if (!Array.isArray(j.bounds) || j.bounds.length !== 4) bad('bounds missing')
  if (!Number.isInteger(j.minzoom) || !Number.isInteger(j.maxzoom)) bad('zoom range missing')
  return j as TerrainTiles
}

/** Terrarium: height = R × 256 + G + B / 256 − 32768 (scaled metres). */
export function terrariumHeight(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768
}

/** Tile and pixel (row i, column j) holding lon/lat at zoom z (XYZ, pixel-is-area). */
export function tilePixel(lon: number, lat: number, z: number, px = 256): { x: number; y: number; i: number; j: number } {
  const n = 2 ** z
  const fx = ((lon + 180) / 360) * n
  const phi = (lat * Math.PI) / 180
  const fy = ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n
  const x = Math.floor(fx)
  const y = Math.floor(fy)
  return { x, y, i: Math.floor((fy - y) * px), j: Math.floor((fx - x) * px) }
}

/** lon/lat of the centre of pixel (i, j) of tile (z, x, y). */
export function pixelCentre(z: number, x: number, y: number, i: number, j: number, px = 256): [number, number] {
  const n = 2 ** z
  const lon = ((x + (j + 0.5) / px) / n) * 360 - 180
  const my = (y + (i + 0.5) / px) / n
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI
  return [lon, lat]
}

/** Source ids: the terrain mesh and the relief shading read separate sources (MapLibre 3D example). */
export const DEM_SOURCE = { terrain: 'terrain-dem', relief: 'relief-dem' } as const

/**
 * The raster-dem source for z minzoom..15 on the planning extent (no 404s: P2 contract text).
 * The z16 focus-area tiles are not used yet: one source cannot hold a zoom whose bounds differ, and a
 * second relief layer stacked at z16 would double the shading or leave a seam at the focus edge
 * (notes/M8.md, DECIDE). Above z15 MapLibre overzooms the z15 tiles (2.4 m Mars pixels).
 */
export function demSource(tj: TerrainTiles, prefix: (path: string) => string): RasterDEMSourceSpecification {
  const top = tj.focus ? Math.min(tj.maxzoom, tj.focus.minzoom - 1) : tj.maxzoom
  return {
    type: 'raster-dem',
    encoding: 'terrarium',
    tiles: tj.tiles.map(prefix),
    tileSize: tj.tile_px,
    minzoom: tj.minzoom,
    maxzoom: top,
    bounds: tj.bounds,
    ...(tj.attribution ? { attribution: tj.attribution } : {}),
  }
}
