// WS16 task 6 (M6): the U13 label model, pure. labels.json -> label features (code, position,
// priority, zoom range), pill sizes from the font metric, and the placement: zoom ranges, sort key,
// variable anchors, collision, the selected label that ignores collisions and route stations that
// are never dropped. The DOM layer (layer.ts) runs exactly this placement on every map move, so
// the CPU collision check in the tests is the one the screen uses.
import type { Feature, FeatureCollection, Point } from 'geojson'
import { COLLISION_GAP_PX, LABEL_TYPE, LABELS, LEADER_LIFT_PX, MARKER_CLEARANCE_PX, MONO_ADVANCE_EM } from './config'

export const LABEL_KINDS = ['pad', 'route_station', 'station', 'scored_site', 'user_point', 'landmark', 'overlay'] as const
export type LabelKind = (typeof LABEL_KINDS)[number]

/** One labels.json entry (contracts/labels.schema.json v1). */
export interface MapLabel {
  code: string
  name: string
  kind: LabelKind
  status: 'official' | 'informal' | null
  lon: number
  lat: number
  priority: number
  minzoom: number
  maxzoom?: number
  ref?: string
  bearing_deg?: number
  dist_m?: number
}

export interface LabelsFile {
  version: '1'
  labels: MapLabel[]
}

/** Shape check of labels.json (the loader validates against the contract where it has one). */
export function parseLabels(raw: unknown): MapLabel[] {
  const f = raw as Partial<LabelsFile> | null
  if (!f || typeof f !== 'object' || f.version !== '1' || !Array.isArray(f.labels)) throw new Error('labels.json: not a version 1 labels file')
  const seen = new Set<string>()
  for (const l of f.labels) {
    const ok =
      typeof l.code === 'string' &&
      /^[A-Z][A-Z0-9]{0,7}$/.test(l.code) &&
      typeof l.name === 'string' &&
      (LABEL_KINDS as readonly string[]).includes(l.kind) &&
      Number.isFinite(l.lon) &&
      Number.isFinite(l.lat) &&
      Number.isInteger(l.priority) &&
      Number.isInteger(l.minzoom)
    if (!ok) throw new Error(`labels.json: bad label ${JSON.stringify(l).slice(0, 80)}`)
    if (seen.has(l.code)) throw new Error(`labels.json: duplicate code ${l.code}`)
    seen.add(l.code)
  }
  return f.labels
}

/** Rank of a kind in config/design.yaml labels.priority without 'selected' (1 = pad, as P1 writes it). */
export function configPriority(kind: LabelKind): number {
  return LABELS.priority.filter((k) => k !== 'selected').indexOf(kind) + 1
}

/** config/design.yaml labels.minzoom for a kind; route stations and scored sites use `station` (P1 MINZOOM_KEY). */
export function configMinzoom(kind: LabelKind): number | undefined {
  const mz = LABELS.minzoom as Record<string, number>
  return mz[kind] ?? (kind === 'route_station' || kind === 'scored_site' || kind === 'user_point' ? mz.station : undefined)
}

export interface LabelProps {
  code: string
  name: string
  kind: LabelKind
  status: 'official' | 'informal' | null
  priority: number
  minzoom: number
  maxzoom: number | null
  /** route stations: shown at every zoom, never dropped by a collision */
  alwaysVisible: boolean
  /** symbol sort key: priority, then file order (route stations in route order); lower wins */
  sortKey: number
  /** the label has a marker graphic at its point (pads, stations, sites, user points): the pill sits beside it */
  marker: boolean
}

export type LabelFeature = Feature<Point, LabelProps>

const ORDER_SPAN = 1000

/**
 * Label features from labels.json. `routeStations`: codes on the active plan's route (the app may
 * re-rank, contracts/labels.schema.json); without it the file's `route_station` kind decides.
 */
