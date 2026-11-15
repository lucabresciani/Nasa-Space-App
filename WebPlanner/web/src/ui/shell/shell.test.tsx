// Shell frames and islands (DESIGN U0, §4.1, §4.3; WS15 task 4, A4): the legacy frame is the old
// layout, the shell has its landmarks and a sane focus order, mode switching writes the UI store.
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NAV_ITEMS } from '../../router'
import { ui } from '../../state/ui'
import { t } from '../copy'
import { all, byClass, byTag, hasClass, installDom, one, type FakeDocument, type FakeNode } from '../testing/dom'
import { TOKENS } from '../tokens'
import { buildLegacyFrame, buildShellFrame, frameKindFor, type Frame } from './frame'
import { mountShell, type ShellHandle } from './Shell'
import { applyRoute, breakpointFor, openSidebar, registerRailSection, setSidebarContent, shell } from './store'

let doc: FakeDocument
const text = (n: FakeNode): string => n.textContent.replace(/\s+/g, ' ').trim()
const focusable = (n: FakeNode): boolean =>
  (n.localName === 'a' && n.hasAttribute('href')) || (['button', 'input', 'select'].includes(n.localName) && !n.hasAttribute('disabled') && n.getAttribute('tabindex') !== '-1')
const fire = (n: FakeNode, type: string) => act(() => void n.dispatch(type, {}))

const fakeWin = () => {
  const ls = new Map<string, Set<(e: unknown) => void>>()
  return {
    innerWidth: 1440,
    addEventListener: (k: string, f: (e: unknown) => void) => void (ls.get(k) ?? ls.set(k, new Set()).get(k)!).add(f),
    removeEventListener: (k: string, f: (e: unknown) => void) => void ls.get(k)?.delete(f),
    dispatchEvent: () => true,
    count: (k: string) => ls.get(k)?.size ?? 0,
  }
}

beforeEach(() => {
  ;({ document: doc } = installDom())
  shell.sidebarOpen.value = false
  shell.focusMode.value = false
  shell.railSheet.value = false
  ui.panels.leftRail.value = TOKENS.layout.leftRail
  ui.panels.timeline.value = TOKENS.layout.timeline
})

describe('frame choice (?legacy, internal pages)', () => {
  it.each([
    ['', '#/', 'shell'],
    ['', '#/hud', 'shell'],
    ['?legacy=1', '#/', 'legacy'],
    ['?legacy=1', '#/evidence/scorecard', 'legacy'],
    ['', '#/trade?legacy=trade', 'legacy'],
    ['?legacy=hud', '#/trade', 'shell'],
    ['?legacy=hud', '#/fly/hud', 'legacy'],
    ['', '#/styleguide', 'legacy'],
    ['', '#/spike', 'legacy'],
  ])('search %s hash %s -> %s', (search, hash, want) => expect(frameKindFor(search, hash)).toBe(want))
})

describe('legacy frame = the layout from before the shell', () => {
  it('has header.topbar (brand + every old nav link), the dummy banner and main.outlet, and nothing of the shell', () => {
    const f = buildLegacyFrame(doc as unknown as Document)
    const root = f.root as unknown as FakeNode
    const header = one(byTag(root, 'header'))
    expect(header.getAttribute('class')).toBe('topbar')
    expect(text(one(byClass(header, 'brand')))).toBe('HOMELINE')
    const links = byTag(one(byClass(header, 'topnav')), 'a')
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['#/', '#/trade', '#/conditions', '#/cuff', '#/hud', '#/scorecard', '#/about'])
    expect(links.map(text)).toEqual(NAV_ITEMS.map((n) => n.label))
    expect(byClass(root, 'dummy-banner')).toHaveLength(1)
    expect(one(byTag(root, 'main')).getAttribute('class')).toBe('outlet')
    expect(all(root, (n) => (n.getAttribute('class') ?? '').includes('hl-')).length).toBe(0)
  })
})

