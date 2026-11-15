// U14 acceptance (WS15 task 5, A5), on the real data tree (web/public/data):
//  - the same ref shows the same card from the map, a list and search;
//  - every number on every card is manifest-backed (<Num> resolves its key) or field-backed;
//  - every readout has a trust chip; history back/forward; Escape clears; empty state;
//  - selection → card rendered within 100 ms (data already loaded);
//  - keyboard: every card control is a native button or link.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, type VNode } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createLoader, type TextFetcher } from '../../data/loader'
import type { Manifest } from '../../data/types'
import type { FieldSample } from '../../map/field'
import { setManifest } from '../../prov/store'
import { registerSelectionAction, resetSelection, select, selection, type SelectionRef } from '../../state/selection'
import { selectFromMap } from '../../state/selectionAdapter'
import { t } from '../copy'
import { shell, sidebarContent } from '../shell/store'
import { all, byClass, byTag, hasClass, installDom, type FakeNode } from '../testing/dom'
import { SelectionCard } from './cards'
import { ensureFor, loadCardData, type CardData, type CellLookup } from './data'
import { cardData, handleSelectionShortcut, installSelectionSidebar, SelectionPanel } from './sidebar'

const REAL = resolve(__dirname, '../../../public/data')
const HAVE = existsSync(resolve(REAL, 'manifest.json'))
const fsFetcher: TextFetcher = async (path) => {
  try {
    return await readFile(resolve(REAL, path), 'utf8')
  } catch {
    return null
  }
}
const L = createLoader(fsFetcher, 'real')

/** Field lookup stand-in (no PNG decoding in node): fixed nearest-pixel samples with the fields the cards read
 *  (fieldAt has since gained margin/collapse fields from M3/M4 that cards do not use). */
const SAMPLE = {
  lon: 137.39,
  lat: -4.79,
  inside: true,
  state: 'assessed',
  unknown: false,
  tHome: { opt: 21.3, nom: 22.1, con: 24.7 },
  o2Home: 31.2,
  noRouteHome: { opt: false, nom: false, con: false },
  drawn: { opt: 21.3, nom: 22.1, con: 24.7 },
} as FieldSample
const cell: CellLookup = (lon, lat) => ({ sample: { ...SAMPLE, lon, lat }, suitKg: 104 })

let d: CardData
let refs: SelectionRef[] = []
let root: FakeNode

function mount(v: VNode): FakeNode {
  act(() => render(v, root as unknown as Element))
  return root
}
/** Serialise the rendered tree (same card ⇔ same markup). */
function html(n: FakeNode): string {
  if (n.nodeType === 3) return n.data
  const attrs = n.attributes.map((a) => ` ${a.name}="${a.value}"`).join('')
  return `<${n.localName}${attrs}>${n.childNodes.map(html).join('')}</${n.localName}>`
}
const text = (n: FakeNode): string => n.textContent.replace(/\s+/g, ' ').trim()
const cardHtml = (r: SelectionRef | null): string => html(mount(<SelectionCard sel={r} d={d} />))

