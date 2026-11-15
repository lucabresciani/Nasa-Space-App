// WS16 task 9 (M9): camera presets (keys 1–5) and focus transitions on the planning map (DESIGN U16).
//  - Keys: the shell (ui/shell/keys.ts) announces { action: 'camera', preset } as a cancelable
//    `hl:shortcut` event; this controller handles it (preventDefault) while the map exists.
//  - Presets 2 and 3 need the 3D view: they turn it on through the ui store (M8's terrain controller
//    loads the terrain) and tilt once it is on. Preset 5 presses M10's Flythrough button (the follow
//    camera of U6); presets 1–4 and a focus stop it.
//  - Focus: selecting an object from any source (map, list, search, history) eases the camera to frame
//    it and its legs. A cell or an edge picked on the map does not move the camera (it is already in
//    view under the pointer); search coordinates do. Preset 4 and the card's Focus action always do.
//  - Every move: 1.2–2.5 s ease-in-out, any input cancels at once; reduced motion: a cut (transition.ts).
import { CONFIG } from '../../config'
import { effect, ui } from '../../state'
import { registerSelectionAction, selection, type SelectionRef } from '../../state/selection'
import { setView } from '../terrain/state'
import { FOCUS_MIN_SPAN_M, PRESETS } from './config'
import { focusBounds, focusPoints, type FocusSources } from './focus'
import { isPresetId, preset, type PresetId } from './presets'
import { CameraMover, type CameraMap, type CameraTarget } from './transition'

export { preset, isPresetId, type PresetId } from './presets'
export { CameraMover, easeInOut, moveDurationMs } from './transition'

export interface ControllerMap extends CameraMap {
  cameraForBounds(b: [[number, number], [number, number]], o: { padding: number; bearing: number; pitch: number }): { center?: unknown; zoom?: number } | undefined
  getMaxZoom(): number
}

interface Win {
  addEventListener(t: string, fn: (e: Event) => void, o?: boolean): void
  removeEventListener(t: string, fn: (e: Event) => void, o?: boolean): void
}

export interface CameraEnv {
  win?: Win | null
  /** Resolves true once the 3D terrain is on, false when it cannot be (default: the map's data-terrain state). */
  terrainReady?: () => Promise<boolean>
  /** The follow camera (M10 flythrough): is it on, and switch it. Default: M10's button in the map. */
  follow?: { on(): boolean; toggle(): boolean }
}

/** M10's Flythrough button (map/flythrough/control.ts) inside the map container. */
function flyFollow(el: ParentNode | null): { on(): boolean; toggle(): boolean } {
  const btn = (): HTMLButtonElement | null => el?.querySelector?.<HTMLButtonElement>('.hl-fly .hl-fly-btn:not(.hl-fly-speed)') ?? null
  return {
    on: () => btn()?.getAttribute('aria-pressed') === 'true',
    toggle: () => {
      const b = btn()
      if (!b || b.disabled) return false
      b.click()
      return true
    },
  }
}

/** Waits for M8's terrain controller (data-terrain on the map container) after the store asked for 3D. */
function terrainReadyOf(el: HTMLElement, timeoutMs = 20000): () => Promise<boolean> {
  return () =>
    new Promise<boolean>((resolve) => {
      if (el.getAttribute('data-terrain') === '3d') return resolve(true)
      let done = false
      const fin = (ok: boolean): void => {
        if (done) return
        done = true
        mo.disconnect()
        stopView()
        clearTimeout(timer)
        resolve(ok)
      }
      const mo = new MutationObserver(() => {
        const s = el.getAttribute('data-terrain')
        if (s === '3d') fin(true)
        else if (s === 'unavailable') fin(false)
      })
      mo.observe(el, { attributes: true, attributeFilter: ['data-terrain'] })
      // the controller's fallback (no WebGL2, slow, no tiles) puts the store back to 2D
      const stopView = effect(() => {
        if (ui.view.value === '2d') queueMicrotask(() => fin(false))
      })
      const timer = setTimeout(() => fin(false), timeoutMs)
    })
}

