// WP6 (D97): the parts of the removed fp3d/ (D99, f06158c) that the route grid needs, ported from
// origin/waypoint-routing web/src/mission/data.ts's imports (N0CEO, Mission Planer), code read from
// origin/main web/src/fp3d/{format,geo,terrain}.ts and copied unchanged:
//   format.ts   parseIndex, farOrigin, gunzipIfNeeded, codecOf, decodeHeights (fp3d/index.json + far.f32.gz)
//   geo.ts      parseEqc, lonLatToXY (analysis CRS from the PROJ string; no constant copied)
//   terrain.ts  HeightGrid (bilinear between pixel centres)
// The data files web/public/data/fp3d/far.f32.gz and index.json still ship on design.


export interface Fp3dChunk {
  i: number
  j: number
  file: string
  tex?: string
  bounds: [number, number, number, number]
  bytes?: number
  tex_bytes?: number
}

export interface Fp3dHeight {
  dtype: string
  byte_order: 'little' | 'big'
  row_order: 'north_to_south' | 'south_to_north'
  offset_m: number
  units: string
  datum?: string
}

export interface Fp3dIndex {
  dummy: boolean
  bounds: [number, number, number, number]
  chunk_grid: {
    cols: number
    rows: number
    chunk_px: number
    res_m: number
    origin_xy_m: [number, number] // NW corner, analysis CRS
    crs: string
    chunks: Fp3dChunk[]
  }
  /** metres per stored unit */
  height_scale: number
  height: Fp3dHeight
  /** origin_xy_m: NW corner of the far grid (absent: the chunk grid's; the M0 dummy) */
  /** tex: optional fp3d/far_tex.jpg over the whole far square (row 0 = north, column 0 = west) */
  far: { file: string; res_m: number; width: number; height: number; origin_xy_m?: [number, number]; bytes?: number; tex?: string; tex_bytes?: number }
  horizon_ring?: string
  /** per-station far-skyline rings (pipeline/export/terrain_chunks.py station_rings; ring.ts farCurtains) */
  station_rings?: { rings?: unknown[]; source?: string; note?: string }
  eye_height_m?: number
  download_bytes?: number
}

/** Check the fields the viewer relies on (the contract fixes only dummy/bounds/chunk_grid/height_scale). */
export function parseIndex(raw: unknown): Fp3dIndex {
  const fail = (m: string): never => {
    throw new Error(`fp3d/index.json: ${m}`)
  }
  if (!raw || typeof raw !== 'object') fail('not an object')
  const o = raw as Partial<Fp3dIndex>
  if (typeof o.dummy !== 'boolean') fail('missing boolean "dummy"')
  if (typeof o.height_scale !== 'number' || !(o.height_scale > 0)) fail('missing positive "height_scale"')
  const g = o.chunk_grid
  if (!g || typeof g !== 'object') return fail('missing "chunk_grid"')
  if (typeof g.crs !== 'string') fail('chunk_grid.crs')
  if (!Array.isArray(g.origin_xy_m) || g.origin_xy_m.length !== 2) fail('chunk_grid.origin_xy_m')
  if (!(g.chunk_px > 0) || !(g.res_m > 0) || !(g.cols > 0) || !(g.rows > 0)) fail('chunk_grid size')
  if (g.cols !== g.rows) fail('chunk_grid must be square')
  if (!Array.isArray(g.chunks)) fail('chunk_grid.chunks')
  const h = o.height
  if (!h || h.dtype !== 'float32') return fail('height.dtype must be float32')
  if (h.units !== 'm') fail('height.units must be m')
  if (h.byte_order !== 'little' && h.byte_order !== 'big') fail('height.byte_order')
  if (h.row_order !== 'north_to_south' && h.row_order !== 'south_to_north') fail('height.row_order')
  if (typeof h.offset_m !== 'number') fail('height.offset_m')
  const f = o.far
  if (!f || typeof f.file !== 'string' || !(f.width > 0) || !(f.height > 0) || !(f.res_m > 0)) return fail('far grid')
  if (f.tex !== undefined && typeof f.tex !== 'string') fail('far.tex')
  return o as Fp3dIndex
}

/** NW corner of the far grid (analysis CRS): far.origin_xy_m, else the chunk grid's. */
export function farOrigin(idx: Pick<Fp3dIndex, 'chunk_grid' | 'far'>): [number, number] {
  const o = idx.far.origin_xy_m
  return Array.isArray(o) && o.length === 2 ? [o[0], o[1]] : [idx.chunk_grid.origin_xy_m[0], idx.chunk_grid.origin_xy_m[1]]
}

