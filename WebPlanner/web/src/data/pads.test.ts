// D21 "Rover parking options" (user 16:14, C layout 16:17): the picker data under scenarios/pads/.
// WS2's files and C's contract rows do not exist yet, so these tests build a fixture tree from the
// 16:17 layout: index.json + summary.json in the provisional shape below, and the reused shapes
// (bands, edges, partner, route, timeline) copied from data-dummy/ and checked against the existing
// contract schemas, exactly as C's SCHEMA_MAP rows will map them.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { schemaFor } from './contracts'
import { createLoader, type TextFetcher } from './loader'
import { dragKeyPrefix } from './partner'
import {
  PADS_INDEX,
  PAD_SCHEMA_PATTERNS,
  headlineFor,
  loadPadsIndex,
  padFiles,
  padKey,
  padViewMode,
  parsePadSummary,
  parsePadsIndex,
} from './pads'
import type { JsonSchema } from './schema'
import type { ScenarioEntry } from './types'

const DUMMY = resolve(__dirname, '../../public/data-dummy')

// What C's SCHEMA_MAP rows will do: the reused shapes map to their existing schemas; index.json and
// summary.json get a provisional object schema here (their contracts are C's, written after WS2).
const PROVISIONAL: JsonSchema = { type: 'object', required: ['dummy'], properties: { dummy: { type: 'boolean' } } }
const glob = (pattern: string) => new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '[^/]*') + '$')
function padSchemaLookup(path: string): JsonSchema | undefined {
  const own = schemaFor(path)
  if (own) return own
  const row = PAD_SCHEMA_PATTERNS.find((r) => glob(r.pattern).test(path))
  if (!row) return undefined
  return row.shape ? schemaFor(row.shape) : PROVISIONAL
}

const NOM: ScenarioEntry = {
  id: 'nom_104',
  variant: 'nominal',
  suit_kg: 104,
  files: { isochrones: 'scenarios/nom_104/isochrones.geojson', bands: 'scenarios/bands_104.geojson', edges: 'scenarios/nom_104/edges.geojson', partner: 'scenarios/nom_104/partner.geojson' },
  headline: { budget_min: 30, reachable_pct: 12.4, range_pct: [4.6, 17.5] },
}

// Provisional shapes (C 16:17 layout). Numbers are fixture values, not results.
const INDEX = {
  dummy: false,
  pads: [
    { id: 'c112', lon: 137.41, lat: -4.77, elev_m: -3800.5, rank: 2, score: 9, tiebreak: { reachable_pct_30min: 31.2, elev_m: -3800.5 }, official: false },
    { id: 'c044', lon: 137.4, lat: -4.76, elev_m: -3812.0, rank: 1, score: 11, tiebreak: { reachable_pct_30min: 28.0, elev_m: -3812.0 }, official: true },
    { id: 'pad_default', lon: 137.382, lat: -4.806, elev_m: -3627.8, rank: 17, score: 2, tiebreak: { reachable_pct_30min: 12.4, elev_m: -3627.8 }, official: false },
    { id: 'c201', lon: 137.39, lat: -4.78, elev_m: -3790.0, rank: 3, score: 9, tiebreak: { reachable_pct_30min: 22.5, elev_m: -3790.0 }, official: false },
  ],
}
const SUMMARY_C112 = {
  dummy: false,
  id: 'c112',
  pad: { lon: 137.41, lat: -4.77, elev_m: -3800.5 },
  rank: 2,
  score: 9,
  tiebreak: { reachable_pct_30min: 31.2, elev_m: -3800.5 },
  headline: { '30': { reachable_pct: 20.1, range_pct: [8.3, 25.0] }, '60': { reachable_pct: 44.0, range_pct: [30.2, 51.9] } },
  route: { stops: ['pad', 'S4', 'S2', 'pad'], total_min: 201.5 },
}

