// DESIGN §4.4 keyboard shortcuts (WS15 task 4, A4).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ui } from '../../state/ui'
import { HELP_ROWS, isTypingTarget, runShortcut, shortcutFor, type ShortcutAction } from './keys'
import { applyRoute, shell } from './store'

const input = (type = 'text') => ({ localName: 'input', type, getAttribute: () => null })

describe('shortcutFor (§4.4 table)', () => {
  it.each([
    [{ key: 'k', ctrlKey: true }, { action: 'search' }],
    [{ key: 'K', metaKey: true }, { action: 'search' }],
    [{ key: '/' }, { action: 'search' }],
    [{ key: '1' }, { action: 'camera', preset: 1 }],
    [{ key: '5' }, { action: 'camera', preset: 5 }],
    [{ key: 'f' }, { action: 'focusMode' }],
    [{ key: ' ' }, { action: 'playPause' }],
    [{ key: 'ArrowLeft' }, { action: 'scrub', minutes: -1 }],
    [{ key: 'ArrowRight' }, { action: 'scrub', minutes: 1 }],
    [{ key: 'ArrowLeft', shiftKey: true }, { action: 'scrub', minutes: -10 }],
    [{ key: 'ArrowRight', shiftKey: true }, { action: 'scrub', minutes: 10 }],
    [{ key: 'Escape' }, { action: 'escape' }],
    [{ key: 'z', ctrlKey: true }, { action: 'undo' }],
    [{ key: 'Z', ctrlKey: true, shiftKey: true }, { action: 'redo' }],
    [{ key: '[' }, { action: 'history', step: -1 }],
    [{ key: ']' }, { action: 'history', step: 1 }],
    [{ key: 'p' }, { action: 'mode', mode: 'plan' }],
    [{ key: 'y' }, { action: 'mode', mode: 'fly' }],
    [{ key: 'r' }, { action: 'mode', mode: 'report' }],
    [{ key: 'e' }, { action: 'mode', mode: 'evidence' }],
    [{ key: 't' }, { action: 'toggle3d' }],
    [{ key: '?', shiftKey: true }, { action: 'help' }],
  ])('%o -> %o', (e, want) => expect(shortcutFor(e)).toEqual(want))

  it('ignores browser shortcuts and unmapped keys', () => {
    for (const e of [{ key: 'r', ctrlKey: true }, { key: 'p', altKey: true }, { key: '6' }, { key: 'x' }, { key: 'P', shiftKey: true }, { key: 'Tab' }]) expect(shortcutFor(e)).toBeNull()
  })

  it('never fires while typing; Escape still does', () => {
    for (const target of [input(), input('search'), input('range'), { localName: 'textarea' }, { localName: 'select' }, { localName: 'div', isContentEditable: true }]) {
      expect(isTypingTarget(target)).toBe(true)
      expect(shortcutFor({ key: 'p', target })).toBeNull()
      expect(shortcutFor({ key: ' ', target })).toBeNull()
      expect(shortcutFor({ key: 'Escape', target })).toEqual({ action: 'escape' })
    }
    expect(isTypingTarget(input('checkbox'))).toBe(false)
    expect(isTypingTarget({ localName: 'button', getAttribute: () => null })).toBe(false)
  })

  it('the help overlay lists every §4.4 row', () => {
    expect(HELP_ROWS.map((r) => r.label)).toEqual([
      'shortcuts.search',
      'shortcuts.cameraPresets',
      'shortcuts.focusMode',
      'shortcuts.playPause',
      'shortcuts.scrub',
      'shortcuts.escape',
      'shortcuts.undoRedo',
      'shortcuts.history',
      'shortcuts.modes',
      'shortcuts.toggle3d',
      'shortcuts.help',
      // I1: the mouse model
      'shortcuts.mouseSelect',
      'shortcuts.mousePan',
      'shortcuts.mouseRotate',
      'shortcuts.mouseZoom',
      'shortcuts.touch',
    ])
  })
})

describe('runShortcut', () => {
  const nav = vi.fn<(h: string) => void>()
  const fakeClock = { t: 30, toggle: vi.fn(), seek: vi.fn() }
  const env = (announce = false) => ({ navigate: nav, announce: () => announce, clock: async () => fakeClock as never })
  const run = (a: ShortcutAction, announce = false) => runShortcut(a, env(announce))
  const flush = () => new Promise((r) => setTimeout(r, 0))

  beforeEach(() => {
    nav.mockReset()
    fakeClock.toggle.mockReset()
    fakeClock.seek.mockReset()
    shell.helpOpen.value = false
    shell.focusMode.value = false
    applyRoute({ name: 'console' }, '#/')
  })
  afterEach(() => {
    ui.view.value = '2d'
  })

  it('P/Y/R/E go to the mode, back to the last place visited in it', () => {
    applyRoute({ name: 'station', id: 'S4' }, '#/station/S4')
    applyRoute({ name: 'about' }, '#/evidence/about')
    expect(ui.mode.value).toBe('evidence')
    expect(run({ action: 'mode', mode: 'plan' })).toBe(true)
    expect(nav).toHaveBeenLastCalledWith('#/station/S4')
    run({ action: 'mode', mode: 'evidence' })
    expect(nav).toHaveBeenLastCalledWith('#/evidence/about')
    run({ action: 'mode', mode: 'report' })
    expect(nav).toHaveBeenLastCalledWith('#/report/cuff')
  })

  it('? opens help, F toggles focus mode, Esc closes help first, then focus mode', () => {
    run({ action: 'help' })
    expect(shell.helpOpen.value).toBe(true)
    run({ action: 'focusMode' })
    expect(shell.focusMode.value).toBe(true)
    expect(run({ action: 'escape' })).toBe(true)
    expect(shell.helpOpen.value).toBe(false)
    expect(shell.focusMode.value).toBe(true)
    run({ action: 'escape' })
    expect(shell.focusMode.value).toBe(false)
    expect(run({ action: 'escape' })).toBe(false) // nothing to close: the browser default stays
  })

  it('T switches 2D/3D in the UI store and never navigates (D99: no first-person 3D view)', () => {
    run({ action: 'toggle3d' })
    expect(ui.view.value).toBe('3d')
    expect(nav).not.toHaveBeenCalled()
    applyRoute({ name: 'hud' }, '#/fly/hud')
    run({ action: 'toggle3d' })
    expect(ui.view.value).toBe('2d')
    expect(nav).not.toHaveBeenCalled()
  })

  it('Space and arrows drive the mission clock in FLY only; the HUD keeps its own Space', async () => {
    expect(run({ action: 'playPause' })).toBe(false) // PLAN
    applyRoute({ name: 'conditions' }, '#/fly/conditions')
    expect(run({ action: 'playPause' })).toBe(true)
    expect(run({ action: 'scrub', minutes: -10 })).toBe(true)
    await flush()
    expect(fakeClock.toggle).toHaveBeenCalledTimes(1)
    expect(fakeClock.seek).toHaveBeenCalledWith(20)
    applyRoute({ name: 'hud' }, '#/fly/hud')
    expect(run({ action: 'playPause' })).toBe(false)
  })

  it('a listener that handles the announced action wins; unbuilt actions are announced only', () => {
    expect(run({ action: 'mode', mode: 'fly' }, true)).toBe(true)
    expect(nav).not.toHaveBeenCalled()
    for (const a of [{ action: 'search' }, { action: 'camera', preset: 2 }, { action: 'undo' }, { action: 'history', step: 1 }] as ShortcutAction[]) {
      expect(run(a)).toBe(false)
    }
  })
})