export function labelFeatures(labels: MapLabel[], routeStations?: ReadonlySet<string>): FeatureCollection<Point, LabelProps> {
  return {
    type: 'FeatureCollection',
    features: labels.map((l, i) => {
      const onRoute = routeStations ? routeStations.has(l.code) && l.kind !== 'pad' && l.kind !== 'landmark' && l.kind !== 'overlay' : l.kind === 'route_station'
      const kind: LabelKind = routeStations && l.kind === 'route_station' && !onRoute ? 'station' : onRoute ? 'route_station' : l.kind
      const priority = kind === l.kind ? l.priority : configPriority(kind)
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [l.lon, l.lat] },
        properties: {
          code: l.code,
          name: l.name,
          kind,
          status: l.status,
          priority,
          minzoom: l.minzoom,
          maxzoom: l.maxzoom ?? null,
          alwaysVisible: onRoute,
          sortKey: priority * ORDER_SPAN + i,
          marker: kind !== 'landmark' && kind !== 'overlay',
        },
      }
    }),
  }
}

/** Expanded (hover) text: the full name plus the naming status where there is one (U13). */
export function expandedText(p: Pick<LabelProps, 'name' | 'status'>): string {
  return p.status ? `${p.name} · ${p.status}` : p.name
}

/** Pill size for a text in the map-label face: monospace advance × characters + pill padding. */
export function pillSize(text: string): { w: number; h: number } {
  const [px, py] = LABELS.pillPaddingPx
  return { w: Math.ceil([...text].length * MONO_ADVANCE_EM * LABEL_TYPE.sizePx) + 2 * px, h: LABEL_TYPE.lineHeightPx + 2 * py }
}

/** Leader lines (U13 item 5): labels float above their point once the view tilts past the config pitch. */
export function leaderLift(pitchDeg: number): number {
  return pitchDeg > LABELS.leaderLineMinPitchDeg ? LEADER_LIFT_PX : 0
}

/** Web Mercator world pixels at a zoom (MapLibre's 512 px world), for tests and off-map layout. */
export function projectWorld(lon: number, lat: number, zoom: number): [number, number] {
  const size = 512 * 2 ** zoom
  const x = ((lon + 180) / 360) * size
  const s = Math.sin((lat * Math.PI) / 180)
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size
  return [x, y]
}

/** Where the pill sits relative to its point: `left` = pill to the right of the point (anchored by its left edge), as in MapLibre text-anchor. */
export type Anchor = 'left' | 'right' | 'bottom' | 'top' | 'center'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface Placement {
  code: string
  anchor: Anchor
  box: Box
  /** px the label floats above its point (leader line), 0 when flat */
  lift: number
  selected: boolean
  forced: boolean
}

export interface LayoutInput {
  props: LabelProps
  /** screen position of the label's point, px */
  x: number
  y: number
}

export interface LayoutOptions {
  zoom: number
  selected?: string | null
  /** map pitch, degrees (leader lines above the config pitch) */
  pitch?: number
}

export interface LayoutResult {
  placed: Placement[]
  hidden: { code: string; reason: 'zoom' | 'collision' }[]
}

function candidates(p: LabelProps, x: number, y: number, w: number, h: number, lift: number): { anchor: Anchor; box: Box }[] {
  if (lift > 0) return [{ anchor: 'bottom', box: { x: x - w / 2, y: y - lift - h, w, h } }]
  if (!p.marker) return [{ anchor: 'center', box: { x: x - w / 2, y: y - h / 2, w, h } }]
  const c = MARKER_CLEARANCE_PX
  return [
    { anchor: 'left', box: { x: x + c, y: y - h / 2, w, h } },
    { anchor: 'right', box: { x: x - c - w, y: y - h / 2, w, h } },
    { anchor: 'bottom', box: { x: x - w / 2, y: y - c - h, w, h } },
    { anchor: 'top', box: { x: x - w / 2, y: y + c, w, h } },
  ]
}