async function fixtureFetcher(index: unknown = INDEX, extra: Record<string, unknown> = {}): Promise<TextFetcher> {
  // The data-dummy/ shapes, re-flagged as a real tree (WS2 writes dummy: false).
  const read = async (p: string) => {
    const v = JSON.parse(await readFile(resolve(DUMMY, p), 'utf8'))
    return JSON.stringify(Array.isArray(v) ? v : { ...v, dummy: false })
  }
  const tree: Record<string, string> = {
    [PADS_INDEX]: JSON.stringify(index),
    'scenarios/pads/c112/summary.json': JSON.stringify(SUMMARY_C112),
    'scenarios/pads/c112/bands_104.geojson': await read('scenarios/bands_104.geojson'),
    'scenarios/pads/c112/edges.geojson': await read('scenarios/nom_104/edges.geojson'),
    'scenarios/pads/c112/partner.geojson': await read('scenarios/nom_104/partner.geojson'),
    'scenarios/pads/c112/route_nom_104.geojson': await read('route_nom_104.geojson'),
    'scenarios/pads/c112/timeline_nom_104.json': await read('timeline_nom_104.json'),
  }
  for (const [k, v] of Object.entries(extra)) tree[k] = JSON.stringify(v)
  return async (p) => tree[p] ?? null
}

describe('D21 picker paths (16:17 layout)', () => {
  it('padFiles: the per-pad files follow the default scenario (nominal, its suit)', () => {
    expect(padFiles('c112', NOM)).toEqual({
      summary: 'scenarios/pads/c112/summary.json',
      bands: 'scenarios/pads/c112/bands_104.geojson',
      edges: 'scenarios/pads/c112/edges.geojson',
      partner: 'scenarios/pads/c112/partner.geojson',
      route: 'scenarios/pads/c112/route_nom_104.geojson',
      timeline: 'scenarios/pads/c112/timeline_nom_104.json',
    })
  })

  it('an id that is not a plain file name is refused (no path tricks)', () => {
    expect(() => padFiles('../x', NOM)).toThrow()
    expect(() => parsePadsIndex({ dummy: false, pads: [{ ...INDEX.pads[1], id: 'a/b' }] })).toThrow(/id/)
  })

  it('PAD_SCHEMA_PATTERNS cover every picker path; reused shapes map to the existing schemas', () => {
    const f = padFiles('c112', NOM)
    for (const p of [PADS_INDEX, ...Object.values(f)]) expect(PAD_SCHEMA_PATTERNS.some((r) => glob(r.pattern).test(p)), p).toBe(true)
    for (const r of PAD_SCHEMA_PATTERNS.filter((x) => x.shape)) {
      expect(schemaFor(r.shape!), r.shape!).toBeDefined()
    }
    expect(PAD_SCHEMA_PATTERNS.find((r) => r.pattern === 'scenarios/pads/*/bands_*.geojson')?.shape).toBe('scenarios/bands_*.geojson')
    expect(PAD_SCHEMA_PATTERNS.find((r) => r.pattern === 'scenarios/pads/*/route_*.geojson')?.shape).toBe('route_*.geojson')
  })

  it('no pad path is covered by an existing row by accident (C adds the rows)', () => {
    // Before C's rows exist, the loader refuses these paths; if a row exists it must map the right shape.
    for (const r of PAD_SCHEMA_PATTERNS) {
      const sample = r.pattern.replace('*/', 'c112/').replace('*', '104')
      const got = schemaFor(sample)
      if (got && r.shape) expect(got).toBe(schemaFor(r.shape))
    }
  })

  it('manifest keys sit under pads.{id}.*', () => {
    expect(padKey('c112', 'headline', 30, 'reachable_pct')).toBe('pads.c112.headline.30.reachable_pct')
    expect(dragKeyPrefix('scenarios/pads/c112/partner.geojson', 'scenarios/nom_104/partner.geojson')).toBe('pads.c112.haul.drag.flat')
    expect(dragKeyPrefix('scenarios/nom_104/partner.geojson', 'scenarios/nom_104/partner.geojson')).toBe('haul.drag.flat')
    expect(dragKeyPrefix('scenarios/opt_104/partner.geojson', 'scenarios/nom_104/partner.geojson')).toBe('haul.drag.flat.opt_104')
  })
})

