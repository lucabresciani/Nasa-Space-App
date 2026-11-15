// Render tests for every DESIGN §3.7 component in each state (WS15 task 2), plus the trust chip's
// provenance popover against the real manifest (web/public/data/manifest.json).
// vitest runs in 'node' without jsdom; ../testing/dom.ts is a minimal DOM that Preact can render into.
import { readFileSync } from 'node:fs'
import { render, type VNode } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setManifest } from '../../prov/store'
import type { Manifest, ManifestEntry } from '../../data/types'
import { t } from '../copy'
import { all, byClass, byRole, byTag, hasClass, installDom, one, type FakeDocument, type FakeNode } from '../testing/dom'
import {
  Badge,
  Banner,
  Button,
  Card,
  CardSkeleton,
  CHIP_KINDS,
  IconButton,
  LegendRow,
  ListRow,
  ModeSwitch,
  Popover,
  ProvenanceTable,
  Readout,
  Segmented,
  Select,
  Slider,
  Tabs,
  Tag,
  Toggle,
  Tooltip,
  TrustChip,
} from './index'

let doc: FakeDocument
let root: FakeNode

function mount(v: VNode): FakeNode {
  act(() => render(v, root as unknown as Element))
  return root
}
function fire(n: FakeNode, type: string, init: Record<string, unknown> = {}): void {
  act(() => void n.dispatch(type, init))
}
const text = (n: FakeNode): string => n.textContent.replace(/\s+/g, ' ').trim()
const focusable = (n: FakeNode): boolean =>
  ['button', 'a', 'input', 'select'].includes(n.localName) ? !n.hasAttribute('disabled') && n.getAttribute('tabindex') !== '-1' : n.getAttribute('tabindex') === '0'

const MANIFEST = JSON.parse(readFileSync(new URL('../../../public/data/manifest.json', import.meta.url), 'utf8')) as Manifest
const KEY = 'reachable_pct.nom_104.30'
const ENTRY = MANIFEST[KEY] as ManifestEntry

beforeEach(() => {
  ;({ document: doc, container: root } = installDom())
  setManifest(MANIFEST)
})
afterEach(() => {
  act(() => render(null, root as unknown as Element))
  setManifest(null)
})

