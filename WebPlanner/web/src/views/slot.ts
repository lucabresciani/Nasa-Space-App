// Mount points for views owned by other workstreams (C, adjustment 4):
//   /hud   -> web/src/hud/index.ts(x)   (WS7)
// The /hud3d (WS8, F20) and /nav (WS9, F21/F22) slots are removed (D99, D98); router.ts redirects them.
// Contract: the module exports `mount(el, ctx)`; it may return a cleanup function (sync or async).
// The shell lazy-loads it only on that route, so Three.js etc. never weigh on the other pages.
// Until the module exists the route shows a placeholder. WS5 never writes inside those folders.
import { DATA_MODE, dataUrl, type DataMode } from '../env'
import type { View } from './types'

export interface ViewContext {
  /** URL of a file in the active data tree (data/ or data-dummy/), e.g. ctx.dataUrl('fields/index.json'). */
  dataUrl: (path: string) => string
  dataMode: DataMode
  /** Route parameters (none today; reserved). */
  params: Record<string, string>
}

export type Cleanup = () => void
export interface SlotModule {
  mount: (el: HTMLElement, ctx: ViewContext) => void | Cleanup | Promise<void | Cleanup>
}

const modules = import.meta.glob<SlotModule>([
  '../hud/index.ts',
  '../hud/index.tsx',
])

/** D19 (user 2026-11-14 14:19): label of the navigation / visual-odometry findings (scorecard). */
export const ADDON_LABEL = 'Optional add-on (not part of the core plan)'

export const SLOTS = {
  hud: { dir: 'hud', owner: 'WS7', title: 'Live HUD (F18, F19)' },
} as const
export type SlotName = keyof typeof SLOTS

export function findSlotLoader(name: SlotName): (() => Promise<SlotModule>) | undefined {
  const dir = SLOTS[name].dir
  return modules[`../${dir}/index.ts`] ?? modules[`../${dir}/index.tsx`]
}

export function slotView(name: SlotName): View {
  return async (el) => {
    const slot = SLOTS[name]
    const container = document.createElement('div')
    container.className = 'slot'
    container.dataset.slot = name
    el.append(container)
    const load = findSlotLoader(name)
    if (!load) {
      container.innerHTML = `<div class="page"><h1>${slot.title}</h1>
        <p class="muted">Mount slot for ${slot.owner}. The view appears here once
        <code>web/src/${slot.dir}/index.ts</code> exports <code>mount(el, ctx)</code>.</p></div>`
      return
    }
    const mod = await load()
    const ctx: ViewContext = { dataUrl: (p) => dataUrl(p), dataMode: DATA_MODE, params: {} }
    const cleanup = await mod.mount(container, ctx)
    return cleanup ?? undefined
  }
}
