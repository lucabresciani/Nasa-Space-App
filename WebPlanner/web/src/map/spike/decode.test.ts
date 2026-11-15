// WS16 M1 spike: CPU mirror of the field shader on the REAL published field PNGs
// (web/public/data/fields/{opt,nom,con}_104/t_home.png, committed). Expected bytes and values were
// read independently with Pillow (python -I, PIL Image.open(...).convert('RGBA')) on 2026-11-14.
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeRGBA } from '../../hud/fields'
import { readJson, readPngRGBA, REPO } from '../../hud/testutil'
import type { FieldsIndex } from '../../hud/types'
import { byteOfNormalized, classify, decodeTexel, gridXform, hexToRgb01, sampleBilinear, texel, type RgbaField } from './decode'
import tokens from '../../ui/tokens.json'

const PUB = resolve(REPO, 'web/public/data')
const index = readJson<FieldsIndex>('fields/index.json', PUB)

function field(v: 'opt' | 'nom' | 'con'): RgbaField {
  const meta = index.fields[`${v}_104/t_home`]
  const { rgba, width, height } = readPngRGBA(resolve(PUB, meta.file))
  return { rgba, width, height, scale: meta.scale }
}

describe('decoder (counts = R*256 + G, A = 0 unknown, scale)', () => {
  it('t_home scale is 0.1 min on the 1480² 5 m grid', () => {
    expect(index.fields['nom_104/t_home'].scale).toBe(0.1)
    expect([index.width, index.height, index.res_m]).toEqual([1480, 1480, 5])
  })
  it('synthetic texels', () => {
    expect(decodeTexel(0, 0, 255, 0.1)).toBe(0)
    expect(decodeTexel(1, 44, 255, 0.1)).toBeCloseTo(30.0, 10) // 300 counts
    expect(decodeTexel(2, 88, 255, 0.1)).toBeCloseTo(60.0, 10) // 600 counts
    expect(decodeTexel(255, 255, 255, 0.01)).toBeCloseTo(655.35, 10)
    expect(decodeTexel(7, 140, 0, 0.1)).toBeNull() // A = 0: unknown whatever R, G say
  })
  it('normalised byte round trip is exact for every byte (shader floor(x*255+0.5))', () => {
    for (let b = 0; b < 256; b++) expect(byteOfNormalized(Math.fround(b / 255))).toBe(b)
  })

  const f = { opt: field('opt'), nom: field('nom'), con: field('con') }
  // [variant, row, col, RGBA (Pillow), value min | null]
  const known: [keyof typeof f, number, number, number[], number | null][] = [
    ['nom', 401, 973, [0, 1, 0, 255], 0.1], // the official pad's pixel
    ['nom', 401, 1173, [1, 146, 0, 255], 40.2],
    ['opt', 401, 1173, [1, 123, 0, 255], 37.9],
    ['con', 401, 1173, [2, 141, 0, 255], 65.3],
    ['nom', 0, 0, [7, 140, 0, 255], 193.2],
    ['nom', 689, 171, [7, 204, 0, 255], 199.6],
    ['con', 492, 373, [10, 88, 0, 255], 264.8],
    ['nom', 740, 740, [1, 120, 0, 255], 37.6],
    ['nom', 701, 873, [0, 0, 0, 0], null],
  ]
  it.each(known)('%s px (%i, %i)', (v, row, col, px, want) => {
    const fld = f[v]
    const j = (row * fld.width + col) * 4
    expect(Array.from(fld.rgba).slice(j, j + 4)).toEqual(px)
    const got = texel(fld, col, row)
    if (want === null) expect(got).toBeNull()
    else expect(got).toBeCloseTo(want, 9)
  })
  it('agrees with the WS7 reference decoder (hud/fields.ts) on every pixel of nom_104', () => {
    const fld = f.nom
    const ref = decodeRGBA(fld.rgba, fld.width, fld.height, fld.scale)
    let mismatches = 0
    for (let i = 0; i < fld.width * fld.height; i++) {
      const v = texel(fld, i % fld.width, Math.floor(i / fld.width))
      const r = ref.known[i] ? ref.counts[i] * fld.scale : null
      if (v !== r) mismatches++
    }
    expect(mismatches).toBe(0)
  })
  it('manual bilinear: exact at a pixel centre, mean between centres, unknown if any neighbour unknown', () => {
    const fld = f.nom
    const uv = (row: number, col: number): [number, number] => [(col + 0.5) / fld.width, (row + 0.5) / fld.height]
    expect(sampleBilinear(fld, ...uv(401, 1173))).toBeCloseTo(40.2, 9)
    const a = texel(fld, 1173, 401)!
    const b = texel(fld, 1174, 401)!
    const [u, v] = uv(401, 1173)
    expect(sampleBilinear(fld, u + 0.5 / fld.width, v)).toBeCloseTo((a + b) / 2, 9)
    // (701, 873) is unknown: every sample whose 2x2 footprint touches it is unknown
    const [u2, v2] = uv(701, 873)
    expect(sampleBilinear(fld, u2, v2)).toBeNull()
    expect(sampleBilinear(fld, u2 + 0.4 / fld.width, v2 + 0.4 / fld.height)).toBeNull()
  })
})

