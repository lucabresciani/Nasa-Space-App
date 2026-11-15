// The browser schema table mirrors tools/validate_contracts.py, and every JSON file in the dummy
// tree validates in the browser checker (brief WS5: every view loads contract-valid data only).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contractVersions, matchPattern, SCHEMA_MAP, schemaFor } from './contracts'
import { PAD_SCHEMA_PATTERNS } from './pads'
import { checkSchema } from './schema'

const REPO = resolve(__dirname, '../../..')
const DUMMY = resolve(REPO, 'web/public/data-dummy')

function pythonSchemaMap(): [string, string][] {
  const src = readFileSync(resolve(REPO, 'tools/validate_contracts.py'), 'utf8')
  const at = src.search(/^SCHEMA_MAP:/m)
  const block = src.slice(at, src.indexOf(']\n', at))
  return [...block.matchAll(/\("([^"]+)",\s*"([^"]+)"\)/g)].map((m) => [m[1], m[2]])
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? files(p) : [p]
  })
}

describe('SCHEMA_MAP mirrors tools/validate_contracts.py', () => {
  const py = pythonSchemaMap()
  it('the Python table parsed', () => expect(py.length).toBeGreaterThanOrEqual(30))
  it('same patterns in the same order, each mapped to the same schema', () => {
    expect(SCHEMA_MAP).toHaveLength(py.length)
    py.forEach(([pattern, file], i) => {
      expect(SCHEMA_MAP[i][0], `row ${i}`).toBe(pattern)
      expect(SCHEMA_MAP[i][1], pattern).toEqual(JSON.parse(readFileSync(resolve(REPO, 'contracts', file), 'utf8')))
    })
  })
  it('contracts are v1.x (v1.1.x is additive; untouched schemas keep their version)', () => {
    expect(contractVersions().sort()).toEqual(['1.0.0', '1.1.0', '1.1.1', '1.1.2', '1.1.3', '1.1.4', '1.1.5'])
  })
})

describe('D21 parking-option rows (v1.1.4) cover pads.ts PAD_SCHEMA_PATTERNS', () => {
  const at = (p: string) => SCHEMA_MAP.find(([q]) => q === p)?.[1]
  it.each(PAD_SCHEMA_PATTERNS.map((x) => [x.pattern, x.shape] as const))('%s', (pattern, shape) => {
    expect(at(pattern), pattern).toBeDefined()
    if (shape) expect(at(pattern)).toBe(at(shape))
  })
  it.each([
    ['scenarios/pads/index.json', 'pads_index.schema.json'],
    ['scenarios/pads/rank2/summary.json', 'pad_summary.schema.json'],
    ['scenarios/pads/rank2/bands_104.geojson', 'bands.schema.json'],
    ['scenarios/pads/pad_default/route_nom_104.geojson', 'route.schema.json'],
    ['scenarios/pads/pad_default/timeline_nom_104.json', 'timeline.schema.json'],
    ['scenarios/nom_104/edges.geojson', 'edges.schema.json'],
  ])('%s -> %s', (path, file) => {
    const want = JSON.parse(readFileSync(resolve(REPO, 'contracts', file), 'utf8'))
    expect(schemaFor(path)).toEqual(want)
  })
  it('no data path matches two patterns', () => {
    const hits = (p: string) => SCHEMA_MAP.filter(([q]) => matchPattern(q, p)).length
    for (const p of ['scenarios/pads/index.json', 'scenarios/pads/rank2/summary.json', 'scenarios/pads/rank2/edges.geojson', 'scenarios/pads/rank2/partner.geojson', 'scenarios/nom_104/partner.geojson', 'scenarios/bands_104.geojson'])
      expect(hits(p), p).toBe(1)
  })
})

describe('matchPattern is fnmatch per segment', () => {
  it.each([
    ['scenarios/*/isochrones.geojson', 'scenarios/nom_104/isochrones.geojson', true],
    ['scenarios/*/isochrones.geojson', 'scenarios/a/b/isochrones.geojson', false],
    ['route_*.geojson', 'route_nom_104.geojson', true],
    ['cards/*.json', 'cards/S1.json', true],
    ['cards/*.json', 'cards/S1/overlay.json', false],
  ])('%s ~ %s = %s', (p, path, want) => expect(matchPattern(p, path)).toBe(want))
})

describe('every JSON / GeoJSON file in data-dummy/ validates in the browser checker', () => {
  const all = files(DUMMY)
    .filter((p) => /\.(geo)?json$/.test(p))
    .map((p) => relative(DUMMY, p).split('\\').join('/'))
  it('found the dummy files', () => {
    for (const p of ['scenarios/index.json', 'stations.json', 'cards/S1.json', 'trade_table.json', 'conditions/rad.json', 'manifest.json', 'pad.json']) expect(all).toContain(p)
  })
  it.each(all.filter((p) => !p.startsWith('fp3d/near')))('%s', (p) => {
    const schema = schemaFor(p)
    expect(schema, `no contract for ${p}`).toBeDefined()
    const errs = checkSchema(JSON.parse(readFileSync(resolve(DUMMY, p), 'utf8')), schema!)
    expect(errs, JSON.stringify(errs.slice(0, 3))).toEqual([])
  })
})
