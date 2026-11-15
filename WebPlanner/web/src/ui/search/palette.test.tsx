// U17 palette acceptance (WS15 task 8, package A8; WS15 "the same object selected from map, list and
// search shows the same card"), on the real data tree:
//  - Enter on a result calls select(ref, 'search') and the sidebar card is the same markup as from the
//    map adapter and from a list click (A5's SelectionCard on the same CardData);
//  - keyboard flow: type → ↓/↑ (wrapping) → Enter; Escape closes without clearing the selection;
//  - ARIA: dialog > combobox (aria-expanded, aria-controls, aria-activedescendant) + listbox/option;
//    focus starts in the input and Tab / Shift+Tab stay inside the dialog;
//  - Ctrl+K and / (the shell's `hl:shortcut` 'search') open and toggle it from the top-bar button;
//  - empty, results and no-results states; no network request.
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { render, type VNode } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLoader, type TextFetcher } from '../../data/loader'
import type { Manifest } from '../../data/types'
import { setManifest } from '../../prov/store'
import { resetSelection, select, selection, type SelectionRef } from '../../state/selection'
import { selectFromMap } from '../../state/selectionAdapter'
import { ui } from '../../state/ui'
import { SelectionCard } from '../cards/cards'
import { ensureFor, loadCardData, type CardData, type CellLookup } from '../cards/data'
import { t } from '../copy'
import { shell } from '../shell/store'
import { byClass, byRole, byTag, installDom, one, type FakeDocument, type FakeNode } from '../testing/dom'
import { SearchButton } from './button'
import { labelOf, Palette, resetSearchIndex, runItem, searchIndex } from './palette'
import type { SearchItem } from './search'

const REAL = resolve(__dirname, '../../../public/data')
const HAVE = existsSync(resolve(REAL, 'manifest.json'))
const requested: string[] = []
const fsFetcher: TextFetcher = async (path) => {
  requested.push(path)
  try {
    return await readFile(resolve(REAL, path), 'utf8')
  } catch {
    return null
  }
}
const L = createLoader(fsFetcher, 'real')
const cell: CellLookup = () => null

let d: CardData
let items: SearchItem[]
let root: FakeNode
let doc: FakeDocument
const fetchSpy = vi.fn(() => Promise.reject(new Error('no network in search')))

/** Serialise the rendered tree (same card ⇔ same markup), as A5's cards.test.tsx does. */
function html(n: FakeNode): string {
  if (n.nodeType === 3) return n.data
  const attrs = n.attributes.map((a) => ` ${a.name}="${a.value}"`).join('')
  return `<${n.localName}${attrs}>${n.childNodes.map(html).join('')}</${n.localName}>`
}
function cardHtml(r: SelectionRef | null): string {
  const host = doc.createElement('div')
  act(() => render(<SelectionCard sel={r} d={d} />, host as unknown as Element))
  const out = html(host)
  act(() => render(null, host as unknown as Element))
  return out
}
function mount(v: VNode): void {
  act(() => render(v, root as unknown as Element))
}
const text = (n: FakeNode) => n.textContent.replace(/\s+/g, ' ').trim()
const input = () => one(byRole(root, 'combobox'), 'combobox')
const options = () => byRole(root, 'option')
function type(q: string): void {
  const el = input() as FakeNode & { value: string }
  act(() => {
    el.value = q
    el.dispatch('input')
  })
}
function key(k: string, init: Record<string, unknown> = {}, on: FakeNode = input()) {
  let ev: ReturnType<FakeNode['dispatch']> | undefined
  act(() => void (ev = on.dispatch('keydown', { key: k, ...init })))
  return ev!
}
const activeId = () => input().getAttribute('aria-activedescendant')
const activeOpt = () => options().find((o) => o.getAttribute('aria-selected') === 'true')!

