// WS16 task 8 (M8): the map controls of U1 — 2D/3D toggle and the exaggeration slider that always
// shows its factor (DESIGN U1 "What the user sees"). Plain DOM (A2's Segmented/Slider are Preact and
// not on this stack; swap after the rebase). Both write the A3 ui store through state.ts.
// T1: the shell's T shortcut (`hl:shortcut` toggle3d, ui/shell/keys.ts) runs the same action as the
// 2D/3D buttons while this control is on the map, and is ignored like a click while 3D is unavailable.
import type { IControl } from 'maplibre-gl'
import { effect, ui } from '../../state'
import { COPY_PENDING, factorText, t, TERRAIN, TERRAIN_PENDING } from './config'
import { exaggeration, setExaggeration, setView, toggleView, type View } from './state'
import './terrain.css'

/** Trust-chip hook (DESIGN §3.6): the terrain layer group is Real (measured DEM), factor noted. */
export const TERRAIN_TRUST = { attr: 'data-trust', chip: 'real', sourceAttr: 'data-trust-source', source: 'terrain/tiles.json', factorAttr: 'data-trust-factor' } as const

export class TerrainControl implements IControl {
  private el: HTMLDivElement | null = null
  private stop: (() => void) | null = null
  private disabledWhy: string | null = null
  private buttons: Partial<Record<View, HTMLButtonElement>> = {}
  private win: Window | null = null

  /** The T shortcut: the 2D/3D button action; nothing while the 3D button is disabled (like a click on it). */
  private readonly onShortcut = (e: Event): void => {
    if ((e as CustomEvent<{ action?: string } | null>).detail?.action !== 'toggle3d') return
    e.preventDefault() // handled here: the shell does not flip ui.view on its own
    if (ui.view.peek() !== '3d' && this.disabledWhy) return
    toggleView()
  }

  onAdd(): HTMLElement {
    const box = document.createElement('div')
    box.className = 'maplibregl-ctrl maplibregl-ctrl-group hl-terrain-ctrl'
    box.setAttribute('aria-label', t('layers.groups.terrain'))
    box.setAttribute(TERRAIN_TRUST.attr, TERRAIN_TRUST.chip)
    box.setAttribute(TERRAIN_TRUST.sourceAttr, TERRAIN_TRUST.source)
    box.setAttribute(TERRAIN_TRUST.factorAttr, String(TERRAIN.elevationFactor))
    box.title = COPY_PENDING.trustNote.replace('{factor}', String(TERRAIN.elevationFactor))

    const seg = document.createElement('div')
    seg.className = 'hl-terrain-seg'
    seg.setAttribute('role', 'radiogroup')
    seg.setAttribute('aria-label', t('buttons.toggle2d3d'))
    const views: View[] = ['2d', '3d']
    for (const v of views) {
      const b = document.createElement('button')
      b.type = 'button'
      b.setAttribute('role', 'radio')
      b.textContent = t(v === '2d' ? 'buttons.view2d' : 'buttons.view3d')
      b.setAttribute('aria-keyshortcuts', 'T')
      b.addEventListener('click', () => setView(v))
      b.addEventListener('keydown', (e) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
        e.preventDefault()
        const other: View = v === '2d' ? '3d' : '2d'
        if (other === '3d' && this.disabledWhy) return
        setView(other)
        this.buttons[other]?.focus()
      })
      this.buttons[v] = b
      seg.appendChild(b)
    }

    const label = document.createElement('label')
    label.className = 'hl-terrain-exag'
    const name = document.createElement('span')
    name.textContent = t('buttons.exaggeration')
    const input = document.createElement('input')
    input.type = 'range'
    input.min = String(TERRAIN.exaggeration.min)
    input.max = String(TERRAIN.exaggeration.max)
    input.step = String(TERRAIN_PENDING.exaggerationStep)
    input.addEventListener('input', () => setExaggeration(Number(input.value)))
    const out = document.createElement('output')
    label.appendChild(name)
    label.appendChild(input)
    label.appendChild(out)

    box.appendChild(seg)
    box.appendChild(label)
    this.el = box
    this.stop = effect(() => {
      const view = ui.view.value
      const x = exaggeration()
      for (const v of views) {
        const b = this.buttons[v]!
        const on = v === view
        b.setAttribute('aria-checked', String(on))
        b.tabIndex = on ? 0 : -1
      }
      this.buttons['3d']!.disabled = this.disabledWhy !== null
      this.buttons['3d']!.title = this.disabledWhy ?? t('tooltips.view3d')
      label.hidden = view !== '3d'
      input.value = String(x)
      out.value = factorText(x)
      const tip = t('tooltips.exaggeration', { factor: x.toFixed(1) })
      input.title = tip
      input.setAttribute('aria-valuetext', tip)
      out.title = tip
    })
    this.win = typeof window === 'undefined' ? null : window
    this.win?.addEventListener('hl:shortcut', this.onShortcut)
    return box
  }

  /** Disable the 3D button with a reason (no tiles in this data tree); null enables it again. */
  setUnavailable(why: string | null): void {
    this.disabledWhy = why
    const b = this.buttons['3d']
    if (b) {
      b.disabled = why !== null
      b.title = why ?? t('tooltips.view3d')
    }
  }

  onRemove(): void {
    this.win?.removeEventListener('hl:shortcut', this.onShortcut)
    this.win = null
    this.stop?.()
    this.el?.remove()
    this.el = null
  }
}

/** The one-line notice over the map (fallback reasons, loading). */
export class TerrainNotice {
  readonly el: HTMLDivElement
  constructor(container: HTMLElement) {
    this.el = document.createElement('div')
    this.el.className = 'hl-terrain-notice'
    this.el.setAttribute('role', 'status')
    this.el.hidden = true
    container.appendChild(this.el)
  }
  show(text: string | null): void {
    this.el.hidden = text === null
    this.el.textContent = text ?? ''
    this.el.title = text ?? ''
  }
  destroy(): void {
    this.el.remove()
  }
}
