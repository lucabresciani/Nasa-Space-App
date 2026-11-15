// Contextual sidebar cards (DESIGN U14, WS15 task 5, package A5). One card per selectable object,
// always the same structure (title row: code, name, chip → 2–4 key readouts → details → actions).
// Card = f(ref, data): the same ref renders the same card whether it was picked on the map, in a list
// or in search. Every number is a <Readout> (→ <Num> with its manifest key) or a <FieldReadout>
// (a field lookup, with the field file's manifest entry in its chip). ✂️ rows/actions (D69) are not built.
import type { ComponentChildren } from 'preact'
import './cards.css'
import { href } from '../../router'
import { dataUrl } from '../../env'
import { formatValue } from '../../prov/provenance'
import { getManifest } from '../../prov/store'
import { padKey, PADS_INDEX } from '../../data/pads'
import type { TimelineEvent } from '../../data/types'
import { Num } from '../../components/Num'
import { actionsFor, select, type SelectionRef } from '../../state/selection'
import { t, type CopyKey } from '../copy'
import { Button, Card, cx, Icon, ListRow, Readout, TrustChip, type ChipKind, type IconName } from '../components'
import { lowestMarginRow, OFFICIAL_PAD, timelineRow, type CardData, type LabelRow, type RouteData } from './data'
import { SimSlot } from './simslot'

// ---------------------------------------------------------------- shared pieces

const BINDING: Record<string, CopyKey> = { O2: 'binding.oxygen', daylight: 'binding.daylight', dose: 'binding.dose', 'EVA duration': 'binding.evaDuration' }
/** Binding term as interface text ("dose limit"); unknown terms are shown as written. */
export function bindingText(b: string | null | undefined): string | undefined {
  if (!b) return undefined
  return t('margin.edgeLabel', { binding: BINDING[b] ? t(BINDING[b]) : b })
}

/** Manifest entry value (budgets quoted straight from the manifest). */
function manifestValue(k: string): number | string | boolean | null {
  const e = getManifest()?.[k] as { value?: unknown } | undefined
  const v = e?.value
  return typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ? v : null
}

/**
 * A number from a field lookup (U14 "any terrain cell"; rule 5: values from field lookups only).
 * Same layout as <Readout>; the value carries data-source="field" and the field file, and the chip
 * opens the field file's manifest entry (script, commit, UTC of the PNG it was read from).
 */
export function FieldReadout({ label, v, file, units, dp = 1, chip = 'modelled', icon }: { label: string; v: number | null; file: string; units?: string; dp?: number; chip?: ChipKind; icon?: IconName }) {
  const key = fieldKey(file)
  const unknown = v === null
  return (
    <div class="hl-readout" data-state={unknown ? 'unknown' : undefined} data-source="field">
      <div class="hl-readout__label">
        {icon && <Icon name={icon} />}
        <span>{label}</span>
        <TrustChip kind={chip} prov={{ key, file, value: manifestValue(key) ?? '' }} />
      </div>
      <div class="hl-readout__value">
        <span class={cx('num', unknown ? 'num-unknown' : 'num-field')} data-source="field" data-file={file} title={`field lookup: ${file} (nearest pixel)`}>
          {formatValue(v, units, { dp })}
        </span>
      </div>
    </div>
  )
}
/** fields/nom_104/t_home.png → fields.nom_104/t_home.sha256 (the field file's manifest entry). */
export const fieldKey = (file: string): string => `${file.replace(/\.png$/, '').replace(/^fields\//, 'fields.')}.sha256`

function Readouts({ children }: { children: ComponentChildren }) {
  return <div class="hl-card__readouts">{children}</div>
}
function Details({ children }: { children: ComponentChildren }) {
  return (
    <div class="hl-cardx__details">
      <h4 class="hl-cardx__h">{t('cards.common.details')}</h4>
      {children}
    </div>
  )
}

/** Registered actions for this ref (U14 Actions column), plus static links. Nothing renders a dead button; undefined = no footer. */
function actions(sel: SelectionRef, links?: ComponentChildren): ComponentChildren | undefined {
  const acts = actionsFor(sel)
  if (!acts.length && !links) return undefined
  return (
    <>
      {acts.map((a) => (
        <Button variant="secondary" onClick={() => a.run(sel)} data-action={a.id}>
          {t(a.label)}
        </Button>
      ))}
      {links}
    </>
  )
}
function LinkButton({ to, icon, children }: { to: string; icon?: IconName; children: ComponentChildren }) {
  return (
    <a class="hl-btn hl-btn--ghost" href={to}>
      {icon && <Icon name={icon} />}
      {children}
    </a>
  )
}

