// WS16 task 5 (M5) acceptance: the cursor readout equals the field values at that cell (DESIGN U4).
// Real tree: t_home PNGs through FieldData.at (= fieldAt), the shared slope PNG through WS7's FieldGrid.
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeRGBA, FieldGrid, fieldGrid } from '../hud/fields'
import { readJson, readPngRGBA, REPO } from '../hud/testutil'
import type { FieldsIndex } from '../hud/types'
import { decodeGrid, decodeState, FieldData, fieldAt, setActiveField, type Bounds } from './field/decode'
import { DASH } from './furniture/text'
import { readoutRows, readoutValues } from './readout'

const PUB = resolve(REPO, 'web/public/data')
const index = readJson<FieldsIndex>('fields/index.json', PUB)
const grid = (key: string) => {
  const meta = index.fields[key]
  const { rgba, width, height } = readPngRGBA(resolve(PUB, meta.file))
  return decodeGrid(rgba, width, height, meta.scale, index.bounds as Bounds)
}
const cs = readJson<{ image: string; bounds: Bounds }>('terrain/cellstate.json', PUB)
const csPng = readPngRGBA(resolve(PUB, cs.image))
const field = new FieldData(104, { opt: grid('opt_104/t_home'), nom: grid('nom_104/t_home'), con: grid('con_104/t_home') }, grid('nom_104/o2_home'), decodeState(csPng.rgba, csPng.width, csPng.height, cs.bounds), [], index.res_m)
const slopeMeta = index.fields.slope
const slopePng = readPngRGBA(resolve(PUB, slopeMeta.file))
const slope = new FieldGrid(fieldGrid(index, 'slope'), decodeRGBA(slopePng.rgba, slopePng.width, slopePng.height, slopeMeta.scale), slopeMeta.units)

describe('cursor readout = fieldAt at the cell', () => {
  setActiveField(field)
  const [w, s, e, n] = index.bounds
  const pts: [number, number][] = []
  for (let i = 0; i < 25; i++) for (let j = 0; j < 25; j++) pts.push([w + ((i + 0.37) / 25) * (e - w), s + ((j + 0.61) / 25) * (n - s)])

  it('time home and slope are the field values; lon / lat are the cursor', () => {
    let withTime = 0
    for (const [lon, lat] of pts) {
      const sample = fieldAt(lon, lat)!
      const v = readoutValues(lon, lat, sample, (a, b) => slope.valueAt(a, b))
      const want = sample.unknown ? null : sample.tHome[sample.variant]
      expect(v.tHomeMin).toBe(want)
      expect(v.slopeDeg).toBe(slope.valueAt(lon, lat))
      const rows = Object.fromEntries(readoutRows(v).map((r) => [r.key, r.value]))
      expect(rows.timeHome).toBe(want === null ? DASH : `${want.toFixed(1)} min`)
      if (want !== null) {
        withTime++
        expect(Math.abs(parseFloat(rows.timeHome) - want)).toBeLessThanOrEqual(0.05)
      }
      expect(parseFloat(rows.lon)).toBeCloseTo(lon, 5)
      expect(parseFloat(rows.lat)).toBeCloseTo(lat, 5)
      expect(rows.slope).toBe(v.slopeDeg === null ? DASH : `${v.slopeDeg.toFixed(1)}°`)
    }
    expect(withTime).toBeGreaterThan(100)
  })

  it('elevation is a dash with a note (the field has no elevation)', () => {
    const r = readoutRows(readoutValues(pts[0][0], pts[0][1], fieldAt(...pts[0]), null)).find((x) => x.key === 'elevation')!
    expect(r.value).toBe(DASH)
    expect(r.note).toBeTruthy()
  })

  it('variant follows fieldAt (the plan variant)', () => {
    field.setMargin(null, 'con')
    const p = pts.find(([lon, lat]) => fieldAt(lon, lat)!.tHome.con !== null)!
    expect(readoutValues(p[0], p[1], fieldAt(...p), null).tHomeMin).toBe(fieldAt(...p)!.tHome.con)
    field.setMargin(null, 'nom')
    setActiveField(null)
  })
})

// M10b (orchestrator): the map's cursor readout used `.hl-readout*`, A2's card Readout component class, and
// its later-loading furniture.css overrode the card and dock readouts (A5b worked around it in cards).
describe('class names: the cursor readout never styles the card Readout component', () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '')
  const css = strip(readFileSync(resolve(REPO, 'web/src/map/furniture/furniture.css'), 'utf8'))
  const src = readFileSync(resolve(REPO, 'web/src/map/readout.ts'), 'utf8')
  it('furniture.css has no .hl-readout selector; the cursor readout rules are .hl-cursor-readout*', () => {
    expect(css).not.toMatch(/\.hl-readout/)
    for (const sel of ['.hl-cursor-readout {', '.hl-cursor-readout__row', '.hl-cursor-readout__label', '.hl-cursor-readout__value']) expect(css).toContain(sel)
  })
  it('readout.ts builds its DOM with the map-specific classes only', () => {
    expect(src).not.toMatch(/['`]hl-readout|\shl-readout/)
    expect(src).toContain("'maplibregl-ctrl hl-cursor-readout'")
  })
})
