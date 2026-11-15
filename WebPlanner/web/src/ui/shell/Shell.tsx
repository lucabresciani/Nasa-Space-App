// App shell islands (DESIGN U0, §4.1 modes, §4.3 layout, §4.4 keyboard; WS15 task 4, package A4).
// Each region of the shell frame (frame.ts) gets one small Preact island; the existing views keep
// rendering into main.outlet on their own. All text comes from copy.json via t().
import { render } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { closePlanner, detect } from '../../marvis/bridge'
import { canonicalHref, type Route } from '../../router'
import { effect, useSignalValue } from '../../state/signal'
import { MODES, ui, type Mode } from '../../state/ui'
import { Button, cx, Icon, IconButton } from '../components'
import { t } from '../copy'
import { SearchButton } from '../search/button'
import type { Frame } from './frame'
import { HELP_ROWS, installShortcuts } from './keys'
import {
  breakpointFor,
  closeSidebar,
  dockCollapsed,
  dockContent,
  isMapMode,
  MODE_KEY,
  MODE_VIEWS,
  modeHash,
  railCollapsed,
  railIconOnly,
  railSections,
  setDockCollapsed,
  setRailCollapsed,
  shell,
  sidebarContent,
} from './store'

const sameView = (a: Route, b: Route): boolean => a.name === b.name || (a.name === 'station' && b.name === 'console')

function useMode(): Mode {
  return useSignalValue(ui.mode) ?? 'plan'
}

function focusMain(): void {
  const main = document.getElementById?.('hl-main')
  main?.focus({ preventScroll: true })
}

export function SkipLink() {
  return (
    <a
      class="hl-skip"
      href="#hl-main"
      onClick={(e) => {
        e.preventDefault() // a hash link would change the route
        focusMain()
      }}
    >
      {t('nav.skipToMap')}
    </a>
  )
}

export function ModeTabs({ mode }: { mode: Mode }) {
  return (
    <ul class="hl-modes" role="list">
      {MODES.map((m) => (
        <li key={m}>
          <a class={cx('hl-modes__tab', m === mode && 'is-active')} href={modeHash(m)} aria-current={m === mode ? 'page' : undefined} aria-keyshortcuts={MODE_KEY[m]}>
            <span>{t(`modes.${m}.label`)}</span>
            <kbd class="hl-modes__key" aria-hidden="true">
              {MODE_KEY[m]}
            </kbd>
          </a>
        </li>
      ))}
    </ul>
  )
}

/** Embedded in the MARVIS simulator (marvis/bridge.ts): the way back to its own menu, on every page. Nothing on any other host. */
export function MarvisBack() {
  const [embedded, setEmbedded] = useState(false)
  useEffect(() => {
    let alive = true
    void detect().then((yes) => alive && setEmbedded(yes))
    return () => {
      alive = false
    }
  }, [])
  if (!embedded) return null
  return (
    <Button variant="primary" icon="chevron-left" class="hl-marvis-back" title={t('simulator.backHint')} onClick={() => void closePlanner()}>
      {t('simulator.back')}
    </Button>
  )
}

export function TopBar() {
  const mode = useMode()
  useSignalValue(shell.lastHash)
  const bp = useSignalValue(shell.breakpoint)
  const sidebarOpen = useSignalValue(shell.sidebarOpen)
  const [menu, setMenu] = useState(false)
  useEffect(() => setMenu(false), [mode])
  const phone = bp === 'phone'
  return (
    <>
      <a class="hl-wordmark" href="#/">
        {t('nav.wordmark')}
      </a>
      <nav class="hl-topbar__modes" aria-label={t('nav.modesMenu')}>
        {phone ? (
          <div class="hl-modemenu">
            <button type="button" class="hl-btn hl-btn--ghost" aria-expanded={menu ? 'true' : 'false'} aria-controls="hl-modemenu" onClick={() => setMenu(!menu)}>
              <Icon name="menu" />
              {t(`modes.${mode}.label`)}
            </button>
            {menu && (
              <div id="hl-modemenu" class="hl-modemenu__list">
                <ModeTabs mode={mode} />
              </div>
            )}
          </div>
        ) : (
          <ModeTabs mode={mode} />
        )}
      </nav>
      <div class="hl-topbar__plan" id="hl-topbar-plan" />
      <div class="hl-topbar__end">
        <SearchButton />
        {isMapMode(mode) && (
          <IconButton
            icon="panel-right"
            label={t('cards.common.details')}
            pressed={sidebarOpen}
            aria-controls="hl-sidebar"
            onClick={() => (shell.sidebarOpen.value = !sidebarOpen)}
          />
        )}
        <IconButton icon="keyboard" label={t('nav.shortcuts')} aria-haspopup="dialog" aria-keyshortcuts="?" onClick={() => (shell.helpOpen.value = true)} />
        <MarvisBack />
      </div>
    </>
  )
}

