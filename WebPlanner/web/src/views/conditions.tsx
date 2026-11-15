// /conditions — F14: RAD dose rate (latest, with its lag), baseline, the 20 May 2024 storm series
// with onset and tripwire, the dose leash with the D9 allowance slider, REMS climatology, Mars clock
// and DONKI context ("context only, not a trigger").
import { useState } from 'preact/hooks'
import { CITED, CONFIG } from '../config'
import { data } from '../data/loader'
import type { Rad } from '../data/types'
import { linear, log10Scale, logTicks, polyline } from '../chart/scale'
import { AssumedTag, DummyNote, StatusTag } from '../components/labels'
import { LooseTable } from '../components/Loose'
import { CfgNum, DerivedNum, Num } from '../components/Num'
import { leashSteps, tauMin } from './leash'
import { Page, preactView, Show, useLoad } from './page'

const F = 'conditions/rad.json'

export function utcLabel(iso: string | null): string {
  return iso ? iso.replace('T', ' ').replace(/(:00)?(\.000)?Z$/, ' UTC') : 'unknown'
}

export function RadChart({ rad }: { rad: Rad }) {
  const s = rad.storm_2024
  const pts = s.series.map(([t, v]) => [Date.parse(t), v !== null && v > 0 ? v : null] as [number, number | null]).filter(([t]) => Number.isFinite(t))
  const vals = pts.map((p) => p[1]).filter((v): v is number => v !== null)
  if (!pts.length || !vals.length) return <p class="muted">No storm series.</p>
  const W = 720
  const H = 280
  const m = { l: 64, r: 12, t: 12, b: 36 }
  const t0 = pts[0][0]
  const t1 = pts[pts.length - 1][0]
  const lo = 10 ** Math.floor(Math.log10(Math.min(...vals)))
  const hi = 10 ** Math.ceil(Math.log10(Math.max(...vals)))
  const x = linear([t0, t1], [m.l, W - m.r])
  const y = log10Scale([lo, hi], [H - m.b, m.t])
  const days: number[] = []
  for (let d = Math.ceil(t0 / 864e5) * 864e5; d <= t1; d += 864e5) days.push(d)
  const vline = (iso: string | null, cls: string, label: string, dy: number) => {
    const t = iso ? Date.parse(iso) : NaN
    if (!Number.isFinite(t)) return null
    return (
      <g class={cls}>
        <line x1={x(t)} x2={x(t)} y1={m.t} y2={H - m.b} />
        <text x={x(t) + 4} y={m.t + 12 + dy}>
          {label}
        </text>
      </g>
    )
  }
  return (
    <svg class="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="RAD dose rate during the May 2024 storm, log scale">
      {logTicks(lo, hi).map((v) => (
        <g class="tick">
          <line x1={m.l} x2={W - m.r} y1={y(v)} y2={y(v)} />
          <text x={m.l - 6} y={y(v) + 4} text-anchor="end">
            {v >= 1000 ? `${v / 1000}k` : v}
          </text>
        </g>
      ))}
      {days.map((d) => (
        <g class="tick">
          <line x1={x(d)} x2={x(d)} y1={H - m.b} y2={H - m.b + 4} />
          <text x={x(d)} y={H - m.b + 18} text-anchor="middle">
            {new Date(d).toISOString().slice(5, 10)}
          </text>
        </g>
      ))}
      <text class="axis-label" x={12} y={m.t + 4} transform={`rotate(-90 12 ${m.t + 4})`} text-anchor="end">
        µGy/day (log)
      </text>
      {rad.baseline_uGy_day !== null && rad.baseline_uGy_day > 0 && (
        <g class="baseline">
          <line x1={m.l} x2={W - m.r} y1={y(rad.baseline_uGy_day)} y2={y(rad.baseline_uGy_day)} />
          <text x={W - m.r - 4} y={y(rad.baseline_uGy_day) - 4} text-anchor="end">
            baseline
          </text>
        </g>
      )}
      {vline(s.onset_utc, 'onset', 'onset', H - m.b - m.t - 20)}
      {vline(s.tripwire_utc, 'tripwire', 'tripwire', 0)}
      {polyline(pts, x, y).map((p) => (
        <polyline class="series" points={p} />
      ))}
    </svg>
  )
}

