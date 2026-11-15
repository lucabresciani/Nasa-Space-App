// Pad tool panel (F24): validation feedback, instant preview card, full plan with staged results.
// Pure function components of PadToolState (no hooks), so tests render them without a DOM.
// Every live view carries LIVE_LABEL and a provenance link (kit rule 6): #/plan/{hash} once a job
// has a hash, before that the engine identity that answered (GET /engine/version).
import { LIVE_LABEL } from './config'
import { bannerFor } from './health'
import { LiveNum, planHref, ScreenNum } from './num'
import type { PadToolActions, PadToolState, PlanState, RecordState } from './padtool'
import { RangeFlags } from './rangeflags'
import type { StageResult } from './stage'
import type { PadCheck, PadReason, PadScreen } from './types'

/** Plain-language text per PadCheck.reason (openapi enum). */
export const REASON_TEXT: Record<Exclude<PadReason, null>, string> = {
  slope: 'Too steep: the block breaks the D21 slope limit',
  unknown_terrain: 'No 1 m terrain here',
  disc_off_grid: 'The flat 30-min disc around this pad leaves the terrain grid',
  outside_grid: 'Outside the terrain grid',
}

const fmtDeg = (v: number) => v.toFixed(6) // input coordinates (user click), not a computed number

function LiveTag({ href, text }: { href: string; text: string }) {
  return (
    <p class="live-label">
      {LIVE_LABEL} · <a class="live-prov" href={href}>{text}</a>
    </p>
  )
}

function CheckView({ check, actions }: { check: PadCheck; actions: PadToolActions }) {
  if (check.valid) return <p class="live-ok">Valid pad (D21 rule)</p>
  const n = check.nearest_valid
  return (
    <div class="live-invalid" role="alert">
      <p class="live-reason" data-reason={check.reason ?? ''}>
        {check.reason ? REASON_TEXT[check.reason] : 'Not a valid pad'}
        {check.detail ? ` (${check.detail})` : ''}
      </p>
      {n ? (
        <p class="live-nearest">
          Nearest valid block: {fmtDeg(n.lon)}°E {fmtDeg(n.lat)}°N, <ScreenNum v={n.distance_m} units="m" /> away{' '}
          <button type="button" class="live-btn" onClick={() => actions.useNearest()}>
            Use the nearest valid block
          </button>
        </p>
      ) : (
        <p class="live-nearest muted">No valid block nearby.</p>
      )}
    </div>
  )
}