/** Two pills closer than the collision gap (touching edges 4 px apart are fine). */
export function overlaps(a: Box, b: Box, gap = COLLISION_GAP_PX): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap
}

export function inZoom(p: LabelProps, zoom: number): boolean {
  return zoom >= p.minzoom && (p.maxzoom === null || zoom <= p.maxzoom)
}

function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

function leastOverlap<T extends { box: Box }>(cands: T[], placed: Placement[]): T {
  const cost = (c: T) => placed.reduce((s, q) => s + overlapArea(c.box, q.box), 0)
  return cands.reduce((best, c) => (cost(c) < cost(best) ? c : best))
}

/**
 * Placement (U13): the selected label first, ignoring collisions and zoom ranges; then route
 * stations in route order, at every zoom, never dropped (each takes the first anchor clear of the
 * labels already placed, else its first anchor); then the rest by sort key within their zoom range,
 * each on the first clear anchor of right / left / above / below, dropped when none is clear.
 */
export function layoutLabels(items: LayoutInput[], opts: LayoutOptions): LayoutResult {
  const lift = leaderLift(opts.pitch ?? 0)
  const rank = (it: LayoutInput) => (it.props.code === opts.selected ? 0 : it.props.alwaysVisible ? 1 : 2)
  const order = [...items].sort((a, b) => rank(a) - rank(b) || a.props.sortKey - b.props.sortKey)
  const placed: Placement[] = []
  const hidden: LayoutResult['hidden'] = []
  for (const it of order) {
    const p = it.props
    const selected = p.code === opts.selected
    const forced = selected || p.alwaysVisible
    if (!forced && !inZoom(p, opts.zoom)) {
      hidden.push({ code: p.code, reason: 'zoom' })
      continue
    }
    const { w, h } = pillSize(p.code)
    const cands = candidates(p, it.x, it.y, w, h, lift)
    // the selected label ignores collisions (its own layer); forced route stations still prefer a clear anchor
    const clearOf = (gap: number) => cands.find((c) => placed.every((q) => !overlaps(c.box, q.box, gap)))
    const clear = selected ? cands[0] : clearOf(COLLISION_GAP_PX)
    // a route station with no clear anchor: touching pills, else the anchor with the least overlap
    const pick = clear ?? (forced ? (clearOf(0) ?? leastOverlap(cands, placed)) : undefined)
    if (!pick) {
      hidden.push({ code: p.code, reason: 'collision' })
      continue
    }
    placed.push({ code: p.code, anchor: pick.anchor, box: pick.box, lift, selected, forced })
  }
  return { placed, hidden }
}

/**
 * Free overlay labels (the edge-cause and zero-margin binding labels: HTML markers outside labels.json,
 * placed on their line in lon/lat) yield to the placed pills. labels.priority puts `overlay` last, and
 * in 3D the pills float up on their leader lines into the overlay labels' spot, so each overlay label
 * keeps its spot when it is clear of the pills and of the overlay labels before it, else moves just
 * above or below the box it hits (the smaller shift first), else hides. Returns the vertical shift
 * per label in px, null = hidden. Pure; layer.ts runs it with the on-screen boxes after every placement.
 */
export function yieldOverlays(boxes: Box[], pills: Box[], gap = COLLISION_GAP_PX): (number | null)[] {
  const taken = [...pills]
  return boxes.map((b) => {
    const at = (dy: number): Box => ({ ...b, y: b.y + dy })
    const clear = (dy: number) => taken.every((q) => !overlaps(at(dy), q, gap))
    const shifts = [0]
    for (const q of taken) if (overlaps(b, q, gap)) shifts.push(q.y - gap - b.h - b.y, q.y + q.h + gap - b.y)
    const dy = shifts.sort((x, y) => Math.abs(x) - Math.abs(y)).find(clear)
    if (dy === undefined) return null
    taken.push(at(dy))
    return dy
  })
}
