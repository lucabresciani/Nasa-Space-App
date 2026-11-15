import { describe, expect, it } from 'vitest'
import type { TileJson } from '../data/types'
import { basemapSources } from './basemap'

// The real tilejson.json written by make web (C 10:35Z): z13-16 over bounds, z17/z18 focus only.
const TJ: TileJson = {
  tilejson: '3.0.0',
  scheme: 'xyz',
  format: 'webp',
  tileSize: 256,
  tiles: ['tiles/basemap/{z}/{x}/{y}.webp'],
  minzoom: 13,
  maxzoom: 18,
  bounds: [137.307129, -4.877521, 137.455444, -4.735201],
  attribution: 'HiRISE: NASA/JPL/University of Arizona',
  zoom_bounds: { '17': [137.367554, -4.820049, 137.422485, -4.768047], '18': [137.368927, -4.820049, 137.421112, -4.769415] },
}
const prefix = (p: string) => `./data/${p}`

describe('basemap sources from tilejson.json (contract v1.1.0)', () => {
  it('one source for minzoom..(first zoom_bounds key - 1) on bounds, one per partial zoom on its zoom_bounds', () => {
    const s = basemapSources(TJ, prefix)
    expect(s.map((x) => [x.minzoom, x.maxzoom])).toEqual([
      [13, 16],
      [17, 17],
      [18, 18],
    ])
    expect(s[0].bounds).toEqual(TJ.bounds)
    expect(s[1].bounds).toEqual(TJ.zoom_bounds!['17'])
    expect(s[2].bounds).toEqual(TJ.zoom_bounds!['18'])
  })
  it('tile URLs are prefixed with the data base URL, size and attribution pass through', () => {
    const s = basemapSources(TJ, prefix)
    for (const x of s) {
      expect(x.tiles).toEqual(['./data/tiles/basemap/{z}/{x}/{y}.webp'])
      expect(x.tileSize).toBe(256)
      expect(x.attribution).toBe(TJ.attribution)
    }
  })
  it('partial-zoom layers start at their own zoom (no overzoomed z16 drawn over real z17 tiles)', () => {
    const s = basemapSources(TJ, prefix)
    expect(s.map((x) => x.layerMinzoom)).toEqual([undefined, 17, 18])
  })
  it('without zoom_bounds: a single source over minzoom..maxzoom', () => {
    const { zoom_bounds: _, ...plain } = TJ
    const s = basemapSources(plain as TileJson, prefix)
    expect(s).toHaveLength(1)
    expect([s[0].minzoom, s[0].maxzoom]).toEqual([13, 18])
  })
  it('ignores zoom_bounds keys outside minzoom..maxzoom', () => {
    const s = basemapSources({ ...TJ, zoom_bounds: { '12': TJ.bounds, '19': TJ.bounds } }, prefix)
    expect(s).toHaveLength(1)
    expect([s[0].minzoom, s[0].maxzoom]).toEqual([13, 18])
  })
})
