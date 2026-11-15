// Every nav file the /nav page reads validates against contracts/ through WS5's loader; broken
// files are refused with a DataError. The fix-interval summary is one file with a `set` field
// (contracts v1.0.0).
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { schemaFor } from '../data/contracts'
import { DataError, type TextFetcher } from '../data/loader'
import { createNavLoader, SUMMARY_PATH } from './load'

const DUMMY = resolve(__dirname, '../../public/data-dummy')
const fsFetcher =
  (patch: Record<string, string | null> = {}): TextFetcher =>
  async (path) => {
    if (path in patch) return patch[path]
    try {
      return await readFile(resolve(DUMMY, path), 'utf8')
    } catch {
      return null
    }
  }

describe('nav loader on data-dummy/', () => {
  it("WS5's SCHEMA_MAP covers every nav path", () => {
    for (const p of ['nav/montecarlo_medium.json', 'nav/fixes.json', 'nav/tracks_high.geojson', SUMMARY_PATH, 'localisation/NLB_1.json']) {
      expect(schemaFor(p), p).toBeDefined()
    }
  })
  it('loads the dummy montecarlo, fixes, tracks and the summary for its own set only', async () => {
    const L = createNavLoader(fsFetcher(), 'dummy')
    const mc = await L.montecarlo('medium')
    expect(mc.per_minute.length).toBeGreaterThan(100)
    expect((await L.fixes()).map((f) => f.type)).toContain('station')
    const tr = await L.tracks('medium')
    expect(tr.features.every((f) => typeof f.properties.t_eva_min === 'number')).toBe(true)
    expect((await L.summary('medium'))?.set).toBe('medium')
    expect(await L.summary('low')).toBeNull()
  })
  it('refuses a file that breaks its contract, and reports a missing set as missing', async () => {
    const L = createNavLoader(fsFetcher({ 'nav/fixes.json': JSON.stringify([{ t_eva_min: 1, station: null, type: 'skyline', sigma_m: 3 }]) }), 'dummy')
    await expect(L.fixes()).rejects.toBeInstanceOf(DataError) // skyline without error_m / image_id
    await expect(L.montecarlo('low')).rejects.toMatchObject({ kind: 'missing' })
  })
  it('refuses dummy-flagged nav files in real mode', async () => {
    const L = createNavLoader(fsFetcher(), 'real')
    await expect(L.montecarlo('medium')).rejects.toMatchObject({ kind: 'dummy-in-real' })
  })
})
