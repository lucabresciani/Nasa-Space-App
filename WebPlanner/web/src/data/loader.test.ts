import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLoader, DataError, type TextFetcher } from './loader'

const DUMMY = resolve(__dirname, '../../public/data-dummy')

const fsFetcher =
  (root: string, patch: Record<string, string> = {}): TextFetcher =>
  async (path) => {
    if (path in patch) return patch[path]
    try {
      return await readFile(resolve(root, path), 'utf8')
    } catch {
      return null
    }
  }

describe('loader on data-dummy/ (every file the web app reads validates against contracts/)', () => {
  const L = createLoader(fsFetcher(DUMMY), 'dummy')

  it('scenarios index and every scenario file', async () => {
    const idx = await L.scenarios()
    expect(idx.dummy).toBe(true)
    expect(idx.scenarios.map((s) => s.id)).toContain(idx.default)
    for (const s of idx.scenarios) {
      const iso = await L.isochrones(s)
      expect(iso.features.length).toBe(60)
      expect((await L.bands(s)).features.length).toBeGreaterThan(0)
      expect((await L.edges(s)).features.length).toBeGreaterThan(0)
      await L.partner(s)
    }
  })

  it('stations, cards, route, timeline, trade, pad, rad, manifest, fields index', async () => {
    const st = await L.stations()
    expect(st.map((s) => s.id)).toEqual(['S1', 'S2', 'S3'])
    for (const s of st) expect((await L.card(s)).landmarks.length).toBeGreaterThan(0)
    expect((await L.route('nom_104')).type).toBe('FeatureCollection')
    expect((await L.timeline('nom_104')).length).toBeGreaterThan(0)
    expect((await L.trade()).cells.length).toBe(2)
    expect((await L.pad()).dummy).toBe(true)
    expect((await L.rad()).storm_2024.series.length).toBeGreaterThan(0)
    expect((await L.manifest()).dummy).toBe(true)
    expect((await L.fieldsIndex()).dummy).toBe(true)
    expect((await L.fixIntervalSummary()).set).toBe('medium')
  })

  it('optional files that are absent resolve to null', async () => {
    expect(await L.optional(() => L.v1())).toBeNull()
    expect(await L.optional(() => L.rems())).toBeNull()
  })
})

describe('loader guards', () => {
  it('a missing required key is an invalid-file error naming the path', async () => {
    const L = createLoader(fsFetcher(DUMMY, { 'trade_table.json': JSON.stringify({ rows: [30], cols: [104] }) }), 'dummy')
    await expect(L.trade()).rejects.toMatchObject({ kind: 'invalid', path: 'trade_table.json' })
  })

  it('a missing file is a missing error', async () => {
    const L = createLoader(fsFetcher('/nonexistent'), 'real')
    const err = await L.scenarios().catch((e) => e)
    expect(err).toBeInstanceOf(DataError)
    expect(err.kind).toBe('missing')
  })

  it('a path no contract covers is refused, even if the file exists', async () => {
    const L = createLoader(fsFetcher(DUMMY, { 'tiles/other/index.json': '{}' }), 'dummy')
    await expect(L.json('tiles/other/index.json')).rejects.toMatchObject({ kind: 'no-contract' })
  })

  it('real mode refuses any file flagged dummy (never show dummy numbers as real)', async () => {
    const L = createLoader(fsFetcher(DUMMY), 'real')
    await expect(L.scenarios()).rejects.toMatchObject({ kind: 'dummy-in-real' })
    await expect(L.trade()).rejects.toMatchObject({ kind: 'dummy-in-real' })
    await expect(L.optional(() => L.pad())).rejects.toMatchObject({ kind: 'dummy-in-real' })
  })

  it('invalid JSON is a parse error', async () => {
    const L = createLoader(fsFetcher(DUMMY, { 'stations.json': '[{' }), 'dummy')
    await expect(L.stations()).rejects.toMatchObject({ kind: 'parse' })
  })
})
