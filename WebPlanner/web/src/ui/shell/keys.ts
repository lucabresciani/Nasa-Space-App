// Keyboard shortcuts (DESIGN §4.4; WS15 task 4, package A4).
// shortcutFor() maps a key event to an action (pure, tested). runShortcut() performs the actions the
// shell owns today (modes, help, focus mode, Escape, 2D/3D, play/pause and scrub on the mission clock in
// FLY) and announces every action as a `hl:shortcut` CustomEvent on window, so later packages (search
// U17, camera U16, selection history A5, undo U15) handle theirs without editing the shell:
//   window.addEventListener('hl:shortcut', (e) => { if (e.detail.action === 'search') { …; e.preventDefault() } })
import type { Route } from '../../router'
import type { ClockDriver } from '../../state/clock'
import { ui, type Mode } from '../../state/ui'
import type { CopyKey } from '../copy'
import { modeHash, shell } from './store'

export type ShortcutAction =
  | { action: 'search' }
  | { action: 'camera'; preset: number }
  | { action: 'focusMode' }
  | { action: 'playPause' }
  | { action: 'scrub'; minutes: number }
  | { action: 'escape' }
  | { action: 'undo' }
  | { action: 'redo' }
  | { action: 'history'; step: -1 | 1 }
  | { action: 'mode'; mode: Mode }
  | { action: 'toggle3d' }
  | { action: 'help' }

export interface KeyLike {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  target?: unknown
}

const MODE_KEYS: Record<string, Mode> = { p: 'plan', y: 'fly', r: 'report', e: 'evidence' }

/** Typing in a field (or a slider, select, editable text) never triggers a shortcut. */
export function isTypingTarget(t: unknown): boolean {
  const el = t as { localName?: string; isContentEditable?: boolean; getAttribute?: (k: string) => string | null; type?: string } | null
  if (!el || typeof el !== 'object') return false
  if (el.isContentEditable) return true
  const tag = (el.localName ?? '').toLowerCase()
  if (tag === 'textarea' || tag === 'select') return true
  if (tag === 'input') {
    const type = (el.type ?? el.getAttribute?.('type') ?? 'text').toLowerCase()
    return !['button', 'checkbox', 'radio', 'submit', 'reset'].includes(type)
  }
  const role = el.getAttribute?.('role')
  return role === 'textbox' || role === 'combobox' || role === 'slider' || role === 'searchbox'
}

export function shortcutFor(e: KeyLike): ShortcutAction | null {
  const mod = !!(e.ctrlKey || e.metaKey)
  const k = e.key
  if (mod && !e.altKey) {
    const l = k.toLowerCase()
    if (l === 'k') return { action: 'search' }
    if (l === 'z') return e.shiftKey ? { action: 'redo' } : { action: 'undo' }
    return null
  }
  if (k === 'Escape') return { action: 'escape' } // also from inside fields
  if (e.altKey || mod || isTypingTarget(e.target)) return null
  if (k === '?') return { action: 'help' }
  if (k === '/') return { action: 'search' }
  if (k === ' ' || k === 'Spacebar') return { action: 'playPause' }
  if (k === 'ArrowLeft' || k === 'ArrowRight') return { action: 'scrub', minutes: (k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1) }
  if (k === '[') return { action: 'history', step: -1 }
  if (k === ']') return { action: 'history', step: 1 }
  if (/^[1-5]$/.test(k)) return { action: 'camera', preset: Number(k) }
  const l = k.toLowerCase()
  if (l in MODE_KEYS && k.length === 1 && !e.shiftKey) return { action: 'mode', mode: MODE_KEYS[l] }
  if (l === 'f' && !e.shiftKey) return { action: 'focusMode' }
  if (l === 't' && !e.shiftKey) return { action: 'toggle3d' }
  return null
}

