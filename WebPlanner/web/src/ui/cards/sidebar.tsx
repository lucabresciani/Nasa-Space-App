// Selection → sidebar (U14, §4.3): the shell's right sidebar follows the selection store. Installed
// once by the shell (lazy chunk). Escape clears the selection, [ / ] walk the history (§4.4); both
// arrive as the shell's cancelable `hl:shortcut` events, so the shell keeps its own Escape order
// (help, then focus mode) when nothing is selected.
import { useEffect, useState } from 'preact/hooks'
import { data, type Loader } from '../../data/loader'
import { ensureManifest } from '../../views/common'
import { canGoBack, canGoForward, clearSelection, selection, stepHistory, type SelectionRef } from '../../state/selection'
import { effect, useSignalValue } from '../../state/signal'
import { t } from '../copy'
import { CardSkeleton, IconButton } from '../components'
import { openSidebar, setSidebarContent, shell } from '../shell/store'
import type { ShortcutAction } from '../shell/keys'
import { SelectionCard } from './cards'
import { ensureFor, isReady, loadCardData, type CardData, type CellLookup } from './data'

export interface SidebarOptions {
  loader?: Loader
  cell?: CellLookup
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'>
}

/** Card data for the whole app, loaded once. */
let shared: Promise<CardData> | undefined
export function cardData(L: Loader = data(), cell?: CellLookup): Promise<CardData> {
  shared ??= Promise.all([ensureManifest(), loadCardData(L, cell)]).then(([, d]) => d)
  shared.catch(() => (shared = undefined))
  return shared
}

/** History back / forward (§4.4 [ ]) and the card for the current selection. */
export function SelectionPanel({ L, cell }: { L: Loader; cell?: CellLookup }) {
  const sel = useSignalValue(selection.selected)
  useSignalValue(selection.cursor)
  useSignalValue(selection.history)
  const [d, setD] = useState<CardData | null>(null)
  const [err, setErr] = useState<unknown>(null)
  const [, bump] = useState(0)
  useEffect(() => {
    let live = true
    cardData(L, cell).then(
      (x) => live && setD(x),
      (e) => live && setErr(e),
    )
    return () => void (live = false)
  }, [L])
  const ready = d && isReady(d, sel)
  useEffect(() => {
    if (!d || ready) return
    let live = true
    ensureFor(L, d, sel).then(
      () => live && bump((n) => n + 1),
      (e) => live && setErr(e),
    )
    return () => void (live = false)
  }, [d, sel, ready])
  return (
    <div class="hl-selection" data-selected={sel ? sel.kind : 'none'}>
      <div class="hl-selection__nav">
        <IconButton icon="chevron-left" label={t('buttons.back')} disabled={!canGoBack()} onClick={() => stepHistory(-1)} />
        <IconButton icon="chevron-right" label={t('buttons.forward')} disabled={!canGoForward()} onClick={() => stepHistory(1)} />
      </div>
      {!sel && (
        <div class="hl-empty">
          <p>{t('states.empty.noSelection')}</p>
        </div>
      )}
      {err ? (
        <p class="hl-cardx__muted">{t('states.error.generic', { what: t('cards.common.details') })}</p>
      ) : d && ready ? (
        <SelectionCard sel={sel} d={d} />
      ) : (
        <CardSkeleton />
      )}
    </div>
  )
}

/** Escape / [ ] from the shell's `hl:shortcut` event. Returns true when the selection used it. */
export function handleSelectionShortcut(a: ShortcutAction): boolean {
  // The shell's own Escape order comes first: help overlay, then focus mode (§4.4).
  if (a.action === 'escape' && selection.selected.peek() && !shell.helpOpen.peek() && !shell.focusMode.peek()) {
    clearSelection()
    return true
  }
  if (a.action === 'history') return stepHistory(a.step)
  return false
}

/** Wire the store to the sidebar; returns dispose. */
export function installSelectionSidebar(opts: SidebarOptions = {}): () => void {
  const L = opts.loader ?? data()
  const win = opts.win ?? (typeof window !== 'undefined' ? window : undefined)
  setSidebarContent(() => <SelectionPanel L={L} cell={opts.cell} />)
  let last: SelectionRef | null = selection.selected.peek()
  const stop = effect(() => {
    const s = selection.selected.value
    if (s && s !== last) openSidebar() // §4.3: the sidebar opens on selection
    last = s
  })
  const onKey = (e: Event) => {
    const a = (e as CustomEvent<ShortcutAction>).detail
    if (a && handleSelectionShortcut(a)) e.preventDefault()
  }
  win?.addEventListener('hl:shortcut', onKey)
  return () => {
    stop()
    win?.removeEventListener('hl:shortcut', onKey)
    setSidebarContent(undefined)
  }
}