/**
 * D9: dose allowance slider. Range and step from config/conditions.yaml (build time); tau per step
 * from rad.json leash.table (manifest keys rad.leash.table.{i}.*). A step the table lacks is
 * computed in the browser with the config formula and labelled so.
 */
export function LeashSlider({ rad }: { rad: Rad }) {
  const steps = leashSteps(CONFIG.dAllowRangeMgy, CONFIG.dAllowStepMgy, rad.leash.table)
  const d0 = rad.leash.D_allow_mGy ?? CONFIG.dAllowMgy
  const [d, setD] = useState(d0)
  const i = Math.max(0, steps.findIndex((s) => Math.abs(s.d - d) < 1e-9))
  const st = steps[i]
  const peak = rad.storm_2024.peak_uGy_day
  const latest = rad.latest.dose_rate_uGy_day
  const how = (rate: string) => `60 × D_allow / Ḋ (config/conditions.yaml leash.formula), D_allow = ${st.d} mGy, Ḋ = ${rate} from ${F}`
  const k = (f: string) => `rad.leash.table.${st.rowIndex}.${f}`
  return (
    <div class="leash-slider">
      <label>
        Dose allowance per EVA{' '}
        <input
          type="range"
          min={0}
          max={steps.length - 1}
          step={1}
          value={i}
          aria-label="Dose allowance per EVA"
          aria-valuetext={`${st.d} mGy`}
          onInput={(e) => setD(steps[+(e.target as HTMLInputElement).value].d)}
        />{' '}
        <b>{st.row ? <Num v={st.row.D_allow_mGy} units="mGy" file={F} k={k('D_allow_mGy')} /> : `${st.d} mGy`}</b>{' '}
        <AssumedTag note="Dose allowance per EVA: our assumption (D9), adjustable" />
      </label>
      <dl class="leash-out">
        <dt>Time on the allowance at the storm peak</dt>
        <dd class="strong">
          {st.row ? <Num v={st.row.tau_min_at_peak} units="min" file={F} k={k('tau_min_at_peak')} /> : <DerivedNum v={roundTenth(tauMin(st.d, peak))} units="min" how={how('storm peak')} />}
        </dd>
        <dt>… at the latest measured rate</dt>
        <dd>
          {st.row ? (
            <Num v={st.row.tau_min_at_latest} units="min" file={F} k={k('tau_min_at_latest')} />
          ) : (
            <DerivedNum v={roundTenth(tauMin(st.d, latest))} units="min" how={how('latest rate')} />
          )}
        </dd>
      </dl>
      <p class="caption">
        Range <CfgNum v={`${CONFIG.dAllowRangeMgy[0]}–${CONFIG.dAllowRangeMgy[1]}`} units="mGy" source="config/conditions.yaml: leash.d_allow_range_mgy" /> in{' '}
        <CfgNum v={CONFIG.dAllowStepMgy} units="mGy" source="config/conditions.yaml: leash.d_allow_step_mgy" /> steps; each value is the pipeline's (rad.json leash table)
        {steps.some((s) => !s.row) ? '; steps missing from the table are computed in the browser from the same backed rate and marked so' : ''}.
      </p>
    </div>
  )
}

function roundTenth(v: number | null): number | null {
  return v === null ? null : Math.round(v * 10) / 10
}