/** Help overlay rows (§4.4), with whether the action does something in this build. */
export interface HelpRow {
  keys: string[]
  label: CopyKey
  ready: boolean
}
export const HELP_ROWS: readonly HelpRow[] = [
  { keys: ['Ctrl+K', '/'], label: 'shortcuts.search', ready: true }, // U17 (ui/search, A8)
  { keys: ['1–5'], label: 'shortcuts.cameraPresets', ready: true }, // U16 (map/camera, M9)
  { keys: ['F'], label: 'shortcuts.focusMode', ready: true },
  { keys: ['Space'], label: 'shortcuts.playPause', ready: true }, // FLY
  { keys: ['←', '→'], label: 'shortcuts.scrub', ready: true }, // FLY
  { keys: ['Esc'], label: 'shortcuts.escape', ready: true },
  { keys: ['Ctrl+Z', 'Ctrl+Shift+Z'], label: 'shortcuts.undoRedo', ready: false }, // U15
  { keys: ['[', ']'], label: 'shortcuts.history', ready: true }, // A5 (ui/cards/sidebar.tsx)
  { keys: ['P', 'Y', 'R', 'E'], label: 'shortcuts.modes', ready: true },
  { keys: ['T'], label: 'shortcuts.toggle3d', ready: true },
  { keys: ['?'], label: 'shortcuts.help', ready: true },
  // I1 mouse model (map/input): left button interacts, right button moves the map
  { keys: ['Left click'], label: 'shortcuts.mouseSelect', ready: true },
  { keys: ['Right drag'], label: 'shortcuts.mousePan', ready: true },
  { keys: ['Ctrl / Shift + right drag', 'Middle drag'], label: 'shortcuts.mouseRotate', ready: true },
  { keys: ['Wheel'], label: 'shortcuts.mouseZoom', ready: true },
  { keys: ['Touch'], label: 'shortcuts.touch', ready: true },
]

/** Views that handle a key themselves: the shell leaves it to them (the HUD's Space toggles the same clock). */
const VIEW_KEYS: Partial<Record<Route['name'], readonly ShortcutAction['action'][]>> = { hud: ['playPause'] }

export interface ShortcutEnv {
  navigate: (hash: string) => void
  /** Announce the action; returns true when a listener handled it (preventDefault). */
  announce: (a: ShortcutAction) => boolean
  /** The mission clock; lazy by default so config YAML stays out of the first load. */
  clock?: () => Promise<ClockDriver>
}

const lazyClock = (): Promise<ClockDriver> => import('../../state/mission').then((m) => m.missionClock)

/** Perform `a`. Returns true when the key was used (the caller then prevents the browser default). */
export function runShortcut(a: ShortcutAction, env: ShortcutEnv): boolean {
  const route = shell.route.peek()
  if (VIEW_KEYS[route.name]?.includes(a.action)) return false
  if (env.announce(a)) return true
  const fly = ui.mode.peek() === 'fly'
  switch (a.action) {
    case 'mode':
      env.navigate(modeHash(a.mode))
      return true
    case 'help':
      shell.helpOpen.value = !shell.helpOpen.peek()
      return true
    case 'focusMode':
      shell.focusMode.value = !shell.focusMode.peek()
      return true
    case 'escape':
      if (shell.helpOpen.peek()) shell.helpOpen.value = false
      else if (shell.focusMode.peek()) shell.focusMode.value = false
      else return false
      return true
    case 'toggle3d': {
      const next = ui.view.peek() === '3d' ? '2d' : '3d'
      ui.view.value = next
      return true
    }
    case 'playPause':
      if (!fly) return false
      void (env.clock ?? lazyClock)().then((c) => c.toggle())
      return true
    case 'scrub':
      if (!fly) return false
      void (env.clock ?? lazyClock)().then((c) => c.seek(c.t + a.minutes))
      return true
    default:
      return false // search, camera, undo/redo, history: announced only until their packages land
  }
}

/** Install the window listener; returns cleanup. */
export function installShortcuts(win: Window, navigate: (hash: string) => void): () => void {
  const announce = (a: ShortcutAction): boolean => {
    const ev = new CustomEvent('hl:shortcut', { detail: a, cancelable: true })
    win.dispatchEvent(ev)
    return ev.defaultPrevented
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return
    const a = shortcutFor(e)
    if (a && runShortcut(a, { navigate, announce })) e.preventDefault()
  }
  win.addEventListener('keydown', onKey)
  return () => win.removeEventListener('keydown', onKey)
}