export function Rail() {
  const mode = useMode()
  const route = useSignalValue(shell.route)
  useSignalValue(ui.panels.leftRail)
  const sheet = useSignalValue(shell.railSheet)
  const bp = useSignalValue(shell.breakpoint)
  const sections = useSignalValue(railSections).filter((s) => s.modes.includes(mode))
  const tablet = bp === 'tablet'
  // §4.3: desktop rail 320 collapsible to 56 (ui.panels.leftRail); tablet rail = 56 px icon column whose
  // toggle opens the full rail as a sheet over the map (shell.railSheet), so the map keeps the width.
  const collapsed = tablet ? !sheet : railCollapsed()
  const toggle = t(collapsed ? 'nav.rail.expand' : 'nav.rail.collapse')
  const iconOnly = railIconOnly()
  return (
    <>
      <div class="hl-rail__head">
        {!iconOnly && <h2 class="hl-rail__title">{t(`modes.${mode}.label`)}</h2>}
        <IconButton
          class="hl-rail__toggle"
          icon={bp === 'phone' ? (collapsed ? 'chevron-up' : 'chevron-down') : 'panel-left'}
          label={toggle}
          aria-expanded={collapsed ? 'false' : 'true'}
          aria-controls="hl-rail-body"
          onClick={() => (tablet ? (shell.railSheet.value = collapsed) : setRailCollapsed(!collapsed))}
        />
      </div>
      <div class="hl-rail__body" id="hl-rail-body" hidden={collapsed && bp === 'phone'}>
        <ul class="hl-rail__views" role="list">
          {MODE_VIEWS[mode].map((v) => {
            const on = sameView(route, v.route)
            const label = t(v.label)
            return (
              <li key={v.route.name}>
                <a class={cx('hl-rail__view', on && 'is-active')} href={canonicalHref(v.route)} aria-current={on ? 'page' : undefined} aria-label={iconOnly ? label : undefined} title={iconOnly ? label : undefined}>
                  <Icon name={v.icon} />
                  {!iconOnly && <span>{label}</span>}
                </a>
              </li>
            )
          })}
        </ul>
        {!iconOnly &&
          sections.map((s) => (
            <section key={s.id} class="hl-rail__section" aria-label={t(s.title)}>
              <h3 class="hl-rail__sectiontitle">
                <Icon name={s.icon} />
                {t(s.title)}
              </h3>
              {s.render()}
            </section>
          ))}
      </div>
    </>
  )
}

export function Sidebar() {
  const content = useSignalValue(sidebarContent)
  return (
    <>
      <div class="hl-sidebar__head">
        <IconButton icon="x" label={t('buttons.close')} onClick={closeSidebar} />
      </div>
      <div class="hl-sidebar__body">
        {content ? (
          content()
        ) : (
          <div class="hl-empty">
            <Icon name="crosshair" />
            <p>{t('states.empty.noSelection')}</p>
          </div>
        )}
      </div>
    </>
  )
}

export function Dock() {
  useSignalValue(ui.panels.timeline)
  const content = useSignalValue(dockContent)
  const collapsed = dockCollapsed()
  return (
    <>
      <div class="hl-dock__head">
        <IconButton icon={collapsed ? 'chevron-up' : 'chevron-down'} label={t(collapsed ? 'nav.rail.expand' : 'nav.rail.collapse')} aria-expanded={collapsed ? 'false' : 'true'} aria-controls="hl-dock-body" onClick={() => setDockCollapsed(!collapsed)} />
        <span class="hl-dock__title">{t('timeline.evaTime')}</span>
      </div>
      <div class="hl-dock__body" id="hl-dock-body" hidden={collapsed}>
        {content ? content() : <p class="hl-dock__placeholder">{t('states.error.notAvailable', { what: t('timeline.marginCurve') })}</p>}
      </div>
    </>
  )
}

/** §4.4 shortcut help: a modal dialog (native <dialog>: focus trapped, Esc closes, focus returns). */
export function HelpDialog() {
  const open = useSignalValue(shell.helpOpen)
  const ref = useRef<HTMLDialogElement>(null)
  const back = useRef<Element | null>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open) {
      back.current = document.activeElement
      if (typeof d.showModal === 'function' && !d.open) d.showModal()
      else d.setAttribute('open', '')
      d.querySelector?.<HTMLElement>('.hl-help__close')?.focus()
    } else {
      if (typeof d.close === 'function' && d.open) d.close()
      else d.removeAttribute('open')
      ;(back.current as HTMLElement | null)?.focus?.()
      back.current = null
    }
  }, [open])
  return (
    <dialog ref={ref} class="hl-help" aria-labelledby="hl-help-title" onClose={() => (shell.helpOpen.value = false)} onCancel={() => (shell.helpOpen.value = false)}>
      <div class="hl-help__head">
        <h2 id="hl-help-title">{t('shortcuts.title')}</h2>
        <IconButton class="hl-help__close" icon="x" label={t('buttons.close')} onClick={() => (shell.helpOpen.value = false)} />
      </div>
      <dl class="hl-help__list">
        {HELP_ROWS.map((r) => (
          <div key={r.label} class={cx('hl-help__row', !r.ready && 'is-pending')}>
            <dt>
              {r.keys.map((k) => (
                <kbd key={k}>{k}</kbd>
              ))}
            </dt>
            <dd>{r.ready ? t(r.label) : t('states.error.notAvailable', { what: t(r.label) })}</dd>
          </div>
        ))}
      </dl>
    </dialog>
  )
}

