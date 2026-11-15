// /styleguide (DESIGN U0 item 3, §3, §9 visual regression target; WS15 task 2). Unlinked dev page,
// lazy-loaded by main.ts like #/spike: it is the only place that loads tokens.css, the fonts and the
// component styles for now, so the first load of every other route is unchanged.
// Every number on this page is either a manifest entry (rendered through <Readout>/<Num>, keeping its
// key and provenance), a config value, or a token value / contrast ratio computed from tokens.json.
// Section titles and state names below are developer text for this page; component labels use t().
import '../tokens.css'
import '../fonts/fonts.css'
import '../components/components.css'
import './styleguide.css'
import type { ComponentChildren } from 'preact'
import { useState } from 'preact/hooks'
import hudRaw from '../../../../config/hud.yaml'
import { CONFIG, cfg } from '../../config'
import type { ManifestEntry } from '../../data/types'
import { Num } from '../../components/Num'
import { formatValue } from '../../prov/provenance'
import { getManifest } from '../../prov/store'
import type { Mode } from '../../state/ui'
import { preactView } from '../../views/page'
import { MIN_RATIO, tokenContrast, USED_PAIRS } from '../contrast'
import { t } from '../copy'
import { ICON_NAMES } from '../icons/icons'
import { TOKENS, type ColorToken } from '../tokens'
import {
  Badge,
  Banner,
  Button,
  Card,
  CardSkeleton,
  CHIP_KINDS,
  Icon,
  IconButton,
  LegendRow,
  ListRow,
  ModeSwitch,
  Popover,
  Readout,
  Segmented,
  Select,
  Slider,
  Tabs,
  Tag,
  Toggle,
  Tooltip,
  TrustChip,
  type ButtonVariant,
  type ForcedState,
  type ReadoutTone,
} from '../components'

const CUSTOM_MARKS = ['pad', 'station', 'scored-site', 'user-point', 'turn-back', 'tripwire', 'fix', 'thread-home', 'rover', 'crew'] as const

/** Manifest keys shown on this page (real published values; nothing typed by hand). */
const KEYS = {
  reach: 'reachable_pct.nom_104.30',
  reachLow: 'reachable_pct_range.nom_104.30.low',
  reachHigh: 'reachable_pct_range.nom_104.30.high',
  tHomeS7: 't_home_min.S7.nom_104',
  marginStart: 'timeline.nom_104.0.margin_min',
  marginDose: 'route.nom_104.dose.lowest_dose_margin_min',
  marginEnd: 'timeline.nom_104.20.margin_min',
} as const

const AMBER_MIN = cfg<number>(hudRaw, 'margin_amber_min')

function entry(k: string): ManifestEntry | undefined {
  const e = getManifest()?.[k]
  return e && typeof e === 'object' ? (e as ManifestEntry) : undefined
}

/** Margin tone from the value and config/hud.yaml margin_amber_min (DESIGN §3.1 meanings). */
function marginTone(v: unknown): ReadoutTone | undefined {
  if (typeof v !== 'number') return undefined
  return v < 0 ? 'limit' : v < AMBER_MIN ? 'caution' : 'safe'
}

function Section({ id, title, children, note }: { id: string; title: string; children: ComponentChildren; note?: string }) {
  return (
    <section class="sg-section" id={`sg-${id}`} aria-labelledby={`sg-${id}-h`}>
      <h2 id={`sg-${id}-h`}>{title}</h2>
      {note && <p class="sg-note">{note}</p>}
      {children}
    </section>
  )
}

function StateGrid({ states, render }: { states: string[]; render: (s: string) => ComponentChildren }) {
  return (
    <div class="sg-states">
      {states.map((s) => (
        <div class="sg-state">
          <div class="sg-state__name">{s}</div>
          <div class="sg-state__demo">{render(s)}</div>
        </div>
      ))}
    </div>
  )
}

const FORCED: (ForcedState | undefined)[] = [undefined, 'hover', 'focus', 'active']
const stateName = (f: ForcedState | undefined) => f ?? 'default'

