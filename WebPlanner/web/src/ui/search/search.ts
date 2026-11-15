// Search index and fuzzy ranking for the command palette (DESIGN U17; WS15 task 8, package A8).
// Fully client-side (share-code search cut, D69): the index is built once from the static, contract-
// checked files the app already loads (labels.json, stations.json, scenarios/pads/index.json) through
// the one loader; typing never fetches. A result carries a SelectionRef, so Enter calls
// select(ref, 'search') and the sidebar shows the same card as a map or list click (A5).
// No number is displayed from here: rows show code, name and kind only.
import type { Loader } from '../../data/loader'
import type { ShortcutAction } from '../shell/keys'
import { refFromLabel } from '../../state/selectionAdapter'
import { refKey, type SelectionRef } from '../../state/selection'
import { MODES } from '../../state/ui'
import type { ChipKind, IconName } from '../components'
import type { CopyKey } from '../copy'

export type SearchGroup = 'pad' | 'parking' | 'stations' | 'sites' | 'landmarks' | 'coordinates' | 'commands'

/** Kind label per group (copy.json). Pads have no search.groups.* key yet: the card titles are reused. */
export const GROUP_LABEL: Readonly<Record<SearchGroup, CopyKey>> = {
  pad: 'cards.pad.title',
  parking: 'cards.pad.alternativeTitle',
  stations: 'search.groups.stations',
  sites: 'search.groups.sites',
  landmarks: 'search.groups.landmarks',
  coordinates: 'search.groups.coordinates',
  commands: 'search.groups.commands',
}

export interface SearchItem {
  /** Unique within the index (refKey for objects, cmd:… for commands). */
  id: string
  group: SearchGroup
  code: string
  /** Display name (from the file), or a copy key for commands (`label`). */
  name: string
  label?: CopyKey
  icon: IconName
  /** Same chip as the object's card head (cards.tsx). */
  chip?: ChipKind
  /** Lower first among equal scores (labels.json priority; commands last). */
  priority: number
  ref?: SelectionRef
  command?: ShortcutAction
  /** Shortcut keys shown beside a command (DESIGN §4.4). */
  keys?: string[]
}

/** labels.json row (contracts/labels.schema.json), the part search reads. */
export interface LabelLike {
  code: string
  name: string
  kind: string
  ref?: string
  priority?: number
}
export interface StationLike {
  id: string
  name: string
}
export interface PadOptionLike {
  id: string
  rank?: number
  official?: boolean
}

const STATION_KINDS = new Set(['route_station', 'station'])

function itemFromLabel(l: LabelLike): SearchItem | null {
  const ref = refFromLabel(l as unknown as Record<string, unknown>)
  if (!ref) return null
  const base = { id: refKey(ref), code: l.code, name: l.name, priority: l.priority ?? 9, ref }
  if (ref.kind === 'pad') return { ...base, group: ref.id === 'rank1' ? 'pad' : 'parking', icon: 'pad', chip: 'modelled' }
  if (ref.kind === 'landmark') return { ...base, group: 'landmarks', icon: 'mountain', chip: 'real' }
  if (ref.kind === 'station') return STATION_KINDS.has(l.kind) ? { ...base, group: 'stations', icon: 'station', chip: 'modelled' } : { ...base, group: 'sites', icon: 'scored-site', chip: 'modelled' }
  return null
}

/** The object index: labels.json rows first (they carry code, name, kind and priority), then any station
 *  or pad option the labels do not name (so a missing label never hides an object). */
export function buildObjectIndex(labels: readonly LabelLike[], stations: readonly StationLike[] = [], pads: readonly PadOptionLike[] = []): SearchItem[] {
  const out: SearchItem[] = []
  const seen = new Set<string>()
  const add = (i: SearchItem | null) => {
    if (i && !seen.has(i.id)) seen.add(i.id), out.push(i)
  }
  for (const l of labels) add(itemFromLabel(l))
  for (const s of stations) add({ id: refKey({ kind: 'station', id: s.id }), group: 'sites', code: s.id, name: s.name, icon: 'scored-site', chip: 'modelled', priority: 9, ref: { kind: 'station', id: s.id } })
  for (const p of pads) {
    const ref: SelectionRef = { kind: 'pad', id: p.id }
    add({ id: refKey(ref), group: p.id === 'rank1' ? 'pad' : 'parking', code: p.id, name: p.id, icon: 'pad', chip: 'modelled', priority: 9, ref })
  }
  return out
}

/** Short command list (U17 commands; first on the DESIGN §8 cut order). Each runs the §4.4 shortcut. */
export function commandItems(): SearchItem[] {
  const modeKey: Record<string, string> = { plan: 'P', fly: 'Y', report: 'R', evidence: 'E' }
  const modeIcon: Record<string, IconName> = { plan: 'map', fly: 'compass', report: 'file-text', evidence: 'shield-check' }
  return [
    ...MODES.map(
      (m): SearchItem => ({ id: `cmd:mode:${m}`, group: 'commands', code: '', name: m, label: `modes.${m}.label`, icon: modeIcon[m], priority: 20, command: { action: 'mode', mode: m }, keys: [modeKey[m]] }),
    ),
    { id: 'cmd:toggle3d', group: 'commands', code: '', name: '2D 3D', label: 'shortcuts.toggle3d', icon: 'rotate-3d', priority: 20, command: { action: 'toggle3d' }, keys: ['T'] },
    { id: 'cmd:playPause', group: 'commands', code: '', name: 'play pause', label: 'shortcuts.playPause', icon: 'play', priority: 20, command: { action: 'playPause' }, keys: ['Space'] },
  ]
}

