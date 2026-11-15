/**
 * Accessibility in the browser (DESIGN §9 "Accessibility", §4.4, U12; package Q1). For every 2D route
 * and /styleguide at both viewports (projects of playwright.config.ts):
 *   - keyboard reach: every interactive element is reached by Tab (native radio groups and roving-
 *     tabindex groups such as radiogroup / tablist count as reached when one member is);
 *     rule `keyboard-unreachable`
 *   - visible focus: each element focused by Tab shows an outline ≥ tokens.json line.focusRingPx
 *     (`focus-ring`; range inputs: on the thumb)
 *   - no keyboard trap: Tab leaves every element and wraps back to the start (`keyboard-trap`)
 *   - landmarks, names, labels, alt text, heading order and text contrast: ./audit.ts
 * Not covered here: #/spike (WebGL; R7; #/nav and #/hud3d are removed, D98/D99), frame rate (RR lane, DESIGN §9 "Performance").
 *
 * Baseline (legacy views): tests/a11y/baseline.json maps `<screen>@<viewport>` to the violations that
 * existed when Q1 landed ({"rule|target": count}). A test fails only on violations that are NEW (key
 * absent or count higher); fixed ones are reported as the annotation `fixed` (prune them). Migration
 * packages fix the listed ones and remove them; never add entries to get green (kit rule: never weaken
 * a test). To rewrite after an intended fix: HL_A11Y_UPDATE=1 npm run test:a11y-perf -- tests/a11y
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { expect, test, type Page } from 'playwright/test'
import tokens from '../../src/ui/tokens.json' with { type: 'json' }
import { auditDom, type AuditViolation } from './audit.ts'

const FIXED_NOW = process.env.HL_SNAPSHOT_NOW ?? '2026-11-15T11:00:00Z'
const BASELINE = new URL('./baseline.json', import.meta.url)
const FOCUS_RING_PX = tokens.line.focusRingPx
const SETTLE_TIMEOUT_MS = 45_000

/** Same screens as the visual regression (web/tests/visual/screens.spec.ts): 2D routes + /styleguide. */
export const SCREENS: { name: string; hash: string }[] = [
  { name: 'plan', hash: '#/' },
  { name: 'station-S1', hash: '#/station/S1' },
  { name: 'trade', hash: '#/trade' },
  { name: 'conditions', hash: '#/conditions' },
  { name: 'cuff', hash: '#/cuff' },
  { name: 'hud', hash: '#/hud' },
  { name: 'scorecard', hash: '#/scorecard' },
  { name: 'about', hash: '#/about' },
  { name: 'styleguide', hash: '#/styleguide' },
]

type Counts = Record<string, number>

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('load')
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  const t0 = Date.now()
  let last = ''
  let stable = 0
  while (Date.now() - t0 < SETTLE_TIMEOUT_MS) {
    const text = await page.evaluate(() => document.body.innerText.replace(/\d+(\.\d+)? ?fps/gi, ''))
    if (!/Loading/.test(text) && text.length > 0 && text === last) {
      if (++stable >= 4) return
    } else stable = 0
    last = text
    await page.waitForTimeout(250)
  }
  throw new Error(`page did not settle within ${SETTLE_TIMEOUT_MS} ms`)
}