function MRead(props: { k: string; label: string; chip?: 'modelled' | 'real' | 'simulated'; tone?: ReadoutTone; stale?: boolean; large?: boolean; range?: boolean }) {
  const e = entry(props.k)
  if (!e) return <Readout label={props.label} v={null} file="manifest.json" chip={props.chip ?? 'modelled'} />
  const lo = props.range ? entry(KEYS.reachLow) : undefined
  const hi = props.range ? entry(KEYS.reachHigh) : undefined
  return (
    <Readout
      label={props.label}
      v={e.value as number}
      file={e.file}
      k={props.k}
      units={e.units}
      chip={props.chip ?? 'modelled'}
      tone={props.tone}
      stale={props.stale}
      size={props.large ? 'large' : 'default'}
      range={lo && hi ? { low: { v: lo.value as number, k: KEYS.reachLow, file: lo.file }, high: { v: hi.value as number, k: KEYS.reachHigh, file: hi.file } } : undefined}
    />
  )
}

function ChipsSection() {
  const e = entry(KEYS.reach)
  return (
    <Section id="chips" title="Trust chips and provenance popover (§3.6)">
      <StateGrid
        states={['labelled', 'compact']}
        render={(s) => (
          <div class="sg-row">
            {CHIP_KINDS.map((k) => (
              <TrustChip kind={k} labelled={s === 'labelled'} />
            ))}
          </div>
        )}
      />
      <StateGrid
        states={FORCED.map(stateName)}
        render={(s) => (
          <div class="sg-row">
            <TrustChip kind="modelled" labelled force={s === 'default' ? undefined : (s as ForcedState)} />
            <TrustChip kind="live" labelled force={s === 'default' ? undefined : (s as ForcedState)} />
          </div>
        )}
      />
      <div class="sg-popover-demo">
        <div class="sg-state__name">open, manifest key {KEYS.reach}</div>
        {e && <TrustChip kind="modelled" labelled open prov={{ key: KEYS.reach, file: e.file, value: e.value }} />}
      </div>
    </Section>
  )
}

function ReadoutSection() {
  const ms = entry(KEYS.marginStart)
  const md = entry(KEYS.marginDose)
  const me = entry(KEYS.marginEnd)
  return (
    <Section id="readouts" title="Number readouts (wrap <Num>: manifest key and provenance kept)">
      <div class="sg-grid sg-grid--readouts">
        <MRead k={KEYS.reach} label={t('cards.pad.reachable')} large range />
        <MRead k={KEYS.tHomeS7} label={t('cards.station.timeHome')} />
        <MRead k={KEYS.marginStart} label={t('glossary.margin')} tone={marginTone(ms?.value)} />
        <MRead k={KEYS.marginDose} label={t('glossary.margin')} tone={marginTone(md?.value)} />
        <MRead k={KEYS.marginEnd} label={t('glossary.margin')} tone={marginTone(me?.value)} />
        <MRead k={KEYS.tHomeS7} label={t('cards.station.timeHome')} stale />
        <Readout label={t('cards.pad.elevation')} v={null} file="pad.json" units="m" chip="real" />
      </div>
      <p class="sg-note">
        Tones follow the value and margin_amber_min from config/hud.yaml; no published margin is below zero, so the limit tone is shown only in the alarm banner. States shown: large with range,
        default, safe, safe, caution, stale, unknown.
      </p>
    </Section>
  )
}

const VARIANT_LABEL: Record<ButtonVariant, () => string> = {
  primary: () => t('buttons.computeFullPlan'),
  secondary: () => t('buttons.focus'),
  ghost: () => t('buttons.cancel'),
  danger: () => t('buttons.discard'),
  live: () => t('glossary.computedLive'),
}

