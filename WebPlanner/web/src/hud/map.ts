// Self-contained 2D map for the /hud view and the expanded-level minimap: homeline band from the
// T_home field (shaded by margin while playing), unknown terrain hatched from terrain/cellstate
// (A = 0; contracts v1.1.0), route, stations, rover pad, walking marker with dwell ring, the uncertainty
// shape (F21 95% ellipse ring when nav data exist, else F19's sigma circle) and the way-home path
// from the pointer field. Canvas 2D, local metres on the T_home grid (equirectangular).
import type { FieldGrid } from './fields'
import type { Plan, PlanState } from './plan'
import type { LonLat } from './types'

export type BandColour = 'green' | 'amber' | 'red' | 'unknown'

const BAND_RGB: Record<BandColour, [number, number, number]> = {
  green: [64, 200, 120],
  amber: [240, 170, 40],
  red: [235, 70, 60],
  unknown: [120, 160, 200],
}

export interface MapView {
  cx: number // view centre, metres east of the grid's west edge
  cy: number // metres south of the north edge
  mPerPx: number
}

export interface MapFrame {
  state: PlanState
  lon: number
  lat: number
  sigmaM: number // F19 circle radius (used when no ellipse ring is given)
  /** F21 95% ellipse as a closed lon/lat ring; replaces the circle (SPEC §2.4) */
  ring?: LonLat[] | null
  band: BandColour
  /** way home from the position (pointer field), lon/lat; reachesPad false = dashed, ends short */
  wayHome?: { coords: LonLat[]; reachesPad: boolean } | null
  /** drag-anywhere mode: draw the marker as a handle */
  dragging?: boolean
}

export class HudMap {
  readonly canvas: HTMLCanvasElement
  private readonly grid: FieldGrid
  private readonly plan: Plan
  private readonly budgetMin: number
  private readonly stations: { id: string; lon: number; lat: number }[]
  private readonly bandCache = new Map<BandColour, HTMLCanvasElement>()
  private readonly follow: boolean
  private readonly spanM: number
  private readonly cellstate: FieldGrid | null
  private hatchCache: HTMLCanvasElement | null = null
  private pad: LonLat
  private lastView: { view: MapView; w: number; h: number } | null = null

  constructor(opts: {
    grid: FieldGrid
    plan: Plan
    budgetMin: number
    stations: { id: string; lon: number; lat: number }[]
    follow?: boolean
    spanM?: number
    className?: string
    /** terrain/cellstate.png (v1.1.0, own grid): hatch where A = 0 (unknown), tint blocked */
    cellstate?: FieldGrid | null
    pad?: LonLat
  }) {
    this.canvas = document.createElement('canvas')
    this.canvas.className = opts.className ?? 'hl-hud-map'
    this.grid = opts.grid
    this.plan = opts.plan
    this.budgetMin = opts.budgetMin
    this.stations = opts.stations
    this.follow = opts.follow ?? false
    this.spanM = opts.spanM ?? 1500
    this.cellstate = opts.cellstate ?? null
    this.pad = opts.pad ?? opts.plan.start
  }

  /** CSS-pixel position on the canvas -> lon/lat, using the last drawn view; null before a draw. */
  screenToLonLat(xCss: number, yCss: number): LonLat | null {
    const v = this.lastView
    if (!v) return null
    return this.lonLat((xCss - v.w / 2) * v.view.mPerPx + v.view.cx, (yCss - v.h / 2) * v.view.mPerPx + v.view.cy)
  }

