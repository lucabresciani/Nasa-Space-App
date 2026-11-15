// Top-bar search button + palette host (DESIGN U17, §4.4 Ctrl+K and /; package A8). This is the only part
// in the first load: a button and a `hl:shortcut` listener. The palette, its index and styles load on
// first open (palette.tsx chunk). The shell registers it with one element in its top bar (Shell.tsx).
import type { ComponentType } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { IconButton } from '../components'
import { t } from '../copy'
import type { PaletteProps } from './palette'

type PaletteC = ComponentType<PaletteProps>
let loaded: PaletteC | null = null
export const loadPalette = (): Promise<PaletteC> => import('./palette').then((m) => (loaded = m.Palette))

/** Warm the palette chunk when the pointer or focus reaches the button (never on page load: perf test). */
const prefetch = (): void => void (loaded || loadPalette().catch(() => {}))

export interface SearchButtonProps {
  win?: Window
  /** Passed to the palette (tests). */
  palette?: Omit<PaletteProps, 'onClose'>
}

export function SearchButton({ win = typeof window === 'undefined' ? undefined : window, palette }: SearchButtonProps) {
  const [open, setOpen] = useState(false)
  const [P, setP] = useState<PaletteC | null>(() => loaded)
  useEffect(() => {
    if (!win) return
    // §4.4: Ctrl+K and / arrive as the shell's cancelable `hl:shortcut` action 'search' (keys.ts).
    const on = (e: Event) => {
      if ((e as CustomEvent<{ action?: string }>).detail?.action !== 'search') return
      e.preventDefault()
      setOpen((o) => !o)
    }
    win.addEventListener('hl:shortcut', on)
    return () => win.removeEventListener('hl:shortcut', on)
  }, [win])
  useEffect(() => {
    if (open && !P) void loadPalette().then((c) => setP(() => c))
  }, [open])
  return (
    <>
      <IconButton icon="search" label={t('nav.search')} aria-haspopup="dialog" aria-expanded={open ? 'true' : 'false'} aria-keyshortcuts="Control+K Meta+K /" onPointerEnter={prefetch} onFocus={prefetch} onClick={() => setOpen(true)} />
      {open && P && <P {...palette} win={palette?.win ?? win} onClose={() => setOpen(false)} />}
    </>
  )
}
