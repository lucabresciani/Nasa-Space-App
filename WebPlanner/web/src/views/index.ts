// Route -> view. Every page is lazy-loaded so the map (MapLibre) loads only on the console.
import type { Route } from '../router'
import { slotView } from './slot'
import type { View } from './types'

type Loader = () => Promise<View>

export const VIEWS: Record<Route['name'], Loader> = {
  console: async () => (await import('./console')).view,
  station: async () => (await import('./station')).view,
  trade: async () => (await import('./trade')).view,
  conditions: async () => (await import('./conditions')).view,
  scorecard: async () => (await import('./scorecard')).view,
  cuff: async () => (await import('./cuff')).view,
  about: async () => (await import('./about')).view,
  hud: async () => slotView('hud'),
  mission: async () => (await import('./mission')).view,
  notfound: async () => (el, route) => {
    const path = route.name === 'notfound' ? route.path : ''
    el.innerHTML = `<div class="page"><h1>Not found</h1><p>No page at <code></code>. <a href="#/">Back to the plan</a>.</p></div>`
    el.querySelector('code')!.textContent = path
  },
}
