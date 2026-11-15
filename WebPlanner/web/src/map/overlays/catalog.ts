// WS16 task 11 (M11, DESIGN U7): the overlay catalogue. One entry per toggleable layer: its group,
// source files (P3 #88, web/public/data/overlays + highlights), trust chip, legend and copy keys.
// Pure data: the map side (layers.ts) and the panel (LayerPanel.tsx) both read it.
// Numbers come from config/design.yaml (overlays.*) and tokens.json; the test checks them against
// overlays/index.json and the manifest (overlays.*, highlights.*), so every legend range equals its
// manifest range (U7 acceptance).
import designRaw from '../../../../config/design.yaml'
import { cfg } from '../../config'
import type { CopyKey } from '../../ui/copy'
import { TOKENS, type ColorToken } from '../../ui/tokens'

export type OverlayGroup = 'terrain' | 'science' | 'evidence'
export const OVERLAY_GROUPS: readonly OverlayGroup[] = ['terrain', 'science', 'evidence']

export type OverlayId = 'contours' | 'slopeClass' | 'rough' | 'mineralSulfate' | 'mineralClay' | 'ridges' | 'mineralPatches' | 'blocked'
export type OverlayChip = 'real' | 'modelled'
export type OverlaySwatch = 'fill' | 'line' | 'dashed' | 'none'

export interface LegendItem {
  swatch: OverlaySwatch
  /** token colour; null = no tint (slope 0–10°) */
  color: ColorToken | null
  /** copy key, or a formatted value (numbers from config) */
  label: { key: CopyKey } | { text: string }
  /** heavier line (contour index lines) */
  heavy?: boolean
}

export interface OverlayDef {
  id: OverlayId
  group: OverlayGroup
  name: CopyKey
  /** one line "what am I looking at" */
  what: CopyKey
  chip: OverlayChip
  /** highlight thresholds not confirmed by S (R9, D87): the panel and legend say "preliminary" */
  preliminary: boolean
  /** thematic (filled) overlay: at most overlays.max_thematic_on at once (U7 panel) */
  thematic: boolean
  kind: 'vector-lines' | 'raster-tiles' | 'image' | 'highlight'
  /** data path under the data tree (tile template for raster-tiles) */
  source: string
  /** key in overlays/index.json describing this layer (raster + image layers) */
  indexKey?: 'slope_class' | 'rough' | 'mineral_sulfate' | 'mineral_clay'
  /** manifest keys that back the legend numbers */
  manifest: readonly string[]
  legend: readonly LegendItem[]
}

/** design.yaml overlays.* (build time) */
export const OVERLAY_CFG = {
  maxThematicOn: cfg<number>(designRaw, 'overlays.max_thematic_on'),
  slopeBreaksDeg: cfg<number[]>(designRaw, 'overlays.slope_classes_deg'),
  contourMinorM: cfg<number>(designRaw, 'overlays.contours_m.minor'),
  contourIndexM: cfg<number>(designRaw, 'overlays.contours_m.index'),
} as const

/** DESIGN §3.1: overlays at 35–55 % (tokens overlayOpacity). Default: the middle of the range. */
export const OPACITY = { min: TOKENS.overlayOpacity.min, max: TOKENS.overlayOpacity.max, step: 0.05 } as const
export const DEFAULT_OPACITY = Math.round(((OPACITY.min + OPACITY.max) / 2) * 100) / 100

export const clampOpacity = (v: number): number => Math.min(OPACITY.max, Math.max(OPACITY.min, Number.isFinite(v) ? v : DEFAULT_OPACITY))

/** Slope class colours (P3 palette): 0–10 no tint, 10–17 safe, 17–20 caution, > 20 limit (§3.1: blocked slope = limit). */
export const SLOPE_TOKENS: readonly (ColorToken | null)[] = [null, 'safe', 'caution', 'limit']

const deg = (v: number) => `${v}°`
function slopeLegend(breaks: readonly number[]): LegendItem[] {
  return breaks.map((b, i) => ({
    swatch: SLOPE_TOKENS[i] ? 'fill' : 'none',
    color: SLOPE_TOKENS[i],
    label: { text: i < breaks.length - 1 ? `${b}–${deg(breaks[i + 1])}` : `> ${deg(b)}` },
  }))
}

const B = OVERLAY_CFG.slopeBreaksDeg
/** rough footing: max 1 m slope > the no-go slope (= the top slope break, 20°; manifest overlays.rough.min_deg) */
export const ROUGH_MIN_DEG = B[B.length - 1]

