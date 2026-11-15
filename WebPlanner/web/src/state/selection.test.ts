// U14 selection store (WS15 task 5, A5): selected, hovered, history (last 10), [ / ] and Escape.
import { beforeEach, describe, expect, it } from 'vitest'
import { back, canGoBack, canGoForward, clearSelection, forward, HISTORY_MAX, hover, refKey, registerSelectionAction, actionsFor, resetSelection, sameRef, select, selection, type SelectionRef } from './selection'
import { hoverFromMap, pickToRef, refFromFeature, refFromLabel, selectFromMap } from './selectionAdapter'

const S = (id: string): SelectionRef => ({ kind: 'station', id })

beforeEach(() => resetSelection())

describe('selection store', () => {
  it('select sets selected, pushes history, remembers the source', () => {
    select(S('S7'), 'list')
    expect(selection.selected.peek()).toEqual(S('S7'))
    expect(selection.history.peek()).toEqual([S('S7')])
    expect(selection.source.peek()).toBe('list')
  })

  it('selecting the shown object again changes nothing', () => {
    select(S('S7'))
    select({ kind: 'station', id: 'S7' })
    expect(selection.history.peek()).toHaveLength(1)
  })

  it('refKey identifies objects; cells to 6 decimals', () => {
    expect(refKey({ kind: 'cell', lon: 137.4, lat: -4.8 })).toBe(refKey({ kind: 'cell', lon: 137.4000000001, lat: -4.8 }))
    expect(sameRef({ kind: 'leg', leg: 1 }, { kind: 'leg', leg: 1, pad: 'rank2' })).toBe(false)
    expect(sameRef(null, null)).toBe(true)
  })

  it('history keeps the last 10 selections', () => {
    for (let i = 1; i <= 14; i++) select(S(`S${i}`))
    const h = selection.history.peek()
    expect(HISTORY_MAX).toBe(10)
    expect(h).toHaveLength(10)
    expect(h[0]).toEqual(S('S5'))
    expect(h[9]).toEqual(S('S14'))
  })

  it('back / forward walk the history ([ / ], §4.4)', () => {
    select(S('S1'))
    select(S('S2'))
    select(S('S3'))
    expect(canGoForward()).toBe(false)
    expect(back()).toBe(true)
    expect(selection.selected.peek()).toEqual(S('S2'))
    expect(back()).toBe(true)
    expect(selection.selected.peek()).toEqual(S('S1'))
    expect(back()).toBe(false)
    expect(canGoBack()).toBe(false)
    expect(forward()).toBe(true)
    expect(selection.selected.peek()).toEqual(S('S2'))
    expect(selection.source.peek()).toBe('history')
    // walking does not grow the history
    expect(selection.history.peek()).toHaveLength(3)
  })

  it('a new selection after going back drops the forward part', () => {
    select(S('S1'))
    select(S('S2'))
    select(S('S3'))
    back()
    back()
    select(S('S9'))
    expect(selection.history.peek()).toEqual([S('S1'), S('S9')])
    expect(canGoForward()).toBe(false)
  })

  it('Escape clears; [ brings the last selection back', () => {
    select(S('S1'))
    select(S('S2'))
    clearSelection()
    expect(selection.selected.peek()).toBeNull()
    expect(selection.history.peek()).toHaveLength(2)
    expect(back()).toBe(true)
    expect(selection.selected.peek()).toEqual(S('S2'))
  })

  it('select(null) clears; hover is separate from selection', () => {
    select(S('S1'))
    hover({ kind: 'landmark', code: 'GDV' })
    expect(selection.hovered.peek()).toEqual({ kind: 'landmark', code: 'GDV' })
    expect(selection.selected.peek()).toEqual(S('S1'))
    select(null)
    expect(selection.selected.peek()).toBeNull()
    hover(null)
    expect(selection.hovered.peek()).toBeNull()
  })

  it('actions: only registered actions that apply to the ref', () => {
    const off = registerSelectionAction({ id: 'focus', label: 'buttons.focus', applies: (r) => r.kind === 'landmark', run: () => {} })
    expect(actionsFor({ kind: 'landmark', code: 'GDV' }).map((a) => a.id)).toEqual(['focus'])
    expect(actionsFor(S('S1'))).toEqual([])
    off()
    expect(actionsFor({ kind: 'landmark', code: 'GDV' })).toEqual([])
  })
})

describe('map adapter (for WS16; the map module is not edited by A5)', () => {
  it('labels.json rows → pad, parking option, station, scored site, landmark', () => {
    expect(refFromLabel({ code: 'PAD', kind: 'pad', ref: 'pad.json' })).toEqual({ kind: 'pad', id: 'rank1' })
    expect(refFromLabel({ code: 'P2', kind: 'pad', ref: 'scenarios/pads/index.json#rank2' })).toEqual({ kind: 'pad', id: 'rank2' })
    expect(refFromLabel({ code: 'S7', kind: 'route_station', ref: 'stations.json#S7' })).toEqual(S('S7'))
    expect(refFromLabel({ code: 'S8', kind: 'scored_site', ref: 'stations.json#S8' })).toEqual(S('S8'))
    expect(refFromLabel({ code: 'GDV', kind: 'landmark', ref: 'landmarks.yaml' })).toEqual({ kind: 'landmark', code: 'GDV' })
  })

  it('route legs, edges and station markers from their file properties', () => {
    expect(refFromFeature({ properties: { leg: 2, from: 'S7', to: 'S6', t_min: 54.1 } })).toEqual({ kind: 'leg', leg: 2 })
    expect(refFromFeature({ properties: { budget: 30, cause: 'slope' } })).toEqual({ kind: 'edge', cause: 'slope', budget: 30 })
    expect(refFromFeature({ properties: { id: 'S4' } })).toEqual(S('S4'))
    expect(refFromFeature({ properties: { budget: 30, variant: 'nominal' } })).toBeNull()
  })

  it('top-most named object wins; nothing named → terrain cell at the pointer', () => {
    const at = { lng: 137.39, lat: -4.79 }
    expect(pickToRef([{ properties: { budget: 30 } }, { properties: { id: 'S1' } }], at)).toEqual(S('S1'))
    expect(pickToRef([], at)).toEqual({ kind: 'cell', lon: 137.39, lat: -4.79 })
    expect(pickToRef([{ properties: { budget: 30, cause: 'physiology' } }], at)).toEqual({ kind: 'edge', cause: 'physiology', budget: 30, lon: 137.39, lat: -4.79 })
    expect(pickToRef([], null)).toBeNull()
  })

  it('selectFromMap writes the store with source map; hover ignores cells', () => {
    selectFromMap([{ properties: { code: 'S7', kind: 'route_station', ref: 'stations.json#S7' } }], null)
    expect(selection.selected.peek()).toEqual(S('S7'))
    expect(selection.source.peek()).toBe('map')
    expect(hoverFromMap([], { lng: 1, lat: 2 })).toBeNull()
    expect(hoverFromMap([{ properties: { id: 'S2' } }], { lng: 1, lat: 2 })).toEqual(S('S2'))
    expect(selection.hovered.peek()).toEqual(S('S2'))
  })
})