function ButtonSection() {
  const states = ['default', 'hover', 'focus', 'active', 'disabled', 'busy']
  return (
    <Section id="buttons" title="Buttons and icon buttons">
      <table class="sg-table">
        <thead>
          <tr>
            <th>variant</th>
            {states.map((s) => (
              <th>{s}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(Object.keys(VARIANT_LABEL) as ButtonVariant[]).map((v) => (
            <tr>
              <th>{v}</th>
              {states.map((s) => (
                <td>
                  <Button
                    variant={v}
                    icon={v === 'secondary' ? 'crosshair' : undefined}
                    force={['hover', 'focus', 'active'].includes(s) ? (s as ForcedState) : undefined}
                    disabled={s === 'disabled'}
                    busy={s === 'busy'}
                  >
                    {VARIANT_LABEL[v]()}
                  </Button>
                </td>
              ))}
            </tr>
          ))}
          <tr>
            <th>icon</th>
            {states.map((s) => (
              <td>
                <div class="sg-row">
                  <IconButton icon="play" label={t('buttons.play')} force={['hover', 'focus', 'active'].includes(s) ? (s as ForcedState) : undefined} disabled={s === 'disabled'} />
                  {s === 'default' && <IconButton icon="layers" label={t('nav.rail.layers')} pressed />}
                </div>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </Section>
  )
}

function ControlsSection() {
  const [mode, setMode] = useState<Mode>('plan')
  const [variant, setVariant] = useState('nom')
  const [on, setOn] = useState(true)
  const budgets = CONFIG.walkbackBudgetsMin
  const [budget, setBudget] = useState(budgets[0])
  const [tab, setTab] = useState('summary')
  const variants = [
    { value: 'opt', label: t('variants.optimistic') },
    { value: 'nom', label: t('variants.nominal') },
    { value: 'con', label: t('variants.conservative') },
  ]
  const budgetOpts = budgets.map((b) => ({ value: String(b), label: formatValue(b, 'min') }))
  const tabs = [
    { id: 'summary', label: t('nav.rail.summary') },
    { id: 'crew', label: t('nav.rail.crewBudgets') },
    { id: 'route', label: t('nav.rail.stationsRoute') },
    { id: 'layers', label: t('nav.rail.layers'), disabled: true },
  ]
  const f = (s: string) => (['hover', 'focus', 'active'].includes(s) ? (s as ForcedState) : undefined)
  const states = ['default', 'hover', 'focus', 'active', 'disabled']
  return (
    <Section id="controls" title="Mode switch, segmented control, toggle, slider, select, tabs">
      <StateGrid states={['default', 'hover', 'focus']} render={(s) => <ModeSwitch value={mode} onChange={setMode} force={f(s)} />} />
      <StateGrid states={states} render={(s) => <Segmented label={t('glossary.homeline')} options={variants} value={variant} onChange={setVariant} force={f(s)} disabled={s === 'disabled'} />} />
      <StateGrid
        states={['off', 'on', 'hover', 'focus', 'disabled']}
        render={(s) => (
          <Toggle
            label={t('layers.relief.name')}
            checked={s === 'off' ? false : s === 'on' ? true : on}
            onChange={setOn}
            force={f(s)}
            disabled={s === 'disabled'}
          />
        )}
      />
      <StateGrid
        states={['default', 'hover', 'focus', 'disabled']}
        render={(s) => <Slider label={t('tooltips.budgetSlider')} min={budgets[0]} max={budgets[budgets.length - 1]} step={budgets[1] - budgets[0]} value={budget} units="min" onChange={setBudget} force={f(s)} disabled={s === 'disabled'} />}
      />
      <StateGrid
        states={['default', 'hover', 'focus', 'disabled']}
        render={(s) => <Select label={t('glossary.walkback')} options={budgetOpts} value={String(budget)} onChange={(v) => setBudget(Number(v))} force={f(s)} disabled={s === 'disabled'} />}
      />
      <StateGrid states={['default', 'hover', 'focus']} render={(s) => <Tabs label={t('nav.rail.summary')} tabs={tabs} value={tab} onChange={setTab} force={f(s)} />} />
      <p class="sg-note">Values: walkback budgets from config/crew.yaml walkback_budgets_min. The last tab is disabled.</p>
    </Section>
  )
}

function CardsSection() {
  const st = CONFIG.stationsPlan
  const th = (id: string) => entry(`t_home_min.${id}.nom_104`)
  const meta = (id: string) => {
    const e = th(id)
    return e ? <Num v={e.value as number} file={e.file} k={`t_home_min.${id}.nom_104`} units={e.units} /> : undefined
  }
  const body = (
    <div class="hl-card__readouts">
      <MRead k={KEYS.tHomeS7} label={t('cards.station.timeHome')} />
      <MRead k={KEYS.marginDose} label={t('glossary.margin')} tone={marginTone(entry(KEYS.marginDose)?.value)} />
    </div>
  )
  const s7 = st.find((s) => s.id === 'S7') ?? st[0]
  return (
    <Section id="cards" title="Cards, sidebar card skeleton, list rows">
      <div class="sg-grid sg-grid--cards">
        {(['default', 'selected', 'dimmed', 'loading'] as const).map((state) => (
          <div>
            <div class="sg-state__name">{state}</div>
            <Card
              title={s7.name}
              code={s7.id}
              chip="modelled"
              subtitle={t('cards.station.title')}
              state={state}
              actions={
                <>
                  <Button icon="box">{t('buttons.openIn3d')}</Button>
                  <Button variant="ghost" icon="crosshair">
                    {t('buttons.focus')}
                  </Button>
                </>
              }
            >
              {body}
            </Card>
          </div>
        ))}
        <div>
          <div class="sg-state__name">sidebar skeleton</div>
          <CardSkeleton />
        </div>
      </div>
      <StateGrid
        states={['default', 'hover', 'focus', 'active', 'selected', 'disabled']}
        render={(s) => {
          const x = st[['default', 'hover', 'focus', 'active', 'selected', 'disabled'].indexOf(s) % st.length]
          return <ListRow code={x.id} label={x.name} meta={meta(x.id)} chip="modelled" force={['hover', 'focus', 'active'].includes(s) ? (s as ForcedState) : undefined} selected={s === 'selected'} disabled={s === 'disabled'} onClick={() => {}} />
        }}
      />
    </Section>
  )
}

function OverlaySection() {
  return (
    <Section id="overlays" title="Tooltip and popover (open)">
      <div class="sg-row sg-row--overlays">
        <Tooltip text={t('tooltips.compass')} open placement="bottom">
          <IconButton icon="compass" label={t('tooltips.compass')} />
        </Tooltip>
        <span class="sg-spacer" />
        <Popover label={t('buttons.more')} title={t('cards.common.details')} open>
          <p class="sg-p">{t('glossary.marginHint')}</p>
          <div class="sg-row">
            <Button>{t('buttons.dismiss')}</Button>
          </div>
        </Popover>
      </div>
    </Section>
  )
}

function BannerSection() {
  return (
    <Section id="banners" title="Banners, badges, tags">
      <div class="sg-stack">
        <Banner kind="info" title={t('tags.hypotheticalTiming.label')}>
          {t('tags.hypotheticalTiming.explanation')}
        </Banner>
        <Banner kind="caution" title={t('alarms.partner')} />
        <Banner kind="offline" title={t('states.offline.banner')} onDismiss={() => {}} />
        <Banner kind="limit" title={t('alarms.turnBack')}>
          {t('alarms.positionUncertain')}
        </Banner>
      </div>
      <div class="sg-row sg-row--wrap">
        {CONFIG.stationsPlan.map((s) => (
          <Badge>{s.id}</Badge>
        ))}
        <Badge>PAD</Badge>
      </div>
      <div class="sg-row sg-row--wrap">
        {(['assumed', 'precomputed', 'live', 'hypotheticalTiming', 'preliminary', 'estimate', 'dummy'] as const).map((k) => (
          <Tag kind={k} />
        ))}
      </div>
    </Section>
  )
}

function LegendSection() {
  return (
    <Section id="legend" title="Legend swatch rows (§3.1 second cues)">
      <div class="sg-legend">
        <LegendRow swatch="fill" color="safe" label={`${t('margin.comfortable')} · ${t('variants.nominal')}`} chip="modelled" />
        <LegendRow swatch="dense" color="safe" label={`${t('margin.comfortable')} · ${t('variants.conservative')}`} chip="modelled" />
        <LegendRow swatch="dashed" color="safe" label={`${t('margin.comfortable')} · ${t('variants.optimistic')}`} chip="modelled" />
        <LegendRow swatch="fill" color="caution" label={t('margin.caution', { amber_min: AMBER_MIN })} chip="modelled" />
        <LegendRow swatch="fill" color="limit" label={t('margin.limit')} chip="modelled" />
        <LegendRow swatch="hatch" color="unknown" label={t('margin.unknown')} chip="real" />
        <LegendRow swatch="fill" color="science" label={t('layers.mineral.name')} chip="real" />
        <LegendRow swatch="line" color="select" label={t('edit.ghost')} />
        <LegendRow swatch="line" color="live" label={t('glossary.computedLive')} chip="live" />
      </div>
    </Section>
  )
}

const COLOR_USE: Partial<Record<ColorToken, string>> = {
  bg: 'app background',
  sidebar: 'rails and sidebar',
  card: 'cards and panels',
  cardBorder: 'card border',
  text: 'text',
  textMuted: 'secondary text',
  textFaint: 'disabled, UI parts only',
  shadow: 'relief shadow (map only)',
  light: 'relief lit side (map only)',
  select: 'selection, focus, labels',
  safe: 'comfortable margin',
  caution: 'margin under amber',
  limit: 'below zero, alarms, blocked',
  science: 'science targets',
  live: 'computed live',
  unknown: 'no 1 m terrain (hatch)',
  labelPill: 'map label pill',
}

function ratioCell(fg: ColorToken, bg: ColorToken) {
  const hex = /^#[0-9a-f]{6}$/i
  if (!hex.test(TOKENS.color[fg]) || !hex.test(TOKENS.color[bg])) return <td>—</td>
  const r = tokenContrast(fg, bg)
  const cls = r >= MIN_RATIO.text ? 'sg-pass' : r >= MIN_RATIO.ui ? 'sg-large' : 'sg-fail'
  return <td class={cls}>{r.toFixed(2)}</td>
}

function ColourSection() {
  const names = Object.keys(TOKENS.color) as ColorToken[]
  const surfaces: ColorToken[] = ['bg', 'sidebar', 'card']
  return (
    <Section id="colours" title="Colour tokens and contrast (WCAG ratio on each surface)" note="Ratio ≥ 4.5 text (green mark), ≥ 3 large text and UI parts only (grey), below 3 decoration only (struck). USED_PAIRS in ui/contrast.ts are tested.">
      <table class="sg-table sg-colours">
        <thead>
          <tr>
            <th>token</th>
            <th>value</th>
            <th>use</th>
            {surfaces.map((s) => (
              <th>on {s}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {names.map((n) => (
            <tr>
              <th>
                <span class="sg-chipcolor" style={{ '--c': `var(--color-${n.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()})` }} />
                {n}
              </th>
              <td class="sg-mono">{TOKENS.color[n]}</td>
              <td>{COLOR_USE[n]}</td>
              {surfaces.map((s) => ratioCell(n, s))}
            </tr>
          ))}
        </tbody>
      </table>
      <p class="sg-note">{USED_PAIRS.length} pairs used by the components are checked in vitest (contrast.test.ts).</p>
    </Section>
  )
}

function TypeSection() {
  const roles: [string, string, string][] = [
    ['display', 'sg-t-display', t('nav.wordmark')],
    ['heading', 'sg-t-heading', t('modes.plan.question')],
    ['body', 'sg-t-body', t('glossary.homelineHint', { budget_min: CONFIG.walkbackBudgetsMin[0] })],
    ['small / label', 'sg-t-small', t('cards.common.keyNumbers')],
    ['map label', 'sg-t-map', t('layers.ridges.name')],
  ]
  const e = entry(KEYS.reach)
  return (
    <Section id="type" title="Type scale (§3.2: Inter, JetBrains Mono, self-hosted)">
      <table class="sg-table">
        <tbody>
          {roles.map(([name, cls, sample]) => (
            <tr>
              <th>{name}</th>
              <td class={cls}>{sample}</td>
            </tr>
          ))}
          {e && (
            <>
              <tr>
                <th>readout</th>
                <td class="sg-t-readout">
                  <Num v={e.value as number} file={e.file} k={KEYS.reach} units={e.units} />
                </td>
              </tr>
              <tr>
                <th>readout large</th>
                <td class="sg-t-readout-large">
                  <Num v={e.value as number} file={e.file} k={KEYS.reach} units={e.units} />
                </td>
              </tr>
            </>
          )}
        </tbody>
      </table>
    </Section>
  )
}

function SpaceSection() {
  return (
    <Section id="space" title="Spacing (4 px grid), radius, lines, motion">
      <div class="sg-space">
        {TOKENS.space.map((px, i) => (
          <div class="sg-space__row">
            <span class="sg-mono">space-{i}</span>
            <span class="sg-space__bar" style={{ width: `var(--space-${i})` }} />
            <span class="sg-mono">{px} px</span>
          </div>
        ))}
      </div>
      <div class="sg-row sg-row--wrap">
        {(Object.keys(TOKENS.radius) as (keyof typeof TOKENS.radius)[]).map((r) => (
          <div class="sg-radius" style={{ borderRadius: `var(--radius-${r})` }}>
            radius-{r} · {TOKENS.radius[r]} px
          </div>
        ))}
      </div>
      <table class="sg-table">
        <tbody>
          {Object.entries(TOKENS.line).map(([k, v]) => (
            <tr>
              <th>line.{k}</th>
              <td class="sg-mono">{v} px</td>
            </tr>
          ))}
          {Object.entries(TOKENS.motion).map(([k, v]) => (
            <tr>
              <th>motion.{k}</th>
              <td class="sg-mono">{Array.isArray(v) ? `${v[0]}–${v[1]} ms` : `${v} ms`} (0 under reduced motion)</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  )
}

function IconSection() {
  return (
    <Section id="icons" title={`Icon sprite (${ICON_NAMES.length} symbols: Lucide, ISC, plus custom marks)`}>
      <div class="sg-icons">
        {ICON_NAMES.map((n) => (
          <div class="sg-icon">
            <Icon name={n} />
            <span>{n}</span>
          </div>
        ))}
      </div>
      <h3>Custom marks at 16, 24 and 32 px</h3>
      <div class="sg-marks">
        {CUSTOM_MARKS.map((n) => (
          <div class="sg-mark">
            <Icon name={n} class="sg-16" />
            <Icon name={n} class="sg-24" />
            <Icon name={n} class="sg-32" />
            <span>{n}</span>
          </div>
        ))}
      </div>
    </Section>
  )
}

export function Styleguide() {
  return (
    <div class="hl-ui hl-sg">
      <header class="sg-head">
        <h1>{t('nav.views.styleguide')}</h1>
        <p class="sg-note">WS15 components in every state (DESIGN §3). Copy deck and mockups are provisional (D73). Numbers on this page are manifest entries or config values.</p>
      </header>
      <div class="sg-cols">
        <div class="sg-col">
          <ChipsSection />
          <ReadoutSection />
          <ButtonSection />
          <BannerSection />
          <OverlaySection />
        </div>
        <div class="sg-col">
          <ControlsSection />
          <CardsSection />
          <LegendSection />
        </div>
      </div>
      <ColourSection />
      <TypeSection />
      <SpaceSection />
      <IconSection />
    </div>
  )
}

export const view = preactView(() => <Styleguide />)