export function FocusExit() {
  const on = useSignalValue(shell.focusMode)
  if (!on) return null
  return (
    <button type="button" class="hl-btn hl-btn--secondary hl-focusexit" aria-keyshortcuts="Escape F" onClick={() => (shell.focusMode.value = false)}>
      <Icon name="minimize" />
      {t('buttons.exitFocusMode')}
    </button>
  )
}

export interface ShellHandle {
  /** Call after every route render: mode, title, data attributes, focus. */
  routed(route: Route, hash: string, userNav: boolean): void
  destroy(): void
}

/** Mount the islands into a shell frame and wire state → layout. */
export function mountShell(frame: Frame, navigate: (hash: string) => void, win: Window = window): ShellHandle {
  const s = frame.slots!
  const root = frame.root
  render(<SkipLink />, s.skip)
  render(<TopBar />, s.top)
  render(<Rail />, s.rail)
  render(<Sidebar />, s.sidebar)
  render(<Dock />, s.dock)
  render(
    <>
      <HelpDialog />
      <FocusExit />
    </>,
    s.overlay,
  )
  const set = (k: string, v: string) => root.setAttribute(k, v)
  const stopLayout = effect(() => {
    const mode = ui.mode.value ?? 'plan'
    const bp = shell.breakpoint.value
    set('data-mode', mode)
    set('data-bp', bp)
    set('data-focus', shell.focusMode.value ? 'on' : 'off')
    set('data-sidebar', shell.sidebarOpen.value && isMapMode(mode) ? 'open' : 'closed')
    set('data-rail', (bp === 'tablet' ? !shell.railSheet.value : railCollapsed()) ? 'collapsed' : 'open')
    set('data-dock', isMapMode(mode) ? (dockCollapsed() ? 'collapsed' : 'open') : 'none')
    root.style.setProperty('--hl-rail-w', `${ui.panels.leftRail.value}px`)
    root.style.setProperty('--hl-side-w', `${ui.panels.sidebar.value}px`)
    root.style.setProperty('--hl-dock-h', `${ui.panels.timeline.value}px`)
    s.rail.setAttribute('aria-label', t(`modes.${mode}.label`))
  })
  const measure = () => (shell.breakpoint.value = breakpointFor(win.innerWidth))
  measure()
  win.addEventListener('resize', measure)
  const stopKeys = installShortcuts(win, navigate)
  // U14 (A5): the sidebar follows the selection store; cards load in their own chunk.
  let alive = true
  let stopSelection: (() => void) | undefined
  void import('../cards/sidebar').then((m) => {
    if (alive) stopSelection = m.installSelectionSidebar({ win })
  })
  // U5 (A7): the timeline dock body, in its own chunk (replaces the dock placeholder once loaded).
  // Its playback needs a frame loop, so a window without one (headless test stubs) keeps the placeholder.
  let stopDock: (() => void) | undefined
  if (typeof win.requestAnimationFrame === 'function')
    void import('../timeline').then((m) => {
      if (alive) stopDock = m.installTimelineDock(win)
    })
  return {
    routed(route, _hash, userNav) {
      // applyRoute (store.ts) is called by main.ts before the view renders; here only title and focus
      const mode = ui.mode.peek() ?? 'plan'
      const view = MODE_VIEWS[mode].find((v) => sameView(route, v.route))
      document.title = [view && view.route.name !== 'console' ? t(view.label) : null, t(`modes.${mode}.label`), t('nav.wordmark')].filter(Boolean).join(' · ')
      if (!userNav) return
      // Focus follows navigation from the shell's own controls (WCAG 2.4.3): move it to the main region.
      const a = document.activeElement
      if (!a || a === document.body || frame.topbar.contains(a) || s.rail.contains(a)) focusMain()
    },
    destroy() {
      alive = false
      stopSelection?.()
      stopDock?.()
      stopKeys()
      stopLayout()
      win.removeEventListener('resize', measure)
      for (const el of [s.skip, s.top, s.rail, s.sidebar, s.dock, s.overlay]) render(null, el)
    },
  }
}