function Unavailable({ what }: { what: string }) {
  return (
    <Card title={what} state="selected">
      <p class="hl-cardx__muted">{t('states.error.cannotShow', { what })}</p>
    </Card>
  )
}

// ---------------------------------------------------------------- pad / parking option

function labelFor(d: CardData, pred: (l: LabelRow) => boolean): LabelRow | undefined {
  return d.labels.find(pred)
}

export function PadCard({ sel, d }: { sel: Extract<SelectionRef, { kind: 'pad' }>; d: CardData }) {
  const sid = d.scenario.id
  const budget = d.scenario.headline.budget_min
  if (sel.id === OFFICIAL_PAD || (d.pads?.official.id === sel.id && d.pad)) {
    const p = d.pad?.pad
    if (!p) return <Unavailable what={t('cards.pad.officialTitle')} />
    const h = d.scenario.headline
    const F = 'pad.json'
    const code = labelFor(d, (l) => l.kind === 'pad' && l.ref === 'pad.json')?.code
    return (
      <Card title={t('cards.pad.officialTitle')} code={code} chip="modelled" state="selected" actions={actions(sel)}>
        <Readouts>
          <Readout label={t('cards.pad.feasibleEvas')} icon="pad" v={p.score} file={F} k="pad.score" chip="modelled" />
          <Readout
            label={t('cards.pad.reachable')}
            v={h.reachable_pct}
            units="%"
            file="scenarios/index.json"
            dp={1}
            k={`reachable_pct.${sid}.${budget}`}
            range={{ low: { v: h.range_pct[0], k: `reachable_pct_range.${sid}.${budget}.low`, dp: 1 }, high: { v: h.range_pct[1], k: `reachable_pct_range.${sid}.${budget}.high`, dp: 1 } }}
            chip="modelled"
          />
          <Readout label={t('cards.pad.elevation')} icon="mountain" v={p.elev_m} units="m" file={F} k="pad.elev_m" chip="real" />
          <Readout label={t('cards.pad.slope')} v={p.checks.max_slope_deg} units="deg" file={F} k="pad.checks.max_slope_deg" chip="modelled" />
        </Readouts>
      </Card>
    )
  }
  const opt = d.pads?.options.find((o) => o.id === sel.id)
  const s = d.padSummaries.get(sel.id)
  if (!opt || !s) return <Unavailable what={t('cards.pad.alternativeTitle')} />
  const F = `scenarios/pads/${sel.id}/summary.json`
  const h = s.headlines.find((x) => x.budget === budget) ?? null
  const code = labelFor(d, (l) => l.kind === 'pad' && l.ref === `${PADS_INDEX}#${sel.id}`)?.code
  return (
    <Card title={t('cards.pad.alternativeTitle')} code={code} subtitle={opt.label} chip="modelled" state="selected" actions={actions(sel)}>
      <Readouts>
        <Readout label={t('cards.pad.feasibleEvas')} icon="pad" v={s.score} file={F} k={padKey(sel.id, 'score')} chip="modelled" />
        {h && (
          <Readout
            label={t('cards.pad.reachable')}
            v={h.reachablePct}
            units="%"
            file={F}
            dp={1}
            k={padKey(sel.id, 'headline', h.budget, 'reachable_pct')}
            range={h.range ? { low: { v: h.range[0], k: padKey(sel.id, 'headline', h.budget, 'range_pct', 'low'), dp: 1 }, high: { v: h.range[1], k: padKey(sel.id, 'headline', h.budget, 'range_pct', 'high'), dp: 1 } } : undefined}
            chip="modelled"
          />
        )}
        <Readout label={t('cards.pad.elevation')} icon="mountain" v={s.elevM} units="m" file={F} k={padKey(sel.id, 'elev_m')} chip="real" />
      </Readouts>
    </Card>
  )
}

// ---------------------------------------------------------------- station / scored site