/** Tags every interactive element with data-q1 and returns what must be reachable by Tab. */
async function tagInteractive(page: Page) {
  return page.evaluate(() => {
    const ROVING = '[role=radiogroup], [role=tablist], [role=toolbar], [role=menu], [role=menubar], [role=listbox], [role=grid], [role=tree]'
    const sel =
      'a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable=true], iframe, [role=button], [role=link], [role=switch], [role=slider], [role=tab], [role=radio], [role=checkbox], [role=menuitem], [role=option]'
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return false
      for (let e: Element | null = el; e; e = e.parentElement) {
        const s = getComputedStyle(e)
        if (s.display === 'none' || s.visibility === 'hidden') return false
      }
      return true
    }
    const name = (el: Element) => {
      const n = (el.getAttribute('aria-label') ?? (el as HTMLElement).innerText ?? el.getAttribute('title') ?? '').replace(/\s+/g, ' ').trim()
      return n.slice(0, 40)
    }
    const describe = (el: Element) => {
      const parts: string[] = []
      let e: Element | null = el
      for (let d = 0; e && d < 3 && e !== document.body; d++, e = e.parentElement) {
        const cls = [...e.classList].filter((c) => !/^(active|on|is-|open)/.test(c)).slice(0, 2)
        parts.unshift(e.localName + (e.id ? `#${e.id}` : '') + cls.map((c) => `.${c}`).join(''))
        if (e.id) break
      }
      const n = name(el)
      return parts.join('>') + (n ? ` "${n}"` : '')
    }
    const items: { id: string; desc: string; group: string | null; mustReach: boolean }[] = []
    let i = 0
    let g = 0
    const groups = new Map<Element, string>()
    for (const el of document.querySelectorAll(sel)) {
      if (!visible(el) || el.closest('[inert], [aria-hidden=true]')) continue
      if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') continue
      const native = el.matches('a[href], button, input, select, textarea, summary, iframe, [contenteditable=""], [contenteditable=true]')
      const role = el.matches('[role]:not([role=presentation]):not([role=none]):not([role=dialog]):not([role=region]):not([role=group])')
      const tabindex = el.getAttribute('tabindex')
      // A container made focusable with tabindex (no native or ARIA widget role) is not a control.
      if (!native && !role && tabindex !== null && Number(tabindex) < 0) continue
      const groupEl = el.parentElement?.closest(ROVING) ?? null
      let group: string | null = null
      // A native radio group (same name) is one Tab stop; arrows move inside it.
      if (el instanceof HTMLInputElement && el.type === 'radio' && el.name) group = `radio:${el.form?.id ?? ''}:${el.name}`
      else if (groupEl) {
        if (!groups.has(groupEl)) groups.set(groupEl, `g${g++}`)
        group = groups.get(groupEl)!
      }
      const id = `q${i++}`
      el.setAttribute('data-q1', id)
      // Native controls are reachable unless tabindex<0; ARIA widgets need tabindex ≥ 0 or a roving group.
      items.push({ id, desc: describe(el), group, mustReach: true })
    }
    return items
  })
}

interface Step {
  id: string | null
  desc: string
  ring: boolean
  ringDetail: string
  body: boolean
}

async function activeInfo(page: Page, ringPx: number): Promise<Step> {
  return page.evaluate((ringPx) => {
    let el = document.activeElement as HTMLElement | null
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement as HTMLElement
    if (!el || el === document.body || el === document.documentElement) return { id: null, desc: 'body', ring: true, ringDetail: '', body: true }
    const s = getComputedStyle(el)
    const ok = (st: CSSStyleDeclaration) => st.outlineStyle !== 'none' && parseFloat(st.outlineWidth) >= ringPx - 0.01
    let ring = ok(s)
    let detail = `outline ${s.outlineStyle} ${s.outlineWidth}`
    if (!ring && el instanceof HTMLInputElement && el.type === 'range') {
      // getComputedStyle cannot read ::-webkit-slider-thumb: find a matching author rule for the thumb.
      const px = (v: string) => {
        const m = /var\((--[\w-]+)\)/.exec(v)
        return parseFloat(m ? s.getPropertyValue(m[1]) : v)
      }
      for (const sheet of document.styleSheets) {
        let rules: CSSRuleList
        try {
          rules = sheet.cssRules
        } catch {
          continue
        }
        for (const r of rules) {
          if (!(r instanceof CSSStyleRule)) continue
          for (const part of r.selectorText.split(',')) {
            if (!part.includes('::-webkit-slider-thumb') || !/:focus/.test(part)) continue
            let base = part.replace('::-webkit-slider-thumb', '').trim()
            try {
              if (!el.matches(base)) continue
            } catch {
              continue
            }
            const w = r.style.outlineWidth || r.style.outline.split(/\s+/)[0]
            if (r.style.outline && !/none/.test(r.style.outline) && px(w) >= ringPx - 0.01) ring = true
            base = ''
          }
        }
      }
      detail += ring ? '' : '; no thumb focus rule'
    }
    const cls = [...el.classList].slice(0, 2).map((c) => `.${c}`).join('')
    return { id: el.getAttribute('data-q1'), desc: `${el.localName}${cls}`, ring, ringDetail: detail, body: false }
  }, ringPx)
}

