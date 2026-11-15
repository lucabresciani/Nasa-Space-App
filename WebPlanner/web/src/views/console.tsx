// "/" planning console (F17): map + side panel. Default view per SPEC F17: basemap, 30-min nominal
// band, edge causes, stations; everything else behind toggles. Budget slider (F5), scenario picker (F6),
// D21 "Rover parking options" (scenarios/pads/, optional: hidden without its index).
import { render, type ComponentChildren } from 'preact'
import { useEffect, useMemo, useState } from 'preact/hooks'
import { CITED, CONFIG } from '../config'
import { data } from '../data/loader'
import { accessFor } from '../data/access'
import { unknownMaskField } from '../data/fields'
import { partnerLabel } from '../data/partner'
import { headlineFor, loadPadsIndex, padFiles, padKey, padViewMode, parsePadSummary, PADS_INDEX, type PadOption, type PadsIndexLoad, type PadsIndexView, type PadSummaryView } from '../data/pads'
import type { BandsFC, EdgesFC, IsochroneFC, PartnerFC, RouteFC, ScenarioEntry, ScenariosIndex, Station, TimelineEvent } from '../data/types'
import { dataUrl } from '../env'
import { ConsoleMap, DEFAULT_VISIBLE, type LayerGroup } from '../map/consoleMap'
import { BASEMAP_CREDIT, basemapSources } from '../map/basemap'
import { loadAlpha } from '../map/hatch'
import { padInUse, padMarker, padProposal, type PadInUse, type PadMarkerInfo, type PadProposal } from '../map/pad'
import { binEdges, binLabelsFor } from '../map/legend'
import { isochroneMinutes, keyStep, snapMinutes, uniformStep } from '../map/slider'
import { href } from '../router'
import { THEME } from '../theme'
import { AssumedTag, DataProblem, DummyNote } from '../components/labels'
import { CfgNum, Num } from '../components/Num'
import { select } from '../state/selection'
import { DragNote } from '../components/DragNote'
import { PadBlockLabel, PadInUseText } from '../components/PadInUse'
import { ensureManifest } from './common'
import { routeSummary, type RouteLeg } from './route'
import { EXCLUDED_NOTE, STORM_TIMING_NOTE, headline60, homeFor, marginLabel, tightestMargin, turnBacks } from './decisions'
import { CellSlopeNote, PlanningRuleNote } from '../components/DecisionNotes'
import { choosePlanScenario, mission, resolvePlanScenario } from '../state/mission'
import { useSignalValue } from '../state/signal'
import type { View } from './types'

const LAYER_LABELS: Record<LayerGroup, string> = {
  basemap: 'Basemap',
  bands: 'Homeline band',
  unknown: 'Unknown terrain (hatched)',
  edges: 'Edge causes',
  stations: 'Stations and pad',
  slider: 'Budget slider (isochrones)',
  route: 'Planned route',
  partner: 'Partner line (cart haul)', // replaced by partner.geojson `label` (D20) once loaded
  siting: 'F8 heatmap',
}

const NO_ISOCHRONES: IsochroneFC = { type: 'FeatureCollection', features: [] }

export const view: View = async (el) => {
  el.innerHTML = `<div class="console"><div class="console-map"></div><aside class="console-panel"></aside></div>`
  const mapEl = el.querySelector<HTMLElement>('.console-map')!
  const panelEl = el.querySelector<HTMLElement>('.console-panel')!
  await ensureManifest()
  const cmap = new ConsoleMap(mapEl, (id) => {
    select({ kind: 'station', id }, 'map') // U14: same card as the list and search
    location.hash = href({ name: 'station', id })
  })
  render(<ConsolePanel cmap={cmap} />, panelEl)
  // Live pad tool (D48, WS13 U2; team lead D81): lazy, only in builds with VITE_LIVE=1.
  let alive = true
  let disposeLive: (() => void) | undefined
  // X3 (e2e H5-2): the live aside gets the side panel's fixed width, so its text never resizes the map.
  const liveAside = () => Object.assign(panelEl.parentElement!.appendChild(document.createElement('aside')), { className: 'console-panel console-live' })
  if (import.meta.env.VITE_LIVE === '1') void import('../live').then((m) => { if (alive) disposeLive = m.padTool(liveAside(), m.consoleMapPort(cmap)) })
  return () => {
    alive = false
    disposeLive?.()
    render(null, panelEl)
    cmap.destroy()
  }
}

export function findScenario(idx: ScenariosIndex, variant: string, suit: number): ScenarioEntry | undefined {
  return idx.scenarios.find((s) => s.variant === variant && s.suit_kg === suit)
}

