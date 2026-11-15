// WS18 task 2 (H2): drag readout, delta strip and cross-fade (U15). Real pads index + manifest.
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, type VNode } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parsePadsIndex } from '../data/pads'
import type { BandsFC, Manifest } from '../data/types'
import { setManifest } from '../prov/store'
import { t } from '../ui/copy'
import { all, byClass, byTag, hasClass, installDom, type FakeNode } from '../ui/testing/dom'
import { TOKENS } from '../ui/tokens'
import { afterimageOpacity, crossfadeFrom, crossfadeMs, XFADE_ID, type MapLike } from './crossfade'
import type { DragFields, SpotValues } from './drag'
import { buildCatalog } from './options'
import { createRoverDrag } from './rover'
import { createPlanEditStore } from './store'
import { DASH, DeltaStrip, DragReadout, factRows, validityText } from './ui'

const PUB = resolve(__dirname, '../../public/data')
const json = (p: string) => JSON.parse(readFileSync(resolve(PUB, p), 'utf8'))
const catalog = buildCatalog(json('scenarios/index.json'), json('scenarios/pads/index.json'), json('stations.json'))
const pads = parsePadsIndex(json('scenarios/pads/index.json'))
const manifest = json('manifest.json') as Manifest
const values = (manifest as unknown as { values?: Record<string, { value: unknown }> }).values ?? (manifest as unknown as Record<string, { value: unknown }>)
// fields stand-in: every spot valid (the real-field rule is tested in drag.test.ts)
const fields: DragFields = { sample: () => null, slope: () => 2.5, grid: null }

let root: FakeNode
const mount = (v: VNode) => {
  act(() => render(v, root as unknown as Element))
  return root
}
const text = (n: FakeNode) => n.textContent.replace(/\s+/g, ' ').trim()

beforeAll(() => setManifest(manifest))
beforeEach(() => {
  ;({ container: root } = installDom())
})
afterEach(() => act(() => render(null, root as unknown as Element)))

describe('drag readout (while dragging)', () => {
  const v: SpotValues = { lon: 137.39, lat: -4.78, validity: 'invalid', failed: ['steep', 'outside'], state: 'assessed', slopeDeg: 7.31, maxSlopeDeg: 9.2, elevationM: null }

  it('shows validity (copy), elevation "—" and the slope lookup; feasible EVAs and reachable are "computing…" ghosts', () => {
    mount(<DragReadout values={v} target={pads.options[1]} />)
    const s = text(root)
    expect(s).toContain(t('cards.pad.invalidSpot', { reason: `${t('cards.pad.invalidSteep')}, ${t('cards.pad.invalidOutside')}` }))
    const slope = all(root, (n) => n.getAttribute('data-source') === 'field' && hasClass(n, 'num'))
    expect(slope).toHaveLength(1)
    expect(text(slope[0])).toBe('7.3°')
    const ghosts = byClass(root, 'hl-edit-ghost')
    expect(ghosts).toHaveLength(2)
    for (const g of ghosts) {
      expect(text(g)).toContain(t('edit.computing'))
      expect(text(g)).not.toMatch(/\d/) // never a number while dragging
      expect(g.getAttribute('data-trust')).toBe('live')
    }
    const elev = all(root, (n) => hasClass(n, 'hl-readout') && n.getAttribute('data-state') === 'unknown')
    expect(text(elev[0])).toContain(DASH)
    expect(s).toContain(t('edit.snapStatic'))
    expect(s).toContain(pads.options[1].label)
  })

  it('validity copy: valid / invalid with reasons / unknown "—"', () => {
    expect(validityText({ ...v, validity: 'valid', failed: [] })).toBe(t('cards.pad.validSpot'))
    expect(validityText({ ...v, validity: 'unknown', failed: [] })).toBe(DASH)
  })
})

