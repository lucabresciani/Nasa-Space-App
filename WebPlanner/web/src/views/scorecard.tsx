// /scorecard — F16: validation (V1, V2 by distance class, coverage, co-registration, RAD checks,
// KAT list), the assumptions table, the real / modelled / simulated table and the provenance
// manifest (every on-screen number links here). Never in the default view (brief WS5 "Don't").
import { useEffect, useMemo, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { CITED, CONFIG } from '../config'
import { o2Reserve } from './o2'
import { data } from '../data/loader'
import type { Localisation, Manifest, ManifestEntry } from '../data/types'
import { contractVersions } from '../data/contracts'
import { formatValue, isEntry } from '../prov/provenance'
import { getManifest } from '../prov/store'
import type { Route } from '../router'
import { DummyNote, StatusTag } from '../components/labels'
import { LooseTable } from '../components/Loose'
import { CfgNum, DerivedNum, Num } from '../components/Num'
import { PadInUseText } from '../components/PadInUse'
import { padInUse } from '../map/pad'
import { f22Rows, f22Verdict, type F22Frame } from './f22'
import { ADDON_LABEL } from './slot'
import { cellStateDisc, confusionThresholds, FAR_NOT_VALIDATED, katAreas, v1Context, v1Sensitivities, v2Classes, type Confusion, type KatTest } from './validation'
import { ist2Rows } from './decisions'
import { CellSlopeNote } from '../components/DecisionNotes'
import { AssumedTag } from '../components/labels'
import { dataUrl } from '../env'
import { Page, preactView, Show, useLoad } from './page'

export { o2Reserve }

export function manifestEntries(m: Manifest | null): [string, ManifestEntry][] {
  if (!m) return []
  return (Object.entries(m).filter(([k, v]) => k !== 'dummy' && isEntry(v)) as [string, ManifestEntry][]).sort(([a], [b]) => a.localeCompare(b))
}

/** Entries recorded before H0 (config/event.yaml h0_utc): must be none (SPEC F16, CI check_h0). */
export function preH0(entries: [string, ManifestEntry][], h0Utc: string): string[] {
  const h0 = Date.parse(h0Utc)
  return entries.filter(([, e]) => !(Date.parse(e.utc) >= h0)).map(([k]) => k)
}

function show(v: unknown, units: string | null): string {
  return typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' || v === null ? formatValue(v, units) : JSON.stringify(v)
}

function ManifestTable({ focus }: { focus?: string }) {
  const m = getManifest()
  const [q, setQ] = useState(focus ?? '')
  const all = useMemo(() => manifestEntries(m), [m])
  const early = useMemo(() => preH0(all, CONFIG.h0Utc), [all])
  const rows = all.filter(([k, e]) => !q || k.includes(q) || e.file.includes(q))
  useEffect(() => {
    if (focus) document.getElementById(`k-${focus}`)?.scrollIntoView({ block: 'center' })
  }, [focus])
  if (!m) return <p class="muted">manifest.json is not available in this data tree.</p>
  return (
    <>
      <p>
        {all.length} entries{m.dummy ? ' (dummy manifest)' : ''}. Each number on the site links here.{' '}
        {early.length ? <b class="bad">{early.length} entries carry a time before H0 ({CONFIG.h0Utc}).</b> : <>All entries are after H0 ({CONFIG.h0Utc}).</>}{' '}
        <input type="search" placeholder="filter by key or file" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      </p>
      <div class="table-scroll">
        <table class="mini manifest">
          <thead>
            <tr>
              <th>Key</th>
              <th class="r">Value</th>
              <th>File</th>
              <th>Script</th>
              <th>Commit</th>
              <th>UTC</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([k, e]) => (
              <tr id={`k-${k}`} class={k === focus ? 'focus' : ''}>
                <td>
                  <code>{k}</code>
                </td>
                <td class="r">{show(e.value, e.units)}</td>
                <td>{e.file}</td>
                <td>{e.script}</td>
                <td>
                  <code>{e.commit.slice(0, 10)}</code>
                </td>
                <td>{e.utc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

/** One 2 x 2 confusion matrix (DEM predicts, IMU is the reference; positive = tilt >= threshold). */
function ConfusionTable({ c, t, keyPrefix, file }: { c: Confusion; t: string; keyPrefix: string; file: string }) {
  const k = (f: keyof Confusion) => `${keyPrefix}.confusion.${t}.${f}`
  return (
    <table class="mini confusion">
      <thead>
        <tr>
          <th>≥ {t}°</th>
          <th class="r">IMU ≥ {t}°</th>
          <th class="r">IMU &lt; {t}°</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th>DEM ≥ {t}°</th>
          <td class="r" title="true positive">
            <Num v={c.tp} file={file} k={k('tp')} />
          </td>
          <td class="r" title="false positive (false alarm)">
            <Num v={c.fp} file={file} k={k('fp')} />
          </td>
        </tr>
        <tr>
          <th>DEM &lt; {t}°</th>
          <td class="r" title="false negative (missed)">
            <Num v={c.fn} file={file} k={k('fn')} />
          </td>
          <td class="r" title="true negative">
            <Num v={c.tn} file={file} k={k('tn')} />
          </td>
        </tr>
      </tbody>
    </table>
  )
}

function V1Section() {
  const l = useLoad(async () => {
    const L = data()
    const [v, cov] = await Promise.all([L.optional(() => L.v1()), L.optional(() => L.coverage())])
    return { v, cov }
  })
  const F = 'validation/v1.json'
  return (
    <Show l={l} what="V1 tilt validation">
      {({ v, cov }) => {
        if (!v) return <p class="muted">validation/v1.json not available yet (WS6).</p>
        const sens = v1Sensitivities(v)
        const ts = confusionThresholds(v.confusion)
        const ctx = v1Context(v)
        const hi = ts.length ? (v.confusion as Record<string, Confusion>)[ts[ts.length - 1]] : undefined
        const b30 = CONFIG.walkbackBudgetsMin[0]
        const con30 = cellStateDisc(cov?.terrain_checks, 'conservative', b30)
        const nom30 = cellStateDisc(cov?.terrain_checks, 'nominal', b30)
        const CF = 'validation/coverage.json'
        return (
          <>
            <p>
              DEM slope over the rover footprint (<Num v={(v.footprint_m as number) ?? null} units="m" file={F} k="v1.footprint_m" />) vs Curiosity's IMU tilt at{' '}
              <Num v={v.n} file={F} k="v1.n" /> drive ends in the focus area. Bias (DEM − IMU) <Num v={v.bias_deg} units="deg" file={F} k="v1.bias_deg" dp={2} signed />, RMSE{' '}
              <Num v={v.rmse_deg} units="deg" file={F} k="v1.rmse_deg" dp={2} />, r <Num v={v.r} file={F} k="v1.r" dp={2} />.
            </p>
            <div class="confusion-row">
              {ts.map((t) => (
                <ConfusionTable c={(v.confusion as Record<string, Confusion>)[t]} t={t} keyPrefix="v1" file={F} />
              ))}
            </div>
            <figure class="v1-figure">
              <img src={dataUrl('validation/v1.svg')} alt="V1 scatter: DEM tilt vs IMU tilt per drive end" loading="lazy" />
              <figcaption>
                <StatusTag kind="real" /> IMU tilt vs <StatusTag kind="modelled" /> DEM tilt per drive end (validation/v1.svg, WS6).
              </figcaption>
            </figure>
            <p>
              {hi && hi.fp > hi.fn ? (
                <>
                  Reading: at {ts[ts.length - 1]}° the DEM raises more false alarms than it misses, so as a hazard flag it errs on the cautious side.{' '}
                </>
              ) : null}
              <b>Caveat: {typeof v.caveat === 'string' ? v.caveat.replace(/\.$/, '') : 'the rover chose gentle ground'}.</b>
            </p>
            <p class="finding">
              <b>{ctx.role ?? 'V1 = validation of the slope model, not a safety margin'}</b> (D23).{' '}
              Conservative no-go <CfgNum v={CITED.nogoConservativeDeg.value} units="deg" source={CITED.nogoConservativeDeg.source} /> from config, not derived from V1
              {ctx.nogoText ? <> (v1.json: “{ctx.nogoText}”)</> : null}
              {ctx.agreesWithConfig === false ? <b class="bad"> (v1.json cites a different value)</b> : null}. Cell slope: <CellSlopeNote />.
              {con30 && (
                <>
                  {' '}
                  At the conservative no-go <Num v={con30.blockedPct} units="%" file={CF} k={`${con30.keyPrefix}.blocked_pct`} /> of the {b30}-min flat disc is blocked
                  {nom30 && (
                    <>
                      {' '}
                      (nominal <Num v={nom30.blockedPct} units="%" file={CF} k={`${nom30.keyPrefix}.blocked_pct`} />)
                    </>
                  )}
                  ; the old max-slope rule ("rough footing") would block{' '}
                  <Num v={con30.maxSlopeRulePct} units="%" file={CF} k={`${con30.keyPrefix}.maxslope_rule_blocked_pct`} /> (comparison only).
                </>
              )}
            </p>
            {sens.length > 0 && (
              <>
                <h4>Sensitivities</h4>
                <table class="mini">
                  <thead>
                    <tr>
                      <th>Run</th>
                      <th class="r">n</th>
                      <th class="r">Bias</th>
                      <th class="r">RMSE</th>
                      <th class="r">r</th>
                      {ts.map((t) => (
                        <th class="r" title="TP / FP / FN / TN">
                          {t}° TP/FP/FN/TN
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sens.map((x) => (
                      <tr>
                        <td>{x.label}</td>
                        <td class="r">
                          <Num v={x.n} file={F} k={`${x.keyPrefix}.n`} />
                        </td>
                        <td class="r">
                          <Num v={x.bias_deg} units="deg" file={F} k={`${x.keyPrefix}.bias_deg`} dp={2} signed />
                        </td>
                        <td class="r">
                          <Num v={x.rmse_deg} units="deg" file={F} k={`${x.keyPrefix}.rmse_deg`} dp={2} />
                        </td>
                        <td class="r">
                          <Num v={x.r} file={F} k={`${x.keyPrefix}.r`} dp={2} />
                        </td>
                        {ts.map((t) => {
                          const c = x.confusion[t]
                          if (!c) return <td class="r muted">–</td>
                          const ck = (f: keyof Confusion) => `${x.keyPrefix}.confusion.${t}.${f}`
                          return (
                            <td class="r">
                              <Num v={c.tp} file={F} k={ck('tp')} /> / <Num v={c.fp} file={F} k={ck('fp')} /> / <Num v={c.fn} file={F} k={ck('fn')} /> /{' '}
                              <Num v={c.tn} file={F} k={ck('tn')} />
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p class="caption">Sensitivities only; the primary result is the 3 m footprint, focus area, MMGIS tilt. None of them sets a no-go (D23).</p>
              </>
            )}
          </>
        )
      }}
    </Show>
  )
}

function V2Section() {
  const l = useLoad(() => data().optional(() => data().v2()))
  const F = 'validation/v2.json'
  const [a, b] = CONFIG.distanceClassesKm
  const range: Record<string, string> = { near: `< ${a} km`, mid: `${a}–${b} km`, far: `> ${b} km` }
  return (
    <Show l={l} what="V2 skyline validation">
      {(v) => {
        if (!v) return <p class="muted">validation/v2.json not available yet (WS3).</p>
        const rows = v2Classes(v.summary)
        if (!rows.length) return <LooseTable value={v.summary} file={F} />
        return (
          <>
            <p>
              Predicted vs detected skyline elevation angle per image column (automatic sky detector, no manual review: D7), by distance class, over{' '}
              <DerivedNum v={v.frames.length} how="counted in the browser: validation/v2.json frames[]" /> frames listed in validation/v2.json.
            </p>
            <table class="mini">
              <thead>
                <tr>
                  <th>Class</th>
                  <th class="r">Columns</th>
                  <th class="r">Median</th>
                  <th class="r">Median |error|</th>
                  <th class="r">P90 |error|</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr class={r.validated ? '' : 'not-validated'}>
                    <td>
                      {r.cls} <span class="muted">({range[r.cls] ?? ''})</span>
                    </td>
                    <td class="r">
                      <Num v={r.n} file={F} k={`${r.keyPrefix}.n`} />
                    </td>
                    <td class="r">
                      <Num v={r.median_deg} units="deg" file={F} k={`${r.keyPrefix}.median_deg`} dp={2} signed />
                    </td>
                    <td class="r">
                      <Num v={r.median_abs_deg} units="deg" file={F} k={`${r.keyPrefix}.median_abs_deg`} dp={2} />
                    </td>
                    <td class="r">
                      <Num v={r.p90_abs_deg} units="deg" file={F} k={`${r.keyPrefix}.p90_abs_deg`} dp={2} />
                    </td>
                    <td>{r.validated ? 'quoted as measured' : <b class="bad">not validated</b>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p class="caption">Far class: {FAR_NOT_VALIDATED} The far numbers stay visible for transparency only.</p>
            <p class="caption">The skyline check validates the DEM–camera–pose chain. It is not a hazard validation.</p>
          </>
        )
      }}
    </Show>
  )
}

function CoverageSection() {
  const l = useLoad(async () => {
    const L = data()
    const [coverage, coreg, pad] = await Promise.all([L.optional(() => L.coverage()), L.optional(() => L.coreg()), L.optional(() => L.pad())])
    return { coverage, coreg, pad }
  })
  return (
    <Show l={l} what="Coverage and co-registration">
      {({ coverage, coreg, pad }) => (
        <>
          {coverage ? <CoverageTable c={coverage} /> : <p class="muted">validation/coverage.json not available yet (WS1).</p>}
          {pad && <PadInUseText u={padInUse(pad)!} />}
          {coreg ? (
            <p>
              Co-registration shift to Curiosity drive ends: dx <Num v={coreg.dx_m} units="m" file="validation/coreg.json" k="coreg.dx_m" />, dy{' '}
              <Num v={coreg.dy_m} units="m" file="validation/coreg.json" k="coreg.dy_m" />; residual median{' '}
              <Num v={coreg.residual_median_m} units="m" file="validation/coreg.json" k="coreg.residual_median_m" />, MAD{' '}
              <Num v={coreg.residual_mad_m} units="m" file="validation/coreg.json" k="coreg.residual_mad_m" /> over {coreg.residuals.length} drive ends.
            </p>
          ) : (
            <p class="muted">validation/coreg.json not available yet (WS1).</p>
          )}
        </>
      )}
    </Show>
  )
}

function RadChecks() {
  const l = useLoad(() => data().optional(() => data().rad()))
  const ex = CITED.radExpected
  return (
    <Show l={l} what="RAD checks">
      {(r) =>
        r ? (
          <table class="mini">
            <thead>
              <tr>
                <th>Check</th>
                <th class="r">Recomputed (file)</th>
                <th class="r">Published range (config)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Storm peak dose rate</td>
                <td class="r">
                  <Num v={r.storm_2024.peak_uGy_day} units="uGy/day" file="conditions/rad.json" k="rad.storm_2024.peak_uGy_day" />
                </td>
                <td class="r">
                  <CfgNum v={`${ex.value.peak_mgy_day[0]}–${ex.value.peak_mgy_day[1]}`} units="mGy/day" source={`${ex.source}.peak_mgy_day`} />
                </td>
              </tr>
              <tr>
                <td>Event excess dose{r.storm_2024.excess_is_lower_bound ? ' (lower bound, D36)' : ''}</td>
                <td class="r">
                  {r.storm_2024.excess_is_lower_bound ? '≥ ' : ''}
                  <Num v={r.storm_2024.excess_mGy} units="mGy" file="conditions/rad.json" k="rad.storm_2024.excess_mGy" />
                </td>
                <td class="r">
                  <CfgNum v={`${ex.value.excess_mgy[0]}–${ex.value.excess_mgy[1]}`} units="mGy" source={`${ex.source}.excess_mgy`} />
                </td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p class="muted">conditions/rad.json not available yet (WS4).</p>
        )
      }
    </Show>
  )
}

function O2ReserveBasis() {
  const r = o2Reserve()
  return (
    <>
      Shuttle/EMU 30-min EVA reserve (NTRS 20140009556), S review: <DerivedNum v={r.litres} units="L" how={`${r.min} min × effort rate ${r.rateLMin} L/min (${CITED.o2EffortRateFormula.source}: ${CITED.o2EffortRateFormula.value})`} /> at{' '}
      <DerivedNum v={r.rateLMin} units="L/min" how={`${CITED.o2EffortRateFormula.source}: ${CITED.o2EffortRateFormula.value}`} />
    </>
  )
}

const ASSUMPTIONS: { what: string; c: { value: unknown; source: string }; units?: string; basis: ComponentChildren }[] = [
  { what: 'Walkback budgets', c: CITED.walkbackBudgetsMin, units: 'min', basis: 'ICES-2026-127, "being considered"; not policy' },
  { what: 'Effort cap (fraction of VO₂max)', c: CITED.effortCapFrac, basis: 'ICES; NASA-STD-3001' },
  { what: 'VO₂max', c: CITED.vo2maxMlKgMin, units: 'mL/kg/min', basis: 'ICES; NASA-STD-3001' },
  { what: 'Level cost at Mars offload (anchor)', c: CITED.anchorVo2, units: 'mL/kg/min', basis: 'ICES (6 subjects)' },
  { what: 'Anchor speed', c: CITED.anchorSpeed, units: 'm/s', basis: 'ICES' },
  { what: 'Body mass', c: CITED.bodyMassKg, units: 'kg', basis: 'Our assumption (D10)' },
  { what: 'Suit masses', c: CITED.suitMassesKg, units: 'kg', basis: '80 kg is our sensitivity value' },
  { what: 'Suit O₂ budget planned against (primary)', c: CITED.o2PrimaryL, units: 'L', basis: 'Derived: NASA EVA-EXP-0075, ICES-2026-127; metabolic only' },
  { what: 'O₂ reserve in the route margin (minutes at the effort cap)', c: CITED.o2ReserveMinAtEffortCap, units: 'min', basis: <O2ReserveBasis /> },
  { what: 'O₂ use while working at a station', c: CITED.stationTaskRateLMin, units: 'L/min', basis: '1,000 BTU/hr ISS/EMU average; S review' },
  { what: 'Access radius around a station', c: CITED.accessRadiusM, units: 'm', basis: 'Decided (D27, user 16:20); access-cell rule chosen by the user, 14 Nov 11:40' },
  { what: 'O₂ energy equivalent', c: CITED.o2EnergyJPerMl, units: 'J/mL', basis: 'Decided (D29): one value for the uphill term, heat, haul and the O₂ budget' },
  { what: 'Slope limit, nominal', c: CITED.nogoNominalDeg, units: 'deg', basis: 'Scoville; our assumption' },
  { what: 'Slope limit, optimistic', c: CITED.nogoOptimisticDeg, units: 'deg', basis: 'Our assumption' },
  { what: 'Slope limit, conservative', c: CITED.nogoConservativeDeg, units: 'deg', basis: 'Decided (D23); V1 is a validation, not a margin' },
  { what: 'Step guard (any 1 m slope inside a 3 m cell)', c: CITED.stepGuardDeg, units: 'deg', basis: <>D22; <AssumedTag note="Step guard: assumed (D22, config)" /></> },
  { what: 'Beyond tested suited data above', c: CITED.flagBeyondTestedDeg, units: 'deg', basis: 'IST-2 tested up to ≈17°' },
  { what: 'Dose allowance per EVA', c: CITED.dAllowMgy, units: 'mGy', basis: 'Our assumption, adjustable (D9)' },
  { what: 'Fix accuracy at the rover', c: CITED.fixSigmaRoverM, units: 'm', basis: 'Our assumption' },
  { what: 'Fix accuracy at a station', c: CITED.fixSigmaStationM, units: 'm', basis: 'Our assumption' },
  { what: 'Simulated drift (fallback rule)', c: CITED.driftPct, units: '%', basis: 'Our assumption (D12), % of distance walked' },
  { what: 'Casualty mass bound', c: CITED.casualtyBoundKg, units: 'kg', basis: 'NASA 2024 rescue challenge' },
  { what: 'Boot traction μ', c: CITED.haulBootMu, basis: 'Assumed band' },
]

export function RealModelledSimulated() {
  return (
    <table class="mini">
      <tbody>
        <tr>
          <td>
            <StatusTag kind="real" />
          </td>
          <td>
            Terrain, imagery, CRISM, THEMIS; Curiosity positions, tilt, Navcam frames, camera models; RAD dose rates; REMS archive; DONKI records; ephemeris.
            Labelled with their lag; the REMS feed is marked stale.
          </td>
        </tr>
        <tr>
          <td>
            <StatusTag kind="modelled" />
          </td>
          <td>
            Slope and no-go; metabolic cost, speed, O₂ and heat; return, haul and siting fields; predicted skylines; daylight; storm dose for a hypothetical crew;
            skyline-matching fix errors (measured on real Navcam); visual-odometry drift on Curiosity drives. Shown with bands.
          </td>
        </tr>
        <tr>
          <td>
            <StatusTag kind="simulated" />
          </td>
          <td>Astronauts, rover pad, casualty, EVA timing, the storm hitting this EVA; the HUD playback, crew position, position drift and fixes.</td>
        </tr>
      </tbody>
    </table>
  )
}

function Scorecard({ focus }: { focus?: string }) {
  return (
    <Page title="Scorecard" wide>
      <DummyNote />
      <section>
        <h2>Validation</h2>
        <h3>V1 · footing: DEM slope vs rover tilt</h3>
        <V1Section />
        <h3>V2 · view: predicted vs observed skyline</h3>
        <V2Section />
        <h3>Coverage and co-registration</h3>
        <CoverageSection />
        <h3>RAD checks</h3>
        <RadChecks />
        <h3>Physiology model check: IST-2 (D30)</h3>
        <Ist2Section />
        <h3>Known-answer tests</h3>
        <KatSection />
      </section>
      <section class="addon">
        <h2>
          Navigation and visual odometry <span class="optional-addon">{ADDON_LABEL}</span>
        </h2>
        <p class="muted">
          The core plan uses the F19 drift circle and position fixes at the rover pad and the surveyed stations. The results below are kept as findings (D19).
        </p>
        <h3>F22 · skyline fix on real Navcam frames (validation finding)</h3>
        <F22Section />
        <h3>X8 · visual-odometry drift on Curiosity drives (rover analogue)</h3>
        <VoDriftSection />
      </section>
      <section>
        <h2>Assumptions</h2>
        <table class="mini">
          <thead>
            <tr>
              <th>Assumption</th>
              <th class="r">Value</th>
              <th>Basis</th>
            </tr>
          </thead>
          <tbody>
            {ASSUMPTIONS.map((a) => (
              <tr>
                <td>{a.what}</td>
                <td class="r">
                  <CfgNum v={Array.isArray(a.c.value) ? a.c.value.join(' / ') : (a.c.value as number)} units={a.units} source={a.c.source} />
                </td>
                <td>{a.basis}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p class="caption">Values read from config/*.yaml at build time; hover a value for its file and key.</p>
      </section>
      <section>
        <h2>Real, modelled, simulated</h2>
        <RealModelledSimulated />
      </section>
      <section>
        <h2>Provenance manifest</h2>
        <ManifestTable focus={focus} />
      </section>
    </Page>
  )
}

export const view = preactView((route: Route) => <Scorecard focus={route.name === 'scorecard' ? route.key : undefined} />)

function F22Section() {
  const l = useLoad(async () => {
    const L = data()
    const stations = await L.stations()
    const frames: F22Frame[] = []
    for (const st of stations) {
      let id: string | null = null
      try {
        id = (await L.optional(() => L.card(st)))?.navcam.image_id ?? null
      } catch {
        id = null // card fails its contract: the station page reports it
      }
      frames.push({ station: st.id, image_id: id })
    }
    const locs: Record<string, Localisation | null> = {}
    for (const f of frames) if (f.image_id) locs[f.image_id] = await L.optional(() => L.localisation(f.image_id!))
    const fixes = await L.optional(() => L.fixes())
    return { frames, locs, fixes }
  })
  const g = CONFIG.skylineFixGate
  return (
    <Show l={l} what="F22 skyline fix">
      {({ frames, locs, fixes }) => {
        const rows = f22Rows(frames, locs, g.toleranceM)
        const v = f22Verdict(rows)
        return (
          <>
            <p>
              Each station card's Navcam frame, localised from its skyline alone against the elevation model. Gate: a result becomes a position fix only if it lands
              within <CfgNum v={g.toleranceM} units="m" source={g.source} /> of where the frame was taken (the F22 known-answer tolerance).
            </p>
            <table class="mini">
              <thead>
                <tr>
                  <th>Station</th>
                  <th>Navcam frame</th>
                  <th class="r">Position error</th>
                  <th>Gate</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr>
                    <td>{r.station}</td>
                    <td>{r.image_id ? <code>{r.image_id}</code> : <span class="muted">no card frame</span>}</td>
                    <td class="r">
                      {r.image_id ? <Num v={r.error_m} units="m" file={`localisation/${r.image_id}.json`} k={`nav.skyline.${r.image_id}.error_m`} /> : null}
                    </td>
                    <td>{r.pass === null ? <span class="muted">no result</span> : r.pass ? <b class="ok">pass</b> : <b class="bad">fail</b>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p>
              <b>
                {v.kind === 'none-pass'
                  ? `No skyline fix passes the gate (${v.evaluated} station frames evaluated). The plan uses station fixes; no skyline result is shown as a position fix.`
                  : v.kind === 'some-pass'
                    ? `Skyline fixes pass at ${v.passed.join(', ')}; the other stations keep their station fixes.`
                    : 'No skyline-fix results in this data tree yet (WS9).'}
              </b>{' '}
              The far-field skyline barely constrains position at this site.
            </p>
            {fixes && (
              <p>
                Fixes in the navigation add-on (nav/fixes.json):{' '}
                {fixes.map((f, i) => (
                  <>
                    {i > 0 ? '; ' : ''}
                    {f.type === 'station' ? `station fix at ${f.station}` : f.type === 'rover' ? 'rover fix' : `${f.type} fix`} at t ={' '}
                    <Num v={f.t_eva_min} units="min" file="nav/fixes.json" k={`nav.fixes.${i}.t_eva_min`} />, σ{' '}
                    <Num v={f.sigma_m} units="m" file="nav/fixes.json" k={`nav.fixes.${i}.sigma_m`} />
                  </>
                ))}
                .
              </p>
            )}
          </>
        )
      }}
    </Show>
  )
}

function VoDriftSection() {
  const l = useLoad(() => data().optional(() => data().voDrift()))
  const F = 'vo/drift.json'
  return (
    <Show l={l} what="Visual-odometry drift">
      {(rows) =>
        rows && rows.length ? (
          <>
            <p>
              <span class="tag tag-assumed">{(rows.find((r) => typeof r.label === 'string')?.label as string) ?? 'rover analogue'}</span> Stereo visual odometry on
              Curiosity's own drive frames, compared with the mission's drive-end positions.
            </p>
            <table class="mini">
              <thead>
                <tr>
                  <th>Sol</th>
                  <th>Drive</th>
                  <th class="r">Length</th>
                  <th class="r">End-point error</th>
                  <th class="r">Drift</th>
                  <th class="r">Heading drift</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr>
                    <td>
                      <Num v={r.sol} file={F} k={`vo.drift.${i}.sol`} />
                    </td>
                    <td>{r.drive}</td>
                    <td class="r">
                      <Num v={r.length_m} units="m" file={F} k={`vo.drift.${i}.length_m`} />
                    </td>
                    <td class="r">
                      <Num v={r.endpoint_error_m} units="m" file={F} k={`vo.drift.${i}.endpoint_error_m`} />
                    </td>
                    <td class="r">
                      <Num v={r.drift_pct} units="%" file={F} k={`vo.drift.${i}.drift_pct`} />
                    </td>
                    <td class="r">
                      <Num v={r.heading_drift_deg} units="deg" file={F} k={`vo.drift.${i}.heading_drift_deg`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {typeof rows[0].truth === 'string' && <p class="caption">Reference: {rows[0].truth}.</p>}
          </>
        ) : (
          <p class="muted">vo/drift.json not available yet (WS10).</p>
        )
      }
    </Show>
  )
}

interface Kats {
  generated_utc: string
  commit: string
  runner: string
  summary: { total: number; passed: number; failed: number; skipped: number }
  tests: KatTest[]
}

function KatSection() {
  const l = useLoad(() => data().optional(() => data().json<Kats>('validation/kats.json')))
  const F = 'validation/kats.json'
  return (
    <Show l={l} what="KAT pass list">
      {(k) => {
        if (!k) return <p class="muted">validation/kats.json not available yet (WS6, contracts v{contractVersions().join(', ')}). The full list runs in CI on every PR.</p>
        const areas = katAreas(k.tests)
        const how = 'counted in the browser from validation/kats.json tests[]'
        return (
          <>
            <p>
              <Num v={k.summary.passed} file={F} k="kats.summary.passed" /> of <Num v={k.summary.total} file={F} k="kats.summary.total" /> known-answer tests pass
              (failed <Num v={k.summary.failed} file={F} k="kats.summary.failed" />, skipped <Num v={k.summary.skipped} file={F} k="kats.summary.skipped" />), {k.runner}{' '}
              at commit <code>{k.commit.slice(0, 10)}</code>, {k.generated_utc}.
            </p>
            <table class="mini">
              <thead>
                <tr>
                  <th>Area (SPEC §9)</th>
                  <th class="r">Tests</th>
                  <th class="r">Passed</th>
                  <th class="r">Failed</th>
                  <th class="r">Skipped</th>
                </tr>
              </thead>
              <tbody>
                {areas.map((a) => (
                  <tr>
                    <td>{a.area === 'other' ? 'other (contracts, config, data tools, web views)' : a.area}</td>
                    <td class="r">
                      <DerivedNum v={a.total} how={how} />
                    </td>
                    <td class="r">
                      <DerivedNum v={a.passed} how={how} />
                    </td>
                    <td class="r">{a.failed ? <b class="bad"><DerivedNum v={a.failed} how={how} /></b> : <DerivedNum v={a.failed} how={how} />}</td>
                    <td class="r">
                      <DerivedNum v={a.skipped} how={how} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {k.tests.some((t) => t.outcome !== 'passed') && (
              <ul>
                {k.tests
                  .filter((t) => t.outcome !== 'passed')
                  .map((t) => (
                    <li>
                      <code>{t.id}</code> {t.outcome}
                      {t.reason ? `: ${t.reason}` : ''}
                    </li>
                  ))}
              </ul>
            )}
            <details>
              <summary>Every test, by area</summary>
              {areas.map((a) => (
                <>
                  <h4>{a.area}</h4>
                  <ul class="kat-list">
                    {k.tests
                      .filter((t) => t.area === a.area)
                      .map((t) => (
                        <li class={t.outcome === 'passed' ? '' : 'bad'}>
                          <code>{t.id}</code>
                          {t.features.length ? <span class="muted"> {t.features.join(', ')}</span> : null}
                          {t.outcome !== 'passed' ? ` (${t.outcome})` : ''}
                        </li>
                      ))}
                  </ul>
                </>
              ))}
            </details>
          </>
        )
      }}
    </Show>
  )
}

interface CoverageDisc {
  budget_min: number
  radius_m: number | null
  assessed_pct: number | null
  blocked_pct: number | null
  unknown_pct: number | null
}

/** WS1 coverage (F1, F16): cell states of the flat 30/60-min discs, DEM source shares, pad check. */
function CoverageTable({ c }: { c: Record<string, unknown> }) {
  const F = 'validation/coverage.json'
  const discs = Array.isArray(c.discs) ? (c.discs as CoverageDisc[]) : null
  const src = c.source_fractions_pct as Record<string, number | null> | undefined
  const pc = c.pad_check as { budget_min: number; min_assessed_pct: number; pass: boolean; known_pct: number | null; basis?: string } | undefined
  if (!discs) return <LooseTable value={c} file={F} />
  return (
    <>
      <table class="mini">
        <thead>
          <tr>
            <th>Flat disc around the pad</th>
            <th class="r">Assessed</th>
            <th class="r">Blocked</th>
            <th class="r">Unknown</th>
          </tr>
        </thead>
        <tbody>
          {discs.map((d) => (
            <tr>
              <td>
                {d.budget_min} min (radius <Num v={d.radius_m} units="m" file={F} />)
              </td>
              <td class="r">
                <Num v={d.assessed_pct} units="%" file={F} k={`coverage.disc_${d.budget_min}.assessed_pct`} />
              </td>
              <td class="r">
                <Num v={d.blocked_pct} units="%" file={F} k={`coverage.disc_${d.budget_min}.blocked_pct`} />
              </td>
              <td class="r">
                <Num v={d.unknown_pct} units="%" file={F} k={`coverage.disc_${d.budget_min}.unknown_pct`} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {src && (
        <p>
          Elevation source over the planning extent: HiRISE <Num v={src.hirise ?? null} units="%" file={F} k="coverage.source_fractions_pct.hirise" />, CTX/other{' '}
          <Num v={src.ctx ?? null} units="%" file={F} k="coverage.source_fractions_pct.ctx" />, no data <Num v={src.nodata ?? null} units="%" file={F} k="coverage.source_fractions_pct.nodata" />.
        </p>
      )}
      {pc && (
        <p>
          Pad check: <Num v={pc.known_pct} units="%" file={F} k="validation.coverage.pad_check.known_pct" /> of the {pc.budget_min}-min disc has terrain data (needs{' '}
          <Num v={pc.min_assessed_pct} units="%" file={F} k="validation.coverage.pad_check.min_assessed_pct" />): {pc.pass ? <b class="ok">pass</b> : <b class="bad">fail</b>}.
        </p>
      )}
    </>
  )
}

/** D30 (no tuning): IST-2 pass/miss per variant and grade from the manifest keys physio.ist2.* (WS2); D29 energy equivalent from config. */
function Ist2Section() {
  const rows = ist2Rows(getManifest())
  return (
    <>
      {rows.length ? (
        <table class="mini">
          <thead>
            <tr>
              <th>Variant</th>
              <th class="r">Grade</th>
              <th class="r">IST-2 reported</th>
              <th class="r">Model band</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr>
                <td>{r.variant}</td>
                <td class="r">{r.grade} %</td>
                <td class="r">
                  <Num v={r.reported} file={r.file} k={`${r.keyPrefix}.reported`} />
                </td>
                <td class="r">
                  <Num v={r.bandLo} file={r.file} k={`${r.keyPrefix}.band_lo`} /> to <Num v={r.bandHi} file={r.file} k={`${r.keyPrefix}.band_hi`} />
                </td>
                <td>
                  <Num v={r.pass} file={r.file} k={`${r.keyPrefix}.pass`} boolText={['pass', 'miss']} className={r.pass === false ? 'bad' : ''} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p class="muted">No physio.ist2.* entries in manifest.json (WS2).</p>
      )}
      <p class="caption">
        Pass = the IST-2 reported value lies inside the model's band for that variant and grade. No tuning (D30): a miss is reported as a finding, not fixed. O₂
        energy equivalent <CfgNum v={CITED.o2EnergyJPerMl.value} units="J/mL" source={CITED.o2EnergyJPerMl.source} /> for the uphill term, heat, haul and the O₂
        budget (D29).
      </p>
    </>
  )
}