function Context() {
  const l = useLoad(async () => {
    const L = data()
    const [clock, rems, donki] = await Promise.all([L.optional(() => L.clock()), L.optional(() => L.rems()), L.optional(() => L.donki())])
    return { clock, rems, donki }
  })
  return (
    <Show l={l} what="Weather, clock and space-weather context">
      {({ clock, rems, donki }) => (
        <>
          <h3>
            Mars clock and sun <StatusTag kind="modelled" />
          </h3>
          {clock ? <ClockView c={clock} /> : <p class="muted">conditions/clock.json not available yet (WS4).</p>}

          <h3>
            Weather (REMS same-season climatology) <StatusTag kind="real" />
          </h3>
          {rems ? <RemsTable r={rems} /> : <p class="muted">conditions/rems.json not available yet (WS4).</p>}
          <p class="caption">
            Air temperature and pressure only (D37: ground temperature and UV dropped). The REMS feed is stale since{' '}
            <CfgNum v={CITED.remsStaleSince.value} source={CITED.remsStaleSince.source} />.
          </p>

          <h3>Space weather (DONKI): context only, not a trigger</h3>
          {donki ? (
            donki.records.length ? (
              <LooseTable value={Object.fromEntries(donki.records.map((r, i) => [String(i), r]))} file="conditions/donki.json" />
            ) : (
              <p class="muted">No DONKI records in the window.</p>
            )
          ) : (
            <p class="muted">conditions/donki.json not available yet (WS4).</p>
          )}
        </>
      )}
    </Show>
  )
}

function ConditionsView() {
  const l = useLoad(() => data().rad())
  return (
    <Page title="Conditions">
      <DummyNote />
      <Show l={l} what="RAD conditions">
        {(r) => (
          <>
            <section>
              <h2>
                Radiation now <StatusTag kind="real" />
              </h2>
              <p>
                Latest Curiosity RAD dose rate{r.source?.component_label ? <> ({r.source.component_label})</> : null}:{' '}
                <Num v={r.latest.dose_rate_uGy_day} units="uGy/day" file={F} k="rad.latest.dose_rate_uGy_day" /> at{' '}
                <Num v={r.latest.utc} file={F} k="rad.latest.utc" fmt={utcLabel} />, <Num v={r.latest.lag_days} units="days" file={F} k="rad.latest.lag_days" /> behind
                real time. Baseline <Num v={r.baseline_uGy_day} units="uGy/day" file={F} k="rad.baseline_uGy_day" />.
              </p>
              <RadSourceNote r={r} />
            </section>
            <section>
              <h2>
                20 May 2024 solar storm, replayed <StatusTag kind="real" /> <StatusTag kind="modelled" />
              </h2>
              <RadChart rad={r} />
              <StormNumbers r={r} />
              <p class="caption">
                Tripwire (the alarm): more than <CfgNum v={CITED.tripwireFactor.value} source={CITED.tripwireFactor.source} />× baseline in{' '}
                <CfgNum v={CITED.tripwireSamples.value} source={CITED.tripwireSamples.source} /> consecutive samples. The storm dose for a hypothetical crew is
                modelled from Curiosity's measured rate.
              </p>
            </section>
            <section>
              <h2>
                Dose leash <StatusTag kind="modelled" />
              </h2>
              <p>
                With a dose allowance of <Num v={r.leash.D_allow_mGy} units="mGy" file={F} k="rad.leash.D_allow_mGy" /> per EVA{' '}
                <AssumedTag note="Dose allowance per EVA: our assumption (D9), adjustable" />, the crew turns back when the walk home takes longer than the time left on
                the allowance. At the storm peak that time is{' '}
                <b>
                  <Num v={r.leash.tau_min_at_peak} units="min" file={F} k="rad.leash.tau_min_at_peak" />
                </b>
                .
              </p>
              <LeashSlider rad={r} />
            </section>
            <section>
              <h2>Weather, clock and space-weather context</h2>
              <Context />
            </section>
          </>
        )}
      </Show>
    </Page>
  )
}

export const view = preactView(() => <ConditionsView />)

const CF = 'conditions/clock.json'

