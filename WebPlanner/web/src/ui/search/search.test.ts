// U17 search index and ranking (WS15 task 8, package A8), known answers on the real data tree:
//  - every searchable object (official pad, parking options, stations, scored sites, landmarks) is indexed
//    once, with the SelectionRef the map adapter gives for the same labels.json row;
//  - fuzzy ranking: "S7", "sharp", "parking", "gediz", typos and in-order letters;
//  - coordinates in decimal degrees become a cell ref only when unambiguous;
//  - client-side only: the index reads three static files through the loader, typing fetches nothing.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createLoader, type TextFetcher } from '../../data/loader'
import { refKey } from '../../state/selection'
import { refFromLabel } from '../../state/selectionAdapter'
import { t } from '../copy'
import { buildObjectIndex, commandItems, loadObjectIndex, parseCoordinates, rank, scoreText, type SearchItem } from './search'

const REAL = resolve(__dirname, '../../../public/data')
const HAVE = existsSync(resolve(REAL, 'labels.json'))
const label = (i: SearchItem) => (i.label ? t(i.label) : i.name)
const codes = (items: SearchItem[], q: string, n?: number) => rank(items, q, label, n).map((r) => r.item.code || r.item.id)

describe.skipIf(!HAVE)('search index (real data)', () => {
  const requested: string[] = []
  const fsFetcher: TextFetcher = async (path) => {
    requested.push(path)
    try {
      return readFileSync(resolve(REAL, path), 'utf8')
    } catch {
      return null
    }
  }
  let objs: SearchItem[] = []
  let all: SearchItem[] = []
  const labels = HAVE ? (JSON.parse(readFileSync(resolve(REAL, 'labels.json'), 'utf8')).labels as Record<string, unknown>[]) : []
  const fetchSpy = vi.fn(() => Promise.reject(new Error('no network in search')))

  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchSpy)
    objs = await loadObjectIndex(createLoader(fsFetcher, 'real'))
    all = [...objs, ...commandItems()]
  })
  afterEach(() => fetchSpy.mockClear())

  it('indexes every labelled object once, with the same ref the map adapter gives', () => {
    for (const l of labels) {
      const ref = refFromLabel(l)!
      const hits = objs.filter((o) => o.ref && refKey(o.ref) === refKey(ref))
      expect(hits, String(l.code)).toHaveLength(1)
      expect(hits[0].code).toBe(l.code)
      expect(hits[0].name).toBe(l.name)
    }
    expect(new Set(objs.map((o) => o.id)).size).toBe(objs.length)
    const groups = new Set(objs.map((o) => o.group))
    for (const g of ['pad', 'parking', 'stations', 'sites', 'landmarks'] as const) expect(groups.has(g), g).toBe(true)
  })

  it('reads only the three static files, through the loader; ranking never fetches', () => {
    expect(requested.sort()).toEqual(['labels.json', 'scenarios/pads/index.json', 'stations.json'])
    const before = requested.length
    for (const q of ['S7', 'sharp', 'parking', 'gdv', '137.38, -4.79', 'xyz', '']) rank(all, q, label)
    expect(requested.length).toBe(before)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('"S7": the station S7 first (exact code beats S1…S8 prefixes)', () => {
    const r = codes(all, 'S7')
    expect(r[0]).toBe('S7')
    expect(rank(all, 'S7', label)[0].item.ref).toEqual({ kind: 'station', id: 'S7' })
    expect(codes(all, 's7')[0]).toBe('S7') // case-insensitive
  })

  it('"sharp": Aeolis Mons (Mount Sharp) by a word of its name', () => {
    const r = rank(all, 'sharp', label)
    expect(r[0].item.code).toBe('MSH')
    expect(r[0].item.ref).toEqual({ kind: 'landmark', code: 'MSH' })
  })

  it('"parking": the four parking options, in code order, before anything else', () => {
    const r = rank(all, 'parking', label)
    expect(r.slice(0, 4).map((x) => x.item.code)).toEqual(['P2', 'P3', 'P4', 'P5'])
    expect(r.slice(0, 4).every((x) => x.item.group === 'parking' && x.item.ref?.kind === 'pad')).toBe(true)
  })

  it('names, codes, typos and multi-word queries', () => {
    expect(codes(all, 'gediz').slice(0, 2).sort()).toEqual(['GDV', 'S4']) // landmark + "Gediz Vallis sulfur field"
    expect(codes(all, 'gediz vallis sulfur')[0]).toBe('S4') // every word must match
    expect(codes(all, 'rover pad')[0]).toBe('PAD')
    expect(codes(all, 'fracture')[0]).toBe('S2')
    expect(codes(all, 'clay')[0]).toBe('S8') // scored site
    expect(codes(all, 'msh')[0]).toBe('MSH')
    expect(codes(all, 'pcvls')[0]).toBe('PCV') // in-order letters: "Peace Vallis"
    expect(rank(all, 'zzzz', label)).toEqual([])
  })

  it('commands: switch mode, 2D/3D, play/pause (copy.json labels)', () => {
    expect(rank(all, 'evidence', label)[0].item.command).toEqual({ action: 'mode', mode: 'evidence' })
    expect(rank(all, '3d', label)[0].item.command).toEqual({ action: 'toggle3d' })
    expect(rank(all, 'play', label)[0].item.command).toEqual({ action: 'playPause' })
  })

  it('empty query: objects in index order (pad first), limited', () => {
    const r = rank(all, '', label, 5)
    expect(r).toHaveLength(5)
    expect(r[0].item.code).toBe('PAD')
  })
})

describe('coordinates (decimal degrees, unambiguous only)', () => {
  it.each([
    ['137.38, -4.79', { kind: 'cell', lon: 137.38, lat: -4.79 }],
    ['-4.79 137.38', { kind: 'cell', lon: 137.38, lat: -4.79 }],
    ['-4.79°, 137.38°', { kind: 'cell', lon: 137.38, lat: -4.79 }],
    ['4.7, 12.1', null], // both within ±90: lon/lat order unknown
    ['137.38', null],
    ['S7', null],
    ['400, 5', null],
  ])('%s', (q, want) => expect(parseCoordinates(q)).toEqual(want))
  it('a coordinate query gives one cell result', () => {
    const r = rank([], '137.38, -4.79', (i) => i.name)
    expect(r).toHaveLength(1)
    expect(r[0].item.group).toBe('coordinates')
    expect(r[0].item.ref).toEqual({ kind: 'cell', lon: 137.38, lat: -4.79 })
  })
})

describe('scoreText', () => {
  it('exact > prefix > word start > substring > in-order letters > none', () => {
    const s = (q: string, x: string) => scoreText(q, x, 1000)
    const v = [s('sharp', 'sharp'), s('sha', 'sharp'), s('sha', 'mount sharp'), s('har', 'mount sharp'), s('mtsh', 'mount sharp'), s('q', 'mount sharp')]
    for (let i = 1; i < v.length; i++) expect(v[i - 1], String(i)).toBeGreaterThan(v[i])
    expect(v[v.length - 1]).toBe(0)
  })
  it('buildObjectIndex adds stations and pad options the labels do not name, once', () => {
    const idx = buildObjectIndex([{ code: 'S1', name: 'A', kind: 'route_station', ref: 'stations.json#S1' }], [{ id: 'S1', name: 'A' }, { id: 'S9', name: 'B' }], [{ id: 'rank1' }, { id: 'rank7' }])
    expect(idx.map((i) => i.id)).toEqual(['station:S1', 'station:S9', 'pad:rank1', 'pad:rank7'])
  })
})