describe('delta strip (on release)', () => {
  it('fact rows are the pads-index values with their manifest keys (precomputed only)', () => {
    const rows = factRows(pads, 'rank1', 'rank4')
    expect(rows.map((r) => r.fact.key)).toEqual(['feasibleEvas', 'reachable', 'elevation'])
    for (const r of rows) {
      for (const end of [r.from, r.to]) {
        expect(end.v).not.toBeNull()
        expect(values[end.k]?.value, end.k).toBe(end.v)
      }
    }
  })

  it('renders the pad change, from → to facts (all manifest-backed), Keep / Discard, the static note; no server-only option', () => {
    const store = createPlanEditStore({ catalog })
    const rd = createRoverDrag(store, fields)
    rd.begin()
    rd.move(catalog.pads.find((p) => p.id === 'rank4')!)
    rd.end()
    mount(<DeltaStrip store={store} rover={rd} pads={pads} />)
    const strip = byClass(root, 'hl-edit-delta')[0]
    expect(strip.getAttribute('data-ghost')).toBe('ready')
    expect(strip.getAttribute('data-ghost-source')).toBe('precomputed')
    const s = text(strip)
    expect(s).toContain(t('edit.deltaTitle'))
    expect(s).toContain(`${pads.official.label}→${pads.options.find((o) => o.id === 'rank4')!.label}`)
    const nums = byClass(strip, 'num')
    expect(nums).toHaveLength(6)
    for (const n of nums) expect(hasClass(n, 'num-ok'), text(n)).toBe(true)
    expect(s).toContain(t('edit.snapStatic'))
    expect(s).not.toContain(t('buttons.setAsPad'))
    expect(s).not.toContain(t('buttons.computeFullPlan'))
    const buttons = byTag(strip, 'button').filter((b) => hasClass(b, 'hl-btn'))
    expect(buttons.map(text)).toEqual([t('buttons.keep'), t('buttons.discard')])
    act(() => void buttons[0].dispatch('click'))
    expect(store.committed.value.plan.pad).toBe('rank4')
    expect(store.draft.value).toBeNull()
    expect(byClass(root, 'hl-edit-delta')).toHaveLength(0)
  })

  it('Discard leaves the committed plan', () => {
    const store = createPlanEditStore({ catalog })
    const rd = createRoverDrag(store, fields)
    rd.cycle(1)
    mount(<DeltaStrip store={store} rover={rd} pads={pads} />)
    const discard = byTag(root, 'button').filter((b) => text(b) === t('buttons.discard'))[0]
    act(() => void discard.dispatch('click'))
    expect(store.committed.value.plan.pad).toBe(catalog.officialPadId)
    expect(store.past.value).toHaveLength(0)
  })
})

describe('cross-fade', () => {
  const fc: BandsFC = { type: 'FeatureCollection', features: [] } as unknown as BandsFC
  function fakeMap() {
    const layers = new Set<string>()
    const sources = new Set<string>()
    const paint: [string, string, unknown][] = []
    const m: MapLike = {
      addSource: ((id: string) => void sources.add(id)) as never,
      addLayer: ((l: { id: string }) => void layers.add(l.id)) as never,
      getLayer: ((id: string) => (layers.has(id) ? { id } : undefined)) as never,
      getSource: ((id: string) => (sources.has(id) ? { id } : undefined)) as never,
      removeLayer: ((id: string) => void layers.delete(id)) as never,
      removeSource: ((id: string) => void sources.delete(id)) as never,
      setPaintProperty: ((id: string, k: string, v: unknown) => void paint.push([id, k, v])) as never,
    }
    return { m, layers, sources, paint }
  }

  it('lasts the data-change motion token; 0 under reduced motion', () => {
    expect(crossfadeMs(false)).toBe(TOKENS.motion.dataMs[1])
    expect(crossfadeMs(true)).toBe(0)
    expect(afterimageOpacity(0, 600)).toBe(TOKENS.overlayOpacity.max)
    expect(afterimageOpacity(300, 600)).toBeCloseTo(TOKENS.overlayOpacity.max / 2)
    expect(afterimageOpacity(600, 600)).toBe(0)
    expect(afterimageOpacity(0, 0)).toBe(0)
  })

  it('reduced motion: no afterimage layer (instant swap)', () => {
    const f = fakeMap()
    crossfadeFrom(f.m, fc, 30, 'nominal', crossfadeMs(true), (cb) => cb(), setTimeout)
    expect(f.layers.size).toBe(0)
    expect(f.sources.size).toBe(0)
  })

  it('the previous homeline fades to 0 and is removed afterwards', () => {
    vi.useFakeTimers()
    const f = fakeMap()
    const ms = crossfadeMs(false)
    crossfadeFrom(f.m, fc, 30, 'nominal', ms, (cb) => cb(), setTimeout)
    expect(f.layers.has(XFADE_ID)).toBe(true)
    expect(f.paint).toContainEqual([XFADE_ID, 'fill-opacity', 0])
    vi.advanceTimersByTime(ms + TOKENS.motion.hoverMs[1])
    expect(f.layers.size).toBe(0)
    expect(f.sources.size).toBe(0)
    vi.useRealTimers()
  })
})