describe('colour classification (bands vs budget, simple margin, unknown)', () => {
  const base = { tMin: 0, tEvaMin: 390, amberMin: 10, terrainUnknown: false }
  it.each([
    [29.9, 30, 'safe'],
    [30.0, 30, 'safe'],
    [30.1, 30, 'none'],
    [40.2, 30, 'none'],
    [40.2, 60, 'safe'],
    [60.1, 60, 'none'],
  ] as const)('bands: T_home %f, budget %i -> %s', (tHome, budget, want) => {
    expect(classify({ ...base, mode: 'bands', tHome, budget })).toBe(want)
  })
  it.each([
    [40.2, 0, 'safe'], // m = 349.8
    [40.2, 300, 'safe'], // m = 49.8
    [40.2, 340, 'caution'], // m = 9.8 (under the 10-min amber)
    [40.2, 345, 'caution'], // m = 4.8
    [40.2, 350, 'limit'], // m = -0.2
    [0.1, 389, 'caution'], // at the pad near the end of the EVA: m = 0.9
  ] as const)('margin (T_EVA 390): T_home %f at t %f -> %s', (tHome, tMin, want) => {
    expect(classify({ ...base, mode: 'margin', tHome, tMin, budget: 30 })).toBe(want)
  })
  it('margin zero is caution, not limit', () => {
    expect(classify({ ...base, mode: 'margin', tHome: 40, tMin: 350, budget: 30 })).toBe('caution')
  })
  it('unknown terrain is always the hatch class, never a warning colour, in both modes', () => {
    for (const mode of ['bands', 'margin'] as const) {
      expect(classify({ ...base, mode, tHome: 500, tMin: 389, budget: 30, terrainUnknown: true })).toBe('unknown')
      expect(classify({ ...base, mode, tHome: null, tMin: 389, budget: 30, terrainUnknown: true })).toBe('unknown')
    }
  })
  it('known terrain without T_home (blocked / unreached) is not coloured', () => {
    expect(classify({ ...base, mode: 'margin', tHome: null, budget: 30 })).toBe('none')
    expect(classify({ ...base, mode: 'bands', tHome: null, budget: 60 })).toBe('none')
  })
  it('colours come from tokens.json', () => {
    expect(hexToRgb01(tokens.color.safe)).toEqual([0x3d / 255, 0xd6 / 255, 0x8c / 255])
    expect(() => hexToRgb01('rgba(0,0,0,1)')).toThrow()
  })
  it('field uv -> 3 m cell-state uv', () => {
    const cs = readJson<{ bounds: [number, number, number, number] }>('terrain/cellstate.json', PUB)
    const [ou, ov, su, sv] = gridXform(index.bounds as [number, number, number, number], cs.bounds)
    // field NW corner maps just inside the (slightly larger) state grid
    expect(ou).toBeGreaterThan(0)
    expect(ov).toBeGreaterThan(0)
    expect(ou + su).toBeLessThan(1)
    expect(ov + sv).toBeLessThan(1)
  })
})
