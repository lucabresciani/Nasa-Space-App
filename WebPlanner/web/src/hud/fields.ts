// Field PNG decoder (F18, F19; SPEC §6.1; contracts/README.md "Field PNGs").
// Must stay bit-identical to pipeline/export/fields_png.py:
//   counts = R*256 + G, value = counts * scale, A = 0 -> unknown (null).
// Values are kept as integer counts (Uint16) so a lookup returns exactly counts * scale, the
// same float64 product Python computes.
import type { FieldsIndex, GridSpec } from './types'

export interface DecodedField {
  width: number
  height: number
  scale: number
  counts: Uint16Array
  known: Uint8Array // 1 = valid (A = 255), 0 = unknown (A = 0)
}

/** RGBA bytes (row-major, 4 per pixel, as ImageData.data) -> decoded field. */
export function decodeRGBA(rgba: ArrayLike<number>, width: number, height: number, scale: number): DecodedField {
  const n = width * height
  if (rgba.length !== n * 4) throw new Error(`RGBA length ${rgba.length} != ${n} * 4`)
  if (!(scale > 0)) throw new Error(`bad scale ${scale}`)
  const counts = new Uint16Array(n)
  const known = new Uint8Array(n)
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    if (rgba[j + 3] === 0) continue
    counts[i] = rgba[j] * 256 + rgba[j + 1]
    known[i] = 1
  }
  return { width, height, scale, counts, known }
}

/**
 * The grid of field `key`: the index grid, overridden by the entry's own bounds/width/height/res_m
 * (contracts v1.1.1: the {scenario}/pointer entry has one, WS2's native 3 m route grid).
 */
export function fieldGrid(index: FieldsIndex, key: string): GridSpec {
  const meta = index.fields[key]
  if (!meta) throw new Error(`fields/index.json has no field ${key}`)
  return {
    bounds: meta.bounds ?? index.bounds,
    width: meta.width ?? index.width,
    height: meta.height ?? index.height,
    res_m: meta.res_m ?? index.res_m,
  }
}

/** A decoded field georeferenced by fields/index.json; all HUD lookups go through this. */
export class FieldGrid {
  readonly w: number
  readonly s: number
  readonly e: number
  readonly n: number
  /** metres per degree of lon / lat on this grid (from width * res_m over the bounds). */
  readonly mPerDegLon: number
  readonly mPerDegLat: number
  readonly resM: number
  readonly data: DecodedField
  readonly units: string

  constructor(index: GridSpec | Pick<FieldsIndex, 'bounds' | 'width' | 'height' | 'res_m'>, data: DecodedField, units = '') {
    if (data.width !== index.width || data.height !== index.height) {
      throw new Error(`field is ${data.width}x${data.height}, index says ${index.width}x${index.height}`)
    }
    ;[this.w, this.s, this.e, this.n] = index.bounds
    this.resM = index.res_m
    this.mPerDegLon = (index.width * index.res_m) / (this.e - this.w)
    this.mPerDegLat = (index.height * index.res_m) / (this.n - this.s)
    this.data = data
    this.units = units
  }

  get width(): number {
    return this.data.width
  }
  get height(): number {
    return this.data.height
  }

  /** Pixel containing (lon, lat), or null outside the extent. Bounds are pixel edges. */
  pixelOf(lon: number, lat: number): { row: number; col: number } | null {
    const col = Math.floor(((lon - this.w) / (this.e - this.w)) * this.width)
    const row = Math.floor(((this.n - lat) / (this.n - this.s)) * this.height)
    if (col < 0 || row < 0 || col >= this.width || row >= this.height) return null
    return { row, col }
  }

  /** Centre of pixel (row, col) in lon/lat. */
  lonLatOf(row: number, col: number): [number, number] {
    return [
      this.w + ((col + 0.5) / this.width) * (this.e - this.w),
      this.n - ((row + 0.5) / this.height) * (this.n - this.s),
    ]
  }

  /** Value at pixel, or null if unknown / outside. */
  valueAtPixel(row: number, col: number): number | null {
    if (row < 0 || col < 0 || row >= this.height || col >= this.width) return null
    const i = row * this.width + col
    return this.data.known[i] ? this.data.counts[i] * this.data.scale : null
  }

  /** Nearest-pixel lookup (no interpolation: the HUD shows what the pipeline computed). */
  valueAt(lon: number, lat: number): number | null {
    const p = this.pixelOf(lon, lat)
    return p ? this.valueAtPixel(p.row, p.col) : null
  }

  /** Local planar metres between two lon/lat points on this grid (equirectangular). */
  distanceM(a: [number, number], b: [number, number]): number {
    return Math.hypot((b[0] - a[0]) * this.mPerDegLon, (b[1] - a[1]) * this.mPerDegLat)
  }

  /**
   * Max over the known pixels whose centre lies within radiusM of (lon, lat) (the pixel under
   * the position always counts). Unknown pixels (no T_home: blocked, unreached) are places the
   * crew cannot be, so they are skipped, as in the worst-case fields (assumption A-WS7-2).
   * null if the disc leaves the extent or holds no known pixel. Used for the alarm-3 circle test.
   */
  discMax(lon: number, lat: number, radiusM: number): number | null {
    const p = this.pixelOf(lon, lat)
    if (!p) return null
    const x0 = (lon - this.w) * this.mPerDegLon // metres from the west edge
    const y0 = (this.n - lat) * this.mPerDegLat // metres from the north edge
    const r = Math.max(0, radiusM)
    const r2 = r * r
    const res = this.resM
    const rowMin = Math.floor((y0 - r) / res)
    const rowMax = Math.floor((y0 + r) / res)
    const colMin = Math.floor((x0 - r) / res)
    const colMax = Math.floor((x0 + r) / res)
    if (rowMin < 0 || colMin < 0 || rowMax >= this.height || colMax >= this.width) return null
    let best = -Infinity
    for (let row = rowMin; row <= rowMax; row++) {
      const dy = (row + 0.5) * res - y0
      for (let col = colMin; col <= colMax; col++) {
        const dx = (col + 0.5) * res - x0
        if (dx * dx + dy * dy > r2 && !(row === p.row && col === p.col)) continue
        const v = this.valueAtPixel(row, col)
        if (v !== null && v > best) best = v
      }
    }
    return best === -Infinity ? null : best
  }
}

/** Fetch a field PNG and decode it through Canvas 2D (browser only). */
export async function loadFieldRGBA(url: string): Promise<{ rgba: Uint8ClampedArray; width: number; height: number }> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const blob = await res.blob()
  // No premultiplication (A=255 pixels are exact anyway) and no colour management: the bytes
  // are counts, not colours.
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
  const { width, height } = bmp
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height })
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (!ctx) throw new Error('Canvas 2D unavailable')
  ctx.drawImage(bmp, 0, 0)
  bmp.close()
  const img = ctx.getImageData(0, 0, width, height, { colorSpace: 'srgb' })
  return { rgba: img.data, width, height }
}

/** Load one field listed in fields/index.json (on its own grid if it has one). */
export async function loadField(index: FieldsIndex, key: string, dataUrl: (p: string) => string): Promise<FieldGrid> {
  const meta = index.fields[key]
  if (!meta) throw new Error(`fields/index.json has no field ${key}`)
  const { rgba, width, height } = await loadFieldRGBA(dataUrl(meta.file))
  return new FieldGrid(fieldGrid(index, key), decodeRGBA(rgba, width, height, meta.scale), meta.units)
}