/** gunzip when the bytes start with the gzip magic (servers may already have decoded it). */
export async function gunzipIfNeeded(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const u8 = new Uint8Array(buf)
  if (u8.length < 2 || u8[0] !== 0x1f || u8[1] !== 0x8b) return buf
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))
  return await new Response(stream).arrayBuffer()
}

export interface HeightCodec {
  byte_order: 'little' | 'big'
  row_order: 'north_to_south' | 'south_to_north'
  scale: number
  offset_m: number
}

export function codecOf(idx: Fp3dIndex): HeightCodec {
  return {
    byte_order: idx.height.byte_order,
    row_order: idx.height.row_order,
    scale: idx.height_scale,
    offset_m: idx.height.offset_m,
  }
}

/**
 * Decode a float32 height grid into row-major Float32Array with row 0 = north, applying the
 * index's scale/offset (metres = raw * height_scale + offset_m).
 */
export function decodeHeights(buf: ArrayBuffer, cols: number, rows: number, h: HeightCodec): Float32Array {
  const n = cols * rows
  if (buf.byteLength !== 4 * n) {
    throw new Error(`height grid: expected ${4 * n} bytes for ${cols}x${rows}, got ${buf.byteLength}`)
  }
  const dv = new DataView(buf)
  const little = h.byte_order === 'little'
  const flip = h.row_order === 'south_to_north'
  const out = new Float32Array(n)
  for (let r = 0; r < rows; r++) {
    const src = (flip ? rows - 1 - r : r) * cols
    const dst = r * cols
    for (let c = 0; c < cols; c++) {
      out[dst + c] = dv.getFloat32(4 * (src + c), little) * h.scale + h.offset_m
    }
  }
  return out
}

export interface Eqc {
  R: number
  latTsDeg: number
  lon0Deg: number
  lat0Deg: number
  x0: number
  y0: number
}

const DEG = Math.PI / 180

export function parseEqc(proj: string): Eqc {
  const kv = new Map<string, string>()
  for (const tok of proj.trim().split(/\s+/)) {
    const m = /^\+([A-Za-z_0-9]+)(?:=(.*))?$/.exec(tok)
    if (m) kv.set(m[1], m[2] ?? '')
  }
  if (kv.get('proj') !== 'eqc') throw new Error(`not an eqc projection: ${proj}`)
  const units = kv.get('units')
  if (units !== undefined && units !== 'm') throw new Error(`eqc units must be m: ${proj}`)
  const R = Number(kv.get('R'))
  if (!Number.isFinite(R) || R <= 0) throw new Error(`eqc needs +R: ${proj}`)
  const n = (k: string) => {
    const v = kv.get(k)
    if (v === undefined) return 0 // PROJ default for these parameters
    const x = Number(v)
    if (!Number.isFinite(x)) throw new Error(`bad +${k} in ${proj}`)
    return x
  }
  return { R, latTsDeg: n('lat_ts'), lon0Deg: n('lon_0'), lat0Deg: n('lat_0'), x0: n('x_0'), y0: n('y_0') }
}

export function lonLatToXY(p: Eqc, lon: number, lat: number): [number, number] {
  return [
    p.x0 + p.R * (lon - p.lon0Deg) * DEG * Math.cos(p.latTsDeg * DEG),
    p.y0 + p.R * (lat - p.lat0Deg) * DEG,
  ]
}

export class HeightGrid {
  readonly west: number
  readonly north: number
  readonly res: number
  readonly cols: number
  readonly rows: number
  readonly data: Float32Array

  constructor(west: number, north: number, res: number, cols: number, rows: number, data: Float32Array) {
    if (data.length !== cols * rows) throw new Error('HeightGrid: data size mismatch')
    this.west = west
    this.north = north
    this.res = res
    this.cols = cols
    this.rows = rows
    this.data = data
  }

  /** Value at lattice (c, r), clamped to the grid. */
  at(c: number, r: number): number {
    const cc = c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c
    const rr = r < 0 ? 0 : r >= this.rows ? this.rows - 1 : r
    return this.data[rr * this.cols + cc]
  }

  /** Bilinear between pixel centres (clamped at the edges). */
  bilinear(x: number, y: number): number {
    const u = (x - this.west) / this.res - 0.5
    const v = (this.north - y) / this.res - 0.5
    const c = Math.floor(u)
    const r = Math.floor(v)
    const fc = u - c
    const fr = v - r
    return (
      this.at(c, r) * (1 - fc) * (1 - fr) +
      this.at(c + 1, r) * fc * (1 - fr) +
      this.at(c, r + 1) * (1 - fc) * fr +
      this.at(c + 1, r + 1) * fc * fr
    )
  }
}