describe.skipIf(!HAVE)('selection cards (real data)', () => {
  beforeAll(async () => {
    setManifest(JSON.parse(readFileSync(resolve(REAL, 'manifest.json'), 'utf8')) as Manifest)
    d = await loadCardData(L, cell)
    refs = [
      ...d.stations.map((s): SelectionRef => ({ kind: 'station', id: s.id })),
      ...(d.pads?.options ?? []).map((o): SelectionRef => ({ kind: 'pad', id: o.id })),
      ...(d.official.route?.legs ?? []).map((l): SelectionRef => ({ kind: 'leg', leg: l.leg })),
      { kind: 'leg', leg: 1, pad: 'rank2' },
      ...d.labels.filter((l) => l.kind === 'landmark').map((l): SelectionRef => ({ kind: 'landmark', code: l.code })),
      { kind: 'edge', cause: 'physiology', budget: 30, lon: 137.39, lat: -4.79 },
      { kind: 'edge', cause: 'slope', budget: 30 },
      { kind: 'cell', lon: 137.39, lat: -4.79 },
    ]
    for (const r of refs) await ensureFor(L, d, r)
  })
  beforeEach(() => {
    ;({ container: root } = installDom())
    resetSelection()
  })
  afterEach(() => act(() => render(null, root as unknown as Element)))

  it('covers every U14 kind that is not cut (pad, parking option, station, scored site, leg, cell, edge, landmark)', () => {
    const kinds = new Set(refs.map((r) => r.kind))
    expect([...kinds].sort()).toEqual(['cell', 'edge', 'landmark', 'leg', 'pad', 'station'])
    expect(refs.filter((r) => r.kind === 'pad').length).toBeGreaterThan(1) // official + parking options
    expect(d.stations.some((s) => !d.official.route?.stops.includes(s.id))).toBe(true) // a scored site
  })

  it('every card has the U14 structure: title row with chip, then body; selected state', () => {
    for (const r of [null, ...refs]) {
      mount(<SelectionCard sel={r} d={d} />)
      const card = byClass(root, 'hl-card')[0]
      expect(card, JSON.stringify(r)).toBeTruthy()
      const head = byClass(card, 'hl-card__head')[0]
      expect(byClass(head, 'hl-card__title')).toHaveLength(1)
      expect(byClass(head, 'hl-chip').length, JSON.stringify(r)).toBe(1)
      expect(text(byClass(head, 'hl-card__title')[0])).not.toBe('')
      if (r) expect(card.getAttribute('data-state')).toBe('selected')
      // no "cannot be shown" fallback for refs that exist
      expect(text(card)).not.toContain(t('states.error.cannotShow', { what: '' }).trim())
    }
  })

  it('every number on every card is manifest- or field-backed, and every readout has a trust chip', () => {
    let nums = 0
    for (const r of [null, ...refs]) {
      mount(<SelectionCard sel={r} d={d} />)
      for (const n of all(root, (x) => hasClass(x, 'num'))) {
        nums++
        const where = `${JSON.stringify(r)}: "${text(n)}" ${n.getAttribute('title') ?? ''}`
        const field = n.getAttribute('data-source') === 'field'
        if (field) {
          expect(n.getAttribute('data-file'), where).toMatch(/^fields\/(opt|nom|con)_\d+\/\w+\.png$/)
          expect(hasClass(n, 'num-field') || hasClass(n, 'num-unknown'), where).toBe(true)
        } else {
          // manifest-backed: <Num> resolved its key (num-ok); unknown (null in the file) is allowed, never unbacked / config / derived
          expect(hasClass(n, 'num-ok') || hasClass(n, 'num-unknown'), where).toBe(true)
          if (hasClass(n, 'num-ok')) expect(n.getAttribute('href'), where).toMatch(/#\/(evidence\/)?scorecard\?key=/)
        }
      }
      for (const ro of byClass(root, 'hl-readout')) {
        expect(byClass(ro, 'hl-chip').length, `${JSON.stringify(r)} readout ${text(ro)}`).toBe(1)
        // a readout's value is only its number(s): no free text digits beside them
        const v = byClass(ro, 'hl-readout__value')[0]
        const numText = all(v, (x) => hasClass(x, 'num')).map(text).join('')
        expect(text(v).replace(/[()–\s]/g, '')).toBe(numText.replace(/\s/g, ''))
      }
    }
    expect(nums).toBeGreaterThan(50)
  })

  it('card numbers resolve to their manifest keys (spot checks against the files)', () => {
    mount(<SelectionCard sel={{ kind: 'station', id: 'S7' }} d={d} />)
    const hrefs = all(root, (x) => hasClass(x, 'num-ok')).map((n) => decodeURIComponent(n.getAttribute('href') ?? ''))
    expect(hrefs.some((h) => h.endsWith('key=card.S7.timeline.arrive'))).toBe(true)
    expect(hrefs.some((h) => h.endsWith('key=t_home_min.S7.nom_104'))).toBe(true)
    mount(<SelectionCard sel={{ kind: 'pad', id: 'rank1' }} d={d} />)
    expect(text(root)).toContain('23.0')
    mount(<SelectionCard sel={{ kind: 'cell', lon: 1, lat: 2 }} d={d} />)
    const f = all(root, (x) => x.getAttribute('data-source') === 'field' && hasClass(x, 'num'))
    expect(f.map((n) => n.getAttribute('data-file'))).toEqual(['fields/nom_104/t_home.png', 'fields/con_104/t_home.png', 'fields/nom_104/o2_home.png'])
    expect(f.map(text)).toEqual(['22.1 min', '24.7 min', '31.2 L'])
  })

  it('the same object from the map, a list and search shows the same card', () => {
    const cases: [SelectionRef, () => void, () => void, () => void][] = [
      [
        { kind: 'station', id: 'S7' },
        () => selectFromMap([{ properties: { code: 'S7', kind: 'route_station', ref: 'stations.json#S7' } }], { lng: 0, lat: 0 }),
        () => select({ kind: 'station', id: 'S7' }, 'list'),
        () => select({ kind: 'station', id: 'S7' }, 'search'),
      ],
      [
        { kind: 'pad', id: 'rank2' },
        () => selectFromMap([{ properties: { code: 'P2', kind: 'pad', ref: 'scenarios/pads/index.json#rank2' } }], null),
        () => select({ kind: 'pad', id: 'rank2' }, 'list'),
        () => select({ kind: 'pad', id: 'rank2' }, 'search'),
      ],
      [
        { kind: 'leg', leg: 3 },
        () => selectFromMap([{ properties: { leg: 3, from: 'S6', to: 'S1' } }], { lng: 0, lat: 0 }),
        () => select({ kind: 'leg', leg: 3 }, 'list'),
        () => select({ kind: 'leg', leg: 3 }, 'search'),
      ],
      [
        { kind: 'landmark', code: 'GDV' },
        () => selectFromMap([{ properties: { code: 'GDV', kind: 'landmark', ref: 'landmarks.yaml' } }], null),
        () => select({ kind: 'landmark', code: 'GDV' }, 'list'),
        () => select({ kind: 'landmark', code: 'GDV' }, 'search'),
      ],
    ]
    for (const [ref, ...entries] of cases) {
      const seen = entries.map((go) => {
        resetSelection()
        go()
        return cardHtml(selection.selected.peek())
      })
      expect(seen[0]).toBe(cardHtml(ref))
      expect(seen[1]).toBe(seen[0])
      expect(seen[2]).toBe(seen[0])
    }
  })

  it('nothing selected: the empty-state hint and the route configuration (stations in order, totals, budgets)', async () => {
    mount(<SelectionPanel L={L} cell={cell} />)
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
    })
    expect(text(root)).toContain(t('states.empty.noSelection'))
    expect(text(root)).toContain(t('cards.routeSummary.title'))
    const rows = byClass(root, 'hl-row')
    expect(rows.map((r) => text(byClass(r, 'hl-badge')[0] ?? r))).toEqual(d.official.route!.stops.filter((s) => s !== 'pad'))
    // a list row is a button and selects its station (list entry point, keyboard reachable)
    expect(rows.every((r) => r.localName === 'button')).toBe(true)
    act(() => void rows[0].dispatch('click'))
    expect(selection.selected.peek()).toEqual({ kind: 'station', id: rows[0].textContent.match(/S\d+/)![0] })
    expect(selection.source.peek()).toBe('list')
  })

  it('selection → card in at most 100 ms (data loaded), for every kind', async () => {
    // the panel's shared card data, with every per-object file already fetched (the fetch is not render time)
    const shared = await cardData(L, cell)
    for (const r of refs) await ensureFor(L, shared, r)
    mount(<SelectionPanel L={L} cell={cell} />)
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
    })
    const times: number[] = []
    for (const r of refs) {
      const t0 = performance.now()
      act(() => select(r, 'map'))
      const ms = performance.now() - t0
      times.push(ms)
      const card = byClass(root, 'hl-card')[0]
      expect(card?.getAttribute('data-state'), JSON.stringify(r)).toBe('selected')
      expect(ms, JSON.stringify(r)).toBeLessThanOrEqual(100)
    }
    expect(Math.max(...times)).toBeLessThanOrEqual(100)
  })

  it('history: back / forward buttons and [ ] keys walk the selections; Escape clears', async () => {
    mount(<SelectionPanel L={L} cell={cell} />)
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
    })
    act(() => select({ kind: 'station', id: 'S7' }, 'map'))
    act(() => select({ kind: 'leg', leg: 2 }, 'map'))
    act(() => select({ kind: 'landmark', code: 'GDV' }, 'map'))
    const title = () => text(byClass(root, 'hl-card__title')[0])
    const gdv = title()
    act(() => void expect(handleSelectionShortcut({ action: 'history', step: -1 })).toBe(true))
    expect(selection.selected.peek()).toEqual({ kind: 'leg', leg: 2 })
    const [backBtn, fwdBtn] = byTag(byClass(root, 'hl-selection__nav')[0], 'button')
    expect(backBtn.getAttribute('aria-label')).toBe(t('buttons.back'))
    act(() => void backBtn.dispatch('click'))
    expect(selection.selected.peek()).toEqual({ kind: 'station', id: 'S7' })
    expect(backBtn.hasAttribute('disabled')).toBe(true)
    act(() => void fwdBtn.dispatch('click'))
    act(() => void expect(handleSelectionShortcut({ action: 'history', step: 1 })).toBe(true))
    expect(title()).toBe(gdv)
    expect(handleSelectionShortcut({ action: 'history', step: 1 })).toBe(false)
    act(() => void expect(handleSelectionShortcut({ action: 'escape' })).toBe(true))
    expect(selection.selected.peek()).toBeNull()
    expect(text(root)).toContain(t('states.empty.noSelection'))
    // nothing selected: Escape is left to the shell (help, focus mode)
    expect(handleSelectionShortcut({ action: 'escape' })).toBe(false)
  })

  it('keyboard: every control on a card is a native button or link; registered actions render, others do not', () => {
    const off = registerSelectionAction({ id: 'focus', label: 'buttons.focus', applies: (r) => r.kind === 'landmark', run: (r) => select(r) })
    mount(<SelectionCard sel={{ kind: 'landmark', code: 'GDV' }} d={d} />)
    const acts = byClass(root, 'hl-card__actions')[0]
    expect(byTag(acts, 'button').map(text)).toEqual([t('buttons.focus')])
    mount(<SelectionCard sel={{ kind: 'leg', leg: 1 }} d={d} />)
    expect(byClass(root, 'hl-card__actions')).toHaveLength(0) // no dead buttons
    off()
    for (const r of refs) {
      mount(<SelectionCard sel={r} d={d} />)
      for (const n of all(root, (x) => x.getAttribute('tabindex') !== null || x.getAttribute('onclick') !== null)) {
        expect(['button', 'a'].includes(n.localName), html(n)).toBe(true)
      }
    }
    mount(<SelectionCard sel={{ kind: 'station', id: 'S1' }} d={d} />)
    const link = byTag(byClass(root, 'hl-card__actions')[0], 'a')[0]
    expect(link.getAttribute('href')).toBe('#/station/S1')
  })

  it('installSelectionSidebar: fills the shell sidebar, opens it on selection, handles Escape and [ ] events', () => {
    const listeners = new Map<string, (e: Event) => void>()
    const win = { addEventListener: (k: string, f: (e: Event) => void) => listeners.set(k, f), removeEventListener: (k: string) => listeners.delete(k) }
    shell.sidebarOpen.value = false
    const stop = installSelectionSidebar({ loader: L, cell, win: win as unknown as Window })
    expect(sidebarContent.peek()).toBeTypeOf('function')
    select({ kind: 'station', id: 'S4' }, 'list')
    expect(shell.sidebarOpen.peek()).toBe(true)
    const ev = (detail: unknown) => {
      let prevented = false
      listeners.get('hl:shortcut')!({ detail, preventDefault: () => (prevented = true) } as unknown as Event)
      return prevented
    }
    select({ kind: 'station', id: 'S1' }, 'list')
    expect(ev({ action: 'history', step: -1 })).toBe(true)
    expect(selection.selected.peek()).toEqual({ kind: 'station', id: 'S4' })
    shell.helpOpen.value = true
    expect(ev({ action: 'escape' })).toBe(false) // the shell closes help first
    shell.helpOpen.value = false
    expect(ev({ action: 'escape' })).toBe(true)
    expect(selection.selected.peek()).toBeNull()
    stop()
    expect(sidebarContent.peek()).toBeUndefined()
    expect(listeners.has('hl:shortcut')).toBe(false)
  })
})