describe.skipIf(!HAVE)('search palette (real data)', () => {
  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchSpy)
    setManifest(JSON.parse(readFileSync(resolve(REAL, 'manifest.json'), 'utf8')) as Manifest)
    d = await loadCardData(L, cell)
    items = await searchIndex(L)
    for (const i of items) if (i.ref) await ensureFor(L, d, i.ref)
  })
  beforeEach(() => {
    ;({ container: root, document: doc } = installDom())
    resetSelection()
    ui.mode.value = 'plan'
    shell.sidebarOpen.value = false
  })
  afterEach(() => act(() => render(null, root as unknown as Element)))

  it('ARIA: modal dialog with a combobox controlling a listbox of options; focus starts in the input', () => {
    mount(<Palette items={items} onClose={() => {}} />)
    const dlg = one(byTag(root, 'dialog'), 'dialog')
    expect(dlg.hasAttribute('open')).toBe(true)
    expect(dlg.getAttribute('aria-label')).toBe(t('nav.search'))
    const cb = input()
    const lb = one(byRole(root, 'listbox'), 'listbox')
    expect(cb.getAttribute('aria-controls')).toBe(lb.getAttribute('id'))
    expect(cb.getAttribute('aria-autocomplete')).toBe('list')
    expect(cb.getAttribute('placeholder')).toBe(t('search.placeholder'))
    expect(doc.activeElement).toBe(cb)
    // empty state: the first objects, the first one active
    expect(options().length).toBeGreaterThan(0)
    expect(cb.getAttribute('aria-expanded')).toBe('true')
    expect(activeId()).toBe(options()[0].getAttribute('id'))
    expect(options().filter((o) => o.getAttribute('aria-selected') === 'true')).toHaveLength(1)
  })

  it('keyboard flow: type "S7" → Enter selects S7 from search and opens the sidebar; the palette closes', () => {
    const onClose = vi.fn()
    mount(<Palette items={items} onClose={onClose} navigate={() => {}} />)
    type('S7')
    expect(text(options()[0])).toContain('S7')
    const ev = key('Enter')
    expect(ev.defaultPrevented).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(selection.selected.value).toEqual({ kind: 'station', id: 'S7' })
    expect(selection.source.value).toBe('search')
    expect(shell.sidebarOpen.value).toBe(true)
  })

  it('↓ / ↑ move the active option (wrapping) and Enter takes the active one', () => {
    mount(<Palette items={items} onClose={() => {}} navigate={() => {}} />)
    type('parking')
    const n = options().length
    expect(n).toBeGreaterThanOrEqual(4)
    expect(activeOpt().getAttribute('data-id')).toBe('pad:rank2')
    key('ArrowDown')
    expect(activeOpt().getAttribute('data-id')).toBe('pad:rank3')
    expect(activeId()).toBe(activeOpt().getAttribute('id'))
    key('ArrowUp')
    key('ArrowUp') // wraps to the last
    expect(activeOpt()).toBe(options()[n - 1])
    key('ArrowDown') // wraps to the first
    key('ArrowDown')
    key('ArrowDown')
    expect(activeOpt().getAttribute('data-id')).toBe('pad:rank4')
    key('Enter')
    expect(selection.selected.value).toEqual({ kind: 'pad', id: 'rank4' })
  })

  it('the same object from the map, a list and search shows the same card', () => {
    const cases: [string, SelectionRef, () => void][] = [
      ['S7', { kind: 'station', id: 'S7' }, () => selectFromMap([{ properties: { code: 'S7', kind: 'route_station', ref: 'stations.json#S7' } }], { lng: 0, lat: 0 })],
      ['sharp', { kind: 'landmark', code: 'MSH' }, () => selectFromMap([{ properties: { code: 'MSH', kind: 'landmark', ref: 'landmarks.yaml' } }], null)],
      ['parking option 2', { kind: 'pad', id: 'rank2' }, () => selectFromMap([{ properties: { code: 'P2', kind: 'pad', ref: 'scenarios/pads/index.json#rank2' } }], null)],
      ['rover pad', { kind: 'pad', id: 'rank1' }, () => selectFromMap([{ properties: { code: 'PAD', kind: 'pad', ref: 'pad.json' } }], null)],
      ['clay', { kind: 'station', id: 'S8' }, () => selectFromMap([{ properties: { code: 'S8', kind: 'scored_site', ref: 'stations.json#S8' } }], { lng: 0, lat: 0 })],
    ]
    for (const [q, ref, fromMap] of cases) {
      resetSelection()
      fromMap()
      const map = cardHtml(selection.selected.peek())
      resetSelection()
      select(ref, 'list')
      const list = cardHtml(selection.selected.peek())
      resetSelection()
      mount(<Palette items={items} onClose={() => {}} navigate={() => {}} />)
      type(q)
      key('Enter')
      expect(selection.source.value, q).toBe('search')
      const search = cardHtml(selection.selected.peek())
      expect(search, q).toBe(list)
      expect(search, q).toBe(map)
      expect(search, q).toContain('hl-card')
      act(() => render(null, root as unknown as Element))
    }
  })

  it('Escape closes the palette and keeps the selection (the key never reaches the shell)', () => {
    select({ kind: 'station', id: 'S4' }, 'list')
    const onClose = vi.fn()
    mount(<Palette items={items} onClose={onClose} />)
    const ev = key('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(ev.defaultPrevented).toBe(true)
    expect(selection.selected.value).toEqual({ kind: 'station', id: 'S4' })
  })

  it('focus trap: Tab from the close button returns to the input, Shift+Tab from the input goes to close', () => {
    mount(<Palette items={items} onClose={() => {}} />)
    const close = one(byClass(root, 'hl-search__close'), 'close')
    expect(close.getAttribute('aria-label')).toBe(t('buttons.close'))
    key('Tab', { shiftKey: true })
    expect(doc.activeElement).toBe(close)
    key('Tab', {}, close)
    expect(doc.activeElement).toBe(input())
  })

  it('no results: the copy.json message in a polite status; Enter does nothing', () => {
    mount(<Palette items={items} onClose={() => {}} navigate={() => {}} />)
    type('zzzz')
    expect(options()).toHaveLength(0)
    expect(input().getAttribute('aria-expanded')).toBe('false')
    expect(input().getAttribute('aria-activedescendant')).toBeNull()
    const st = one(byRole(root, 'status'), 'status')
    expect(text(st)).toBe(t('search.noResults', { query: 'zzzz' }))
    key('Enter')
    expect(selection.selected.value).toBeNull()
  })

  it('a click on an option chooses it', () => {
    const onClose = vi.fn()
    mount(<Palette items={items} onClose={onClose} navigate={() => {}} />)
    type('gdv')
    act(() => void options()[0].dispatch('click'))
    expect(selection.selected.value).toEqual({ kind: 'landmark', code: 'GDV' })
    expect(onClose).toHaveBeenCalled()
  })

  it('outside PLAN/FLY an object result opens PLAN first (the sidebar shows only on the map)', () => {
    ui.mode.value = 'evidence'
    const nav = vi.fn()
    runItem(items.find((i) => i.code === 'S7')!, { navigate: nav })
    expect(nav).toHaveBeenCalledWith(expect.stringMatching(/^#\//))
    expect(selection.selected.value).toEqual({ kind: 'station', id: 'S7' })
  })

  it('commands run the §4.4 action (2D/3D toggles the view; a mode command navigates)', () => {
    ui.view.value = '2d'
    runItem(items.find((i) => i.id === 'cmd:toggle3d')!, { navigate: () => {} })
    expect(ui.view.value).toBe('3d')
    const nav = vi.fn()
    runItem(items.find((i) => i.id === 'cmd:mode:evidence')!, { navigate: nav })
    expect(nav).toHaveBeenCalledTimes(1)
    expect(labelOf(items.find((i) => i.id === 'cmd:mode:evidence')!)).toBe(t('modes.evidence.label'))
  })

  it('top-bar button: click opens; the shell\'s search shortcut (Ctrl+K, /) toggles; Escape closes', async () => {
    const win = new EventTarget() as unknown as Window
    mount(<SearchButton win={win} palette={{ items }} />)
    const btn = one(byClass(root, 'hl-iconbtn'), 'button')
    expect(btn.getAttribute('aria-label')).toBe(t('nav.search'))
    expect(btn.getAttribute('aria-haspopup')).toBe('dialog')
    expect(btn.getAttribute('aria-keyshortcuts')).toContain('/')
    const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))))
    act(() => void btn.dispatch('click'))
    await settle()
    expect(byTag(root, 'dialog')).toHaveLength(1)
    key('Escape')
    expect(byTag(root, 'dialog')).toHaveLength(0)
    const shortcut = () => {
      const ev = new CustomEvent('hl:shortcut', { detail: { action: 'search' }, cancelable: true })
      act(() => void win.dispatchEvent(ev))
      return ev
    }
    expect(shortcut().defaultPrevented).toBe(true) // the shell leaves the key to us
    await settle()
    expect(byTag(root, 'dialog')).toHaveLength(1)
    shortcut()
    expect(byTag(root, 'dialog')).toHaveLength(0)
    // other actions are not ours
    const other = new CustomEvent('hl:shortcut', { detail: { action: 'escape' }, cancelable: true })
    win.dispatchEvent(other)
    expect(other.defaultPrevented).toBe(false)
  })

  it('no network: index from three static files through the loader, nothing fetched while typing', () => {
    resetSearchIndex()
    expect(requested.filter((p) => /labels|stations\.json|pads\/index/.test(p)).length).toBeGreaterThan(0)
    const before = requested.length
    mount(<Palette items={items} onClose={() => {}} />)
    for (const q of ['S', 'S7', 'sharp', 'parking', '137.38, -4.79']) type(q)
    expect(requested.length).toBe(before)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