/** WS4 clock.json: the simulated EVA window and daylight, and Mars time at H0 (structure from WS4). */
function ClockView({ c }: { c: Record<string, unknown> }) {
  const eva = c.eva as Record<string, unknown> | undefined
  const h0 = c.h0 as Record<string, unknown> | undefined
  if (!eva || !h0) return <LooseTable value={c} file={CF} />
  const n = (o: Record<string, unknown>, f: string) => (typeof o[f] === 'number' || typeof o[f] === 'string' ? (o[f] as number | string) : null)
  return (
    <>
      <dl class="kv-grid">
        <dt>
          Simulated EVA <span class="tag tag-simulated">simulated</span>
        </dt>
        <dd>
          sol <Num v={n(eva, 'msl_sol')} file={CF} k="clock.eva.msl_sol" />, start <Num v={n(eva, 'start_lmst')} file={CF} k="clock.eva.start_lmst" /> LMST (
          <Num v={n(eva, 'start_utc')} file={CF} k="clock.eva.start_utc" fmt={utcLabel} />) to <Num v={n(eva, 'end_utc')} file={CF} k="clock.eva.end_utc" fmt={utcLabel} />,{' '}
          <Num v={n(eva, 'eva_min')} units="min" file={CF} k="clock.eva.eva_min" />
        </dd>
        <dt>Daylight left at EVA start</dt>
        <dd>
          <b>
            <Num v={n(eva, 't_dark_min')} units="min" file={CF} k="clock.eva.t_dark_min" />
          </b>{' '}
          (sunset on a flat horizon <Num v={n(eva, 'sunset_flat_utc')} file={CF} k="clock.eva.sunset_flat_utc" fmt={utcLabel} />)
        </dd>
        <dt>Mars time at H0</dt>
        <dd>
          sol <Num v={n(h0, 'msl_sol')} file={CF} k="clock.h0.msl_sol" />, LMST <Num v={n(h0, 'lmst')} file={CF} k="clock.h0.lmst" />, Ls{' '}
          <Num v={n(h0, 'ls_deg')} units="deg" file={CF} k="clock.h0.ls_deg" />, Mars year <Num v={n(h0, 'mars_year')} file={CF} k="clock.h0.mars_year" />; one-way light time{' '}
          <Num v={n(h0, 'light_time_min')} units="min" file={CF} k="clock.h0.light_time_min" />
        </dd>
      </dl>
      {typeof eva.note === 'string' && <p class="caption">{eva.note}</p>}
      {typeof c.algorithm === 'string' && <p class="caption">Clock: {c.algorithm}.</p>}
    </>
  )
}

interface RemsVar {
  name: string
  units: string | null
  n_sols?: number
  daily_min?: { median: number | null; p10: number | null; p90: number | null }
  daily_max?: { median: number | null; p10: number | null; p90: number | null }
}

