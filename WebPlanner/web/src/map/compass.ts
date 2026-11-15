// WS16 task 5 (M5): compass with north arrow and sun direction (DESIGN U4 "Furniture").
// The sun is WS4's Mars24 sun series in conditions/clock.json (C decision 12:20: no sun.json; read
// through WS7's hud/sun.ts), at the mission clock minute. Azimuth is clockwise from north; both
// arrows turn with the map bearing. No sun arrow outside the series (never extrapolated).
import type { Map as MlMap } from 'maplibre-gl'
import { sunAt, type SunData } from '../hud/sun'
import { COPY_PENDING, fmt1, t } from './furniture/text'

export interface CompassAngles {
  /** screen rotation of the north arrow, deg clockwise */
  north: number
  /** screen rotation of the sun arrow, deg clockwise; null = no sun known at this minute */
  sun: number | null
  sunAzDeg: number | null
  sunElDeg: number | null
}

/** Arrow angles on screen for a map bearing (deg) at EVA minute tMin. */
export function compassAngles(bearingDeg: number, sun: SunData | null, tMin: number): CompassAngles {
  const r = sun ? sunAt(sun, tMin) : null
  const az = r?.azDeg ?? null
  const norm = (a: number): number => ((a % 360) + 360) % 360
  return { north: norm(-bearingDeg), sun: az === null ? null : norm(az - bearingDeg), sunAzDeg: az, sunElDeg: r?.elDeg ?? null }
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** MapLibre control: a round dial, a north arrow and a sun arrow (tokens via compass CSS). */
export class CompassControl {
  readonly el: HTMLDivElement
  private readonly north: SVGGElement
  private readonly sunG: SVGGElement
  private map: MlMap | null = null
  private sun: SunData | null = null
  private tMin = 0
  private readonly onRotate = (): void => this.render()

  constructor() {
    const el = document.createElement('div')
    el.className = 'maplibregl-ctrl hl-compass'
    el.setAttribute('role', 'img')
    el.setAttribute('data-trust', 'simulated') // the sun at the simulated EVA's time (DESIGN §3.6)
    el.setAttribute('data-trust-source', 'conditions/clock.json eva.sun_series')
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '-20 -20 40 40')
    svg.setAttribute('aria-hidden', 'true')
    const dial = document.createElementNS(SVG_NS, 'circle')
    dial.setAttribute('r', '18')
    dial.setAttribute('class', 'hl-compass-dial')
    this.north = document.createElementNS(SVG_NS, 'g')
    this.north.setAttribute('class', 'hl-compass-north')
    const n = document.createElementNS(SVG_NS, 'path')
    n.setAttribute('d', 'M0 -15 L5 2 L0 -1 L-5 2 Z')
    const nText = document.createElementNS(SVG_NS, 'path') // an "N" drawn as a path (no glyphs)
    nText.setAttribute('d', 'M-2.5 12 V6 L2.5 12 V6')
    nText.setAttribute('class', 'hl-compass-n')
    this.north.append(n, nText)
    this.sunG = document.createElementNS(SVG_NS, 'g')
    this.sunG.setAttribute('class', 'hl-compass-sun')
    const ray = document.createElementNS(SVG_NS, 'path')
    ray.setAttribute('d', 'M0 -4 V-12')
    const disc = document.createElementNS(SVG_NS, 'circle')
    disc.setAttribute('cy', '-15')
    disc.setAttribute('r', '3')
    this.sunG.append(ray, disc)
    svg.append(dial, this.sunG, this.north)
    el.append(svg)
    this.el = el
  }

  onAdd(map: MlMap): HTMLElement {
    this.map = map
    map.on('rotate', this.onRotate)
    this.render()
    return this.el
  }
  onRemove(): void {
    this.map?.off('rotate', this.onRotate)
    this.map = null
    this.el.remove()
  }

  setSun(sun: SunData | null): void {
    this.sun = sun
    this.render()
  }
  setMinute(tMin: number): void {
    this.tMin = tMin
    this.render()
  }

  private render(): void {
    const a = compassAngles(this.map?.getBearing() ?? 0, this.sun, this.tMin)
    this.north.setAttribute('transform', `rotate(${a.north})`)
    this.sunG.style.display = a.sun === null ? 'none' : ''
    if (a.sun !== null) this.sunG.setAttribute('transform', `rotate(${a.sun})`)
    const sunText = a.sunAzDeg === null ? COPY_PENDING.sunNone : `${COPY_PENDING.sun} ${fmt1(a.sunAzDeg)}°${a.sunElDeg === null ? '' : ` · ${fmt1(a.sunElDeg)}°`}`
    const label = `${t('tooltips.compass')} · ${sunText}`
    this.el.setAttribute('aria-label', label)
    this.el.title = label
  }
}
