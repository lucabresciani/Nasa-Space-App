// Selection store (DESIGN §5.2, U14; WS15 task 5, package A5): selected object, hovered object and the
// history of the last selections. Writers: map clicks (via selectionAdapter.ts), lists, search (U17),
// the history keys [ and ] (§4.4). Readers: the sidebar cards (ui/cards), map highlights, camera, WS18.
// A ref names an object; it never carries a displayed number (cards read numbers from the manifest-
// backed files or from field lookups), so the same ref gives the same card from any entry point.
import type { CopyKey } from '../ui/copy'
import { batch, signal } from './signal'

export type EdgeCauseRef = 'physiology' | 'slope' | 'data'

export type SelectionRef =
  /** Rover pad: `rank1` = the official pad, other ids = D21 parking options (scenarios/pads/index.json). */
  | { kind: 'pad'; id: string }
  /** Station or scored site (stations.json id, e.g. S7). */
  | { kind: 'station'; id: string }
  /** Route leg (1-based `leg` of route_{scenario}.geojson); `pad` = a parking option's route (default: official). */
  | { kind: 'leg'; leg: number; pad?: string }
  /** Any terrain cell (field lookup at lon/lat). */
  | { kind: 'cell'; lon: number; lat: number }
  /** Landmark from labels.json (its `code`, e.g. GDV). */
  | { kind: 'landmark'; code: string }
  /** Homeline edge segment (edges.geojson feature properties); lon/lat = where it was picked. */
  | { kind: 'edge'; cause: EdgeCauseRef; budget: number; lon?: number; lat?: number }

export type SelectionKind = SelectionRef['kind']

/** Where a selection came from (for analytics/tests only; never changes the card). */
export type SelectionSource = 'map' | 'list' | 'search' | 'history' | 'api'

/** DESIGN U14: "history of the last 10 selections". */
export const HISTORY_MAX = 10

/** Stable identity of a ref: two refs with the same key are the same object (cells to 6 decimals, §3.8). */
export function refKey(r: SelectionRef): string {
  switch (r.kind) {
    case 'pad':
    case 'station':
      return `${r.kind}:${r.id}`
    case 'leg':
      return `leg:${r.pad ?? 'official'}:${r.leg}`
    case 'cell':
      return `cell:${r.lon.toFixed(6)},${r.lat.toFixed(6)}`
    case 'landmark':
      return `landmark:${r.code}`
    case 'edge':
      return `edge:${r.cause}:${r.budget}:${r.lon?.toFixed(6) ?? ''},${r.lat?.toFixed(6) ?? ''}`
  }
}

export const sameRef = (a: SelectionRef | null | undefined, b: SelectionRef | null | undefined): boolean =>
  !!a && !!b ? refKey(a) === refKey(b) : a == b

export const selection = {
  selected: signal<SelectionRef | null>(null),
  hovered: signal<SelectionRef | null>(null),
  /** Oldest first, at most HISTORY_MAX entries. */
  history: signal<readonly SelectionRef[]>([]),
  /** Index into history of the shown entry; history.length while nothing is selected (after Escape). */
  cursor: signal<number>(0),
  /** Source of the last selection (tests and debugging). */
  source: signal<SelectionSource | null>(null),
} as const

/** Select `ref` (null clears). Selecting the shown object again changes nothing. */
export function select(ref: SelectionRef | null, source: SelectionSource = 'api'): void {
  if (ref === null) return clearSelection()
  const cur = selection.selected.peek()
  selection.source.value = source
  if (sameRef(cur, ref)) return
  const h = selection.history.peek()
  const c = selection.cursor.peek()
  // A new selection drops the forward part (browser-like), then appends.
  const kept = cur && c < h.length ? h.slice(0, c + 1) : h.slice()
  if (!sameRef(kept[kept.length - 1], ref)) kept.push(ref)
  const next = kept.slice(-HISTORY_MAX)
  batch(() => {
    selection.history.value = next
    selection.cursor.value = next.length - 1
    selection.selected.value = ref
  })
}

/** Escape (§4.4): clear the selection; history is kept, so [ brings the last one back. */
export function clearSelection(): void {
  batch(() => {
    selection.cursor.value = selection.history.peek().length
    selection.selected.value = null
  })
}

export function hover(ref: SelectionRef | null): void {
  if (!sameRef(selection.hovered.peek(), ref)) selection.hovered.value = ref
}

/** [ / ] (§4.4): walk the history. Returns false when there is nothing in that direction. */
export function stepHistory(step: -1 | 1): boolean {
  const h = selection.history.peek()
  const c = selection.cursor.peek()
  const n = c + step
  if (n < 0 || n >= h.length) return false
  batch(() => {
    selection.cursor.value = n
    selection.source.value = 'history'
    selection.selected.value = h[n]
  })
  return true
}
export const back = (): boolean => stepHistory(-1)
export const forward = (): boolean => stepHistory(1)
export const canGoBack = (): boolean => selection.cursor.value > 0 && selection.history.value.length > 0
export const canGoForward = (): boolean => selection.cursor.value < selection.history.value.length - 1

/** Test helper: empty store. */
export function resetSelection(): void {
  selection.selected.value = null
  selection.hovered.value = null
  selection.history.value = []
  selection.cursor.value = 0
  selection.source.value = null
}

// ---- Actions offered on a card (U14 "Actions" column). Each owner registers what it can do; a card
// shows only registered actions that apply to its ref, so nothing renders a button that does nothing.
export interface SelectionAction {
  id: string
  /** copy.json key of the button label. */
  label: CopyKey
  applies: (r: SelectionRef) => boolean
  run: (r: SelectionRef) => void
}
export const selectionActions = signal<readonly SelectionAction[]>([])
export function registerSelectionAction(a: SelectionAction): () => void {
  selectionActions.value = [...selectionActions.peek().filter((x) => x.id !== a.id), a]
  return () => (selectionActions.value = selectionActions.peek().filter((x) => x !== a))
}
export const actionsFor = (r: SelectionRef): SelectionAction[] => selectionActions.value.filter((a) => a.applies(r))
