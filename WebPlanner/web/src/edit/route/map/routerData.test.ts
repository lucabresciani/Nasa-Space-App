// WP6 (D97, team lead 12:46): the waypoint router's data files are present and load with WP6's own
// code path (heights.ts, the fp3d subset ported after D99 removed web/src/fp3d/, and grid.ts). D99
// removed the 3D VIEW code only; these files must stay:
//   web/public/data/fp3d/index.json   (far block: the 8 m height grid)
//   web/public/data/fp3d/far.f32.gz   (heights, decoded to width x height float32)
//   web/public/data/fields/index.json + the default scenario's T_home PNG (the 5 m routing grid)
// Skips only when web/public/data is absent altogether (a checkout without the real data); a present
// data tree with a missing or unreadable file FAILS.
/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeRGBA, FieldGrid } from '../../../hud/fields'
import { readPngRGBA, REPO } from '../../../hud/testutil'
import type { FieldsIndex } from '../../../hud/types'
import { CONFIG } from '../../../config'
import { accessCell, cellOf, lonLatOfCell, routeGridOf, sampleElevation } from './grid'
import { codecOf, decodeHeights, farOrigin, gunzipIfNeeded, HeightGrid, lonLatToXY, parseEqc, parseIndex } from './heights'
import { gradeModel, scenarioParams } from './physio'
import { LegRouter } from './router'
import { ACCESS_RADIUS_M } from './validity'

const PUB = resolve(REPO, 'web/public/data')
/** The official pad (team lead 12:46). */
const PAD = { lon: 137.393301, lat: -4.776468 }

describe.skipIf(!existsSync(PUB))('waypoint router data files are present and load (D99 must not remove them)', () => {
  const file = (rel: string) => {
    const p = resolve(PUB, rel)
    expect(existsSync(p), `web/public/data/${rel} is missing`).toBe(true)
    return p
  }

  it('fp3d/index.json parses with the far block; far.f32.gz decodes to width x height floats; the pad samples a finite elevation', async () => {
    const fp = parseIndex(JSON.parse(readFileSync(file('fp3d/index.json'), 'utf8')))
    expect(fp.far.file).toBe('fp3d/far.f32.gz')
    expect(fp.far.width).toBeGreaterThan(0)
    expect(fp.far.height).toBeGreaterThan(0)
    const raw = readFileSync(file(fp.far.file))
    const buf = await gunzipIfNeeded(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer)
    const z = decodeHeights(buf, fp.far.width, fp.far.height, codecOf(fp))
    expect(z.length).toBe(fp.far.width * fp.far.height)
    const [west, north] = farOrigin(fp)
    const h = new HeightGrid(west, north, fp.far.res_m, fp.far.width, fp.far.height, z)
    const [x, y] = lonLatToXY(parseEqc(fp.chunk_grid.crs), PAD.lon, PAD.lat)
    // inside the far grid, not clamped at its edge
    expect(x).toBeGreaterThan(west)
    expect(x).toBeLessThan(west + fp.far.width * fp.far.res_m)
    expect(y).toBeLessThan(north)
    expect(y).toBeGreaterThan(north - fp.far.height * fp.far.res_m)
    const e = h.bilinear(x, y)
    expect(Number.isFinite(e)).toBe(true)
  })

  it('the default scenario T_home field grid loads; the pad cell is walkable; a leg from the pad routes on the real grid', async () => {
    const fi = JSON.parse(readFileSync(file('fields/index.json'), 'utf8')) as FieldsIndex
    const sid = CONFIG.defaultScenario
    const meta = fi.fields[`${sid}/t_home`]
    expect(meta, `fields/index.json has no ${sid}/t_home`).toBeTruthy()
    const { rgba, width, height } = readPngRGBA(file(meta.file))
    const tHome = new FieldGrid(fi, decodeRGBA(rgba, width, height, meta.scale), meta.units)
    expect(tHome.width * tHome.height).toBe(fi.width * fi.height)
    // the route grid with the real heights, as loadRouteGrid builds it
    const fp = parseIndex(JSON.parse(readFileSync(file('fp3d/index.json'), 'utf8')))
    const raw = readFileSync(file(fp.far.file))
    const buf = await gunzipIfNeeded(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer)
    const [west, north] = farOrigin(fp)
    const heights = new HeightGrid(west, north, fp.far.res_m, fp.far.width, fp.far.height, decodeHeights(buf, fp.far.width, fp.far.height, codecOf(fp)))
    const eqc = parseEqc(fp.chunk_grid.crs)
    const grid = routeGridOf(tHome, sampleElevation(tHome, heights, (lon, lat) => lonLatToXY(eqc, lon, lat)))
    const pad = accessCell(grid, cellOf(tHome, PAD.lon, PAD.lat), ACCESS_RADIUS_M)
    expect(pad, 'no walkable cell within the access radius of the pad').not.toBeNull()
    expect(Number.isFinite(grid.elev[pad!])).toBe(true)
    // ~100 m east of the pad: a walkable cell there routes from the pad with a finite time
    const [plon, plat] = lonLatOfCell(tHome, pad!)
    const to = accessCell(grid, cellOf(tHome, plon + 100 / tHome.mPerDegLon, plat), ACCESS_RADIUS_M)
    expect(to).not.toBeNull()
    const leg = new LegRouter(grid, gradeModel(scenarioParams(sid))).route(pad!, to!)
    expect(leg).not.toBeNull()
    expect(Number.isFinite(leg!.timeS)).toBe(true)
    expect(leg!.distM).toBeGreaterThan(0)
  })
})
