// WS16 task 10 (M10): page-level set-up for ?capture=<id> and ?demo=1, run by main.ts before the first
// render (lazy). Capture: virtual time before the map exists (vtime.ts), the capture frame size as CSS
// variables (storyboards carry their own size; config/design.yaml capture.size is the default), and
// the planning map as the route. Kiosk: the planning map as the route.
import { CAPTURE } from './config'
import { storyParams } from './query'
import { installVirtualTime } from './vtime'

export function boot(): void {
  const p = storyParams(location.search, location.hash)
  const root = document.documentElement
  if (p.capture) {
    installVirtualTime()
    root.dataset.storyCapture = p.capture
    root.style.setProperty('--hl-capture-w', `${CAPTURE.size[0]}px`)
    root.style.setProperty('--hl-capture-h', `${CAPTURE.size[1]}px`)
  }
  // stories run on the planning map (#/); keep any hash query (?chrome=1 …)
  const [path, q] = location.hash.replace(/^#/, '').split('?')
  if (path !== '/' && path !== '') history.replaceState(history.state, '', `${location.pathname}${location.search}#/${q ? `?${q}` : ''}`)
}
