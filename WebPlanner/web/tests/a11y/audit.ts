// In-page accessibility audit (package Q1, DESIGN §9 "Accessibility"). No axe-core: lightweight rules
// that run inside the page via page.evaluate, so this function must stay self-contained (no imports,
// no references outside its body). Returns violations as stable keys `rule|target` plus a detail line.
//   html-lang, document-title          <html lang>, non-empty <title>
//   landmark-main / -banner / -nav     exactly one main, at least one banner (header) and one nav
//   img-alt                            <img> without alt; svg[role=img] without a name
//   button-name, link-name             buttons / links without an accessible name
//   control-label                      inputs, selects, textareas, role=switch/slider without a label
//   heading-h1, heading-order          at least one h1; no level skipped when going deeper
//   contrast                           text colour vs. its effective background (composited, opacity),
//                                      ≥ 4.5:1, large text ≥ 3:1; text over a canvas, map or image skipped
export interface AuditViolation {
  key: string
  detail: string
}

export function auditDom(): AuditViolation[] {
  const out: AuditViolation[] = []
  const add = (rule: string, el: Element | null, detail = '') => {
    out.push({ key: `${rule}|${el ? describe(el) : 'document'}`, detail })
  }
  function describe(el: Element): string {
    const parts: string[] = []
    let e: Element | null = el
    for (let depth = 0; e && depth < 3 && e !== document.body; depth++, e = e.parentElement) {
      const cls = [...e.classList].filter((c) => !/^(active|on|is-|open)/.test(c)).slice(0, 2)
      parts.unshift(e.localName + (e.id ? `#${e.id}` : '') + cls.map((c) => `.${c}`).join(''))
      if (e.id) break
    }
    const name = accName(el).replace(/\s+/g, ' ').trim().slice(0, 40)
    return parts.join('>') + (name ? ` "${name}"` : '')
  }
  function visible(el: Element): boolean {
    const r = el.getBoundingClientRect()
    if (r.width <= 1 || r.height <= 1) return false
    for (let e: Element | null = el; e; e = e.parentElement) {
      const s = getComputedStyle(e)
      if (s.display === 'none' || s.visibility === 'hidden' || (e as HTMLElement).hidden) return false
      if (s.clip === 'rect(0px, 0px, 0px, 0px)' || s.clipPath === 'inset(50%)') return false
    }
    return true
  }
  function textOf(ids: string): string {
    return ids
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim()
  }
  function accName(el: Element): string {
    const a = el.getAttribute('aria-label')?.trim()
    if (a) return a
    const lb = el.getAttribute('aria-labelledby')
    if (lb && textOf(lb)) return textOf(lb)
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
      const labels = el.labels ? [...el.labels].map((l) => l.textContent ?? '').join(' ').trim() : ''
      if (labels) return labels
      if (el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type)) return el.value || el.type
    }
    if (el instanceof HTMLImageElement) return el.alt ?? ''
    const own = el instanceof HTMLElement ? el.innerText?.trim() : el.textContent?.trim()
    if (own) return own
    const alts = [...el.querySelectorAll('img[alt], [role=img][aria-label], svg[aria-label]')]
      .map((i) => i.getAttribute('alt') ?? i.getAttribute('aria-label') ?? '')
      .join(' ')
      .trim()
    if (alts) return alts
    return el.getAttribute('title')?.trim() ?? ''
  }

  // Document
  if (!document.documentElement.lang) add('html-lang', null)
  if (!document.title.trim()) add('document-title', null)

  // Landmarks
  const mains = document.querySelectorAll('main, [role=main]')
  if (mains.length !== 1) add('landmark-main', null, `${mains.length} main landmarks`)
  const banners = [...document.querySelectorAll('header, [role=banner]')].filter(
    (h) => h.getAttribute('role') === 'banner' || !h.parentElement?.closest('article, aside, main, nav, section, [role=main]'),
  )
  if (banners.length < 1) add('landmark-banner', null)
  if (document.querySelectorAll('nav, [role=navigation]').length < 1) add('landmark-nav', null)

  // Images
  for (const img of document.querySelectorAll('img')) if (!img.hasAttribute('alt')) add('img-alt', img)
  for (const svg of document.querySelectorAll('svg[role=img]')) if (!accName(svg) && !svg.querySelector('title')) add('img-alt', svg)

  // Names and labels
  for (const b of document.querySelectorAll('button, [role=button], input[type=button], input[type=submit], input[type=reset]')) {
    if (visible(b) && !accName(b)) add('button-name', b)
  }
  for (const a of document.querySelectorAll('a[href]')) if (visible(a) && !accName(a)) add('link-name', a)
  const controls = document.querySelectorAll(
    'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]), select, textarea, [role=switch], [role=slider], [role=combobox], [role=textbox], [role=checkbox], [role=radio]',
  )
  for (const c of controls) {
    if (!visible(c)) continue
    const wrapped = c.closest('label')
    if (!accName(c) && !(wrapped && wrapped.textContent?.trim()) && !c.getAttribute('title')) add('control-label', c)
  }

  // Headings
  const hs = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role=heading]')].filter(visible)
  if (!hs.some((h) => h.localName === 'h1' || h.getAttribute('aria-level') === '1')) add('heading-h1', null)
  let prev = 0
  for (const h of hs) {
    const lvl = h.localName.startsWith('h') && h.localName.length === 2 ? Number(h.localName[1]) : Number(h.getAttribute('aria-level') ?? 2)
    if (prev && lvl > prev + 1) add('heading-order', h, `h${prev} → h${lvl}`)
    prev = lvl
  }

  // Contrast
  type RGBA = [number, number, number, number]
  const parse = (c: string): RGBA | null => {
    const m = /rgba?\(([^)]+)\)/.exec(c)
    if (!m) return null
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]
  }
  const over = (top: RGBA, under: RGBA): RGBA => {
    const a = top[3] + under[3] * (1 - top[3])
    if (a === 0) return [0, 0, 0, 0]
    const ch = (i: number) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a
    return [ch(0), ch(1), ch(2), a]
  }
  const lum = (c: RGBA) => {
    const f = (v: number) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
  }
  /** Effective opaque background behind `el`, or null when it is an image, gradient, canvas or map. */
  function background(el: Element): RGBA | null {
    const layers: RGBA[] = []
    for (let e: Element | null = el; e; e = e.parentElement) {
      const s = getComputedStyle(e)
      if (s.backgroundImage !== 'none' || e.localName === 'canvas' || e.classList.contains('maplibregl-map')) return null
      if (e.localName === 'img' || e.localName === 'video') return null
      const c = parse(s.backgroundColor)
      if (c && c[3] > 0) {
        layers.push(c)
        if (c[3] >= 1) break
      }
    }
    // Siblings painted under the element (absolutely positioned canvases, map tiles) are not ancestors:
    // a text box over a map without its own background has no ancestor colour before body.
    let bg: RGBA = [255, 255, 255, 1] // the browser canvas
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg)
    return bg
  }
  function overMap(el: Element): boolean {
    return !!el.closest('.maplibregl-map, .maplibregl-marker, .maplibregl-popup, .maplibregl-ctrl')
  }
  const seen = new Set<Element>()
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement
    if (!el || seen.has(el) || !n.textContent?.trim()) continue
    seen.add(el)
    if (['script', 'style', 'noscript', 'option'].includes(el.localName) || !visible(el) || overMap(el)) continue
    if (el.closest(':disabled, [aria-disabled=true], [inert]')) continue // WCAG 1.4.3: inactive components exempt
    // …including the label / value output of a disabled control.
    const ctl = el.closest('label') ? (el.closest('label') as HTMLLabelElement).control : el.closest('output') ? document.getElementById((el.closest('output') as HTMLOutputElement).htmlFor.value) : null
    if (ctl && (ctl as HTMLInputElement).disabled) continue
    const s = getComputedStyle(el)
    const fg0 = parse(s.color)
    const bg = background(el)
    if (!fg0 || !bg) continue
    let opacity = 1
    for (let e: Element | null = el; e; e = e.parentElement) opacity *= Number(getComputedStyle(e).opacity)
    const fg = over([fg0[0], fg0[1], fg0[2], fg0[3] * opacity], bg)
    const [l1, l2] = [lum(fg), lum(bg)]
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    const px = parseFloat(s.fontSize)
    const large = px >= 24 || (px >= 18.66 && Number(s.fontWeight) >= 700)
    const min = large ? 3 : 4.5
    if (ratio < min - 0.005) add('contrast', el, `${ratio.toFixed(2)}:1 < ${min}:1 (${s.color} on rgb(${bg.slice(0, 3).map(Math.round).join(',')}), ${px}px)`)
  }
  return out
}
