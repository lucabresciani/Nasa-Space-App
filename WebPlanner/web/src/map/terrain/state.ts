// WS16 task 8 (M8): the 2D/3D view and exaggeration actions (store writes) plus the pure pieces of
// the terrain wiring (sun-driven relief direction, leader-line pitch). No map, no DOM: the control
// (controls.ts) and the controller (index.ts) call these; the tests call them in node.
import { sunAt, type SunData } from '../../hud/sun'
import { batch, ui } from '../../state'
import { TERRAIN, TERRAIN_PENDING } from './config'

export type View = '2d' | '3d'

/** Exaggeration as the store holds it: clamped to design.yaml [min, max], on the slider step. */
export function clampExaggeration(x: number): number {
  const { min, max } = TERRAIN.exaggeration
  if (!Number.isFinite(x)) return TERRAIN.exaggeration.default
  const s = TERRAIN_PENDING.exaggerationStep
  const v = Math.round(Math.min(max, Math.max(min, x)) / s) * s
  return Number(v.toFixed(1))
}

/** The exaggeration in effect: the store's, or design.yaml's default until something sets it. */
export function exaggeration(): number {
  return ui.exaggeration.value ?? TERRAIN.exaggeration.default
}

export function setExaggeration(x: number): void {
  ui.exaggeration.value = clampExaggeration(x)
}

export function setView(v: View): void {
  batch(() => {
    if (v === '3d' && ui.exaggeration.peek() === undefined) ui.exaggeration.value = TERRAIN.exaggeration.default
    ui.view.value = v
  })
}

export function toggleView(): View {
  const next: View = ui.view.peek() === '3d' ? '2d' : '3d'
  setView(next)
  return next
}

/**
 * Relief light (DESIGN U1 item 4): the sun azimuth (deg clockwise from north, hillshade anchor 'map')
 * at the simulated minute; the clock starts at the plan's start. null outside WS4's sun series
 * (never extrapolated): the layer then keeps MapLibre's default light.
 */
export function reliefAzimuth(sun: SunData | null, tMin: number): number | null {
  if (!sun) return null
  const az = sunAt(sun, reliefMinute(tMin)).azDeg
  return az === null ? null : ((az % 360) + 360) % 360
}

/** The relief follows the clock at most once per simulated minute: the light is set at whole minutes. */
export function reliefMinute(tMin: number): number {
  return Math.floor(tMin)
}
