// WS16 task 4 (M4): the collapse's DOM furniture on the planning map (DESIGN U3).
//   - "Flat vs real" toggle (a MapLibre control): real -> flat jumps to k = 0; flat -> real plays
//     the collapse (3 s ease-in-out, or the reduced-motion cross-fade).
//   - The headline overlay: counts up with k to the manifest value (D25; D43 at 60 min), with its
//     range; a trust-chip hook (data-trust="modelled" + manifest key and file, A2 attaches the chip).
// Plain DOM, no framework; colours, sizes and durations come from tokens.css (collapse.css).
import type { IControl } from 'maplibre-gl'
import { formatValue } from '../../prov/provenance'
import { lookup } from '../../prov/store'
import { effect, ui } from '../../state'
import { collapseFade, headlineCount, HEADLINE_DP, playCollapse, setCollapse, type CollapseHeadline } from './collapse'
import './collapse.css'

/** Trust-chip hook attributes on the headline (DESIGN §3.6: the homeline headline is ◐ Modelled). */
export const HEADLINE_TRUST = {
  chip: 'modelled',
  attr: 'data-trust',
  keyAttr: 'data-trust-key',
  sourceAttr: 'data-trust-source',
} as const

export const TOGGLE_LABEL = { toFlat: 'Flat vs real: show the flat circle', toReal: 'Flat vs real: collapse to the real homeline' } as const

/** The "Flat vs real" toggle (DESIGN U3 trigger in Plan). */
export class CollapseToggle implements IControl {
  private el: HTMLDivElement | null = null
  private stop: (() => void) | null = null

  onAdd(): HTMLElement {
    const box = document.createElement('div')
    box.className = 'maplibregl-ctrl maplibregl-ctrl-group collapse-toggle'
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'collapse-toggle-btn'
    b.textContent = 'Flat vs real'
    b.addEventListener('click', () => {
      const k = ui.collapseK.peek()
      if (k !== undefined && k < 1 && !collapseFade.playing.peek()) void playCollapse({ from: k })
      else setCollapse(0)
    })
    box.appendChild(b)
    this.el = box
    this.stop = effect(() => {
      const k = ui.collapseK.value
      const flat = k !== undefined && k < 1
      b.setAttribute('aria-pressed', String(flat))
      b.title = flat ? TOGGLE_LABEL.toReal : TOGGLE_LABEL.toFlat
      b.disabled = collapseFade.playing.value
    })
    return box
  }

  onRemove(): void {
    this.stop?.()
    this.el?.remove()
    this.el = null
  }
}

/** Headline text pieces at collapse progress k (pure; the overlay renders them). */
export function headlineParts(h: CollapseHeadline, k: number, reduced: boolean): { value: string; range: string | null; final: boolean; label: string } {
  const c = headlineCount(h, k, reduced)
  const value = `${c.text}%`
  const range = h.range ? `(${h.range[0].toFixed(HEADLINE_DP)}–${h.range[1].toFixed(HEADLINE_DP)})` : null
  const where = h.inDataPct !== null ? `of the part of the ${h.budget}-min flat circle inside the terrain data` : `of the assessed flat ${h.budget}-min circle`
  const label = `${formatValue(h.value, '%', { dp: HEADLINE_DP })} ${range ?? ''} reachable on foot ${where}`.replace(/\s+/g, ' ')
  return { value, range, final: c.final, label }
}

/**
 * The counted headline over the map. Visible while the collapse state is set (ui.collapseK defined);
 * k = 0 shows the flat-world caption without a number.
 */
export class CollapseHeadlineOverlay {
  readonly el: HTMLDivElement
  private readonly valueEl: HTMLSpanElement
  private readonly rangeEl: HTMLSpanElement
  private readonly textEl: HTMLSpanElement
  private headline: CollapseHeadline | null = null
  private readonly stop: () => void

  constructor(container: HTMLElement) {
    const el = document.createElement('div')
    el.className = 'collapse-headline'
    el.setAttribute('role', 'status')
    el.hidden = true
    this.valueEl = document.createElement('span')
    this.valueEl.className = 'collapse-headline-value'
    this.valueEl.setAttribute('aria-hidden', 'true')
    this.rangeEl = document.createElement('span')
    this.rangeEl.className = 'collapse-headline-range'
    this.textEl = document.createElement('span')
    this.textEl.className = 'collapse-headline-text'
    el.append(this.valueEl, this.rangeEl, this.textEl)
    container.appendChild(el)
    this.el = el
    this.stop = effect(() => {
      // subscribe to every input of the frame
      ui.collapseK.value
      collapseFade.xfade.value
      collapseFade.kFrom.value
      ui.reducedMotion.value
      this.render()
    })
  }

  setHeadline(h: CollapseHeadline | null): void {
    this.headline = h
    const el = this.el
    if (h) {
      const r = lookup({ key: h.keys.value, file: h.file, value: h.value })
      el.setAttribute(HEADLINE_TRUST.attr, HEADLINE_TRUST.chip)
      el.setAttribute(HEADLINE_TRUST.keyAttr, h.keys.value)
      el.setAttribute(HEADLINE_TRUST.sourceAttr, h.file)
      el.dataset.provenance = r.status
      el.title = r.status === 'ok' || r.status === 'matched' ? `◐ Modelled · manifest: ${r.key}\nfile: ${r.entry.file}\nscript: ${r.entry.script}\ncommit: ${r.entry.commit}\nutc: ${r.entry.utc}` : `no manifest entry (${r.status})`
    } else {
      for (const a of [HEADLINE_TRUST.attr, HEADLINE_TRUST.keyAttr, HEADLINE_TRUST.sourceAttr]) el.removeAttribute(a)
    }
    this.render()
  }

  private render(): void {
    const k = ui.collapseK.peek()
    const h = this.headline
    const el = this.el
    el.hidden = k === undefined || !h
    if (k === undefined || !h) return
    const reduced = ui.reducedMotion.peek()
    const xf = collapseFade.xfade.peek()
    // reduced motion: the picture cross-fades (k is already at its target, no count); the overlay
    // shows the target state and fades in with the picture
    const p = headlineParts(h, k, reduced)
    const flat = k <= 0
    el.classList.toggle('is-flat', flat)
    el.style.setProperty('--collapse-headline-opacity', String(xf < 1 ? xf : 1))
    this.valueEl.textContent = flat ? '' : p.value
    this.rangeEl.textContent = !flat && p.final && p.range ? p.range : ''
    this.textEl.textContent = flat ? `Flat world: the ${h.budget}-min walk circle on flat ground` : h.inDataPct !== null ? `reachable on foot within ${h.budget} min (part of the circle inside the terrain data)` : `reachable on foot within ${h.budget} min of the assessed flat circle`
    el.setAttribute('aria-label', flat ? this.textEl.textContent : p.label)
  }

  destroy(): void {
    this.stop()
    this.el.remove()
  }
}
