// Command palette dialog (DESIGN U17, §3.7 "Command palette: empty, results, no results"; package A8).
// Lazy chunk: the top-bar button (button.tsx) imports it on first open. ARIA 1.2 combobox pattern:
// the input is role=combobox and keeps focus; the active option is aria-activedescendant; ↑/↓ move
// (wrapping), Enter chooses, Escape closes. The dialog is modal (native showModal: the page behind is
// inert) and Tab / Shift+Tab cycle between the input and the close button (focus trap). Focus returns to
// the opener on close.
// Keys the palette handles stop propagating, so the shell's window listener (keys.ts) never sees them:
// Escape closes the palette without clearing the selection. Ctrl+K still reaches the shell and toggles.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { data, type Loader } from '../../data/loader'
import { select } from '../../state/selection'
import { ui } from '../../state/ui'
import { Badge, ChipMark, cx, Icon } from '../components'
import { t } from '../copy'
import { runShortcut, type ShortcutAction } from '../shell/keys'
import { isMapMode, modeHash, openSidebar } from '../shell/store'
import { commandItems, GROUP_LABEL, loadObjectIndex, rank, type SearchItem } from './search'
import './search.css'

/** Shown text of an item: the file's name for objects, copy.json for commands. */
export const labelOf = (i: SearchItem): string => (i.label ? t(i.label) : i.name)

let cached: Promise<SearchItem[]> | null = null
/** Objects (static files, loader-cached) + commands. One build per page load. */
export function searchIndex(L: Loader = data()): Promise<SearchItem[]> {
  return (cached ??= loadObjectIndex(L).then((objs) => [...objs, ...commandItems()]))
}
/** Tests: forget the built index. */
export const resetSearchIndex = (): void => void (cached = null)

export interface RunEnv {
  navigate: (hash: string) => void
  win?: Window
}

/** Enter on a result. Objects: select(ref, 'search'), the same call a map or list click makes, so the
 *  sidebar shows the same card; outside PLAN/FLY the sidebar is hidden, so PLAN opens first. Commands:
 *  the §4.4 shortcut, through the shell's runner (other packages may handle it via `hl:shortcut`). */
export function runItem(item: SearchItem, env: RunEnv): void {
  if (item.ref) {
    if (!isMapMode(ui.mode.peek() ?? 'plan')) env.navigate(modeHash('plan'))
    select(item.ref, 'search')
    openSidebar()
    return
  }
  if (item.command) {
    const win = env.win
    const announce = (a: ShortcutAction): boolean => {
      if (!win) return false
      const ev = new CustomEvent('hl:shortcut', { detail: a, cancelable: true })
      win.dispatchEvent(ev)
      return ev.defaultPrevented
    }
    runShortcut(item.command, { navigate: env.navigate, announce })
  }
}

export interface PaletteProps {
  onClose: () => void
  /** Default: the app loader (static data tree). */
  loader?: Loader
  navigate?: (hash: string) => void
  win?: Window
  /** Tests: a ready index instead of loading one. */
  items?: SearchItem[]
}

const defaultNavigate = (hash: string): void => {
  if (location.hash !== hash) location.hash = hash
}

export function Palette({ onClose, loader, navigate = defaultNavigate, win = typeof window === 'undefined' ? undefined : window, items: given }: PaletteProps) {
  const [items, setItems] = useState<SearchItem[] | null>(given ?? null)
  const [failed, setFailed] = useState(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const dlg = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const closeBtn = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (given) return
    let alive = true
    searchIndex(loader).then(
      (x) => alive && setItems(x),
      () => alive && setFailed(true),
    )
    return () => void (alive = false)
  }, [])

  // open modal, focus the input; on unmount close and give focus back to the opener
  useEffect(() => {
    const d = dlg.current
    const back = (globalThis.document?.activeElement ?? null) as HTMLElement | null
    if (d) {
      if (typeof d.showModal === 'function' && !d.open) d.showModal()
      else d.setAttribute('open', '')
    }
    input.current?.focus()
    return () => {
      if (d && typeof d.close === 'function' && d.open) d.close()
      back?.focus?.()
    }
  }, [])

  const results = useMemo(() => (items ? rank(items, q, labelOf) : []), [items, q])
  const cur = Math.min(active, Math.max(results.length - 1, 0))
  const optId = (i: number) => `hl-search-opt-${i}`

  const choose = (item: SearchItem | undefined) => {
    if (!item) return
    onClose()
    runItem(item, { navigate, win })
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const n = results.length
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        if (n) setActive((cur + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
        break
      case 'Enter':
        if (e.target === closeBtn.current) return
        choose(results[cur]?.item)
        break
      case 'Escape':
        onClose()
        break
      case 'Tab': {
        const a = globalThis.document?.activeElement
        if (!e.shiftKey && a === closeBtn.current) input.current?.focus()
        else if (e.shiftKey && a === input.current) closeBtn.current?.focus()
        else return
        break
      }
      default:
        return
    }
    e.preventDefault()
    e.stopPropagation() // the shell's window listener skips handled keys (Escape must not clear the selection)
  }

  const expanded = results.length > 0
  return (
    <dialog
      ref={dlg}
      class="hl-ui hl-search"
      aria-label={t('nav.search')}
      onKeyDown={onKeyDown}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => e.target === dlg.current && onClose()}
    >
      <div class="hl-search__field">
        <Icon name="search" />
        <input
          ref={input}
          id="hl-search-input"
          class="hl-search__input"
          type="text"
          role="combobox"
          aria-label={t('nav.search')}
          aria-autocomplete="list"
          aria-expanded={expanded ? 'true' : 'false'}
          aria-controls="hl-search-list"
          aria-activedescendant={expanded ? optId(cur) : undefined}
          autocomplete="off"
          spellcheck={false}
          placeholder={t('search.placeholder')}
          value={q}
          onInput={(e) => {
            setQ((e.currentTarget as HTMLInputElement).value)
            setActive(0)
          }}
        />
        <button ref={closeBtn} type="button" class="hl-iconbtn hl-search__close" aria-label={t('buttons.close')} onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <ul id="hl-search-list" class="hl-search__list" role="listbox" aria-label={t('nav.search')}>
        {results.map(({ item }, i) => (
          <li
            key={item.id}
            id={optId(i)}
            role="option"
            aria-selected={i === cur ? 'true' : 'false'}
            class={cx('hl-search__opt', i === cur && 'is-active')}
            data-id={item.id}
            onMouseDown={(e) => e.preventDefault() /* keep focus in the input */}
            onMouseMove={() => i !== cur && setActive(i)}
            onClick={() => choose(item)}
          >
            <Icon name={item.icon} />
            {item.code && <Badge>{item.code}</Badge>}
            <span class="hl-search__name">{labelOf(item)}</span>
            <span class="hl-search__kind">{t(GROUP_LABEL[item.group])}</span>
            {item.chip && <ChipMark kind={item.chip} />}
            {item.keys?.map((k) => (
              <kbd key={k} aria-hidden="true">
                {k}
              </kbd>
            ))}
          </li>
        ))}
      </ul>
      <p class="hl-search__status" role="status" aria-live="polite">
        {failed
          ? t('states.error.generic', { what: t('nav.search') })
          : !items
            ? t('states.loading.generic', { what: t('nav.search') })
            : q.trim() && !results.length
              ? t('search.noResults', { query: q.trim() })
              : ''}
      </p>
    </dialog>
  )
}