/** Tabs through the page; returns violations and the ids reached. */
async function tabWalk(page: Page, items: Awaited<ReturnType<typeof tagInteractive>>): Promise<AuditViolation[]> {
  const out: AuditViolation[] = []
  const byId = new Map(items.map((x) => [x.id, x]))
  await page.evaluate(() => {
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    window.scrollTo(0, 0)
  })
  const reached = new Set<string>()
  const max = Math.min(800, items.length * 2 + 20)
  let first: string | null = null
  let prev: string | null = null
  let repeats = 0
  let wrapped = false
  for (let step = 0; step < max; step++) {
    await page.keyboard.press('Tab')
    const a = await activeInfo(page, FOCUS_RING_PX)
    if (a.body) {
      if (reached.size > 0) {
        wrapped = true
        break
      }
      continue
    }
    const key = a.id ?? `untagged:${a.desc}`
    if (key === first && reached.size > 0) {
      wrapped = true
      break
    }
    first ??= key
    if (key === prev) {
      if (++repeats >= 2) {
        out.push({ key: `keyboard-trap|${byId.get(key)?.desc ?? a.desc}`, detail: 'Tab does not move focus' })
        return out
      }
    } else repeats = 0
    prev = key
    if (a.id && !reached.has(a.id) && !a.ring) out.push({ key: `focus-ring|${byId.get(a.id)?.desc ?? a.desc}`, detail: `${a.ringDetail} < ${FOCUS_RING_PX}px` })
    if (a.id) reached.add(a.id)
  }
  if (!wrapped) out.push({ key: `keyboard-trap|${prev ? (byId.get(prev)?.desc ?? prev) : 'page'}`, detail: `Tab never returned to the start in ${max} presses` })
  const groupsReached = new Set(items.filter((x) => x.group && reached.has(x.id)).map((x) => x.group))
  for (const x of items) {
    if (reached.has(x.id) || (x.group && groupsReached.has(x.group))) continue
    out.push({ key: `keyboard-unreachable|${x.desc}`, detail: 'never focused by Tab' })
  }
  return out
}

const count = (vs: AuditViolation[]): Counts => {
  const c: Counts = {}
  for (const v of vs) c[v.key] = (c[v.key] ?? 0) + 1
  return Object.fromEntries(Object.entries(c).sort(([a], [b]) => a.localeCompare(b)))
}
const readBaseline = (): Record<string, Counts> => JSON.parse(readFileSync(BASELINE, 'utf8'))

for (const s of SCREENS) {
  test(`a11y ${s.name}`, async ({ page }, info) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.clock.setFixedTime(new Date(FIXED_NOW))
    await page.goto(s.hash)
    await settle(page)
    expect(await page.getByRole('heading', { name: 'Not found', exact: true }).count(), `${s.hash} renders`).toBe(0)

    const violations: AuditViolation[] = await page.evaluate(auditDom)
    const items = await tagInteractive(page)
    violations.push(...(await tabWalk(page, items)))
    expect(errors, 'uncaught page errors').toEqual([])

    const id = `${s.name}@${info.project.name}`
    const now = count(violations)
    if (process.env.HL_A11Y_UPDATE) {
      const all = readBaseline()
      if (Object.keys(now).length) all[id] = now
      else delete all[id]
      writeFileSync(BASELINE, JSON.stringify(Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b))), null, 1) + '\n')
      return
    }
    const base = readBaseline()[id] ?? {}
    const fresh = Object.entries(now)
      .filter(([k, n]) => n > (base[k] ?? 0))
      .map(([k, n]) => `${k} (×${n - (base[k] ?? 0)}) ${violations.find((v) => v.key === k)?.detail ?? ''}`.trim())
    const fixed = Object.keys(base).filter((k) => (now[k] ?? 0) < base[k])
    if (fixed.length) info.annotations.push({ type: 'fixed', description: `${fixed.length} baseline entries fixed; prune tests/a11y/baseline.json: ${fixed.join('; ')}` })
    info.annotations.push({ type: 'checked', description: `${items.length} interactive elements, ${violations.length} violations (${fresh.length} new)` })
    expect(fresh, `new accessibility violations on ${id} (not in tests/a11y/baseline.json)`).toEqual([])
  })
}