describe('parsePadsIndex', () => {
  const v = parsePadsIndex(INDEX)
  it('rows sorted by rank; the official row flagged and found', () => {
    expect(v.options.map((o) => o.id)).toEqual(['c044', 'c112', 'c201', 'pad_default'])
    expect(v.official.id).toBe('c044')
    expect(v.options.filter((o) => o.official)).toHaveLength(1)
  })
  it('score = feasible-EVA count and tiebreak values as written', () => {
    const o = v.options.find((x) => x.id === 'c112')!
    expect(o.score).toBe(9)
    expect(o.tiebreak).toEqual([
      ['reachable_pct_30min', 31.2],
      ['elev_m', -3800.5],
    ])
    expect(o.elevM).toBe(-3800.5)
  })
  it('labels: official pad, pad_default by name, others by rank', () => {
    expect(v.options.map((o) => o.label)).toEqual(['Official pad', '#2', '#3', 'pad_default'])
  })
  it('the official id may come from a top-level `official` field', () => {
    const rows = INDEX.pads.map(({ official: _, ...r }) => r)
    expect(parsePadsIndex({ dummy: false, official: 'c044', pads: rows }).official.id).toBe('c044')
  })
  it('a `rows` array is read like `pads`', () => {
    expect(parsePadsIndex({ dummy: false, rows: INDEX.pads }).options).toHaveLength(4)
  })
  it('no official row, two official rows, or no rows: refused with a reason', () => {
    expect(() => parsePadsIndex({ dummy: false, pads: INDEX.pads.map((r) => ({ ...r, official: false })) })).toThrow(/official/)
    expect(() => parsePadsIndex({ dummy: false, pads: INDEX.pads.map((r) => ({ ...r, official: true })) })).toThrow(/official/)
    expect(() => parsePadsIndex({ dummy: false, pads: [] })).toThrow(/rows/)
  })
})

describe('parsePadSummary', () => {
  const s = parsePadSummary(SUMMARY_C112, 'c112')
  it('headline at 30 and 60 min, keyed by budget', () => {
    expect(s.headlines.map((h) => h.budget)).toEqual([30, 60])
    expect(headlineFor(s, 60)).toEqual({ budget: 60, reachablePct: 44.0, range: [30.2, 51.9], inDataPct: null, inData: false })
    expect(headlineFor(s, 30)?.reachablePct).toBe(20.1)
  })
  it('a budget without a headline falls back to the first one', () => {
    expect(headlineFor(s, 45)?.budget).toBe(30)
  })
  it('an array headline form reads the same', () => {
    const a = parsePadSummary({ ...SUMMARY_C112, headline: [{ budget_min: 60, reachable_pct: 44.0, range_pct: [30.2, 51.9] }, { budget_min: 30, reachable_pct: 20.1 }] }, 'c112')
    expect(a.headlines.map((h) => h.budget)).toEqual([30, 60])
    expect(headlineFor(a, 30)).toEqual({ budget: 30, reachablePct: 20.1, range: null, inDataPct: null, inData: false })
  })
  it('score, rank, pad position and route summary as written', () => {
    expect(s.score).toBe(9)
    expect(s.rank).toBe(2)
    expect([s.lon, s.lat, s.elevM]).toEqual([137.41, -4.77, -3800.5])
    expect(s.route).toEqual({ stops: ['pad', 'S4', 'S2', 'pad'], totalMin: 201.5 })
  })
  it('a summary for another pad is refused', () => {
    expect(() => parsePadSummary(SUMMARY_C112, 'c201')).toThrow(/c201/)
  })
})