/** Load the object index from the static data tree (loader-cached: no extra request if the cards loaded them). */
export async function loadObjectIndex(L: Loader): Promise<SearchItem[]> {
  const [labels, stations, pads] = await Promise.all([
    L.optional(() => L.json<{ labels: LabelLike[] }>('labels.json')),
    L.optional(() => L.stations()),
    L.optional(() => L.json<{ pads?: PadOptionLike[] }>('scenarios/pads/index.json')),
  ])
  return buildObjectIndex(labels?.labels ?? [], stations ?? [], pads?.pads ?? [])
}

// ---- Coordinates: decimal degrees "lon, lat" or "lat, lon"; accepted only when unambiguous (one value
// outside ±90 is the longitude). Planner metres (x, y) need the site projection: not built here.
const NUM = /^[-+]?\d+(?:\.\d+)?$/
export function parseCoordinates(q: string): Extract<SelectionRef, { kind: 'cell' }> | null {
  const parts = q
    .trim()
    .replace(/[°]/g, '')
    .split(/[\s,;]+/)
    .filter(Boolean)
  if (parts.length !== 2 || !parts.every((p) => NUM.test(p))) return null
  const [a, b] = parts.map(Number)
  const aLon = Math.abs(a) > 90 && Math.abs(a) <= 360 && Math.abs(b) <= 90
  const bLon = Math.abs(b) > 90 && Math.abs(b) <= 360 && Math.abs(a) <= 90
  if (aLon === bLon) return null
  return aLon ? { kind: 'cell', lon: a, lat: b } : { kind: 'cell', lon: b, lat: a }
}

// ---- Fuzzy ranking --------------------------------------------------------------------------------
const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')

/** Score one query token against one text (0 = no match). Exact > prefix > word start > substring > in-order letters. */
export function scoreText(token: string, text: string, exact: number): number {
  const q = norm(token)
  const s = norm(text)
  if (!q || !s) return 0
  if (s === q) return exact
  if (s.startsWith(q)) return 800 - Math.min(s.length - q.length, 50)
  const words = s.split(/[^a-z0-9]+/).filter(Boolean)
  const w = words.findIndex((x) => x.startsWith(q))
  if (w >= 0) return 600 - Math.min(w * 10, 100) - Math.min(words[w].length - q.length, 50)
  const i = s.indexOf(q)
  if (i >= 0) return 400 - Math.min(i, 100)
  // in-order letters: reward runs, punish gaps; at least 2 letters and no huge spread
  if (q.length < 2) return 0
  let pos = -1
  let run = 0
  let score = 200
  for (const ch of q) {
    const n = s.indexOf(ch, pos + 1)
    if (n < 0) return 0
    if (n === pos + 1) run++
    else (score -= Math.min(n - pos - 1, 20)), (run = 0)
    score += run * 5
    pos = n
  }
  return Math.max(score, 1)
}

function scoreItem(tokens: string[], it: SearchItem, labelText: string): number {
  let total = 0
  for (const tok of tokens) {
    const s = Math.max(it.code ? scoreText(tok, it.code, 1000) : 0, scoreText(tok, labelText, 900), it.label ? scoreText(tok, it.name, 700) : 0)
    if (s === 0) return 0 // every token must match
    total += s
  }
  return total / tokens.length
}

export interface SearchResult {
  item: SearchItem
  score: number
}

/** Rank `items` for `query`. Empty query: objects in index order (pad, stations, …), then commands.
 *  `label(item)` gives the shown text (copy for commands, the file's name for objects). */
export function rank(items: readonly SearchItem[], query: string, label: (i: SearchItem) => string, limit = 12): SearchResult[] {
  const q = query.trim()
  const coord = parseCoordinates(q)
  if (coord) {
    const c: SearchItem = { id: refKey(coord), group: 'coordinates', code: '', name: `${coord.lon}, ${coord.lat}`, icon: 'crosshair', priority: 0, ref: coord }
    return [{ item: c, score: Infinity }]
  }
  if (!q) return items.slice(0, limit).map((item) => ({ item, score: 0 }))
  const tokens = q.split(/\s+/)
  const out: SearchResult[] = []
  for (const item of items) {
    const score = scoreItem(tokens, item, label(item))
    if (score > 0) out.push({ item, score })
  }
  out.sort((a, b) => b.score - a.score || a.item.priority - b.item.priority || a.item.code.localeCompare(b.item.code, 'en', { numeric: true }))
  return out.slice(0, limit)
}