describe('shell frame and islands', () => {
  let f: Frame
  let h: ShellHandle
  let win: ReturnType<typeof fakeWin>
  const root = () => f.root as unknown as FakeNode
  beforeEach(() => {
    f = buildShellFrame(doc as unknown as Document)
    doc.body.appendChild(root())
    win = fakeWin()
    applyRoute({ name: 'console' }, '#/')
    act(() => void (h = mountShell(f, () => {}, win as unknown as Window)))
  })
  afterEach(() => act(() => h.destroy()))

  it('keeps the anchors other code relies on: .topbar and main.outlet in one subtree (live layer, value snapshot)', () => {
    expect(hasClass(f.topbar as unknown as FakeNode, 'topbar')).toBe(true)
    const main = one(byTag(root(), 'main'))
    expect(hasClass(main, 'outlet')).toBe(true)
    expect(main.getAttribute('id')).toBe('hl-main')
    expect(main.getAttribute('tabindex')).toBe('-1') // focus target of the skip link, not in the Tab order
  })

  it('has the landmarks: banner, two labelled navigations, main, complementary sidebar, labelled dock region', () => {
    expect(byTag(root(), 'header')).toHaveLength(1)
    expect(byTag(root(), 'main')).toHaveLength(1)
    const navs = byTag(root(), 'nav')
    expect(navs.map((n) => n.getAttribute('aria-label'))).toEqual([t('nav.modesMenu'), t('modes.plan.label')])
    expect(one(byTag(root(), 'aside')).getAttribute('aria-label')).toBe(t('cards.common.details'))
    expect(one(byClass(root(), 'hl-dock')).getAttribute('aria-label')).toBe(t('timeline.evaTime'))
  })

  it('focus order: skip link, wordmark, the four modes in order, then the top bar tools, then the rail', () => {
    const order = all(root(), focusable)
    expect(text(order[0])).toBe(t('nav.skipToMap'))
    expect(text(order[1])).toBe(t('nav.wordmark'))
    expect(order.slice(2, 6).map((n) => text(n).replace(/[A-Z]$/, '').trim())).toEqual(['plan', 'fly', 'report', 'evidence'].map((m) => t(`modes.${m}.label` as 'modes.plan.label')))
    const rail = one(byClass(root(), 'hl-rail'))
    const firstRail = order.findIndex((n) => rail.contains(n))
    const lastTop = order.findLastIndex((n) => (f.topbar as unknown as FakeNode).contains(n))
    expect(lastTop).toBeLessThan(firstRail)
  })

  it('the mode tabs follow the UI store: aria-current on the active mode, links to the mode routes', () => {
    const tabs = () => byClass(root(), 'hl-modes__tab')
    expect(tabs().map((a) => a.getAttribute('aria-current'))).toEqual(['page', null, null, null])
    expect(tabs().map((a) => a.getAttribute('href'))).toEqual(['#/', '#/fly/hud', '#/report/cuff', '#/evidence/scorecard'])
    act(() => void applyRoute({ name: 'scorecard', key: 'k' }, '#/evidence/scorecard?key=k'))
    expect(ui.mode.value).toBe('evidence')
    expect(tabs().map((a) => a.getAttribute('aria-current'))).toEqual([null, null, null, 'page'])
    expect(root().getAttribute('data-mode')).toBe('evidence')
    expect(root().getAttribute('data-dock')).toBe('none') // REPORT/EVIDENCE are documents: no dock
    const views = byClass(root(), 'hl-rail__view')
    expect(views.map(text)).toEqual([t('nav.views.scorecard'), t('nav.views.about')])
    expect(views[0].getAttribute('aria-current')).toBe('page')
    expect(views.map((a) => a.getAttribute('href'))).toEqual(['#/evidence/scorecard', '#/evidence/about'])
  })

  it('every route maps into its mode (§4.2)', () => {
    const cases = [
      [{ name: 'console' }, 'plan'],
      [{ name: 'station', id: 'S1' }, 'plan'],
      [{ name: 'trade' }, 'plan'],
      [{ name: 'mission' }, 'plan'], // MARVIS build: the Mission Planer
      [{ name: 'conditions' }, 'fly'],
      [{ name: 'hud' }, 'fly'],
      [{ name: 'cuff' }, 'report'],
      [{ name: 'scorecard' }, 'evidence'],
      [{ name: 'about' }, 'evidence'],
    ] as const
    for (const [r, m] of cases) {
      act(() => void applyRoute(r, '#/x'))
      expect(ui.mode.value).toBe(m)
    }
    act(() => void applyRoute({ name: 'notfound', path: '/plan/abc' }, '#/plan/abc'))
    expect(ui.mode.value).toBe('evidence') // unknown and live plan routes keep the mode
  })

  it('rail and dock collapse write the panel sizes of the UI store (320/56, 120/40)', () => {
    const toggle = one(byClass(root(), 'hl-rail__toggle'))
    expect(toggle.getAttribute('aria-label')).toBe(t('nav.rail.collapse'))
    fire(toggle, 'click')
    expect(ui.panels.leftRail.value).toBe(TOKENS.layout.leftRailCollapsed)
    expect(root().getAttribute('data-rail')).toBe('collapsed')
    expect(root().style['--hl-rail-w']).toBe(`${TOKENS.layout.leftRailCollapsed}px`)
    // collapsed on desktop: icon-only links keep their names
    expect(byClass(root(), 'hl-rail__view').map((a) => a.getAttribute('aria-label'))).toEqual([t('modes.plan.label'), t('nav.views.mission'), t('nav.views.trade')])
    fire(one(byClass(root(), 'hl-rail__toggle')), 'click')
    expect(ui.panels.leftRail.value).toBe(TOKENS.layout.leftRail)
    const dockBtn = byTag(one(byClass(root(), 'hl-dock__head')), 'button')[0]
    fire(dockBtn, 'click')
    expect(ui.panels.timeline.value).toBe(TOKENS.layout.timelineCollapsed)
    expect(root().style['--hl-dock-h']).toBe(`${TOKENS.layout.timelineCollapsed}px`)
  })

  it('tablet (768–1279, A7b): rail = 56 px icon column, its toggle opens a sheet without touching the desktop size; navigation closes it', () => {
    act(() => void (shell.breakpoint.value = breakpointFor(1024)))
    let off = () => {}
    act(() => void (off = registerRailSection({ id: 'layers', modes: ['plan'], title: 'nav.rail.layers', icon: 'layers', render: () => <p class="probe">x</p> })))
    expect(root().getAttribute('data-bp')).toBe('tablet')
    expect(ui.panels.leftRail.value).toBe(TOKENS.layout.leftRail) // desktop preference: open
    expect(root().getAttribute('data-rail')).toBe('collapsed')
    expect(byClass(root(), 'hl-rail__view').map((a) => a.getAttribute('aria-label'))).toEqual([t('modes.plan.label'), t('nav.views.mission'), t('nav.views.trade')])
    expect(byClass(root(), 'hl-rail__title')).toHaveLength(0)
    expect(byClass(root(), 'probe')).toHaveLength(0)
    expect(one(byClass(root(), 'hl-rail__body')).hasAttribute('hidden')).toBe(false)
    const toggle = one(byClass(root(), 'hl-rail__toggle'))
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.getAttribute('aria-label')).toBe(t('nav.rail.expand'))
    fire(toggle, 'click')
    expect(shell.railSheet.value).toBe(true)
    expect(root().getAttribute('data-rail')).toBe('open')
    expect(ui.panels.leftRail.value).toBe(TOKENS.layout.leftRail)
    expect(text(one(byClass(root(), 'hl-rail__title')))).toBe(t('modes.plan.label'))
    expect(byClass(root(), 'probe')).toHaveLength(1)
    expect(one(byClass(root(), 'hl-rail__toggle')).getAttribute('aria-expanded')).toBe('true')
    act(() => void applyRoute({ name: 'trade' }, '#/trade'))
    expect(shell.railSheet.value).toBe(false)
    expect(root().getAttribute('data-rail')).toBe('collapsed')
    // back on desktop the rail is the 320 px column again
    act(() => void (shell.breakpoint.value = breakpointFor(1440)))
    expect(root().getAttribute('data-rail')).toBe('open')
    expect(byClass(root(), 'hl-rail__title')).toHaveLength(1)
    act(() => off())
  })

  it('sidebar: closed until opened (§4.3 opens on selection), empty-state card, A5 content slot', () => {
    expect(root().getAttribute('data-sidebar')).toBe('closed')
    act(() => openSidebar())
    expect(root().getAttribute('data-sidebar')).toBe('open')
    expect(text(one(byClass(root(), 'hl-empty')))).toBe(t('states.empty.noSelection'))
    act(() => setSidebarContent(() => <p class="probe">card</p>))
    expect(byClass(root(), 'probe')).toHaveLength(1)
    act(() => setSidebarContent(undefined))
    fire(byTag(one(byClass(root(), 'hl-sidebar__head')), 'button')[0], 'click')
    expect(shell.sidebarOpen.value).toBe(false)
  })

  it('rail sections registered by later packages show in their modes only', () => {
    let off = () => {}
    act(() => void (off = registerRailSection({ id: 'layers', modes: ['plan'], title: 'nav.rail.layers', icon: 'layers', render: () => <p class="probe">x</p> })))
    expect(byClass(root(), 'probe')).toHaveLength(1)
    act(() => void applyRoute({ name: 'hud' }, '#/fly/hud'))
    expect(byClass(root(), 'probe')).toHaveLength(0)
    act(() => off())
  })

  it('help overlay is a labelled dialog with every shortcut; the top bar button opens it', () => {
    const dlg = one(byTag(root(), 'dialog'))
    expect(dlg.getAttribute('aria-labelledby')).toBe('hl-help-title')
    expect(byClass(dlg, 'hl-help__row')).toHaveLength(16) // 11 keyboard rows + 5 mouse / touch rows (I1)
    const btn = all(root(), (n) => n.getAttribute('aria-label') === t('nav.shortcuts'))[0]
    fire(btn, 'click')
    expect(shell.helpOpen.value).toBe(true)
    expect(dlg.hasAttribute('open')).toBe(true)
    act(() => void (shell.helpOpen.value = false))
    expect(dlg.hasAttribute('open')).toBe(false)
  })

  it('focus mode hides the rails and dock (data-focus) and offers an exit button', () => {
    act(() => void (shell.focusMode.value = true))
    expect(root().getAttribute('data-focus')).toBe('on')
    const exit = one(byClass(root(), 'hl-focusexit'))
    fire(exit, 'click')
    expect(shell.focusMode.value).toBe(false)
  })

  it('installs one keydown and one resize listener on the window', () => {
    expect(win.count('keydown')).toBe(1)
    expect(win.count('resize')).toBe(1)
  })
})

describe('breakpoints (tokens.json layout.breakpoints)', () => {
  it.each([
    [1440, 'desktop'],
    [1280, 'desktop'],
    [1279, 'tablet'],
    [1024, 'tablet'],
    [768, 'tablet'],
    [767, 'phone'],
  ] as const)('%i px -> %s', (w, bp) => expect(breakpointFor(w)).toBe(bp))
})