function PreviewCard({ screen, canCompute, heavyOff, blocked, actions }: { screen: PadScreen; canCompute: boolean; heavyOff: boolean; blocked: string | null; actions: PadToolActions }) {
  return (
    <section class="live-card live-preview">
      <h3>Instant preview</h3>
      <p>
        Feasible EVAs (D21 score): <ScreenNum v={screen.feasible_evas} />
      </p>
      <table class="mini live-stations">
        <thead>
          <tr>
            <th>Station</th>
            <th>Reachable</th>
            <th>Out</th>
            <th>Home</th>
          </tr>
        </thead>
        <tbody>
          {screen.stations.map((s) => (
            <tr key={s.id} data-station={s.id}>
              <td>{s.id}</td>
              <td>{s.reachable ? 'yes' : 'no'}</td>
              <td>
                <ScreenNum v={s.t_out_min} units="min" />
              </td>
              <td>
                <ScreenNum v={s.t_home_min} units="min" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {screen.best_route ? (
        <p class="live-best">
          Best route estimate: pad → {screen.best_route.order.join(' → ')} → pad, <ScreenNum v={screen.best_route.total_min} units="min" />
        </p>
      ) : (
        <p class="muted">No route estimate.</p>
      )}
      <p class="muted">{screen.label}</p>
      <button type="button" class="live-btn live-compute" disabled={!canCompute} onClick={() => actions.computePlan()}>
        Compute full plan
      </button>
      {heavyOff ? <p class="muted">Full plans are switched off on the server right now.</p> : null}
      {blocked ? (
        <p class="live-failed" role="alert">
          {blocked}
        </p>
      ) : null}
    </section>
  )
}

function Headline({ r, hash }: { r: StageResult; hash: string }) {
  const s = r.scenario
  if (!s) return <p class="muted">No scenario index yet.</p>
  const h = s.headline
  const b = h.budget_min
  return (
    <p class="live-headline">
      Reachable within a {b}-min walk home ({s.id}):{' '}
      <LiveNum v={h.reachable_pct} units="%" file="scenarios/index.json" k={`reachable_pct.${s.id}.${b}`} manifest={r.manifest} hash={hash} />
      {h.range_pct[0] !== null || h.range_pct[1] !== null ? (
        <>
          {' '}
          (range <LiveNum v={h.range_pct[0]} units="%" file="scenarios/index.json" k={`reachable_pct_range.${s.id}.${b}.low`} manifest={r.manifest} hash={hash} /> to{' '}
          <LiveNum v={h.range_pct[1]} units="%" file="scenarios/index.json" k={`reachable_pct_range.${s.id}.${b}.high`} manifest={r.manifest} hash={hash} />)
        </>
      ) : null}
    </p>
  )
}

/** Range flags of the finished plan, from its run record (read once the job is done). */
function RecordFlags({ record }: { record: RecordState }) {
  if (record.kind === 'loading') return <p class="muted">Reading the run record…</p>
  if (record.kind === 'error') return <p class="live-failed">Run record not shown: {record.message}</p>
  if (record.kind !== 'done') return null
  const flags = record.record.range_flags ?? []
  return flags.length ? <RangeFlags flags={flags} title="Range flags (run record)" /> : <p class="live-ok live-no-flags">No range flags: every input is inside its validated range.</p>
}

function PlanView({ plan, record, actions }: { plan: Exclude<PlanState, { kind: 'idle' }>; record: RecordState; actions: PadToolActions }) {
  const job = plan.job
  const r = plan.result
  return (
    <section class="live-card live-plan" data-plan={plan.kind}>
      <h3>Full plan</h3>
      {job ? <LiveTag href={planHref(job.hash)} text={`provenance of plan ${job.hash}`} /> : <p class="live-label">{LIVE_LABEL}</p>}
      {plan.kind === 'running' ? (
        <p class="live-progress">
          {!job || job.status === 'queued' ? 'Queued' : `Running stage ${job.stage ?? '…'}`}
          {job ? <progress max={1} value={job.progress} /> : null}{' '}
          <button type="button" class="live-btn" onClick={() => actions.cancelPlan()}>
            Cancel
          </button>
        </p>
      ) : null}
      {plan.kind === 'done' ? <p class="live-ok">All stages done.</p> : null}
      {plan.kind === 'failed' ? (
        <p class="live-failed" role="alert">
          The plan failed: {plan.error}
          {plan.retryAfterS ? `; try again in ${plan.retryAfterS} s` : ''}.
        </p>
      ) : null}
      {plan.kind === 'cancelled' ? <p class="muted">Cancelled.</p> : null}
      {job && (plan.kind === 'running' || plan.kind === 'done') && plan.attached ? <p class="muted live-attached">Same inputs as an earlier run: attached to plan {job.hash} (not computed again).</p> : null}
      {job && job.stages_done.length ? <p class="live-stages">Stages on the map: {job.stages_done.join(', ')}</p> : null}
      {plan.kind === 'done' ? <RecordFlags record={record} /> : null}
      {r && job ? <Headline r={r} hash={job.hash} /> : null}
      {r && r.errors.length ? (
        <ul class="live-errors">
          {r.errors.map((e) => (
            <li key={e.path}>
              {e.path}: not shown ({e.message})
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

export interface PadToolPanelProps {
  state: PadToolState
  actions: PadToolActions
  /** Provenance before a job exists: the engine identity that answers (client.root + /engine/version). */
  engineHref: string
  /** Why "Compute full plan" is blocked (the crew panel: a field is not a number), or null. */
  computeBlocked?: string | null
}

/** null while live planning is offline, warming or checking: the controls hide behind U1's banner. */
export function PadToolPanel({ state, actions, engineHref, computeBlocked = null }: PadToolPanelProps) {
  const banner = bannerFor(state.live)
  if (!banner.controls) return null
  const { pad, check, preview, plan } = state
  const valid = check.kind === 'done' && check.result.valid
  return (
    <section class="live-pad" aria-label="Live pad tool">
      <h2>Live pad</h2>
      <LiveTag href={engineHref} text="provenance: engine version" />
      {!pad ? <p class="muted">Click the map to try a pad location.</p> : null}
      {pad ? (
        <p class="live-pad-pos">
          Pad {fmtDeg(pad.lon)}°E {fmtDeg(pad.lat)}°N{' '}
          <button type="button" class="live-btn" onClick={() => actions.clear()}>
            Clear
          </button>
        </p>
      ) : null}
      {check.kind === 'checking' ? <p class="muted">Checking the pad…</p> : null}
      {check.kind === 'error' ? (
        <p class="live-failed" role="alert">
          Could not check the pad: {check.message}
        </p>
      ) : null}
      {check.kind === 'done' ? <CheckView check={check.result} actions={actions} /> : null}
      {valid && preview.kind === 'loading' ? <p class="muted">Loading the instant preview…</p> : null}
      {valid && preview.kind === 'error' ? (
        <p class="live-failed" role="alert">
          No preview: {preview.message}
        </p>
      ) : null}
      {valid && preview.kind === 'done' ? (
        <PreviewCard screen={preview.screen} canCompute={banner.heavyJobs && plan.kind !== 'running' && !computeBlocked} heavyOff={!banner.heavyJobs} blocked={computeBlocked} actions={actions} />
      ) : null}
      {plan.kind !== 'idle' ? <PlanView plan={plan} record={state.record} actions={actions} /> : null}
    </section>
  )
}
