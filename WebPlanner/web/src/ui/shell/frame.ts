// The two page frames main.ts mounts views into (WS15 task 4, package A4).
//   legacy: the layout from before the shell, unchanged (header.topbar > a.brand + nav.topnav, the dummy
//           banner, main.outlet). Used for ?legacy=… (DESIGN U0, kit rule 10) and the internal
//           #/styleguide and #/spike pages.
//   shell:  DESIGN §4.3: top bar, left rail, main.outlet, right sidebar, timeline dock. The existing
//           views render unchanged into main.outlet; the Preact islands go into the slots.
// Both keep `.topbar` (live status anchor, src/live/index.ts mountLive) with `main.outlet` in the same
// parent subtree (the live #/plan routes), and `main.outlet` (tools/values_snapshot.ts reads numbers there).
// Built with createElement/setAttribute/appendChild only, so the vitest fake DOM can build them too.
import { href, isLegacy, isSpikeHash, isStyleguideHash, legacyParam, NAV_ITEMS, parseRoute } from '../../router'
import { t } from '../copy'

export type FrameKind = 'legacy' | 'shell'

export interface Frame {
  kind: FrameKind
  /** The element appended to #app (remove it to switch frames). */
  root: HTMLElement
  topbar: HTMLElement
  outlet: HTMLElement
  banner: HTMLElement
  /** legacy: the old top navigation (links get .active) */
  nav?: HTMLElement
  /** shell: Preact island hosts */
  slots?: { skip: HTMLElement; top: HTMLElement; rail: HTMLElement; sidebar: HTMLElement; dock: HTMLElement; overlay: HTMLElement }
}

/** Which frame a location renders in: internal pages and ?legacy=… use the old layout. */
export function frameKindFor(search: string, hash: string): FrameKind {
  if (isSpikeHash(hash) || isStyleguideHash(hash)) return 'legacy'
  return isLegacy(legacyParam(search, hash), parseRoute(hash)) ? 'legacy' : 'shell'
}

type Attrs = Record<string, string>
function el(doc: Document, tag: string, attrs: Attrs = {}, ...kids: (Node | string)[]): HTMLElement {
  const n = doc.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v)
  for (const k of kids) n.appendChild(typeof k === 'string' ? doc.createTextNode(k) : k)
  return n
}

const DUMMY_TEXT = 'DUMMY DATA · synthetic world, not Mars results · never capture'

/** The pre-shell layout, element for element as main.ts built it before A4. */
export function buildLegacyFrame(doc: Document): Frame {
  const nav = el(doc, 'nav', { class: 'topnav' })
  for (const item of NAV_ITEMS) nav.appendChild(el(doc, 'a', { href: href(item.route), 'data-route': item.route.name }, item.label))
  const topbar = el(doc, 'header', { class: 'topbar' }, el(doc, 'a', { class: 'brand', href: '#/' }, 'HOMELINE'), nav)
  const banner = el(doc, 'div', { class: 'dummy-banner' }, DUMMY_TEXT)
  const outlet = el(doc, 'main', { class: 'outlet' })
  // display: contents keeps #app's flex column layout exactly as before
  const root = el(doc, 'div', { class: 'hl-frame-legacy' }, topbar, banner, outlet)
  return { kind: 'legacy', root, topbar, outlet, banner, nav }
}

/** The shell layout (§4.3). Region sizes come from the UI store via CSS variables set by the shell. */
export function buildShellFrame(doc: Document): Frame {
  const skip = el(doc, 'div', { class: 'hl-shell__skip hl-ui' })
  const top = el(doc, 'div', { class: 'hl-topbar__inner' })
  const topbar = el(doc, 'header', { class: 'topbar hl-topbar hl-ui' }, top)
  const banner = el(doc, 'div', { class: 'dummy-banner' }, DUMMY_TEXT)
  const rail = el(doc, 'nav', { class: 'hl-rail hl-ui', id: 'hl-rail', 'aria-label': t('nav.modesMenu') })
  const outlet = el(doc, 'main', { class: 'outlet hl-main', id: 'hl-main', tabindex: '-1' })
  const sidebar = el(doc, 'aside', { class: 'hl-sidebar hl-ui', id: 'hl-sidebar', 'aria-label': t('cards.common.details') })
  const dock = el(doc, 'section', { class: 'hl-dock hl-ui', id: 'hl-dock', 'aria-label': t('timeline.evaTime') })
  const body = el(doc, 'div', { class: 'hl-shell__body' }, rail, outlet, sidebar, dock)
  const overlay = el(doc, 'div', { class: 'hl-shell__overlay hl-ui' })
  const root = el(doc, 'div', { class: 'hl-shell' }, skip, topbar, banner, body, overlay)
  return { kind: 'shell', root, topbar, outlet, banner, slots: { skip, top, rail, sidebar, dock, overlay } }
}