// WS2 session 8 shapes (real files, numbers as WS2 reported them): D43 in-data share at 60 min, D45
// excluded-combination count on every index row and summary.
describe('WS2 session 8: feasible counts (D45) and the 60-min in-data share (D43)', () => {
  const feasible = (screen: number, full: number) => ({ screen_count: screen, full_run_count: full, excluded_by_effort_cap_rule: screen - full, note: 'upper bound' })
  const idx = {
    dummy: false,
    official: 'rank1',
    pads: [
      { id: 'rank1', kind: 'block', lon: 137.401783, lat: -4.77748, elev_m: -3742.4, rank: 1, score: 38, official: true, picker: false, tiebreak: { reachable_pct_30: 22.98, elev_m: -3742.4 }, feasible: feasible(52, 38), summary: null },
      { id: 'rank2', kind: 'block', lon: 137.393301, lat: -4.776468, elev_m: -3779.5, rank: 2, score: 38, official: false, picker: true, tiebreak: { reachable_pct_30: 21.46, elev_m: -3779.5 }, feasible: feasible(51, 38), summary: 'scenarios/pads/rank2/summary.json' },
      { id: 'pad_default', kind: 'pad_default', lon: 137.382, lat: -4.806, elev_m: -3627.8, rank: 5, score: 31, official: false, picker: true, tiebreak: { reachable_pct_30: 16.7, elev_m: -3627.8 }, feasible: feasible(50, 31), summary: 'scenarios/pads/pad_default/summary.json' },
    ],
  }
  it('every row carries its excluded-combination count and screening count', () => {
    const v = parsePadsIndex(idx)
    expect(v.options.map((o) => [o.id, o.excluded, o.screenCount])).toEqual([
      ['rank1', 14, 52],
      ['rank2', 13, 51],
      ['pad_default', 19, 50],
    ])
    expect(v.official.id).toBe('rank1')
  })
  it('rows without `feasible` (older index): null, not 0', () => {
    expect(parsePadsIndex(INDEX).options.every((o) => o.excluded === null && o.screenCount === null)).toBe(true)
  })
  it('summary: 60 min over the part inside the data, with its share; 30 min full disc', () => {
    const s = parsePadSummary(
      {
        dummy: false,
        id: 'rank2',
        pad: { lon: 137.393301, lat: -4.776468, elev_m: -3779.5 },
        rank: 2,
        score: 38,
        feasible: feasible(51, 38),
        headline: {
          '30': { budget_min: 30, reachable_pct: 21.5, range_pct: [16.4, 30.3], basis: 'full_disc', in_data_pct: 100.0, label: null },
          '60': { budget_min: 60, reachable_pct: 22.7, range_pct: [12.0, 38.8], basis: 'in_data', in_data_pct: 80.3, label: '80.3 % of the circle lies inside the terrain data' },
        },
        route: null,
      },
      'rank2',
    )
    expect(headlineFor(s, 60)).toEqual({ budget: 60, reachablePct: 22.7, range: [12.0, 38.8], inDataPct: 80.3, inData: true })
    expect(headlineFor(s, 30)?.inData).toBe(false)
    expect(s.excluded).toBe(13)
  })
})

describe('loadPadsIndex: the picker is optional', () => {
  it('index missing: picker absent, console as before', async () => {
    const L = createLoader(async () => null, 'real', { schemaFor: padSchemaLookup })
    expect((await loadPadsIndex(L)).state).toBe('absent')
    // Without C's rows the loader refuses the path before fetching: hidden all the same.
    expect(['absent', 'no-contract']).toContain((await loadPadsIndex(createLoader(async () => null, 'real'))).state)
  })
  it('index present but no contract row yet: hidden (no-contract), nothing thrown', async () => {
    const L = createLoader(await fixtureFetcher(), 'real')
    const r = await loadPadsIndex(L)
    if (schemaFor(PADS_INDEX)) expect(r.state).toBe('ok')
    else expect(r.state).toBe('no-contract')
  })
  it('with the pad rows: index loads and every file of a pad validates against its reused schema', async () => {
    const L = createLoader(await fixtureFetcher(), 'real', { schemaFor: padSchemaLookup })
    const r = await loadPadsIndex(L)
    expect(r.state).toBe('ok')
    if (r.state !== 'ok') return
    expect(r.index.official.id).toBe('c044')
    const f = padFiles('c112', NOM)
    expect(parsePadSummary(await L.json(f.summary), 'c112').score).toBe(9)
    expect((await L.json<{ features: unknown[] }>(f.bands)).features.length).toBeGreaterThan(0)
    await L.json(f.edges)
    await L.json(f.partner)
    await L.json(f.route)
    expect((await L.json<unknown[]>(f.timeline)).length).toBeGreaterThan(0)
  })
  it('a dummy-flagged index in real mode is an error, not a picker', async () => {
    const L = createLoader(await fixtureFetcher({ ...INDEX, dummy: true }), 'real', { schemaFor: padSchemaLookup })
    const r = await loadPadsIndex(L)
    expect(r.state).toBe('error')
  })
  it('an index without an official row is an error with the reason', async () => {
    const L = createLoader(await fixtureFetcher({ dummy: false, pads: [INDEX.pads[0]] }), 'real', { schemaFor: padSchemaLookup })
    const r = await loadPadsIndex(L)
    expect(r.state).toBe('error')
    if (r.state === 'error') expect(String(r.error)).toMatch(/official/)
  })
})

describe('padViewMode: what a non-official pad switches', () => {
  it('official pad: everything on, scenario picker free', () => {
    expect(padViewMode(null)).toEqual({ slider: true, scenarioPicker: true })
  })
  it('a parking option: no isochrones (slider off), nominal 104 kg only (scenario picker locked)', () => {
    expect(padViewMode('c112')).toEqual({ slider: false, scenarioPicker: false })
  })
})