  /** Cell-state overlay on its own grid: diagonal hatch on unknown (A = 0), grey tint on blocked. */
  private hatchImage(): HTMLCanvasElement | null {
    if (!this.cellstate) return null
    if (this.hatchCache) return this.hatchCache
    const g = this.cellstate
    const { width: W, height: H } = g
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const ctx = c.getContext('2d')!
    const img = ctx.createImageData(W, H)
    const { counts, known } = g.data
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        const j = i * 4
        if (!known[i]) {
          if ((x + y) % 6 === 0) {
            img.data[j] = img.data[j + 1] = img.data[j + 2] = 160
            img.data[j + 3] = 110
          }
        } else if (counts[i] === 1) {
          img.data[j] = img.data[j + 1] = img.data[j + 2] = 90
          img.data[j + 3] = 90
        }
      }
    }
    ctx.putImageData(img, 0, 0)
    this.hatchCache = c
    return c
  }

  /** lon/lat -> metres from the grid's NW corner (x east, y south). */
  m(lon: number, lat: number): [number, number] {
    return [(lon - this.grid.w) * this.grid.mPerDegLon, (this.grid.n - lat) * this.grid.mPerDegLat]
  }

  /** Inverse of m(): metres from the NW corner -> lon/lat. */
  lonLat(x: number, y: number): LonLat {
    return [this.grid.w + x / this.grid.mPerDegLon, this.grid.n - y / this.grid.mPerDegLat]
  }

  /** Main view: fit the route and the homeline budget circle around the pad. */
  fitView(wPx: number, hPx: number, insetRightPx = 0): MapView {
    const pts = [...this.plan.legs.flatMap((l) => l.coords), this.pad].map(([lo, la]) => this.m(lo, la))
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
    for (const [x, y] of pts) {
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
    const pad = this.plan.legs.length ? 250 : 1500 // empty plan: a view around the pad
    x0 -= pad
    y0 -= pad
    x1 += pad
    y1 += pad
    const usable = Math.max(1, wPx - insetRightPx)
    const mPerPx = Math.max((x1 - x0) / usable, (y1 - y0) / Math.max(1, hPx))
    // centre the route in the area left of the panel
    return { cx: (x0 + x1) / 2 + (insetRightPx / 2) * mPerPx, cy: (y0 + y1) / 2, mPerPx }
  }

  private bandImage(colour: BandColour): HTMLCanvasElement {
    const hit = this.bandCache.get(colour)
    if (hit) return hit
    const g = this.grid
    const { width: W, height: H } = g
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const ctx = c.getContext('2d')!
    const img = ctx.createImageData(W, H)
    const [r, gg, b] = BAND_RGB[colour]
    const { counts, known, scale } = g.data
    const limit = this.budgetMin / scale // compare in counts, as the pipeline encoded them
    const inside = (i: number) => known[i] === 1 && counts[i] <= limit + 1e-9
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        const j = i * 4
        if (!known[i]) {
          // unknown T_home: faint grey hatch, unless the cell-state overlay hatches unknown terrain
          if (!this.cellstate && (x + y) % 6 === 0) {
            img.data[j] = img.data[j + 1] = img.data[j + 2] = 150
            img.data[j + 3] = 90
          }
          continue
        }
        if (!inside(i)) continue
        const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1 || !inside(i - 1) || !inside(i + 1) || !inside(i - W) || !inside(i + W)
        img.data[j] = r
        img.data[j + 1] = gg
        img.data[j + 2] = b
        img.data[j + 3] = edge ? 255 : 55
      }
    }
    ctx.putImageData(img, 0, 0)
    this.bandCache.set(colour, c)
    return c
  }

  /** Right-hand inset (CSS px) kept free for an overlaid panel in the fitted view. */
  insetRightPx = 0

  draw(frame: MapFrame, dpr = window.devicePixelRatio || 1): void {
    const cv = this.canvas
    const wCss = cv.clientWidth || 300
    const hCss = cv.clientHeight || 300
    if (cv.width !== Math.round(wCss * dpr) || cv.height !== Math.round(hCss * dpr)) {
      cv.width = Math.round(wCss * dpr)
      cv.height = Math.round(hCss * dpr)
    }
    const ctx = cv.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#0b0d10'
    ctx.fillRect(0, 0, wCss, hCss)

    const [mx, my] = this.m(frame.lon, frame.lat)
    const view: MapView = this.follow ? { cx: mx, cy: my, mPerPx: this.spanM / Math.max(1, Math.min(wCss, hCss)) } : this.fitView(wCss, hCss, this.insetRightPx)
    this.lastView = { view, w: wCss, h: hCss }
    const sx = (x: number) => (x - view.cx) / view.mPerPx + wCss / 2
    const sy = (y: number) => (y - view.cy) / view.mPerPx + hCss / 2
    const P = (lon: number, lat: number): [number, number] => {
      const [x, y] = this.m(lon, lat)
      return [sx(x), sy(y)]
    }
    const pathOf = (pts: LonLat[]) => {
      ctx.beginPath()
      pts.forEach(([lo, la], k) => {
        const [x, y] = P(lo, la)
        if (k === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
    }

    // band (field pixels are res_m squares; nearest-neighbour so the edge stays crisp)
    const img = this.bandImage(frame.band)
    const res = this.grid.resM
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(img, sx(0), sy(0), (this.grid.width * res) / view.mPerPx, (this.grid.height * res) / view.mPerPx)

    // unknown terrain hatch / blocked tint on the cell-state grid (its own bounds)
    const hatch = this.hatchImage()
    if (hatch && this.cellstate) {
      const cs = this.cellstate
      const [x0, y0] = P(cs.w, cs.n)
      const [x1, y1] = P(cs.e, cs.s)
      ctx.drawImage(hatch, x0, y0, x1 - x0, y1 - y0)
    }

    // route
    ctx.lineWidth = 2
    ctx.setLineDash([6, 5])
    ctx.strokeStyle = 'rgba(230, 236, 245, 0.75)'
    ctx.beginPath()
    for (const leg of this.plan.legs) {
      leg.coords.forEach(([lo, la], k) => {
        const [x, y] = P(lo, la)
        if (k === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
    }
    ctx.stroke()
    ctx.setLineDash([])

    // stations
    ctx.font = '12px ui-monospace, monospace'
    for (const s of this.stations) {
      const [x, y] = P(s.lon, s.lat)
      ctx.fillStyle = '#e6ecf5'
      ctx.beginPath()
      ctx.arc(x, y, 4, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillText(s.id, x + 7, y - 6)
    }

    // way home from the position (pointer field): solid when it reaches the rover
    if (frame.wayHome && frame.wayHome.coords.length > 1) {
      ctx.lineWidth = 3
      ctx.setLineDash(frame.wayHome.reachesPad ? [] : [3, 4])
      ctx.strokeStyle = frame.wayHome.reachesPad ? 'rgba(127, 216, 255, 0.95)' : 'rgba(255, 140, 120, 0.95)'
      pathOf(frame.wayHome.coords)
      ctx.stroke()
      ctx.setLineDash([])
    }

    // rover pad
    const [px, py] = P(this.pad[0], this.pad[1])
    ctx.fillStyle = '#ffd34d'
    ctx.fillRect(px - 5, py - 5, 10, 10)

    // uncertainty: F21 ellipse ring (replaces the circle), else F19 circle
    const [ux, uy] = [sx(mx), sy(my)]
    ctx.lineWidth = 2
    if (frame.ring && frame.ring.length > 2) {
      ctx.strokeStyle = 'rgba(255, 210, 80, 0.9)'
      ctx.fillStyle = 'rgba(255, 210, 80, 0.12)'
      pathOf(frame.ring)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
    } else if (frame.sigmaM > 0) {
      ctx.strokeStyle = 'rgba(255, 210, 80, 0.9)'
      ctx.fillStyle = 'rgba(255, 210, 80, 0.12)'
      ctx.beginPath()
      ctx.arc(ux, uy, frame.sigmaM / view.mPerPx, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }

    // dwell progress ring
    if (!frame.dragging && frame.state.phase === 'dwell' && frame.state.dwellFrac !== null) {
      ctx.strokeStyle = '#7fd8ff'
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.arc(ux, uy, 13, -Math.PI / 2, -Math.PI / 2 + frame.state.dwellFrac * Math.PI * 2)
      ctx.stroke()
    }

    // marker + heading (a ringed handle in drag-anywhere mode)
    ctx.fillStyle = frame.dragging ? '#7fd8ff' : '#ffffff'
    ctx.strokeStyle = '#0b0d10'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(ux, uy, frame.dragging ? 8 : 6, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    if (frame.state.headingDeg !== null) {
      const a = (frame.state.headingDeg * Math.PI) / 180
      ctx.strokeStyle = '#ffffff'
      ctx.beginPath()
      ctx.moveTo(ux + Math.sin(a) * 8, uy - Math.cos(a) * 8)
      ctx.lineTo(ux + Math.sin(a) * 18, uy - Math.cos(a) * 18)
      ctx.stroke()
    }
  }
}
