// WS16 task 5 (M5): cursor readout (DESIGN U4 "Furniture"): longitude, latitude, elevation, slope,
// time home, in monospace. Values are lookups only:
//   time home = fieldAt(lon, lat).tHome[variant] (nearest pixel = the published field value);
//   slope     = fields/shared/slope.png, nearest pixel (WS2 field, deg);
//   elevation = not in any field on this map: a dash with a note (terrain tiles come with U1).
import type { FieldSample } from './field'
import { COPY_PENDING, DASH, fmt1, t } from './furniture/text'

export interface ReadoutValues {
  lon: number
  lat: number
  /** always null: the field has no elevation */
  elevationM: null
  slopeDeg: number | null
  tHomeMin: number | null
}

export function readoutValues(lon: number, lat: number, sample: FieldSample | null, slopeAt: ((lon: number, lat: number) => number | null) | null): ReadoutValues {
  const tHome = sample && sample.inside && !sample.unknown ? sample.tHome[sample.variant] : null
  return { lon, lat, elevationM: null, slopeDeg: slopeAt ? slopeAt(lon, lat) : null, tHomeMin: tHome }
}

export interface ReadoutRow {
  key: 'lon' | 'lat' | 'elevation' | 'slope' | 'timeHome'
  label: string
  value: string
  /** note shown as the row's title (elevation: why there is none) */
  note?: string
  /** trust chip of the value (DESIGN §3.6); undefined = a coordinate, no chip */
  trust?: 'real' | 'modelled'
}

/** Degrees with 5 decimals (about 0.6 m on Mars at Gale), east / north positive. */
function deg(v: number): string {
  return `${v.toFixed(5)}°`
}

export function readoutRows(v: ReadoutValues): ReadoutRow[] {
  return [
    { key: 'lon', label: t('tooltips.cursor.longitude'), value: deg(v.lon) },
    { key: 'lat', label: t('tooltips.cursor.latitude'), value: deg(v.lat) },
    { key: 'elevation', label: t('tooltips.cursor.elevation'), value: DASH, note: COPY_PENDING.elevationNone },
    { key: 'slope', label: t('tooltips.cursor.slope'), value: v.slopeDeg === null ? DASH : `${fmt1(v.slopeDeg)}°`, trust: 'modelled' },
    { key: 'timeHome', label: t('tooltips.cursor.timeHome'), value: v.tHomeMin === null ? DASH : `${fmt1(v.tHomeMin)} min`, trust: 'modelled' },
  ]
}

/** The readout control (bottom right of the planning map). Pass the values each cursor update. */
export class CursorReadout {
  readonly el: HTMLDivElement
  private readonly cells = new Map<ReadoutRow['key'], HTMLElement>()

  constructor() {
    const el = document.createElement('div')
    el.className = 'maplibregl-ctrl hl-cursor-readout'
    el.setAttribute('aria-live', 'off')
    el.hidden = true
    this.el = el
  }

  onAdd(): HTMLElement {
    return this.el
  }
  onRemove(): void {
    this.el.remove()
  }

  set(v: ReadoutValues | null): void {
    if (!v) {
      this.el.hidden = true
      return
    }
    this.el.hidden = false
    for (const r of readoutRows(v)) {
      let cell = this.cells.get(r.key)
      if (!cell) {
        const row = document.createElement('div')
        row.className = `hl-cursor-readout__row hl-cursor-readout__row--${r.key}`
        const k = document.createElement('span')
        k.className = 'hl-cursor-readout__label'
        k.textContent = r.label
        cell = document.createElement('span')
        cell.className = 'hl-cursor-readout__value'
        if (r.trust) cell.setAttribute('data-trust', r.trust)
        if (r.key === 'timeHome') cell.setAttribute('data-trust-source', 'fields t_home.png (fieldAt)')
        if (r.key === 'slope') cell.setAttribute('data-trust-source', 'fields/shared/slope.png')
        if (r.note) row.title = r.note
        row.append(k, cell)
        this.el.append(row)
        this.cells.set(r.key, cell)
      }
      cell.textContent = r.value
    }
  }
}