/** WS4 rems.json: same-season climatology per variable (median and P10-P90 of daily min and max). */
function RemsTable({ r }: { r: Record<string, unknown> }) {
  const RF = 'conditions/rems.json'
  const vars = Array.isArray(r.variables) ? (r.variables as RemsVar[]) : null
  if (!vars) return <LooseTable value={r} file={RF} />
  const cell = (i: number, which: 'daily_min' | 'daily_max', st?: { median: number | null; p10: number | null; p90: number | null }, units?: string | null) =>
    st ? (
      <>
        <Num v={st.median} units={units} file={RF} k={`rems.variables.${i}.${which}.median`} />{' '}
        <span class="muted">
          (<Num v={st.p10} file={RF} k={`rems.variables.${i}.${which}.p10`} /> to <Num v={st.p90} file={RF} k={`rems.variables.${i}.${which}.p90`} />)
        </span>
      </>
    ) : (
      <span class="num-unknown">unknown</span>
    )
  return (
    <>
      <table class="mini">
        <thead>
          <tr>
            <th>Variable</th>
            <th class="r">Daily minimum, median (P10 to P90)</th>
            <th class="r">Daily maximum, median (P10 to P90)</th>
          </tr>
        </thead>
        <tbody>
          {vars.map((v, i) => (
            <tr>
              <td>{v.name}</td>
              <td class="r">{cell(i, 'daily_min', v.daily_min, v.units)}</td>
              <td class="r">{cell(i, 'daily_max', v.daily_max, v.units)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class="caption">
        {typeof r.sols_used === 'number' ? (
          <>
            <Num v={r.sols_used} file={RF} k="rems.sols_used" /> sols in the same season
          </>
        ) : null}
        {typeof r.source === 'string' ? ` · ${r.source}` : ''}.
      </p>
    </>
  )
}

/** D34 / D35: the RAD dose column and its time tag, both unverified (G to check). */
function RadSourceNote({ r }: { r: Rad }) {
  const src = r.source
  if (!src?.component_label && !src?.time_tag_status) return null
  return (
    <p class="caption">
      {src.component_label && (
        <>
          Dose column {src.component ? <code>{src.component}</code> : null} = "{src.component_label}" (D34): {src.component_status ?? 'status not given'}
          {' '}
          <span class="pending">unverified</span>.{' '}
        </>
      )}
      {src.time_tag_status && <>RAD time tag: {src.time_tag_status}{src.series_time ? `; series times are the ${src.series_time}` : ''}.</>}
    </p>
  )
}

/**
 * Storm numbers (D35, D36): tripwire time with its half-width, excess as a lower bound with the
 * end-of-window rate vs baseline, dose equivalent at ⟨Q⟩ ≈ 1.
 */
export function StormNumbers({ r }: { r: Rad }) {
  const s = r.storm_2024
  const lower = s.excess_is_lower_bound === true
  return (
    <>
      <p>
        Peak <Num v={s.peak_uGy_day} units="uGy/day" file={F} k="rad.storm_2024.peak_uGy_day" />; event excess {lower ? '≥ ' : ''}
        <Num v={s.excess_mGy} units="mGy" file={F} k="rad.storm_2024.excess_mGy" dp={lower ? 2 : undefined} />
        {lower ? ' (lower bound: the fixed storm window ends while the rate is still above baseline)' : ''}. Onset{' '}
        <Num v={s.onset_utc} file={F} k="rad.storm_2024.onset_utc" fmt={utcLabel} />; the tripwire fired at{' '}
        <Num v={s.tripwire_utc} file={F} k="rad.storm_2024.tripwire_utc" fmt={utcLabel} />
        {s.tripwire_halfwidth_label ? (
          <>
            {' '}
            <Num v={s.tripwire_halfwidth_label} file={F} k="rad.storm_2024.tripwire_halfwidth_label" />
          </>
        ) : null}
        .
      </p>
      {s.dose_equivalent_mSv !== undefined && (
        <p>
          Dose equivalent ≈ <Num v={s.dose_equivalent_mSv ?? null} units="mSv" file={F} k="rad.storm_2024.dose_equivalent_mSv" dp={1} /> at ⟨Q⟩ ≈{' '}
          <CfgNum v={CITED.qSep.value} source={CITED.qSep.source} /> for the SEP.
        </p>
      )}
      {s.end_of_window_rate_uGy_day !== undefined && (
        <p class="caption">
          End of the storm window (<Num v={s.end_of_window_utc ?? null} file={F} k="rad.storm_2024.end_of_window_utc" fmt={utcLabel} />): rate{' '}
          <Num v={s.end_of_window_rate_uGy_day ?? null} units="uGy/day" file={F} k="rad.storm_2024.end_of_window_rate_uGy_day" />,{' '}
          <Num v={s.end_of_window_rate_over_baseline_ratio ?? null} file={F} k="rad.storm_2024.end_of_window_rate_over_baseline_ratio" /> × baseline (+
          <Num v={s.end_of_window_rate_minus_baseline_uGy_day ?? null} units="uGy/day" file={F} k="rad.storm_2024.end_of_window_rate_minus_baseline_uGy_day" />
          ).
        </p>
      )}
      {s.tripwire_halfwidth_rule && <p class="caption">Tripwire time uncertainty: {s.tripwire_halfwidth_rule}.</p>}
    </>
  )
}