function ConsolePanel({ cmap }: { cmap: ConsoleMap }) {
  const L = data()
  const [idx, setIdx] = useState<ScenariosIndex | null>(null)
  const [stations, setStations] = useState<Station[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  // The current plan lives in the mission state (WS15 A3): it survives route changes.
  const scenarioId = useSignalValue(mission.plan.scenario) ?? null
  const budget = useSignalValue(mission.plan.budgetMin)
  const setBudget = (b: number) => (mission.plan.budgetMin.value = b)
  const [sliderMin, setSliderMin] = useState<number>(CONFIG.walkbackBudgetsMin[0])
  const [isoMinutes, setIsoMinutes] = useState<number[]>([])
  const [visible, setVisible] = useState<Record<LayerGroup, boolean>>({ ...DEFAULT_VISIBLE })
  const [notes, setNotes] = useState<Partial<Record<LayerGroup, ComponentChildren>>>({})
  const [padInfo, setPadInfo] = useState<PadMarkerInfo | null>(null)
  const [proposal, setProposal] = useState<PadProposal | null>(null)
  const [padUse, setPadUse] = useState<PadInUse | null>(null)
  const [sitingShown, setSitingShown] = useState(false)
  const [partner, setPartner] = useState<PartnerFC | null>(null)
  // Route + timeline with the manifest key prefix they were loaded for (X3, e2e H5-6): after a pad or
  // scenario switch the old route is never rendered under the new keys while the new files load.
  const [routeData, setRouteData] = useState<{ key: string; route: RouteFC | null; timeline: TimelineEvent[] | null } | null>(null)
  const [credit, setCredit] = useState<string | null>(null)
  // D21 parking options: null = the official pad (pad.json, existing paths).
  const [pads, setPads] = useState<PadsIndexLoad | null>(null)
  const padSel = useSignalValue(mission.plan.pad)
  const setPadSel = (id: string | null) => (mission.plan.pad.value = id)
  const [padSummary, setPadSummary] = useState<PadSummaryView | null>(null)
  const [padError, setPadError] = useState<unknown>(null)

  const note = (k: LayerGroup, v: ComponentChildren) => setNotes((n) => ({ ...n, [k]: v }))

  // Static layers: index, pad, stations, unknown mask.
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const i = await L.scenarios()
        if (!alive) return
        setIdx(i)
        // the stored plan if the index has it, else the index default (else the first entry)
        choosePlanScenario(resolvePlanScenario(i))
      } catch (e) {
        if (alive) setError(e)
        return
      }
      // The pad in use: pad.json `pad` (contract v1.1.2: = pad_default, F8 rule evaluated there), else
      // config/site.yaml pad_default. The F8 siting result is a proposal only: siting.png + siting_png.json
      // + the pad.json `proposal` block.
      let pad = padMarker(null, CONFIG.padDefault)
      let pp: PadProposal | null = null
      let pu: PadInUse | null = null
      try {
        const pf = await L.optional(() => L.pad())
        pad = padMarker(pf, CONFIG.padDefault)
        pp = padProposal(pf)
        pu = padInUse(pf)
      } catch (e) {
        note('stations', `pad.json: ${e instanceof Error ? e.message : String(e)}`)
      }
      try {
        const sp = await L.optional(() => L.sitingPng())
        if (!alive) return
        setProposal(pp)
        setPadUse(pu)
        setSitingShown(!!sp)
        if (sp || pp) {
          await cmap.setSiting(
            sp ? { url: dataUrl(sp.image), coordinates: sp.coordinates } : null,
            pp ? { lon: pp.lon, lat: pp.lat, title: 'Top F8 siting score (D21 picks the official pad by feasible EVAs, not by this score)', alternatives: pp.alternatives } : null,
          )
        }
        note('siting', sp ? '' : 'siting_png.json not available yet')
      } catch (e) {
        note('siting', `siting_png.json: ${e instanceof Error ? e.message : String(e)}`)
      }
      if (!alive) return
      setPadInfo(pad)
      cmap.setPad({ lon: pad.lon, lat: pad.lat, label: 'Pad', title: pad.title })
      try {
        const st = await L.stations()
        if (!alive) return
        setStations(st)
        cmap.fitTo([...st, pad])
      } catch (e) {
        note('stations', e instanceof Error ? e.message : String(e))
      }
      // Basemap (F17): tiles/basemap/tilejson.json (contract v1.1.0).
      try {
        const tj = await L.optional(() => L.tilejson())
        if (!alive) return
        if (!tj) {
          note('basemap', 'tiles/basemap/tilejson.json not available yet: plain background')
        } else {
          const src = basemapSources(tj, (p) => dataUrl(p))
          await cmap.setBasemap(src)
          if (!alive) return
          setCredit(tj.attribution ?? BASEMAP_CREDIT)
          note('basemap', `HiRISE colour ortho, z${tj.minzoom}–${tj.maxzoom}${tj.zoom_bounds ? ` (z${Object.keys(tj.zoom_bounds).join('/z')} near the stations)` : ''}`)
        }
      } catch (e) {
        note('basemap', e instanceof Error ? e.message : String(e))
      }
      // Hatched unknowns (F1): terrain/cellstate.png alpha (A = 0 unknown, contract v1.1.0);
      // without it, the alpha of the shared slope field (SPEC §6.1).
      try {
        const cs = await L.optional(() => L.cellstate())
        if (!alive) return
        if (cs) {
          const a = await loadAlpha(dataUrl(cs.image))
          if (!alive) return
          if (a.width !== cs.width || a.height !== cs.height) return note('unknown', `${cs.image} is ${a.width}×${a.height}, cellstate.json says ${cs.width}×${cs.height}`)
          await cmap.setUnknownMask({ ...a, bounds: cs.bounds })
          if (!alive) return
          const pct = cs.pct?.unknown
          if (alive)
            note(
              'unknown',
              <>
                F1 cell states, {cs.res_m} m cells; unknown{' '}
                {pct === undefined ? '(share not given)' : <Num v={pct} units="%" file="terrain/cellstate.json" k="terrain.cellstate.pct.unknown" />}
                {pct === 0 ? ' (nothing to hatch: every cell is HiRISE-assessed)' : ''}
              </>,
            )
          return
        }
        const fi = await L.optional(() => L.fieldsIndex())
        if (!alive) return
        const g = fi && unknownMaskField(fi)
        if (!g) return note('unknown', fi ? 'no cell states and no shared slope field' : 'terrain/cellstate.json not available yet')
        const a = await loadAlpha(dataUrl(g.file))
        if (!alive) return
        if (a.width !== g.width || a.height !== g.height) return note('unknown', `${g.file} is ${a.width}×${a.height}, index says ${g.width}×${g.height}`)
        await cmap.setUnknownMask({ ...a, bounds: g.bounds })
        if (alive) note('unknown', `from ${g.file} (A = 0; no terrain/cellstate.json)`)
      } catch (e) {
        if (alive) note('unknown', e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // D21 picker index (optional): missing, or not yet covered by a contract row -> no picker.
  useEffect(() => {
    let alive = true
    void loadPadsIndex(L).then((r) => {
      if (alive) setPads(r)
    })
    return () => {
      alive = false
    }
  }, [])
  const padIndex: PadsIndexView | null = pads?.state === 'ok' ? pads.index : null

  const scenario = useMemo(() => idx?.scenarios.find((s) => s.id === scenarioId) ?? null, [idx, scenarioId])
  const nominal = useMemo(() => idx?.scenarios.find((s) => s.id === idx.default) ?? null, [idx])
  const padF = padSel && nominal ? padFiles(padSel, nominal) : null
  const mode = padViewMode(padSel)

  // Parking-option markers (official pad excluded: it is the "Pad" marker); click selects.
  useEffect(() => {
    if (!padIndex) return
    cmap.setPadOptions(
      padIndex.options
        .filter((o) => !o.official && o.lon !== null && o.lat !== null)
        .map((o) => ({ id: o.id, lon: o.lon!, lat: o.lat!, label: o.label, title: `Rover parking option ${o.label} (scenarios/pads/index.json): click to switch the bands, route and partner line`, selected: o.id === padSel })),
      (id) => pickPad(id),
    )
  }, [padIndex, padSel])

  // Science points, access cells and walk-in lines depend on the scenario (WS2 access per scenario).
  useEffect(() => {
    if (stations && scenario) void cmap.setStations(stations, scenario.id)
  }, [stations, scenario])

  // Scenario layers.
  useEffect(() => {
    if (!scenario) return
    let alive = true
    const pf = padSel && nominal ? padFiles(padSel, nominal) : null
    ;(async () => {
      if (pf && padSel) {
        // D21 parking option: its own bands, edges, partner line, route and summary; no isochrones.
        setPadSummary(null)
        setPadError(null)
        try {
          const [bands, edges, partner, sum] = await Promise.all([L.json<BandsFC>(pf.bands), L.json<EdgesFC>(pf.edges), L.json<PartnerFC>(pf.partner), L.json<unknown>(pf.summary)])
          if (!alive) return
          setPadSummary(parsePadSummary(sum, padSel))
          await cmap.setScenarioData({ bands, isochrones: NO_ISOCHRONES, edges, partner, variant: nominal!.variant })
          setPartner(partner)
          setIsoMinutes([])
        } catch (e) {
          if (alive) setPadError(e)
        }
      } else {
        setPadSummary(null)
        setPadError(null)
        try {
          const [bands, isochrones, edges, partner] = await Promise.all([L.bands(scenario), L.isochrones(scenario), L.edges(scenario), L.partner(scenario)])
          if (!alive) return
          await cmap.setScenarioData({ bands, isochrones, edges, partner, variant: scenario.variant })
          setPartner(partner)
          const mins = isochroneMinutes(isochrones)
          setIsoMinutes(mins)
          setSliderMin((v) => snapMinutes(mins, v) ?? v)
          setError(null)
        } catch (e) {
          if (alive) setError(e)
        }
      }
      if (!alive) return
      const routeFile = pf ? pf.route : `route_${scenario.id}.geojson`
      const key = pf && padSel ? padKey(padSel, 'route') : `route.${scenario.id}` // = routeProps.routeKey
      try {
        const r = await L.optional(() => (pf ? L.json<RouteFC>(pf.route) : L.route(scenario.id)))
        if (!alive) return
        const tl = r ? await L.optional(() => (pf ? L.json<TimelineEvent[]>(pf.timeline) : L.timeline(scenario.id))) : null
        if (!alive) return
        setRouteData({ key, route: r, timeline: tl })
        await cmap.setRoute(r)
        if (alive) note('route', r ? (routeSummary(r) ? '' : `${routeFile} has no legs (no reachable station)`) : `no ${routeFile}`)
      } catch (e) {
        if (!alive) return
        setRouteData({ key, route: null, timeline: null })
        await cmap.setRoute(null)
        if (alive) note('route', e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [scenario, padSel])

  useEffect(() => cmap.setBudget(budget), [budget])
  useEffect(() => cmap.setSliderMinutes(sliderMin), [sliderMin])

  const toggle = (g: LayerGroup, on: boolean) => {
    cmap.setVisible(g, on)
    setVisible((v) => ({ ...v, [g]: on }))
  }

  /** D21: null = the official pad. A parking option is nominal at the default suit and has no isochrones. */
  function pickPad(id: string | null) {
    if (id !== null) toggle('slider', false)
    setPadSel(id)
  }
  // A parking option runs on the default scenario only (nominal, its suit).
  useEffect(() => {
    if (padSel && idx && scenarioId !== idx.default) {
      const d = idx.scenarios.find((s) => s.id === idx.default)
      if (d) choosePlanScenario(d)
      else mission.plan.scenario.value = idx.default
    }
  }, [padSel, idx])

  if (error && !idx) {
    return (
      <div class="panel-body">
        <h2>Planning console</h2>
        <DataProblem error={error} what="Scenarios" />
      </div>
    )
  }
  if (!idx || !scenario) return <div class="panel-body muted">Loading…</div>

  const pick = (variant: string, suit: number) => {
    const s = findScenario(idx, variant, suit)
    if (s) choosePlanScenario(s)
  }
  const h = scenario.headline
  const hb = h.budget_min
  const defaultPartnerFile = idx.scenarios.find((s) => s.id === idx.default)?.files.partner ?? null
  const partnerFile = padF ? padF.partner : scenario.files.partner
  const routeProps = padF && padSel
    ? { label: `parking option ${padIndex?.options.find((o) => o.id === padSel)?.label ?? padSel}`, routeFile: padF.route, timelineFile: padF.timeline, routeKey: padKey(padSel, 'route'), timelineKey: padKey(padSel, 'timeline') }
    : { label: scenario.id, routeFile: `route_${scenario.id}.geojson`, timelineFile: `timeline_${scenario.id}.json`, routeKey: `route.${scenario.id}`, timelineKey: `timeline.${scenario.id}` }
  const label = (g: LayerGroup) => (g === 'partner' ? partnerLabel(partner) : LAYER_LABELS[g])
  const rd = routeData?.key === routeProps.routeKey ? routeData : null

  return (
    <div class="panel-body">
      <DummyNote />
      {error != null && <DataProblem error={error} what="Scenario layers" />}

      {padSel && padF ? (
        <PadHeadline id={padSel} summary={padSummary?.id === padSel ? padSummary : null} file={padF.summary} budget={budget} error={padError} />
      ) : (
        <section class="headline">
          <div class="headline-value">
            <Num v={h.reachable_pct} units="%" file="scenarios/index.json" k={`reachable_pct.${scenario.id}.${hb}`} />
          </div>
          <div class="headline-text">
            reachable of the <i>assessed</i> flat disc within {hb} min.
            <br />
            Range <Num v={h.range_pct[0]} units="%" file="scenarios/index.json" k={`reachable_pct_range.${scenario.id}.${hb}.low`} /> (conservative) to{' '}
            <Num v={h.range_pct[1]} units="%" file="scenarios/index.json" k={`reachable_pct_range.${scenario.id}.${hb}.high`} /> (optimistic)
            {padIndex && (
              <>
                <br />
                Official pad: <Num v={padIndex.official.score} file={PADS_INDEX} k={padKey(padIndex.official.id, 'score')} /> feasible EVAs (frozen, D42).
              </>
            )}
          </div>
          <Headline60 entry={scenario} />
        </section>
      )}

      {padIndex && nominal && <PadPicker index={padIndex} selected={padSel} onPick={pickPad} suitKg={nominal.suit_kg} />}

      <RouteSection {...routeProps} route={rd?.route ?? null} timeline={rd?.timeline ?? null} loading={!rd} shown={visible.route} onShow={(on) => toggle('route', on)} />

      <section>
        <h3>Scenario</h3>
        <div class="seg" role="radiogroup" aria-label="Variant">
          {CONFIG.variantNames.map((v) => {
            const ok = mode.scenarioPicker && !!findScenario(idx, v, scenario.suit_kg)
            return (
              <button type="button" role="radio" aria-checked={scenario.variant === v} class={scenario.variant === v ? 'on' : ''} disabled={!ok} onClick={() => pick(v, scenario.suit_kg)}>
                {v}
              </button>
            )
          })}
        </div>
        <div class="seg" role="radiogroup" aria-label="Suit mass">
          {CONFIG.suitMassesKg.map((kg) => {
            const ok = mode.scenarioPicker && !!findScenario(idx, scenario.variant, kg)
            return (
              <button
                type="button"
                role="radio"
                aria-checked={scenario.suit_kg === kg}
                class={scenario.suit_kg === kg ? 'on' : ''}
                disabled={!ok}
                onClick={() => pick(scenario.variant, kg)}
                title={ok ? '' : mode.scenarioPicker ? 'scenario not in scenarios/index.json' : 'parking options are computed at the nominal suit only'}
              >
                {kg} kg suit
              </button>
            )
          })}
        </div>
        <p class="caption">
          Scenario <code>{scenario.id}</code>. Combinations not in <code>scenarios/index.json</code> are disabled.
          {CONFIG.suitMassesKg[0] === 80 && <> The 80 kg suit is our sensitivity value.</>}
          {!mode.scenarioPicker && <> Locked to <code>{scenario.id}</code> while a parking option is selected (options are computed for it only).</>}
        </p>
      </section>

      <section>
        <h3>Walkback budget</h3>
        <div class="seg" role="radiogroup" aria-label="Walkback budget">
          {CONFIG.bandBudgetsMin.map((b) => (
            <button type="button" role="radio" aria-checked={budget === b} class={budget === b ? 'on' : ''} onClick={() => setBudget(b)}>
              {b} min
            </button>
          ))}
        </div>
        <p class="caption">NASA is <i>considering</i> a 30- or 60-min walkback; neither is a rule.</p>
        {mode.slider ? (
          <>
            <label class="toggle">
              <input type="checkbox" checked={visible.slider} onChange={(e) => toggle('slider', (e.target as HTMLInputElement).checked)} />
              Budget slider (0–{CONFIG.isochroneMinutes.max} min)
            </label>
            {visible.slider && isoMinutes.length > 0 && (
              <BudgetSlider values={isoMinutes} value={sliderMin} onChange={setSliderMin} file={scenario.files.isochrones} scenarioId={scenario.id} />
            )}
          </>
        ) : (
          <p class="caption slider-off">Budget slider off: no isochrones are computed for parking options. Select the official pad to use it.</p>
        )}
      </section>

      <section>
        <h3>Layers</h3>
        {(Object.keys(LAYER_LABELS) as LayerGroup[])
          .filter((g) => g !== 'slider')
          .map((g) => (
            <label class="toggle">
              <input type="checkbox" checked={visible[g]} onChange={(e) => toggle(g, (e.target as HTMLInputElement).checked)} />
              {label(g)}
              {notes[g] ? <span class="muted"> · {notes[g]}</span> : null}
            </label>
          ))}
      </section>

      <Legend
        visible={visible}
        budget={budget}
        variant={scenario.variant}
        minutes={isoMinutes}
        pad={padInfo}
        credit={credit}
        partner={visible.partner ? { fc: partner, label: partnerLabel(partner), file: partnerFile, defaultFile: defaultPartnerFile } : null}
        proposal={visible.siting ? proposal : null}
        padOptions={!!padIndex}
      />

      {padUse && (
        <section>
          <h3>Rover pad</h3>
          <PadInUseText u={padUse} />
        </section>
      )}

      {visible.siting && <PadProposalSection p={proposal} heatmap={sitingShown} pad={padInfo} />}

      <section>
        <h3>Stations</h3>
        {stations ? (
          <table class="mini">
            <thead>
              <tr>
                <th>Station</th>
                <th class="r" title="Straight-line walk-in from the access cell to the science point (not modelled)">
                  Walk-in
                </th>
                <th class="r" title="Walk home from the access cell, this scenario">
                  Home
                </th>
              </tr>
            </thead>
            <tbody>
              {stations.map((s) => {
                const a = accessFor(s, scenario.id)
                return (
                  <tr>
                    <td>
                      <a href={href({ name: 'station', id: s.id })} onClick={() => select({ kind: 'station', id: s.id }, 'list')}>
                        <b>{s.id}</b> {s.name}
                      </a>
                      {s.reachability_label ? <span class="muted"> · {s.reachability_label}</span> : null}
                    </td>
                    <td class="r">
                      {a.state === 'access' ? (
                        <Num v={a.dist_m} units="m" file={a.file} k={`${a.keyPrefix}.dist_m`} />
                      ) : a.state === 'none' ? (
                        <span class="num-unknown" title={a.reason ?? ''}>
                          none
                        </span>
                      ) : (
                        <span class="num-unknown">unknown</span>
                      )}
                    </td>
                    <td class="r">
                      <HomeCell s={s} sid={scenario.id} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <p class="muted">{notes.stations || 'Loading…'}</p>
        )}
        {stations && padSel && (
          <p class="caption">
            <b>Official pad:</b> the walk-home times, access cells and station cards are for the official pad, not the selected parking option.
          </p>
        )}
        {stations && (
          <p class="caption">
            Access-cell rule: each station keeps its science point (filled marker); the route ends at the nearest walkable cell within{' '}
            <CfgNum v={CITED.accessRadiusM.value} units="m" source={CITED.accessRadiusM.source} /> (open circle, dotted walk-in line; radius decided, D27). The walk-in
            leg is not modelled.
            {stations.some((s) => homeFor(s, scenario.id).kind === 'unreachable') && (
              <>
                {' '}
                <b>
                  {stations
                    .filter((s) => homeFor(s, scenario.id).kind === 'unreachable')
                    .map((s) => s.id)
                    .join(', ')}
                </b>
                : {CITED.unreachableLabel.value} in <code>{scenario.id}</code> (no access cell within the radius with a walk home; hover for WS2's reason). Shown as is
                (D46).
              </>
            )}
          </p>
        )}
      </section>
    </div>
  )
}

/**
 * Budget slider over the contours that exist (isochrones.geojson `minutes`): the range input runs
 * over their indices, so dragging, clicking and the arrow keys always land on a real contour.
 */
function BudgetSlider({ values, value, onChange, file, scenarioId }: { values: number[]; value: number; onChange: (v: number) => void; file: string; scenarioId: string }) {
  const v = snapMinutes(values, value) ?? values[0]
  const i = values.indexOf(v)
  const step = uniformStep(values)
  const onKey = (e: KeyboardEvent) => {
    const nv = keyStep(values, v, e.key, THEME.isoBinStepMin)
    if (nv === null) return
    e.preventDefault()
    if (nv !== v) onChange(nv)
  }
  return (
    <div class="slider">
      <input
        type="range"
        min={0}
        max={values.length - 1}
        step={1}
        value={i}
        onInput={(e) => onChange(values[+(e.target as HTMLInputElement).value] ?? v)}
        onKeyDown={onKey}
        aria-label="Isochrone minutes"
        aria-valuetext={`${v} min`}
      />
      <span class="slider-value">{v} min</span>
      <span class="caption slider-steps">
        Where the crew can be and still walk home within {v} min. Contours {values[0]}–{values[values.length - 1]} min,{' '}
        {step !== null ? (
          <>
            <Num v={step} units="min" file={file} k={`isochrone_step_min.${scenarioId}`} /> steps
            {step === CONFIG.isochroneFallbackStepMin && step !== CONFIG.isochroneMinutes.step ? ' (size fallback; config/variants.yaml isochrone_fallback_step_min)' : ''}
          </>
        ) : (
          `${values.length} contours`
        )}{' '}
        (<code>{file}</code>).
      </span>
    </div>
  )
}

function Swatch({ kind, color, dashed }: { kind: 'fill' | 'line' | 'hatch' | 'dot' | 'ring' | 'pad'; color?: string; dashed?: boolean }) {
  return <span class={`sw sw-${kind}${dashed ? ' sw-dashed' : ''}`} style={color ? { '--c': color } : undefined} />
}

function Legend(p: {
  visible: Record<LayerGroup, boolean>
  budget: number
  variant: string
  minutes: number[]
  pad: PadMarkerInfo | null
  credit: string | null
  partner: { fc: PartnerFC | null; label: string; file: string; defaultFile: string | null } | null
  proposal: PadProposal | null
  padOptions: boolean
}) {
  const v = p.visible
  const edges = binEdges(CONFIG.isochroneMinutes.max, THEME.isoBinStepMin) // same bins as the map colour ramp
  return (
    <section class="legend">
      <h3>Legend</h3>
      <ul>
        {v.basemap && (
          <li>
            {p.credit ? (
              <>
                Basemap: HiRISE colour ortho <span class="muted">({p.credit})</span>
              </>
            ) : (
              <>
                <Swatch kind="fill" color={THEME.mapBackground} /> Basemap not available: plain background
              </>
            )}
          </li>
        )}
        {v.bands && (
          <>
            <li>
              <Swatch kind="fill" color={THEME.variant.conservative} /> {p.budget}-min homeline, conservative (inner; no-go{' '}
              <CfgNum v={CITED.nogoConservativeDeg.value} units="deg" source={CITED.nogoConservativeDeg.source} />, D23)
            </li>
            <li>
              <Swatch kind="fill" color={THEME.variant.optimistic} /> … optimistic only (outer)
            </li>
            <li>
              <Swatch kind="line" color={THEME.variant[p.variant] ?? THEME.variant.nominal} /> {p.variant} contour (selected scenario, bold)
            </li>
          </>
        )}
        {v.edges &&
          (['physiology', 'slope', 'data'] as const).map((c) => (
            <li>
              <Swatch kind="line" color={THEME.cause[c]} /> edge set by <b>{THEME.causeLabel[c]}</b>: {THEME.causeHelp[c]}
              {c === 'slope' && <CellSlopeNote />}
            </li>
          ))}
        {v.unknown && (
          <li>
            <Swatch kind="hatch" /> unknown terrain: never routed, left out of every percentage
          </li>
        )}
        {v.slider &&
          binLabelsFor(edges, p.minutes).map(({ i, label }) => (
            <li>
              <Swatch kind="line" color={THEME.isoRamp[i]} /> isochrone {label}
            </li>
          ))}
        {v.stations && (
          <li>
            <Swatch kind="dot" color={THEME.station} /> science point (click for its card) · <Swatch kind="ring" color={THEME.station} /> access cell, dotted walk-in ·{' '}
            <Swatch kind="pad" /> rover pad
            {p.pad ? <span class="muted"> ({p.pad.sourceLabel})</span> : null}
          </li>
        )}
        {v.stations && p.padOptions && (
          <li>
            <span class="pad-option">#2</span>
            <span>rover parking option (click to select; outlined = selected)</span>
          </li>
        )}
        {v.route && (
          <li>
            <Swatch kind="line" color={THEME.route} dashed /> planned route (simulated EVA)
          </li>
        )}
        {p.partner && (
          <li>
            <Swatch kind="line" color={THEME.partner} dashed /> <b>{p.partner.label}</b>: where one astronaut can still haul a downed crewmate home by cart. <i>{CONFIG.haulPartnerCaption}</i>{' '}
            <AssumedTag />
            <DragNote fc={p.partner.fc} file={p.partner.file} defaultFile={p.partner.defaultFile} />
          </li>
        )}
        {v.siting && (
          <li>
            <Swatch kind="fill" color="#bbbbbb" /> F8 heatmap: siting score per candidate block (grey; white = highest)
            {p.proposal ? (
              <>
                {' '}
                · <span class="pad-marker pad-proposal">F8?</span> top F8 score · <span class="pad-alt">#2</span> next F8 ranks
              </>
            ) : null}
            . The official pad is chosen by feasible EVAs (D21), not by this score.
          </li>
        )}
      </ul>
    </section>
  )
}

/** F9 route (simulated EVA): stop order from the route legs, times from the timeline (manifest-backed). */
function RouteSection(p: {
  /** What the route belongs to (scenario id, or the parking option). */
  label: string
  routeFile: string
  timelineFile: string
  /** Manifest key prefixes: route.{sid} / timeline.{sid}, or pads.{id}.route / pads.{id}.timeline (D21). */
  routeKey: string
  timelineKey: string
  route: RouteFC | null
  timeline: TimelineEvent[] | null
  /** The route files for this key are still loading. */
  loading?: boolean
  shown: boolean
  onShow: (on: boolean) => void
}) {
  const r = routeSummary(p.route)
  const tf = p.timelineFile
  if (p.loading) {
    return (
      <section>
        <h3>Planned route</h3>
        <p class="muted">Loading the route for {p.label}…</p>
      </section>
    )
  }
  if (!r) {
    return (
      <section>
        <h3>Planned route</h3>
        <p class="muted">
          No route for {p.label}
          {p.route ? ' (no reachable station)' : ''}.
        </p>
      </section>
    )
  }
  const tl = p.timeline ?? []
  const tight = tightestMargin(tl)
  const tb = turnBacks(tl)
  const at = (event: string, station: string | null) => {
    const i = tl.findIndex((e) => e.event === event && e.station === station)
    return i < 0 ? null : <Num v={tl[i].t_min} units="min" file={tf} k={`${p.timelineKey}.${i}.t_min`} />
  }
  return (
    <section>
      <h3>
        Planned route <span class="tag tag-simulated">simulated EVA</span>
      </h3>
      <ol class="route-stops">
        {r.stops.map((st, i) => {
          const first = i === 0
          const last = i === r.stops.length - 1
          const t = first ? at('depart', null) : last ? at('return', null) : at('arrive', st)
          return (
            <li>
              {st === 'pad' ? 'Pad' : <a href={href({ name: 'station', id: st })}>{st}</a>}
              {t ? <span class="muted"> · {first ? 'depart' : last ? 'back' : 'arrive'} </span> : null}
              {t}
            </li>
          )
        })}
      </ol>
      <RouteLegs file={p.routeFile} keyPrefix={p.routeKey} legs={r.legs} />
      <p>
        Total <Num v={r.endMin} units="min" file={tf} k={`${p.routeKey}.total_min`} />{' '}
        <label class="toggle inline">
          <input type="checkbox" checked={p.shown} onChange={(e) => p.onShow((e.target as HTMLInputElement).checked)} /> show on map
        </label>
      </p>
      {tight && (
        <p>
          Tightest margin <Num v={tight.e.margin_min} units="min" file={tf} k={`${p.timelineKey}.${tight.i}.margin_min`} /> ({marginLabel(tight.e.margin_binding)}
          {tight.e.station ? `, ${tight.e.event} ${tight.e.station}` : ''})
          {tight.dose && <span class="muted"> · {STORM_TIMING_NOTE}</span>}
        </p>
      )}
      {tb.length > 0 && <TurnBackTable rows={tb} file={tf} keyPrefix={p.timelineKey} />}
      <p class="caption">
        <PlanningRuleNote />
      </p>
    </section>
  )
}

/**
 * Route legs (F9) from route_{scenario}.geojson; manifest keys {prefix}.leg.{i}.* (WS2, i = the 1-based `leg`).
 * Units sit in the header so the table fits the 340 px side panel.
 */
function RouteLegs({ file, keyPrefix, legs }: { file: string; keyPrefix: string; legs: RouteLeg[] }) {
  const rf = file
  const k = (l: RouteLeg, f: string) => `${keyPrefix}.leg.${l.leg}.${f}`
  const name = (s: string) => (s === 'pad' ? 'Pad' : s)
  return (
    <table class="mini route-legs">
      <thead>
        <tr>
          <th>Leg</th>
          <th class="r">
            Walk <span class="unit">min</span>
          </th>
          <th class="r">
            Dist. <span class="unit">m</span>
          </th>
          <th class="r">
            O₂ <span class="unit">L</span>
          </th>
          <th class="r" title="Straight walk-in from the access cell to the science point at the leg's end (not modelled)">
            Walk-in <span class="unit">m</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {legs.map((l) => (
          <tr>
            <td>
              {name(l.from)}→{name(l.to)}
            </td>
            <td class="r">
              <Num v={l.t_min} file={rf} k={k(l, 't_min')} />
            </td>
            <td class="r">
              <Num v={l.length_m} file={rf} k={k(l, 'length_m')} />
            </td>
            <td class="r">
              <Num v={l.o2_L} file={rf} k={k(l, 'o2_L')} />
            </td>
            <td class="r">{l.to === 'pad' ? <span class="muted">–</span> : <Num v={l.to_access_dist_m} file={rf} k={k(l, 'to_access_dist_m')} />}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** F8 heatmap (siting.png) + the pad.json `proposal` block (F8 top score, contract pad v1.1.2); D21 chooses the pad by feasible EVAs instead. */
function PadProposalSection({ p, heatmap, pad }: { p: PadProposal | null; heatmap: boolean; pad: PadMarkerInfo | null }) {
  const F = 'pad.json'
  const b = CONFIG.walkbackBudgetsMin[0]
  const ak = (rank: number, f: string) => `pad.proposal.alternatives.${rank}.${f}`
  return (
    <section>
      <h3>F8 heatmap</h3>
      <p>
        {heatmap ? 'Grey heatmap: the F8 siting score of each candidate block (white = highest).' : 'siting.png is not in this tree: no heatmap.'} D21 (user, 14 Nov
        16:14): the official pad is the candidate with the most feasible EVAs, not the top F8 score; see Rover parking options. The pad in use is{' '}
        {pad?.file ? 'pad.json' : 'config/site.yaml pad_default'}.
      </p>
      {p ? (
        <>
          <p>
            Top F8 score at <Num v={p.lon} file={F} k="pad.proposal.lon" />, <Num v={p.lat} file={F} k="pad.proposal.lat" />, elevation{' '}
            <Num v={p.elevM} units="m" file={F} k="pad.proposal.elev_m" />: score <Num v={p.score} file={F} k="pad.proposal.score" />
            {p.stations.length > 0 && <> (stations within the conservative {b}-min walk home: {p.stations.join(', ')})</>}; <PadBlockLabel />{' '}
            <Num v={p.maxSlopeDeg} units="deg" file={F} k="pad.proposal.checks.max_slope_deg" />; {b}-min disc{' '}
            {p.assessedPct === null ? (
              <b>not assessed</b>
            ) : (
              <>
                assessed <Num v={p.assessedPct} units="%" file={F} k="pad.proposal.checks.assessed_pct_30min" />
              </>
            )}
            ; pad rule {p.ruleLabel}.
          </p>
          {p.checksNote ? (
            <p class="caption">Why: {p.checksNote}.</p>
          ) : (
            p.assessedPct === null && <p class="caption">The disc check is null in pad.json (no reason given).</p>
          )}
          {p.tie && (
            <p>
              <b>Tie:</b> <Num v={p.tie.nAtTop} file={F} k="pad.proposal.tie.n_blocks_at_top_score" /> of{' '}
              <Num v={p.tie.nCandidates} file={F} k="pad.proposal.tie.n_candidate_blocks" /> candidate blocks share the top score{' '}
              <Num v={p.tie.topScore} file={F} k="pad.proposal.tie.top_score" />: the rule cannot tell them apart
              {p.tie.tiebreak ? <>; the tiebreak alone picks rank 1 ({p.tie.tiebreak})</> : null}.
            </p>
          )}
          {p.ranked.length > 0 && (
            <table class="mini">
              <thead>
                <tr>
                  <th>Rank</th>
                  <th class="r">Lon, lat</th>
                  <th class="r">Score</th>
                </tr>
              </thead>
              <tbody>
                {p.ranked.map((a) => (
                  <tr>
                    <td title={a.isProposal ? 'rank 1 = the top F8 score' : 'F8 rank'}>
                      #{a.rank}
                      {a.isProposal ? '*' : ''}
                    </td>
                    <td class="r">
                      <Num v={a.lon} file={F} k={ak(a.rank, 'lon')} />, <Num v={a.lat} file={F} k={ak(a.rank, 'lat')} />
                    </td>
                    <td class="r">
                      <Num v={a.score} file={F} k={ak(a.rank, 'score')} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {p.ranked.some((a) => a.isProposal) && <p class="caption">* the top F8 score (rank 1).</p>}
          {!p.tie && p.tied && <p class="caption">Every listed alternative has the proposal's score: the rule cannot tell the candidates apart.</p>}
          {p.noAccess.length > 0 && (
            <p class="caption">
              Not scored (no access cell with a walk home in this scenario):{' '}
              {p.noAccess.map(([sid, why], i) => (
                <>
                  {i > 0 ? '; ' : ''}
                  {sid}: {why}
                </>
              ))}
              .
            </p>
          )}
          {p.rule && <p class="caption">Rule: {p.rule}.</p>}
        </>
      ) : (
        <p class="caption">pad.json carries no F8 result block: only the heatmap is shown.</p>
      )}
    </section>
  )
}

/** Headline of a D21 parking option (scenarios/pads/{id}/summary.json, keys pads.{id}.*). */
function PadHeadline({ id, summary, file, budget, error }: { id: string; summary: PadSummaryView | null; file: string; budget: number; error: unknown }) {
  if (error != null) return <DataProblem error={error} what={`Parking option ${id}`} />
  if (!summary) return <section class="headline muted">Loading parking option…</section>
  const h = headlineFor(summary, budget)
  const k = (...p: (string | number)[]) => padKey(id, ...p)
  return (
    <section class="headline">
      <div class="headline-value">{h ? <Num v={h.reachablePct} units="%" file={file} k={k('headline', h.budget, 'reachable_pct')} /> : <span class="num-unknown">–</span>}</div>
      <div class="headline-text">
        {h ? (
          <>
            reachable of the <i>assessed</i> flat disc within {h.budget} min{h.inData ? ' (of the part inside the terrain data)' : ''}, from this parking option.
            {h.range && (
              <>
                <br />
                Range <Num v={h.range[0]} units="%" file={file} k={k('headline', h.budget, 'range_pct', 'low')} /> (conservative) to{' '}
                <Num v={h.range[1]} units="%" file={file} k={k('headline', h.budget, 'range_pct', 'high')} /> (optimistic)
              </>
            )}
            {h.inData && h.inDataPct !== null && (
              <>
                <br />
                <b>
                  <Num v={h.inDataPct} units="%" file={file} k={k('headline', h.budget, 'in_data_pct')} /> of the circle lies inside the terrain data
                </b>
              </>
            )}
          </>
        ) : (
          <>no headline in {file}</>
        )}
        <br />
        Feasible EVAs: <Num v={summary.score} file={file} k={k('score')} />
        {summary.excluded !== null && (
          <>
            {' '}
            · combinations excluded by the planning rule: at most <Num v={summary.excluded} file={file} k={k('feasible', 'excluded_by_effort_cap_rule')} />
          </>
        )}
      </div>
    </section>
  )
}

/** Tiebreak values to print: an elevation tiebreak equal to the Elev. column is not repeated. */
const shownTiebreaks = (o: PadOption) => o.tiebreak.filter(([n, v]) => !(/elev/.test(n) && v === o.elevM))

const tbLabel = (name: string) => {
  const m = /^reachable_pct(?:_(\d+)_?min)?$/.exec(name)
  return m ? `reachable${m[1] ? ` in ${m[1]} min` : ''}` : name.replace(/_/g, ' ')
}

const tbUnits = (name: string): string | null => (/pct/.test(name) ? '%' : /elev|_m$/.test(name) ? 'm' : null)

/** D21 "Rover parking options": the official pad first (default), then the ranked alternatives. */
function PadPicker({ index, selected, onPick, suitKg }: { index: PadsIndexView; selected: string | null; onPick: (id: string | null) => void; suitKg: number }) {
  const F = PADS_INDEX
  return (
    <section class="pad-picker">
      <h3>Rover parking options</h3>
      <table class="mini">
        <thead>
          <tr>
            <th />
            <th>Pad</th>
            <th class="r" title="D21 score: station subsets with a feasible route from this pad">
              Feasible EVAs
            </th>
            <th class="r" title={`Excluded combinations: ${EXCLUDED_NOTE}`}>
              Excl. <span class="unit">≤</span>
            </th>
            <th class="r">
              Elev. <span class="unit">m</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {index.options.map((o) => {
            const on = o.official ? selected === null : selected === o.id
            const pick = () => onPick(o.official ? null : o.id)
            return (
              <tr class={on ? 'on' : ''} onClick={pick}>
                <td>
                  <input type="radio" name="pad-option" checked={on} onChange={pick} aria-label={o.label} />
                </td>
                <td>
                  <b>{o.label}</b>
                  {o.rank !== null && (
                    <span class="muted">
                      {' '}
                      rank <Num v={o.rank} file={F} k={padKey(o.id, 'rank')} />
                    </span>
                  )}
                  {shownTiebreaks(o).length > 0 && (
                    <div class="caption">
                      tiebreak{' '}
                      {shownTiebreaks(o).map(([n, v], i) => (
                        <>
                          {i > 0 ? ' · ' : ''}
                          {tbLabel(n)} <Num v={v} units={tbUnits(n)} file={F} k={padKey(o.id, 'tiebreak', n)} />
                        </>
                      ))}
                    </div>
                  )}
                </td>
                <td class="r">
                  <Num v={o.score} file={F} k={padKey(o.id, 'score')} />
                </td>
                <td class="r">
                  {o.excluded === null ? <span class="muted">–</span> : <Num v={o.excluded} file={o.official ? F : `scenarios/pads/${o.id}/summary.json`} k={padKey(o.id, 'feasible', 'excluded_by_effort_cap_rule')} />}
                </td>
                <td class="r">
                  <Num v={o.elevM} file={F} k={padKey(o.id, 'elev_m')} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p class="caption">
        D21: the official pad is the candidate with the most feasible EVAs (station subsets with a feasible route); it is the default. Choosing another option
        switches the bands, route, partner line, headline and feasible-EVA count to that pad (nominal variant, {suitKg} kg suit only; no budget slider).{' '}
        <b>The HUD, the 3D view and the station cards stay on the official pad.</b> The official pad is frozen (D42).
      </p>
      {index.options.some((o) => o.excluded !== null) && (
        <p class="caption">
          <b>Excl. ≤</b>: {EXCLUDED_NOTE}. <PlanningRuleNote />
        </p>
      )}
    </section>
  )
}

/** D43: the 60-min share over the part of the circle inside the terrain data, with the coverage label. */
function Headline60({ entry }: { entry: ScenarioEntry }) {
  const h = headline60(entry)
  if (!h) return null
  const F = 'scenarios/index.json'
  const sid = entry.id
  return (
    <div class="headline-60 caption">
      Within {h.budget} min: <Num v={h.reachablePct} units="%" file={F} k={`reachable_pct.${sid}.${h.budget}`} />
      {h.range && (
        <>
          {' '}
          (<Num v={h.range[0]} units="%" file={F} k={`reachable_pct_range.${sid}.${h.budget}.low`} /> to{' '}
          <Num v={h.range[1]} units="%" file={F} k={`reachable_pct_range.${sid}.${h.budget}.high`} />)
        </>
      )}
      {h.inData ? ' of the part of the circle inside the terrain data. ' : '. '}
      {h.inDataPct !== null && h.inData && (
        <b>
          <Num v={h.inDataPct} units="%" file={F} k={`headline.${sid}.disc_${h.budget}.in_data_pct`} /> of the circle lies inside the terrain data
        </b>
      )}
      . The {CONFIG.walkbackBudgetsMin[0]}-min figure stays the headline.
    </div>
  )
}

/** Walk home in a scenario; null = "not reachable on foot" (D26, D46: shown as is). */
function HomeCell({ s, sid }: { s: Station; sid: string }) {
  const h = homeFor(s, sid)
  if (h.kind === 'time') return <Num v={h.v} units="min" file="stations.json" k={`t_home_min.${s.id}.${sid}`} />
  if (h.kind === 'unreachable')
    return (
      <span class="num-unknown" title={h.reason ?? ''}>
        {h.label}
      </span>
    )
  return <span class="num-unknown">unknown</span>
}

/** D28: latest turn-back per station from the timeline's turn_back rows, with the binding term. */
function TurnBackTable({ rows, file, keyPrefix }: { rows: ReturnType<typeof turnBacks>; file: string; keyPrefix: string }) {
  return (
    <table class="mini">
      <thead>
        <tr>
          <th>Turn back by</th>
          <th class="r">
            t <span class="unit">min</span>
          </th>
          <th>Bound by</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr>
            <td>{r.station ?? '–'}</td>
            <td class="r">
              <Num v={r.t_min} file={file} k={`${keyPrefix}.${r.i}.t_min`} />
            </td>
            <td>{marginLabel(r.binding)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
