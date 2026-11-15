import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Manifest } from '../data/types'
import { formatValue, normFile, resolveProvenance, sameValue } from './provenance'

const DUMMY = resolve(__dirname, '../../public/data-dummy')
const m = JSON.parse(readFileSync(resolve(DUMMY, 'manifest.json'), 'utf8')) as Manifest
const e = (value: unknown, file: string) => ({ value, units: 'min', file, script: 's.py', commit: 'c', utc: '2026-11-14T10:00:00Z' })

describe('resolveProvenance', () => {
  const man: Manifest = { 'a.b': e(30, 'stations.json'), 'x.y': e(12.5, 'web/public/data/trade_table.json'), dummy: false }

  it('named key with the same value is ok', () => expect(resolveProvenance(man, { key: 'a.b', file: 'stations.json', value: 30 })).toMatchObject({ status: 'ok', key: 'a.b' }))
  it('named key with another value is a mismatch', () => expect(resolveProvenance(man, { key: 'a.b', file: 'stations.json', value: 31 }).status).toBe('mismatch'))
  it('no key: found by file + value (file path normalised)', () => expect(resolveProvenance(man, { file: 'trade_table.json', value: 12.5 })).toMatchObject({ status: 'matched', key: 'x.y' }))
  it('unknown key falls back to file + value and names the expected key', () =>
    expect(resolveProvenance(man, { key: 'nope', file: 'stations.json', value: 30 })).toMatchObject({ status: 'matched', key: 'a.b', expectedKey: 'nope' }))
  it('same value from another file is not a match', () => expect(resolveProvenance(man, { file: 'pad.json', value: 30 }).status).toBe('missing'))
  it('"dummy" is never a key', () => expect(resolveProvenance(man, { key: 'dummy', file: 'x', value: false }).status).toBe('missing'))
  it('no manifest', () => expect(resolveProvenance(null, { file: 'x', value: 1 }).status).toBe('no-manifest'))
})

describe('dummy manifest backs the dummy numbers the views show', () => {
  it.each([
    ['reachable_pct.nom_104.30', 'scenarios/index.json', 99.4],
    ['t_home_min.S1.nom_104', 'stations.json', 11.1],
    ['trade.60.104.reachable_pct', 'trade_table.json', 76.5],
    ['rad.leash.tau_min_at_peak', 'conditions/rad.json', 85.7],
    ['turn_back_min.S2', 'cards/S2.json', 343.3],
  ])('%s', (key, file, value) => expect(resolveProvenance(m, { key, file, value }).status).toBe('ok'))
})

describe('helpers', () => {
  it('normFile strips the tree prefix', () => {
    expect(normFile('web/public/data/stations.json')).toBe('stations.json')
    expect(normFile('data-dummy/cards/S1.json')).toBe('cards/S1.json')
    expect(normFile('./pad.json')).toBe('pad.json')
  })
  it('sameValue tolerates float noise only', () => {
    expect(sameValue(0.1 + 0.2, 0.3)).toBe(true)
    expect(sameValue(85.7, 85.8)).toBe(false)
    expect(sameValue([1, 2], [1, 2])).toBe(true)
  })
  it('formatValue prints the stored value with units, unknown for null', () => {
    expect(formatValue(99.4, '%')).toBe('99.4%')
    expect(formatValue(-2.5, 'deg')).toBe('−2.5°')
    expect(formatValue(1.715, 'km2')).toBe('1.715 km²')
    expect(formatValue(null, 'min')).toBe('unknown')
    expect(formatValue(0.42, null)).toBe('0.42')
  })
  it('formatValue display options: fixed decimals and an explicit sign (the stored value is unchanged)', () => {
    expect(formatValue(1.3098175914666925, 'deg', { dp: 2, signed: true })).toBe('+1.31°')
    expect(formatValue(5.447021418084812, 'deg', { dp: 2 })).toBe('5.45°')
    expect(formatValue(0.5025571598604971, '1', { dp: 2 })).toBe('0.50')
    expect(formatValue(-0.594, 'deg', { dp: 1, signed: true })).toBe('−0.6°')
    expect(formatValue(0, null, { signed: true })).toBe('0')
    expect(formatValue(null, 'deg', { dp: 2 })).toBe('unknown')
    expect(formatValue('x', null, { dp: 2 })).toBe('x')
  })
})
