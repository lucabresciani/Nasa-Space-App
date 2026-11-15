// Mars scale bar (SPEC §4.2, D4). MapLibre treats our Mars lon/lat as Earth lon/lat, so its own
// scale control is wrong by R_earth / R_mars. We measure the on-screen span in Mars metres with the
// Mars radius from config/site.yaml.
import type { IControl, Map as MlMap } from 'maplibre-gl'

export interface LngLatLite {
  lng: number
  lat: number
}

const rad = (d: number) => (d * Math.PI) / 180

/** Great-circle distance on a sphere of radius R (haversine), metres. */
export function marsDistanceM(lon1: number, lat1: number, lon2: number, lat2: number, R: number): number {
  const dLat = rad(lat2 - lat1)
  const dLon = rad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** Largest 1, 2 or 5 x 10^n that is <= maxM. */
export function niceLength(maxM: number): number {
  const p = 10 ** Math.floor(Math.log10(maxM))
  const f = maxM / p
  const m = f >= 5 ? 5 : f >= 2 ? 2 : 1
  return m * p
}

export function formatLength(m: number): string {
  return m >= 1000 ? `${+(m / 1000).toPrecision(6)} km` : `${+m.toPrecision(6)} m`
}

export function scaleBar(left: LngLatLite, right: LngLatLite, widthPx: number, R: number) {
  const span = marsDistanceM(left.lng, left.lat, right.lng, right.lat, R)
  const meters = niceLength(span)
  return { meters, px: (meters / span) * widthPx, label: formatLength(meters) }
}

/** MapLibre control drawing the Mars scale bar; measured horizontally across the map centre. */
export class MarsScaleControl implements IControl {
  private map?: MlMap
  private el = document.createElement('div')
  private bar = document.createElement('div')
  private readonly maxWidthPx: number
  private readonly radiusM: number
  private readonly update = () => this.render()

  constructor(radiusM: number, maxWidthPx = 120) {
    this.radiusM = radiusM
    this.maxWidthPx = maxWidthPx
    this.el.className = 'maplibregl-ctrl mars-scale'
    this.bar.className = 'mars-scale-bar'
    this.el.append(this.bar)
    this.el.title = 'Scale on Mars (sphere R from config/site.yaml)'
  }

  onAdd(map: MlMap): HTMLElement {
    this.map = map
    map.on('move', this.update)
    this.render()
    return this.el
  }

  onRemove(): void {
    this.map?.off('move', this.update)
    this.el.remove()
    this.map = undefined
  }

  private render(): void {
    const map = this.map
    if (!map) return
    const y = map.getContainer().clientHeight / 2
    const x0 = map.getContainer().clientWidth / 2 - this.maxWidthPx / 2
    const a = map.unproject([x0, y])
    const b = map.unproject([x0 + this.maxWidthPx, y])
    const s = scaleBar(a, b, this.maxWidthPx, this.radiusM)
    this.bar.style.width = `${s.px}px`
    this.bar.textContent = s.label
  }
}
