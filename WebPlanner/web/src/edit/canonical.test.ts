// Client hash == server hash (WS18 task 1, D57). Known answers from server/tests/test_engine_hash.py
// (derived there with coreutils, independently of server/engine/hashing.py).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONTRACT_VERSION, canonicalJson, defaultInputs, pyFloatRepr, resultHash, round6, type CanonicalContext, type PadRow, type PlanInputs, type StationRow } from './canonical'
import { sha256Hex } from './sha256'

const DATA = resolve(__dirname, '../../public/data')
const json = (p: string) => JSON.parse(readFileSync(resolve(DATA, p), 'utf8'))
const pads: PadRow[] = json('scenarios/pads/index.json').pads
const stations: StationRow[] = json('stations.json')
const ctx: CanonicalContext = { defaults: defaultInputs(pads), stations }

// server/tests/test_engine_hash.py OFFICIAL_CANONICAL_TMPL, FIXED_IDENTITY, PINNED_CV, OFFICIAL_HASH_PINNED
const OFFICIAL_CANONICAL_TMPL =
  '{"conditions":{"d_allow_mgy":0.5,"storm":"2024-05-20","tripwire_at":"route_max_t_home"},' +
  '"contract_version":"@CV@",' +
  '"crew":{"body_mass_kg":75.0,"effort_cap_frac":0.5,"suit_kg":104.0,"tools_kg":10.0,' +
  '"vo2max_ml_kg_min":36.0},' +
  '"eva":{"duration_h":6.5,"reserve_min":30.0,"start_lmst_h":9.0,' +
  '"walkback_budgets_min":[30.0,60.0]},' +
  '"pad":{"lat":-4.77748,"lon":137.401783},' +
  '"stations":{"custom":[],"dwell_min":{"S1":30.0,"S2":30.0,"S4":30.0,"S6":30.0,"S7":30.0,' +
  '"S8":30.0},"mode":"best"}}'
const FIXED_IDENTITY = {
  engine_tree: '0123456789abcdef0123456789abcdef01234567',
  config_hash: 'sha256:1fef9c5747acbd487e0a3090f6e9617eba1c8627e25095db683e18ab7589099d',
  terrain_hash: `sha256:${'0'.repeat(64)}`,
}
const PINNED_CV = '1.0.1'
const OFFICIAL_HASH_PINNED = 'c81aafcf1a1ef64f'
const MINIMAL: PlanInputs = { contract_version: CONTRACT_VERSION, pad: { lon: 137.401783, lat: -4.77748 } }
const h = (p: PlanInputs) => resultHash(p, ctx, FIXED_IDENTITY)

describe('sha256', () => {
  it('matches FIPS 180-4 vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
    for (const s of ['a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'Krater Süd\0x\0y', OFFICIAL_CANONICAL_TMPL])
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'))
  })
})

describe('Python float repr and round(x, 6)', () => {
  it('writes floats as json.dumps does', () => {
    expect([75, 0.5, 104, 137.401783, -4.77748, 1e-6, 5e-5, 1e-4, 1e16, 1e15, 123.456].map(pyFloatRepr)).toEqual([
      '75.0', '0.5', '104.0', '137.401783', '-4.77748', '1e-06', '5e-05', '0.0001', '1e+16', '1000000000000000.0', '123.456',
    ])
  })
  it('rounds ties to even on the exact value and drops -0', () => {
    expect(round6(0.0078125)).toBe(0.007812) // exact tie (1/128): Python gives 0.007812
    expect(round6(0.0234375)).toBe(0.023438) // 3/128: tie, 7 is odd -> up
    expect(round6(-0.0078125)).toBe(-0.007812)
    expect(Object.is(round6(-1e-9), 0)).toBe(true)
    expect(round6(0.1 + 0.2 + 0.2 - 1e-12)).toBe(0.5)
    expect(round6(137.401783 + 3e-10)).toBe(137.401783)
  })
})

describe('client hash == server canonical hash (D57)', () => {
  it('official defaults give the server known canonical text', () => {
    expect(canonicalJson(ctx.defaults, ctx)).toBe(OFFICIAL_CANONICAL_TMPL.replace('@CV@', CONTRACT_VERSION))
    expect(canonicalJson(MINIMAL, ctx)).toBe(OFFICIAL_CANONICAL_TMPL.replace('@CV@', CONTRACT_VERSION))
  })
  it('pinned official hash (coreutils known answer)', () => {
    expect(h({ ...ctx.defaults, contract_version: PINNED_CV })).toBe(OFFICIAL_HASH_PINNED)
    expect(h({ ...MINIMAL, contract_version: PINNED_CV })).toBe(OFFICIAL_HASH_PINNED)
  })
  it('title and pad.id are not hashed; pad lon/lat are', () => {
    const base = h(MINIMAL)
    expect(h({ ...MINIMAL, title: 'anything', pad: { id: 'rank1', lon: 137.401783, lat: -4.77748 } })).toBe(base)
    expect(h({ ...MINIMAL, pad: { lon: 137.401784, lat: -4.77748 } })).not.toBe(base)
  })
  it('omitted defaults, int/float spelling and float noise hash the same', () => {
    const base = h(MINIMAL)
    expect(h({ ...MINIMAL, crew: { suit_kg: 104 } })).toBe(base)
    expect(h({ ...MINIMAL, stations: { mode: 'best', dwell_min: { S4: 30 }, custom: [] } })).toBe(base)
    expect(h({ ...MINIMAL, pad: { lon: 137.401783 + 3e-10, lat: -4.77748 - 4e-8 }, conditions: { d_allow_mgy: 0.5000001 } })).toBe(base)
    expect(h({ ...MINIMAL, crew: { suit_kg: 120 } })).not.toBe(base)
    expect(h({ ...MINIMAL, contract_version: '1.99.0' })).not.toBe(base)
  })
  it('user point dwell default is filled', () => {
    const pt = { id: 'U1', lon: 137.4, lat: -4.78 }
    const a = { ...MINIMAL, stations: { mode: 'best' as const, custom: [pt] } }
    const b = { ...MINIMAL, stations: { mode: 'best' as const, custom: [pt], dwell_min: { U1: 30 } } }
    expect(h(a)).toBe(h(b))
    expect(canonicalJson(a, ctx)).toContain('"U1":30.0')
  })
  it('non-ASCII text stays UTF-8 (ensure_ascii=False)', () => {
    const doc = { ...MINIMAL, stations: { mode: 'best' as const, custom: [{ id: 'U1', name: 'Krater Süd', lon: 137.4, lat: -4.78 }] } }
    const s = canonicalJson(doc, ctx)
    expect(s).toContain('Krater Süd')
    expect(s.replace('Krater Süd', '')).not.toContain(' ')
  })
})
