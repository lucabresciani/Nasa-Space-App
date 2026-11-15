// KATs for the browser-side contract checker (brief WS5: data loads only from contract-valid files).
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkSchema, SUPPORTED_KEYWORDS } from './schema'

describe('checkSchema (JSON Schema 2020-12 subset used by contracts/)', () => {
  const s = {
    type: 'object',
    required: ['a', 'b'],
    properties: {
      a: { type: 'integer', minimum: 1, maximum: 60 },
      b: { type: ['number', 'null'] },
      c: { enum: ['physiology', 'slope', 'data'] },
      d: { const: 'FeatureCollection' },
      e: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
      f: { type: 'array', prefixItems: [{ type: 'string' }, { type: ['number', 'null'] }] },
      g: { type: 'number', exclusiveMinimum: 0 },
      h: { type: 'object', additionalProperties: { type: 'number' } },
      i: { type: 'string', pattern: '^[a-z]+_[0-9]+$' },
    },
  }

  it('accepts a valid object', () => {
    expect(checkSchema({ a: 30, b: null, c: 'slope', d: 'FeatureCollection', e: [1, 2], f: ['t', 1], g: 5, h: { x: 1 }, i: 'nom_104' }, s)).toEqual([])
  })

  it.each([
    [{ b: 1 }, '$.a', 'required'],
    [{ a: 1.5, b: 1 }, '$.a', 'integer'],
    [{ a: 61, b: 1 }, '$.a', 'maximum'],
    [{ a: 0, b: 1 }, '$.a', 'minimum'],
    [{ a: 1, b: 'x' }, '$.b', 'type'],
    [{ a: 1, b: 1, c: 'wind' }, '$.c', 'enum'],
    [{ a: 1, b: 1, d: 'Feature' }, '$.d', 'const'],
    [{ a: 1, b: 1, e: [1] }, '$.e', 'minItems'],
    [{ a: 1, b: 1, e: [1, 2, 3] }, '$.e', 'maxItems'],
    [{ a: 1, b: 1, e: [1, 'x'] }, '$.e[1]', 'type'],
    [{ a: 1, b: 1, f: [1, 1] }, '$.f[0]', 'type'],
    [{ a: 1, b: 1, g: 0 }, '$.g', 'exclusiveMinimum'],
    [{ a: 1, b: 1, h: { x: 'y' } }, '$.h.x', 'type'],
    [{ a: 1, b: 1, i: 'Nom-104' }, '$.i', 'pattern'],
  ])('rejects %j at %s (%s)', (value, path, keyword) => {
    const errs = checkSchema(value, s)
    expect(errs.length).toBeGreaterThan(0)
    expect(errs[0].path).toBe(path)
    expect(errs[0].keyword).toBe(keyword)
  })

  it('additionalProperties: false rejects extra keys', () => {
    const errs = checkSchema({ x: 1 }, { type: 'object', properties: {}, additionalProperties: false })
    expect(errs[0]).toMatchObject({ path: '$.x', keyword: 'additionalProperties' })
  })

  it('null is not a number, NaN is not a number, arrays are not objects', () => {
    expect(checkSchema(null, { type: 'number' })).toHaveLength(1)
    expect(checkSchema(Number.NaN, { type: 'number' })).toHaveLength(1)
    expect(checkSchema([], { type: 'object' })).toHaveLength(1)
    expect(checkSchema(3, { type: 'number' })).toHaveLength(0)
  })
})

describe('allOf + if/then (contracts/fixes.schema.json)', () => {
  const fixes = JSON.parse(readFileSync(resolve(__dirname, '../../../contracts/fixes.schema.json'), 'utf8'))
  it('a skyline fix needs error_m and image_id; a station fix does not', () => {
    expect(checkSchema([{ t_eva_min: 1, station: 'S1', type: 'station', sigma_m: 5 }], fixes)).toEqual([])
    expect(checkSchema([{ t_eva_min: 1, station: 'S1', type: 'skyline', sigma_m: 40, error_m: 38, image_id: 'NLB_1' }], fixes)).toEqual([])
    const errs = checkSchema([{ t_eva_min: 1, station: 'S1', type: 'skyline', sigma_m: 40 }], fixes)
    expect(errs.map((e) => e.keyword)).toContain('required')
  })
})

describe('every keyword used in contracts/ is supported', () => {
  const dir = resolve(__dirname, '../../../contracts')
  const used = new Set<string>()
  const walk = (v: unknown, inProps: boolean) => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, false))
    if (!v || typeof v !== 'object') return
    for (const [k, x] of Object.entries(v)) {
      if (!inProps) used.add(k)
      walk(x, !inProps && (k === 'properties' || k === '$defs'))
    }
  }
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.schema.json'))) walk(JSON.parse(readFileSync(resolve(dir, f), 'utf8')), false)
  it('found the schemas', () => expect(used.size).toBeGreaterThan(10))
  it.each([...used])('%s', (k) => expect(SUPPORTED_KEYWORDS.has(k), `unsupported keyword ${k}`).toBe(true))
})
