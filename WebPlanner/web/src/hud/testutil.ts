/// <reference types="node" />
// Test-only helpers (never imported by the app; *.test.ts only): read the committed dummy data and the
// config YAML from Node, and decode 8-bit RGBA PNGs without a browser canvas.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { parse } from 'yaml'
import { parseHudConfig, type HudConfig } from './config'
import { decodeRGBA, FieldGrid, fieldGrid } from './fields'
import type { FieldsIndex } from './types'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
export const DUMMY = resolve(REPO, 'web/public/data-dummy')

export function readJson<T>(rel: string, root = DUMMY): T {
  return JSON.parse(readFileSync(resolve(root, rel), 'utf8')) as T
}

const yamlConfig = (f: string): unknown => parse(readFileSync(resolve(REPO, 'config', f), 'utf8'))

/** config/conditions.yaml (D39 storm_replay key, WS4). */
export function loadConditionsYaml(): unknown {
  return yamlConfig('conditions.yaml')
}

export function loadConfig(): HudConfig {
  return parseHudConfig(yamlConfig('hud.yaml'), yamlConfig('crew.yaml'), loadConditionsYaml())
}

/** Minimal PNG reader: 8-bit RGBA, non-interlaced (the field contract). Returns raw RGBA. */
export function readPngRGBA(path: string): { rgba: Uint8Array; width: number; height: number } {
  const buf = readFileSync(path)
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  sig.forEach((b, i) => {
    if (buf[i] !== b) throw new Error(`${path}: not a PNG`)
  })
  let off = 8
  let width = 0
  let height = 0
  const idat: Buffer[] = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const [depth, colour, , , interlace] = [data[8], data[9], data[10], data[11], data[12]]
      if (depth !== 8 || colour !== 6 || interlace !== 0) throw new Error(`${path}: not 8-bit RGBA non-interlaced`)
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const bpp = 4
  const stride = width * bpp
  const out = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0
      const b = y > 0 ? out[dst - stride + x] : 0
      const c = x >= bpp && y > 0 ? out[dst - stride + x - bpp] : 0
      let v = raw[src + x]
      if (ft === 1) v += a
      else if (ft === 2) v += b
      else if (ft === 3) v += (a + b) >> 1
      else if (ft === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (ft !== 0) throw new Error(`${path}: bad filter ${ft}`)
      out[dst + x] = v & 255
    }
  }
  return { rgba: out, width, height }
}

export function dummyIndex(): FieldsIndex {
  return readJson<FieldsIndex>('fields/index.json')
}

/** Decode a committed dummy field PNG into a FieldGrid (Node, no canvas; per-field grid honoured). */
export function dummyGrid(key: string): FieldGrid {
  const index = readJson<FieldsIndex>('fields/index.json')
  const meta = index.fields[key]
  if (!meta) throw new Error(`no dummy field ${key}`)
  const { rgba, width, height } = readPngRGBA(resolve(DUMMY, meta.file))
  return new FieldGrid(fieldGrid(index, key), decodeRGBA(rgba, width, height, meta.scale), meta.units)
}
