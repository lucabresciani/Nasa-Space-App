// WS16 task 11 (M11, U7): overlay state shared by the layer panel (left rail) and the map.
// In memory only (no browser storage). At most overlays.max_thematic_on thematic overlays at once:
// turning on one more turns off the oldest and leaves a notice (copy tooltips.layerCap).
import { batch, signal } from '../../state/signal'
import { clampOpacity, DEFAULT_ON, DEFAULT_OPACITY, OVERLAY_CFG, overlayById, OVERLAYS, type OverlayId } from './catalog'

export const overlayOn = signal<Readonly<Record<OverlayId, boolean>>>({ ...DEFAULT_ON })
export const overlayOpacity = signal<Readonly<Record<OverlayId, number>>>(Object.fromEntries(OVERLAYS.map((o) => [o.id, DEFAULT_OPACITY])) as Record<OverlayId, number>)
/** The thematic overlays that are on, oldest first. */
export const thematicOrder = signal<readonly OverlayId[]>([])
/** Set when the cap turned an overlay off: { turnedOff } (the panel shows tooltips.layerCap). */
export const capNotice = signal<{ turnedOff: OverlayId } | null>(null)

export function setOverlay(id: OverlayId, on: boolean): void {
  batch(() => {
    const cur = { ...overlayOn.peek() }
    let order = thematicOrder.peek().filter((x) => x !== id)
    cur[id] = on
    capNotice.value = null
    if (on && overlayById(id).thematic) {
      order = [...order, id]
      while (order.length > OVERLAY_CFG.maxThematicOn) {
        const oldest = order.shift()!
        cur[oldest] = false
        capNotice.value = { turnedOff: oldest }
      }
    }
    thematicOrder.value = order
    overlayOn.value = cur
  })
}

export function setOverlayOpacity(id: OverlayId, v: number): void {
  overlayOpacity.value = { ...overlayOpacity.peek(), [id]: clampOpacity(v) }
}

/** Back to the default view (tests; story mode). */
export function resetOverlays(): void {
  batch(() => {
    overlayOn.value = { ...DEFAULT_ON }
    overlayOpacity.value = Object.fromEntries(OVERLAYS.map((o) => [o.id, DEFAULT_OPACITY])) as Record<OverlayId, number>
    thematicOrder.value = []
    capNotice.value = null
  })
}