export class CameraController {
  readonly mover: CameraMover
  private readonly map: ControllerMap
  private readonly sources: () => FocusSources
  private readonly env: Required<Pick<CameraEnv, 'terrainReady' | 'follow'>> & { win: Win | null }
  private readonly stops: (() => void)[] = []
  private seq = 0

  constructor(map: ControllerMap, sources: () => FocusSources, env: CameraEnv = {}) {
    this.map = map
    this.sources = sources
    const el = map.getContainer() as unknown as HTMLElement
    const win = env.win !== undefined ? env.win : typeof window === 'undefined' ? null : window
    this.env = { win, terrainReady: env.terrainReady ?? terrainReadyOf(el), follow: env.follow ?? flyFollow(el) }
    this.mover = new CameraMover(map, win)
    const onShortcut = (e: Event): void => {
      const d = (e as CustomEvent<{ action?: string; preset?: unknown }>).detail
      if (d?.action !== 'camera' || !isPresetId(d.preset)) return
      e.preventDefault()
      void this.applyPreset(d.preset)
    }
    win?.addEventListener('hl:shortcut', onShortcut)
    this.stops.push(() => win?.removeEventListener('hl:shortcut', onShortcut))
    // focus on selection, from any source (not on mount: the camera keeps the view the map opened with)
    let first = true
    this.stops.push(
      effect(() => {
        const ref = selection.selected.value
        if (first) {
          first = false
          return
        }
        if (!ref) return
        const src = selection.source.peek()
        if (src === 'map' && (ref.kind === 'cell' || ref.kind === 'edge')) return
        this.focus(ref)
      }),
      registerSelectionAction({ id: 'map.focus', label: 'buttons.focus', applies: (r) => focusPoints(r, this.sources()).length > 0, run: (r) => void this.focus(r) }),
    )
  }

  private reduced(): boolean {
    return ui.reducedMotion.peek()
  }

  private stopFollow(): void {
    if (this.env.follow.on()) this.env.follow.toggle()
  }

  /** The camera target that frames `ref` and its legs (focus padding from design.yaml), or null. */
  focusTarget(ref: SelectionRef): CameraTarget | null {
    const b = focusBounds(focusPoints(ref, this.sources()), FOCUS_MIN_SPAN_M, CONFIG.marsRadiusM)
    if (!b) return null
    const bearing = this.map.getBearing()
    const pitch = this.map.getPitch()
    const cam = this.map.cameraForBounds(
      [
        [b[0], b[1]],
        [b[2], b[3]],
      ],
      { padding: PRESETS.focus.paddingPx, bearing, pitch },
    )
    if (!cam || cam.zoom === undefined || !cam.center) return null
    const c = cam.center as [number, number] | { lng?: number; lon?: number; lat: number }
    const center: [number, number] = Array.isArray(c) ? [c[0], c[1]] : [c.lng ?? c.lon ?? NaN, c.lat]
    if (!center.every(Number.isFinite)) return null
    return { center, zoom: Math.min(cam.zoom, this.map.getMaxZoom()), bearing, pitch }
  }

  /** Ease to frame the selected object and its legs. False when it has no place on this map. */
  focus(ref: SelectionRef): boolean {
    const to = this.focusTarget(ref)
    if (!to) return false
    this.seq++
    this.stopFollow()
    this.mover.move(to, this.reduced())
    return true
  }

  /** Keys 1–5. Resolves false when the preset cannot apply (nothing selected, no 3D, no route). */
  async applyPreset(id: PresetId): Promise<boolean> {
    const p = preset(id)
    const seq = ++this.seq
    if (p.kind === 'follow') {
      this.mover.cancel()
      return this.env.follow.on() || this.env.follow.toggle()
    }
    if (p.kind === 'focus') {
      const ref = selection.selected.peek()
      return ref ? this.focus(ref) : false
    }
    this.stopFollow()
    if (p.needs3d && ui.view.peek() !== '3d') {
      setView('3d')
      if (!(await this.env.terrainReady())) return false
      if (seq !== this.seq) return false // another key or a focus came first
    }
    this.mover.move({ pitch: p.pitch, ...(p.bearing !== undefined ? { bearing: p.bearing } : {}) }, this.reduced())
    return true
  }

  destroy(): void {
    this.seq++
    this.mover.cancel()
    for (const s of this.stops) s()
  }
}