export const OVERLAYS: readonly OverlayDef[] = [
  {
    id: 'contours',
    group: 'terrain',
    name: 'layers.contours.name',
    what: 'layers.contours.what',
    chip: 'real',
    preliminary: false,
    thematic: false,
    kind: 'vector-lines',
    source: 'overlays/contours.geojson',
    manifest: ['overlays.contours.interval_m', 'overlays.contours.index_m'],
    legend: [
      { swatch: 'line', color: 'text', label: { text: `${OVERLAY_CFG.contourMinorM} m` } },
      { swatch: 'line', color: 'text', heavy: true, label: { text: `${OVERLAY_CFG.contourIndexM} m` } },
    ],
  },
  {
    id: 'slopeClass',
    group: 'terrain',
    name: 'layers.slopeClass.name',
    what: 'layers.slopeClass.what',
    chip: 'modelled',
    preliminary: false,
    thematic: true,
    kind: 'raster-tiles',
    source: 'overlays/slope_class/{z}/{x}/{y}.png',
    indexKey: 'slope_class',
    manifest: ['overlays.slope_class.breaks_deg'],
    legend: slopeLegend(B),
  },
  {
    id: 'rough',
    group: 'terrain',
    name: 'layers.rough.name',
    what: 'layers.rough.what',
    chip: 'modelled',
    preliminary: false,
    thematic: true,
    kind: 'raster-tiles',
    source: 'overlays/rough/{z}/{x}/{y}.png',
    indexKey: 'rough',
    manifest: ['overlays.rough.min_deg'],
    legend: [{ swatch: 'fill', color: 'caution', label: { text: `> ${deg(ROUGH_MIN_DEG)}` } }],
  },
  {
    id: 'mineralSulfate',
    group: 'science',
    name: 'cards.mineral.sulfate',
    what: 'layers.mineral.what',
    chip: 'real',
    preliminary: false,
    thematic: true,
    kind: 'image',
    source: 'overlays/mineral_sulfate.png',
    indexKey: 'mineral_sulfate',
    manifest: ['overlays.mineral_sulfate.norm_range'],
    legend: [{ swatch: 'fill', color: 'science', label: { key: 'cards.mineral.note' } }],
  },
  {
    id: 'mineralClay',
    group: 'science',
    name: 'cards.mineral.clay',
    what: 'layers.mineral.what',
    chip: 'real',
    preliminary: false,
    thematic: true,
    kind: 'image',
    source: 'overlays/mineral_clay.png',
    indexKey: 'mineral_clay',
    manifest: ['overlays.mineral_clay.norm_range'],
    legend: [{ swatch: 'fill', color: 'science', label: { key: 'cards.mineral.note' } }],
  },
  {
    id: 'ridges',
    group: 'science',
    name: 'layers.ridges.name',
    what: 'layers.ridges.what',
    chip: 'modelled',
    preliminary: true,
    thematic: false,
    kind: 'highlight',
    source: 'highlights/ridges.geojson',
    manifest: ['highlights.ridges.threshold_m', 'highlights.ridges.min_length_m', 'highlights.ridges.count'],
    legend: [{ swatch: 'line', color: 'science', label: { key: 'cards.ridge.kind' } }],
  },
  {
    id: 'mineralPatches',
    group: 'science',
    name: 'cards.mineral.title',
    what: 'cards.mineral.note',
    chip: 'real',
    preliminary: true,
    thematic: false,
    kind: 'highlight',
    source: 'highlights/mineral.geojson',
    manifest: ['highlights.mineral.threshold_norm', 'highlights.mineral.count'],
    legend: [{ swatch: 'dashed', color: 'science', label: { key: 'cards.mineral.note' } }],
  },
  {
    id: 'blocked',
    group: 'evidence',
    name: 'cards.blocked.title',
    what: 'cards.blocked.why',
    chip: 'modelled',
    preliminary: true,
    thematic: false,
    kind: 'highlight',
    source: 'highlights/blocked.geojson',
    manifest: ['highlights.blocked.count'],
    legend: [
      { swatch: 'line', color: 'limit', label: { key: 'cards.blocked.slopeClass' } },
      { swatch: 'line', color: 'limit', label: { key: 'cards.blocked.stepGuard' } },
    ],
  },
]

export const overlayById = (id: OverlayId): OverlayDef => OVERLAYS.find((o) => o.id === id)!

/** Default view unchanged (brief): every overlay off. */
export const DEFAULT_ON: Readonly<Record<OverlayId, boolean>> = Object.fromEntries(OVERLAYS.map((o) => [o.id, false])) as Record<OverlayId, boolean>
