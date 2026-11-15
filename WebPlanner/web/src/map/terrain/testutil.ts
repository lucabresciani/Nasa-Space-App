// Test helpers for the terrain tiles (not shipped: only *.test.ts files import this). The PNG reader
// moved here from terrain.test.ts (M8) so T1's clearance test reads the same bytes the same way.
/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import { REPO } from '../../hud/testutil'
import { parseTerrainTiles, terrariumHeight, tilePixel, type TerrainTiles } from './tiles'

/** Minimal PNG reader (8-bit RGB or RGBA, non-interlaced): the tile's Terrarium bytes. */
export function readPng(path: string): { px: Uint8Array; w: number; bpp: number } {
  const buf = readFileSync(path)
  let off = 8
  let w = 0
  let h = 0
  let bpp = 0
  const idat: Buffer[] = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const d = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      w = d.readUInt32BE(0)
      h = d.readUInt32BE(4)
      if (d[8] !== 8 || d[12] !== 0 || (d[9] !== 2 && d[9] !== 6)) throw new Error(`${path}: not 8-bit RGB(A)`)
      bpp = d[9] === 6 ? 4 : 3
    } else if (type === 'IDAT') idat.push(d)
    else if (type === 'IEND') break
    off += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const st = w * bpp
  const out = new Uint8Array(h * st)
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (st + 1)]
    const s = y * (st + 1) + 1
    const o = y * st
    for (let x = 0; x < st; x++) {
      const a = x >= bpp ? out[o + x - bpp] : 0
      const b = y > 0 ? out[o - st + x] : 0
      const c = x >= bpp && y > 0 ? out[o - st + x - bpp] : 0
      let v = raw[s + x]
      if (ft === 1) v += a
      else if (ft === 2) v += b
      else if (ft === 3) v += (a + b) >> 1
      else if (ft === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[o + x] = v & 255
    }
  }
  return { px: out, w, bpp }
}


/** The published terrain tree (web/public/data/terrain), or null when this data tree has none. */
export const TERRAIN_DIR = resolve(REPO, 'web/public/data/terrain')
export const HAVE_TERRAIN = existsSync(resolve(TERRAIN_DIR, 'tiles.json'))

/**
 * True ground height (m, the tile value / factor) at lon/lat from the zoom-z tiles, nearest pixel;
 * null outside the published tiles.
 */
export function groundSampler(z = 15): { tiles: TerrainTiles; trueM: (lon: number, lat: number) => number | null } {
  const tiles = parseTerrainTiles(JSON.parse(readFileSync(resolve(TERRAIN_DIR, 'tiles.json'), 'utf8')))
  const cache = new Map<string, ReturnType<typeof readPng> | null>()
  const [w, s, e, n] = tiles.bounds
  const trueM = (lon: number, lat: number): number | null => {
    if (lon < w || lon > e || lat < s || lat > n) return null
    const p = tilePixel(lon, lat, z)
    const key = `${p.x}/${p.y}`
    if (!cache.has(key)) {
      const f = resolve(TERRAIN_DIR, String(z), String(p.x), `${p.y}.png`)
      cache.set(key, existsSync(f) ? readPng(f) : null)
    }
    const t = cache.get(key)
    if (!t) return null
    const k = (p.i * t.w + p.j) * t.bpp
    return terrariumHeight(t.px[k], t.px[k + 1], t.px[k + 2]) / tiles.factor
  }
  return { tiles, trueM }
}