export function StationCard({ sel, d }: { sel: Extract<SelectionRef, { kind: 'station' }>; d: CardData }) {
  const s = d.stations.find((x) => x.id === sel.id)
  if (!s) return <Unavailable what={sel.id} />
  const sid = d.scenario.id
  const c = d.stationCards.get(s.id) ?? null
  const cf = s.card
  const onRoute = c?.on_route ?? d.official.route?.stops.includes(s.id) ?? false
  const kind = onRoute ? t('cards.station.title') : t('cards.scoredSite.title')
  const homeKey = (v: string) => `t_home_min.${s.id}.${v}`
  const [opt, con] = [sid.replace(/^nom_/, 'opt_'), sid.replace(/^nom_/, 'con_')]
  const home = (
    <Readout
      label={t('cards.station.timeHome')}
      icon="thread-home"
      v={s.t_home_min[sid] ?? null}
      units="min"
      file="stations.json"
      k={homeKey(sid)}
      range={sid.startsWith('nom_') ? { low: { v: s.t_home_min[opt] ?? null, k: homeKey(opt) }, high: { v: s.t_home_min[con] ?? null, k: homeKey(con) } } : undefined}
      chip="modelled"
    />
  )
  const subtitle = (
    <>
      {kind}
      {' · '}
      {onRoute ? t('cards.station.onRoute') : t('cards.scoredSite.notOnRoute')}
      {s.reachable_on_foot === false ? ` · ${s.reachability_label ?? t('cards.station.notReachable')}` : ''}
    </>
  )
  const err = c?.skyline_error_deg
  const navcam = c?.navcam.url_local ?? null
  return (
    <Card
      title={s.name}
      code={s.id}
      subtitle={subtitle}
      chip="modelled"
      state="selected"
      actions={actions(sel, <LinkButton to={href({ name: 'station', id: s.id })} icon="file-text">{t('cards.common.details')}</LinkButton>)}
    >
      <Readouts>
        {onRoute && c ? (
          <>
            <Readout label={t('cards.station.arrival')} icon="clock" v={c.timeline.arrive} units="min" file={cf} k={`card.${s.id}.timeline.arrive`} chip="simulated" />
            <Readout
              label={t('cards.station.turnBack')}
              icon="turn-back"
              v={c.timeline.turn_back}
              units="min"
              file={cf}
              k={`card.${s.id}.timeline.turn_back`}
              chip="simulated"
              note={bindingText(c.turn_back_binding)}
            />
            {home}
            <Readout label={t('cards.route.lowestMargin')} v={c.margin_min ?? null} units="min" file={cf} k={`card.${s.id}.margin_min`} chip="modelled" note={bindingText(c.margin_binding)} />
          </>
        ) : (
          <>
            <Readout label={t('cards.scoredSite.score')} icon="flask-conical" v={s.value} file="stations.json" k={`stations.${s.id}.value`} chip="modelled" tone="science" />
            {home}
          </>
        )}
      </Readouts>
      {(s.objective || s.tasks.length > 0 || err || navcam) && (
        <Details>
          {s.objective && (
            <p>
              <span class="hl-cardx__k">{t('cards.station.objective')}</span> {s.objective}
            </p>
          )}
          {s.tasks.length > 0 && (
            <>
              <span class="hl-cardx__k">{t('cards.station.tasks')}</span>
              <ul class="hl-cardx__list">
                {s.tasks.map((x) => (
                  <li>{x}</li>
                ))}
              </ul>
            </>
          )}
          {onRoute && <Readout label={t('cards.scoredSite.score')} icon="flask-conical" v={s.value} file="stations.json" k={`stations.${s.id}.value`} chip="modelled" tone="science" />}
          {navcam && c && (
            <figure class="hl-cardx__navcam">
              <div class="hl-cardx__photo">
                <img src={dataUrl(navcam)} alt={t('cards.station.navcam')} loading="lazy" />
                {c.navcam.overlay_png && <img class="hl-cardx__overlay" src={dataUrl(c.navcam.overlay_png)} alt="" aria-hidden="true" loading="lazy" />}
              </div>
              {c.navcam.credit && <figcaption class="hl-cardx__muted">{c.navcam.credit}</figcaption>}
            </figure>
          )}
          {err && (
            <div class="hl-card__readouts">
              {(['near', 'mid', 'far'] as const).map((band) =>
                err[band] === null ? null : (
                  <Readout label={`${t('cards.station.skylineError')} · ${band}`} v={err[band]} units="deg" file={cf} k={`skyline_error_deg.${s.id}.${band}`} chip="modelled" />
                ),
              )}
            </div>
          )}
        </Details>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------- route leg

const stopName = (s: string): string => (s === 'pad' ? t('cards.pad.title') : s)

function routeFor(d: CardData, pad: string | undefined): RouteData | undefined {
  return !pad || pad === OFFICIAL_PAD ? d.official : d.padRoutes.get(pad)
}

export function LegCard({ sel, d }: { sel: Extract<SelectionRef, { kind: 'leg' }>; d: CardData }) {
  const r = routeFor(d, sel.pad)
  const leg = r?.route?.legs.find((l) => l.leg === sel.leg)
  if (!r || !leg) return <Unavailable what={t('cards.route.title')} />
  const k = (f: string) => `${r.routeKey}.leg.${leg.leg}.${f}`
  const low = lowestMarginRow(r.timeline, leg.t_start_min ?? -Infinity, leg.t_end_min ?? Infinity)
  return (
    <Card title={t('cards.route.titleFromTo', { from: stopName(leg.from), to: stopName(leg.to) })} code={`${leg.leg}`} subtitle={t('cards.route.title')} chip="simulated" state="selected" actions={actions(sel)}>
      <Readouts>
        <Readout label={t('cards.route.distance')} icon="ruler" v={leg.length_m} units="m" file={r.routeFile} k={k('length_m')} chip="modelled" />
        <Readout label={t('cards.route.time')} icon="timer" v={leg.t_min} units="min" file={r.routeFile} k={k('t_min')} chip="modelled" />
        <Readout label={t('cards.route.oxygen')} v={leg.o2_L} units="L" file={r.routeFile} k={k('o2_L')} chip="modelled" />
        {low && <Readout label={t('cards.route.lowestMargin')} v={low.e.margin_min} units="min" file={r.timelineFile} k={`${r.timelineKey}.${low.i}.margin_min`} chip="modelled" note={bindingText(low.e.margin_binding)} />}
      </Readouts>
    </Card>
  )
}

// ---------------------------------------------------------------- any terrain cell

const STATE_TEXT: Record<string, CopyKey> = { assessed: 'cards.cell.assessed', blocked: 'cards.cell.blocked', unknown: 'cards.cell.unknown', outside: 'cards.cell.unknown' }

export function CellCard({ sel, d }: { sel: Extract<SelectionRef, { kind: 'cell' }>; d: CardData }) {
  const hit = d.cell(sel.lon, sel.lat)
  if (!hit) return <Unavailable what={t('cards.cell.title')} />
  const { sample: f, suitKg } = hit
  const file = (v: string, what: string) => `fields/${v}_${suitKg}/${what}.png`
  const state = f.state ?? (f.inside ? null : 'outside')
  return (
    <Card title={t('cards.cell.title')} chip="modelled" chipProv={{ key: fieldKey(file('nom', 't_home')), file: file('nom', 't_home'), value: manifestValue(fieldKey(file('nom', 't_home'))) ?? '' }} state="selected" actions={actions(sel)}>
      <Readouts>
        <FieldReadout label={t('cards.cell.timeHomeNominal')} icon="thread-home" v={f.tHome.nom} units="min" file={file('nom', 't_home')} />
        <FieldReadout label={t('cards.cell.timeHomeConservative')} v={f.tHome.con} units="min" file={file('con', 't_home')} />
        <FieldReadout label={t('cards.cell.oxygenHome')} v={f.o2Home} units="L" file={file('nom', 'o2_home')} />
      </Readouts>
      <Details>
        <p>
          <span class="hl-cardx__k">{t('cards.cell.cellState')}</span> {state ? t(STATE_TEXT[state] ?? 'cards.cell.unknown') : t('cards.cell.unknown')}
        </p>
        {f.unknown && <p class="hl-cardx__muted">{t('margin.unknown')}</p>}
      </Details>
    </Card>
  )
}

// ---------------------------------------------------------------- homeline edge segment

const CAUSE_TEXT: Record<string, CopyKey> = { physiology: 'cards.homelineEdge.physiology', slope: 'cards.homelineEdge.slope', data: 'cards.homelineEdge.data' }

export function EdgeCard({ sel }: { sel: Extract<SelectionRef, { kind: 'edge' }>; d: CardData }) {
  return (
    <Card title={t('cards.homelineEdge.title')} chip="modelled" state="selected" actions={actions(sel)}>
      <p>
        <span class="hl-cardx__k">{t('cards.homelineEdge.cause')}</span> {t(CAUSE_TEXT[sel.cause])}
      </p>
    </Card>
  )
}

// ---------------------------------------------------------------- landmark

export function LandmarkCard({ sel, d }: { sel: Extract<SelectionRef, { kind: 'landmark' }>; d: CardData }) {
  const l = d.labels.find((x) => x.kind === 'landmark' && x.code === sel.code)
  if (!l) return <Unavailable what={t('cards.landmark.title')} />
  const F = 'labels.json'
  return (
    <Card
      title={l.name}
      code={l.code}
      subtitle={l.status === 'official' ? t('cards.landmark.official') : t('cards.landmark.informal')}
      chip="real"
      state="selected"
      actions={actions(sel)}
    >
      <Readouts>
        <Readout label={t('cards.landmark.bearing')} icon="compass" v={l.bearing_deg ?? null} units="deg" file={F} k={`labels.${l.code}.bearing_deg`} chip="real" />
        <Readout label={t('cards.landmark.distance')} icon="ruler" v={l.dist_m ?? null} units="m" file={F} k={`labels.${l.code}.dist_m`} chip="real" />
      </Readouts>
    </Card>
  )
}

// ---------------------------------------------------------------- nothing selected: route summary

function arrival(r: RouteData, station: string): { i: number; e: TimelineEvent } | null {
  const i = timelineRow(r.timeline, 'arrive', station)
  return i < 0 || !r.timeline ? null : { i, e: r.timeline[i] }
}

export function RouteSummaryCard({ d }: { d: CardData }) {
  const r = d.official
  const route = r.route
  if (!route) {
    return (
      <Card title={t('cards.routeSummary.title')} chip="simulated">
        <p class="hl-cardx__muted">{t('cards.routeSummary.noRoute')}</p>
        <SimSlot />
      </Card>
    )
  }
  const low = lowestMarginRow(r.timeline)
  const stations = route.stops.filter((s) => s !== 'pad')
  return (
    <Card title={t('cards.routeSummary.title')} chip="simulated" chipProv={{ key: `${r.routeKey}.total_min`, file: r.timelineFile, value: route.endMin }}>
      <h4 class="hl-cardx__h">{t('cards.routeSummary.totals')}</h4>
      <Readouts>
        <Readout label={t('cards.route.time')} icon="timer" v={route.endMin} units="min" file={r.timelineFile} k={`${r.routeKey}.total_min`} chip="simulated" />
        {low && (
          <Readout label={t('cards.route.lowestMargin')} v={low.e.margin_min} units="min" file={r.timelineFile} k={`${r.timelineKey}.${low.i}.margin_min`} chip="modelled" note={bindingText(low.e.margin_binding)} />
        )}
      </Readouts>
      <h4 class="hl-cardx__h">{t('cards.routeSummary.budgets')}</h4>
      <Readouts>
        <Readout label={t('cards.route.oxygen')} v={manifestValue('margin.o2_budget_L')} units="L" file="scenarios/index.json" k="margin.o2_budget_L" chip="simulated" />
        <Readout label={t('timeline.evaTime')} icon="clock" v={manifestValue('clock.eva.eva_min')} units="min" file="conditions/clock.json" k="clock.eva.eva_min" chip="simulated" />
      </Readouts>
      <h4 class="hl-cardx__h">{t('cards.routeSummary.stationsInOrder')}</h4>
      <ol class="hl-cardx__rows">
        {stations.map((id) => {
          const a = arrival(r, id)
          const st = d.stations.find((s) => s.id === id)
          return (
            <li>
              <ListRow
                code={id}
                label={st?.name ?? id}
                chip="simulated"
                meta={a ? <Num v={a.e.t_min} units="min" file={r.timelineFile} k={`${r.timelineKey}.${a.i}.t_min`} /> : undefined}
                onClick={() => select({ kind: 'station', id }, 'list')}
              />
            </li>
          )
        })}
      </ol>
      <SimSlot />
    </Card>
  )
}

// ---------------------------------------------------------------- dispatch

/** The card for `sel` (null = nothing selected: route configuration). Pure: same ref + data → same card. */
export function SelectionCard({ sel, d }: { sel: SelectionRef | null; d: CardData }) {
  if (!sel) return <RouteSummaryCard d={d} />
  switch (sel.kind) {
    case 'pad':
      return <PadCard sel={sel} d={d} />
    case 'station':
      return <StationCard sel={sel} d={d} />
    case 'leg':
      return <LegCard sel={sel} d={d} />
    case 'cell':
      return <CellCard sel={sel} d={d} />
    case 'edge':
      return <EdgeCard sel={sel} d={d} />
    case 'landmark':
      return <LandmarkCard sel={sel} d={d} />
  }
}