describe('Button', () => {
  for (const variant of ['primary', 'secondary', 'ghost', 'danger', 'live'] as const) {
    it(`${variant}: default is a focusable button with its label`, () => {
      const b = one(byTag(mount(<Button variant={variant}>{t('buttons.retry')}</Button>), 'button'))
      expect(hasClass(b, 'hl-btn')).toBe(true)
      expect(hasClass(b, `hl-btn--${variant}`)).toBe(true)
      expect(b.getAttribute('type')).toBe('button')
      expect(text(b)).toBe(t('buttons.retry'))
      expect(focusable(b)).toBe(true)
    })
  }
  for (const force of ['hover', 'focus', 'active'] as const) {
    it(`forced ${force} state is exposed for the style guide`, () => {
      const b = one(byTag(mount(<Button force={force}>{t('buttons.retry')}</Button>), 'button'))
      expect(b.getAttribute('data-force')).toBe(force)
    })
  }
  it('disabled: not focusable, click ignored', () => {
    const onClick = vi.fn()
    const b = one(byTag(mount(<Button disabled onClick={onClick}>{t('buttons.retry')}</Button>), 'button'))
    expect(b.hasAttribute('disabled')).toBe(true)
    fire(b, 'click')
    expect(onClick).not.toHaveBeenCalled()
  })
  it('busy (loading): aria-busy, spinner, stays focusable, click ignored', () => {
    const onClick = vi.fn()
    const b = one(byTag(mount(<Button busy onClick={onClick}>{t('buttons.computeFullPlan')}</Button>), 'button'))
    expect(b.getAttribute('aria-busy')).toBe('true')
    expect(b.getAttribute('aria-disabled')).toBe('true')
    expect(byClass(b, 'icon-loader-circle')).toHaveLength(1)
    expect(text(b)).toBe(t('buttons.computeFullPlan'))
    fire(b, 'click')
    expect(onClick).not.toHaveBeenCalled()
  })
  it('click calls onClick', () => {
    const onClick = vi.fn()
    fire(one(byTag(mount(<Button onClick={onClick}>{t('buttons.retry')}</Button>), 'button')), 'click')
    expect(onClick).toHaveBeenCalledTimes(1)
  })
  it('icon button: aria-label from copy, icon decorative', () => {
    const b = one(byTag(mount(<IconButton icon="play" label={t('buttons.play')} />), 'button'))
    expect(b.getAttribute('aria-label')).toBe(t('buttons.play'))
    expect(hasClass(b, 'hl-iconbtn')).toBe(true)
    const svg = one(byTag(b, 'svg'))
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(one(byTag(svg, 'use')).getAttribute('href')).toMatch(/#i-play$/)
  })
  it('icon button pressed state', () => {
    const b = one(byTag(mount(<IconButton icon="layers" label={t('nav.rail.layers')} pressed />), 'button'))
    expect(b.getAttribute('aria-pressed')).toBe('true')
  })
})

describe('Segmented control and mode switch', () => {
  const opts = [
    { value: 'opt', label: t('variants.optimistic') },
    { value: 'nom', label: t('variants.nominal') },
    { value: 'con', label: t('variants.conservative') },
  ]
  it('radiogroup with one checked radio; roving tabindex', () => {
    mount(<Segmented label={t('cards.common.details')} options={opts} value="nom" onChange={() => {}} />)
    const group = one(byRole(root, 'radiogroup'))
    expect(group.getAttribute('aria-label')).toBe(t('cards.common.details'))
    const radios = byRole(root, 'radio')
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
    expect(radios.map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '0', '-1'])
  })
  it('click and arrow keys change the value', () => {
    const onChange = vi.fn()
    mount(<Segmented label="v" options={opts} value="nom" onChange={onChange} />)
    const radios = byRole(root, 'radio')
    fire(radios[2], 'click')
    expect(onChange).toHaveBeenLastCalledWith('con')
    fire(radios[1], 'keydown', { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('opt')
    fire(radios[1], 'keydown', { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('con')
  })
  it('disabled: every radio disabled', () => {
    mount(<Segmented label="v" options={opts} value="nom" onChange={() => {}} disabled />)
    expect(byRole(root, 'radio').every((r) => r.hasAttribute('disabled'))).toBe(true)
  })
  it('forced focus marks the checked segment', () => {
    mount(<Segmented label="v" options={opts} value="nom" onChange={() => {}} force="focus" />)
    expect(byRole(root, 'radio')[1].getAttribute('data-force')).toBe('focus')
  })
  it('mode switch: the four modes from copy with icons', () => {
    mount(<ModeSwitch value="plan" onChange={() => {}} />)
    const radios = byRole(root, 'radio')
    expect(radios.map(text)).toEqual(['plan', 'fly', 'report', 'evidence'].map((m) => t(`modes.${m}.label` as 'modes.plan.label')))
    expect(radios[0].getAttribute('aria-checked')).toBe('true')
    expect(radios.every((r) => byTag(r, 'svg').length === 1)).toBe(true)
  })
})

describe('Toggle', () => {
  it('switch role, aria-checked follows the value, click toggles', () => {
    const onChange = vi.fn()
    mount(<Toggle label={t('layers.relief.name')} checked={false} onChange={onChange} />)
    const sw = one(byRole(root, 'switch'))
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(text(root)).toContain(t('layers.relief.name'))
    fire(sw, 'click')
    expect(onChange).toHaveBeenCalledWith(true)
  })
  it('on, disabled, forced focus', () => {
    mount(<Toggle label="x" checked onChange={() => {}} disabled force="focus" />)
    const sw = one(byRole(root, 'switch'))
    expect(sw.getAttribute('aria-checked')).toBe('true')
    expect(sw.hasAttribute('disabled')).toBe(true)
    expect(sw.getAttribute('data-force')).toBe('focus')
  })
})

describe('Slider', () => {
  it('range input with label, and it shows its value and unit', () => {
    mount(<Slider label={t('tooltips.budgetSlider')} min={30} max={60} step={30} value={30} units="min" onChange={() => {}} />)
    const input = one(byTag(root, 'input'))
    expect(input.getAttribute('type')).toBe('range')
    expect(input.getAttribute('aria-valuetext')).toBe('30 min')
    expect(text(one(byClass(root, 'hl-slider__value')))).toBe('30 min')
    expect(text(root)).toContain(t('tooltips.budgetSlider'))
  })
  it('input event reports a number; disabled state', () => {
    const onChange = vi.fn()
    mount(<Slider label="s" min={0} max={10} step={1} value={3} units="min" onChange={onChange} />)
    const input = one(byTag(root, 'input'))
    fire(input, 'input', { target: { value: '7' } })
    expect(onChange).toHaveBeenCalledWith(7)
    mount(<Slider label="s" min={0} max={10} step={1} value={3} units="min" onChange={onChange} disabled />)
    expect(one(byTag(root, 'input')).hasAttribute('disabled')).toBe(true)
  })
})

describe('Select', () => {
  it('native select with label and options; disabled', () => {
    const onChange = vi.fn()
    const opts = [
      { value: 'opt', label: t('variants.optimistic') },
      { value: 'nom', label: t('variants.nominal') },
    ]
    mount(<Select label={t('cards.common.details')} options={opts} value="nom" onChange={onChange} />)
    const sel = one(byTag(root, 'select'))
    expect(byTag(sel, 'option').map(text)).toEqual([t('variants.optimistic'), t('variants.nominal')])
    fire(sel, 'change', { target: { value: 'opt' } })
    expect(onChange).toHaveBeenCalledWith('opt')
    mount(<Select label="x" options={opts} value="nom" onChange={onChange} disabled />)
    expect(one(byTag(root, 'select')).hasAttribute('disabled')).toBe(true)
  })
})

describe('Tabs', () => {
  const tabs = [
    { id: 'summary', label: t('nav.rail.summary') },
    { id: 'layers', label: t('nav.rail.layers') },
    { id: 'off', label: t('nav.rail.crewBudgets'), disabled: true },
  ]
  it('tablist, selected tab, arrow keys skip disabled tabs', () => {
    const onChange = vi.fn()
    mount(<Tabs label="rail" tabs={tabs} value="summary" onChange={onChange} />)
    one(byRole(root, 'tablist'))
    const ts = byRole(root, 'tab')
    expect(ts.map((x) => x.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
    expect(ts[2].hasAttribute('disabled')).toBe(true)
    fire(ts[0], 'keydown', { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('layers')
    fire(ts[1], 'keydown', { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('summary')
  })
})

describe('Card, skeleton, list row', () => {
  for (const state of ['default', 'selected', 'dimmed'] as const) {
    it(`card ${state}: title row with code and chip`, () => {
      mount(
        <Card title={t('cards.pad.title')} code="PAD" chip="modelled" state={state}>
          <p>body</p>
        </Card>,
      )
      const card = one(byClass(root, 'hl-card'))
      expect(card.getAttribute('data-state')).toBe(state)
      expect(text(one(byClass(card, 'hl-card__title')))).toContain(t('cards.pad.title'))
      expect(text(one(byClass(card, 'hl-badge')))).toBe('PAD')
      expect(byClass(card, 'hl-chip')).toHaveLength(1)
      expect(text(card)).toContain('body')
    })
  }
  it('card loading: busy, skeleton instead of the body, label from copy', () => {
    mount(
      <Card title={t('cards.pad.title')} state="loading">
        <p>body</p>
      </Card>,
    )
    const card = one(byClass(root, 'hl-card'))
    expect(card.getAttribute('aria-busy')).toBe('true')
    expect(text(card)).not.toContain('body')
    expect(byClass(card, 'hl-skel').length).toBeGreaterThan(0)
    expect(one(byRole(card, 'status')).getAttribute('aria-label')).toBe(t('states.loading.generic', { what: t('cards.pad.title') }))
  })
  it('sidebar card skeleton: title, four readouts, details, actions', () => {
    mount(<CardSkeleton />)
    const sk = one(byClass(root, 'hl-card-skeleton'))
    expect(byClass(sk, 'hl-skel--readout')).toHaveLength(4)
    expect(sk.getAttribute('aria-busy')).toBe('true')
  })
  it('list row: button with code, label, meta; selected and disabled', () => {
    const onClick = vi.fn()
    mount(<ListRow code="S7" label={t('cards.station.title')} meta="00:44" onClick={onClick} selected chip="modelled" />)
    const row = one(byClass(root, 'hl-row'))
    expect(row.localName).toBe('button')
    expect(row.getAttribute('aria-current')).toBe('true')
    expect(text(row)).toContain('S7')
    fire(row, 'click')
    expect(onClick).toHaveBeenCalled()
    mount(<ListRow label="x" disabled onClick={onClick} />)
    expect(one(byClass(root, 'hl-row')).hasAttribute('disabled')).toBe(true)
  })
})

describe('Tooltip and popover (keyboard reachable)', () => {
  it('tooltip opens on focus and hover, closes on blur and Escape', () => {
    mount(
      <Tooltip text={t('tooltips.compass')}>
        <IconButton icon="compass" label={t('tooltips.compass')} />
      </Tooltip>,
    )
    const wrap = one(byClass(root, 'hl-tooltip-wrap'))
    expect(byRole(root, 'tooltip')).toHaveLength(0)
    fire(one(byTag(root, 'button')), 'focusin')
    const tip = one(byRole(root, 'tooltip'))
    expect(text(tip)).toBe(t('tooltips.compass'))
    expect(one(byTag(root, 'button')).getAttribute('aria-describedby')).toBe(tip.getAttribute('id'))
    fire(one(byTag(root, 'button')), 'keydown', { key: 'Escape' })
    expect(byRole(root, 'tooltip')).toHaveLength(0)
    fire(wrap, 'mouseenter')
    expect(byRole(root, 'tooltip')).toHaveLength(1)
    fire(wrap, 'mouseleave')
    expect(byRole(root, 'tooltip')).toHaveLength(0)
  })
  it('tooltip forced open (style guide)', () => {
    mount(
      <Tooltip text="tip" open>
        <span>x</span>
      </Tooltip>,
    )
    expect(byRole(root, 'tooltip')).toHaveLength(1)
  })
  it('popover: button toggles a dialog, Escape closes and returns focus, outside click closes', () => {
    mount(
      <Popover label={t('buttons.more')} title={t('cards.common.details')}>
        <p>inside</p>
      </Popover>,
    )
    const btn = one(byTag(root, 'button'))
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    fire(btn, 'click')
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    const dlg = one(byRole(root, 'dialog'))
    expect(btn.getAttribute('aria-controls')).toBe(dlg.getAttribute('id'))
    expect(text(dlg)).toContain('inside')
    fire(dlg, 'keydown', { key: 'Escape' })
    expect(byRole(root, 'dialog')).toHaveLength(0)
    expect(doc.activeElement).toBe(btn)
    fire(btn, 'click')
    expect(byRole(root, 'dialog')).toHaveLength(1)
    fire(doc.body, 'pointerdown')
    expect(byRole(root, 'dialog')).toHaveLength(0)
  })
})

describe('Banner, badge, tag', () => {
  it('info / caution / offline are status; limit (alarm) is an alert', () => {
    const cases = [
      ['info', 'status', 'icon-info'],
      ['caution', 'status', 'icon-triangle-alert'],
      ['offline', 'status', 'icon-wifi-off'],
      ['limit', 'alert', 'icon-circle-alert'],
    ] as const
    for (const [kind, role, icon] of cases) {
      mount(<Banner kind={kind} title={t('states.offline.banner')} />)
      const b = one(byClass(root, 'hl-banner'))
      expect(hasClass(b, `hl-banner--${kind}`)).toBe(true)
      expect(b.getAttribute('role')).toBe(role)
      expect(byClass(b, icon)).toHaveLength(1)
      expect(text(b)).toContain(t('states.offline.banner'))
    }
  })
  it('dismissible banner calls onDismiss from a labelled close button', () => {
    const onDismiss = vi.fn()
    mount(<Banner kind="info" title="x" onDismiss={onDismiss} />)
    const close = one(byTag(root, 'button'))
    expect(close.getAttribute('aria-label')).toBe(t('buttons.close'))
    fire(close, 'click')
    expect(onDismiss).toHaveBeenCalled()
  })
  it('badge shows a code; tag text and explanation from copy', () => {
    mount(<Badge>S7</Badge>)
    expect(text(one(byClass(root, 'hl-badge')))).toBe('S7')
    for (const kind of ['assumed', 'precomputed', 'live', 'hypotheticalTiming', 'preliminary', 'estimate', 'dummy'] as const) {
      mount(<Tag kind={kind} />)
      const tag = one(byClass(root, 'hl-tag'))
      expect(text(tag)).toBe(t(`tags.${kind}.label`))
      expect(tag.getAttribute('title')).toBe(t(`tags.${kind}.explanation`))
    }
  })
})

describe('Trust chip and provenance popover (DESIGN §3.6)', () => {
  it('five kinds, label and explanation from copy, live in the live colour class', () => {
    expect(CHIP_KINDS).toEqual(['real', 'modelled', 'simulated', 'live', 'visual'])
    for (const kind of CHIP_KINDS) {
      mount(<TrustChip kind={kind} labelled />)
      const chip = one(byClass(root, 'hl-chip'))
      expect(chip.localName).toBe('button')
      expect(hasClass(chip, `hl-chip--${kind}`)).toBe(true)
      expect(text(chip)).toBe(t(`chips.${kind}.label`))
      expect(chip.getAttribute('aria-label')).toBe(`${t(`chips.${kind}.label`)}: ${t('tooltips.chip')}`)
      expect(byClass(chip, 'hl-chip__mark')).toHaveLength(1)
    }
  })
  it('compact chip (mark only) still has an accessible name', () => {
    mount(<TrustChip kind="modelled" />)
    const chip = one(byClass(root, 'hl-chip'))
    expect(text(chip)).toBe('')
    expect(chip.getAttribute('aria-label')).toContain(t('chips.modelled.label'))
  })
  it(`shows the manifest provenance for a known key (${KEY})`, () => {
    mount(<TrustChip kind="modelled" prov={{ key: KEY, file: ENTRY.file, value: ENTRY.value }} />)
    const chip = one(byClass(root, 'hl-chip'))
    fire(chip, 'click')
    const dlg = one(byRole(root, 'dialog'))
    const body = text(dlg)
    expect(body).toContain(t('chips.popover.title'))
    expect(body).toContain(t('chips.modelled.explanation'))
    expect(body).toContain(KEY)
    expect(body).toContain(String(ENTRY.value))
    expect(body).toContain(String(ENTRY.units))
    expect(body).toContain(ENTRY.file)
    expect(body).toContain(ENTRY.script)
    expect(body).toContain(ENTRY.commit)
    expect(body).toContain(ENTRY.utc)
    for (const k of ['value', 'units', 'sourceFile', 'script', 'commit', 'time'] as const) expect(body).toContain(t(`chips.popover.${k}`))
    const link = one(byTag(dlg, 'a'))
    expect(link.getAttribute('href')).toBe(`#/scorecard?key=${encodeURIComponent(KEY)}`)
    fire(dlg, 'keydown', { key: 'Escape' })
    expect(byRole(root, 'dialog')).toHaveLength(0)
  })
  it('unbacked value: popover says so instead of inventing provenance', () => {
    mount(<ProvenanceTable prov={{ key: 'no.such.key', file: 'nowhere.json', value: 1 }} />)
    expect(text(root)).toContain(t('chips.popover.missing'))
    expect(byTag(root, 'dl')).toHaveLength(0)
  })
  it('popover forced open for the style guide', () => {
    mount(<TrustChip kind="real" open prov={{ key: KEY, file: ENTRY.file, value: ENTRY.value }} />)
    expect(byRole(root, 'dialog')).toHaveLength(1)
  })
})

describe('Readout wraps the manifest number component', () => {
  it('keeps the manifest key and provenance of <Num> (same text, link and tooltip)', () => {
    mount(<Readout label={t('cards.pad.reachable')} v={ENTRY.value as number} file={ENTRY.file} k={KEY} units="%" chip="modelled" />)
    const ro = one(byClass(root, 'hl-readout'))
    const num = one(byClass(ro, 'num'))
    expect(hasClass(num, 'num-ok')).toBe(true)
    expect(num.localName).toBe('a')
    expect(num.getAttribute('href')).toBe(`#/scorecard?key=${encodeURIComponent(KEY)}`)
    expect(num.getAttribute('title')).toContain(`manifest: ${KEY}`)
    expect(text(num)).toBe('23%') // formatValue(23.0, '%'): unchanged number formatting
    expect(text(ro)).toContain(t('cards.pad.reachable'))
    expect(byClass(ro, 'hl-chip')).toHaveLength(1)
  })
  it('range: both ends are <Num> values backed by their own keys', () => {
    const lo = MANIFEST['reachable_pct_range.nom_104.30.low'] as ManifestEntry
    const hi = MANIFEST['reachable_pct_range.nom_104.30.high'] as ManifestEntry
    mount(
      <Readout
        label="r"
        v={ENTRY.value as number}
        file={ENTRY.file}
        k={KEY}
        units="%"
        chip="modelled"
        range={{ low: { v: lo.value as number, k: 'reachable_pct_range.nom_104.30.low' }, high: { v: hi.value as number, k: 'reachable_pct_range.nom_104.30.high' } }}
      />,
    )
    const nums = byClass(root, 'num')
    expect(nums).toHaveLength(3)
    expect(nums.every((n) => hasClass(n, 'num-ok'))).toBe(true)
  })
  it('unknown: null value renders the unknown number, no tone', () => {
    mount(<Readout label="u" v={null} file={ENTRY.file} units="%" chip="modelled" tone="safe" />)
    const ro = one(byClass(root, 'hl-readout'))
    expect(ro.getAttribute('data-state')).toBe('unknown')
    expect(hasClass(one(byClass(ro, 'num')), 'num-unknown')).toBe(true)
    expect(ro.getAttribute('data-tone')).toBe(null)
  })
  it('stale and tone states; large size', () => {
    mount(<Readout label="s" v={ENTRY.value as number} file={ENTRY.file} k={KEY} units="%" chip="modelled" stale tone="caution" size="large" />)
    const ro = one(byClass(root, 'hl-readout'))
    expect(ro.getAttribute('data-state')).toBe('stale')
    expect(ro.getAttribute('data-tone')).toBe('caution')
    expect(hasClass(ro, 'hl-readout--large')).toBe(true)
  })
})

describe('Legend swatch row', () => {
  it('swatch kinds with label and optional chip; the colour is a token variable', () => {
    for (const swatch of ['fill', 'line', 'dashed', 'dense', 'hatch'] as const) {
      mount(<LegendRow swatch={swatch} color="safe" label={t('margin.comfortable')} chip="modelled" />)
      const row = one(byClass(root, 'hl-legend-row'))
      const sw = one(byClass(row, 'hl-swatch'))
      expect(hasClass(sw, `hl-swatch--${swatch}`)).toBe(true)
      expect(sw.style['--sw']).toBe('var(--color-safe)')
      expect(sw.getAttribute('aria-hidden')).toBe('true')
      expect(text(row)).toContain(t('margin.comfortable'))
      expect(byClass(row, 'hl-chip')).toHaveLength(1)
    }
  })
})

describe('every interactive component is keyboard reachable', () => {
  it('has a focusable element', () => {
    const cases: VNode[] = [
      <Button>x</Button>,
      <IconButton icon="x" label="x" />,
      <Segmented label="s" options={[{ value: 'a', label: 'a' }]} value="a" onChange={() => {}} />,
      <Toggle label="t" checked={false} onChange={() => {}} />,
      <Slider label="s" min={0} max={1} step={1} value={0} units="min" onChange={() => {}} />,
      <Select label="s" options={[{ value: 'a', label: 'a' }]} value="a" onChange={() => {}} />,
      <Tabs label="t" tabs={[{ id: 'a', label: 'a' }]} value="a" onChange={() => {}} />,
      <ListRow label="r" onClick={() => {}} />,
      <TrustChip kind="real" />,
      <Popover label="p">x</Popover>,
    ]
    for (const v of cases) {
      mount(v)
      expect(all(root, focusable).length, String(v.type)).toBeGreaterThan(0)
    }
  })
})
