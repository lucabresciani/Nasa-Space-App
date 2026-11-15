// Permalink, provenance and play views of one result (F28, F35, F24). Pure function components of
// their props (no hooks), so the tests render them without a DOM. Numbers go through LiveNum against
// the result's own manifest.json, with the static console's file names and manifest keys, so the
// official hash shows the console's numbers. Every view carries the origin's label from config
// (labels.live for computed results, labels.precomputed for the official tree) and a provenance link.
import type { ComponentChildren } from 'preact'
import { headline60, marginLabel, tightestMargin } from '../views/decisions'
import { routeSummary } from '../views/route'
import { LIVE_LABEL, OFFLINE_LABEL, PRECOMPUTED_LABEL, TITLE_MAX_CHARS, UPLOAD_MAX_BYTES } from './config'
import { LiveNum } from './num'
import { canonicalJson, exportPlanInputs } from './planio'
import { planUrl, recordRoute, type ImportState, type PlanLoad, type PlanTree } from './plan'
import { stopTexts } from './plans/route'
import { planId } from './plans/store'
import { MyPlans, SavePlan, type MyPlansProps } from './plans/view'
import { RangeFlags } from './rangeflags'
import { SimSlot } from './simslot'
import type { RunOrigin, RunRecord } from './types'

/** The label of a result by origin, from config/backend.yaml labels. */
export function labelFor(origin: RunOrigin): string {
  return origin === 'precomputed' ? PRECOMPUTED_LABEL : LIVE_LABEL
}

/**
 * Label + provenance link: on every view of a result. Without an origin (the run record has not
 * loaded, or never will: offline, not found) no origin label is drawn, only a neutral placeholder on
 * the same line, so the official tree never reads as computed live and nothing jumps when it loads.
 */
export function PlanTag({ hash, origin }: { hash: string; origin: RunOrigin | null }) {
  return (
    <p class="live-label" data-origin={origin ?? ''}>
      {origin ? (
        <>
          {labelFor(origin)} ·{' '}
        </>
      ) : (
        <span class="live-origin-pending" aria-hidden="true">
          {'\u00a0'}
        </span>
      )}
      <a class="live-prov" href={planUrl(hash, 'provenance')}>
        provenance of plan {hash}
      </a>
    </p>
  )
}

function Page({ children }: { children: ComponentChildren }) {
  return <div class="page live-plan-page">{children}</div>
}

/**
 * Not found, offline or broken answers: a message, never a crash. With `plans`, "My plans" follows,
 * so saved plans stay listed and exportable while the live server is unreachable.
 */
export function PlanProblem({ load, plans }: { load: Exclude<PlanLoad, { state: 'ok' }>; plans?: MyPlansProps }) {
  return (
    <Page>
      <h1>Plan {load.hash}</h1>
      {load.state === 'notfound' ? (
        <p class="live-notfound" role="alert">
          Plan not found: {load.reason}. A permalink opens a result the server has computed. <a href="#/">Back to the plan</a>.
        </p>
      ) : load.state === 'offline' ? (
        <p class="live-offline" role="status">
          {OFFLINE_LABEL}. This plan needs the live server. <a href="#/">Back to the plan</a>.
        </p>
      ) : (
        <p class="live-failed" role="alert">
          This plan could not be shown: {load.message}
        </p>
      )}
      <PlanTag hash={load.hash} origin={null} />
      {plans && <MyPlans {...plans} />}
    </Page>
  )
}

/** While a permalink loads: the origin label once the run record is in (origin), a placeholder before. */
export function PlanLoading({ hash, origin = null }: { hash: string; origin?: RunOrigin | null }) {
  return (
    <Page>
      <h1>Plan {hash}</h1>
      <p class="muted">Loading…</p>
      <PlanTag hash={hash} origin={origin} />
    </Page>
  )
}

const INDEX = 'scenarios/index.json'

/** The console's headline (30-min figure, range, 60-min line), from the result's index and manifest. */
export function PlanHeadline({ tree, hash }: { tree: PlanTree; hash: string }) {
  const s = tree.scenario
  if (!s) return <p class="muted">No scenario in this result yet.</p>
  const m = tree.manifest
  const h = s.headline
  const hb = h.budget_min
  const h60 = headline60(s)
  return (
    <section class="headline live-headline">
      <div class="headline-value">
        <LiveNum v={h.reachable_pct} units="%" file={INDEX} k={`reachable_pct.${s.id}.${hb}`} manifest={m} hash={hash} />
      </div>
      <div class="headline-text">
        reachable of the <i>assessed</i> flat disc within {hb} min.
        <br />
        Range <LiveNum v={h.range_pct[0]} units="%" file={INDEX} k={`reachable_pct_range.${s.id}.${hb}.low`} manifest={m} hash={hash} /> (conservative) to{' '}
        <LiveNum v={h.range_pct[1]} units="%" file={INDEX} k={`reachable_pct_range.${s.id}.${hb}.high`} manifest={m} hash={hash} /> (optimistic)
      </div>
      {h60 && (
        <div class="headline-60 caption">
          Within {h60.budget} min: <LiveNum v={h60.reachablePct} units="%" file={INDEX} k={`reachable_pct.${s.id}.${h60.budget}`} manifest={m} hash={hash} />
          {h60.range && (
            <>
              {' '}
              (<LiveNum v={h60.range[0]} units="%" file={INDEX} k={`reachable_pct_range.${s.id}.${h60.budget}.low`} manifest={m} hash={hash} /> to{' '}
              <LiveNum v={h60.range[1]} units="%" file={INDEX} k={`reachable_pct_range.${s.id}.${h60.budget}.high`} manifest={m} hash={hash} />)
            </>
          )}
          .
        </div>
      )}
      <p class="caption">
        Scenario <code>{s.id}</code>
      </p>
    </section>
  )
}

/** Route stops, total and tightest margin, with the console's keys (route.{sid}, timeline.{sid}). */
export function PlanRouteSection({ tree, hash }: { tree: PlanTree; hash: string }) {
  const s = tree.scenario
  const r = routeSummary(tree.route)
  if (!s || !r) return <p class="muted">No route in this result{tree.route ? ' (no reachable station)' : ''}.</p>
  const tf = `timeline_${s.id}.json`
  const tight = tightestMargin(tree.timeline)
  return (
    <section class="live-route">
      <h3>Planned route</h3>
      <ol class="route-stops">
        {r.stops.map((st) => (
          <li>{st === 'pad' ? 'Pad' : st}</li>
        ))}
      </ol>
      <p>
        Total <LiveNum v={r.endMin} units="min" file={tf} k={`route.${s.id}.total_min`} manifest={tree.manifest} hash={hash} />
      </p>
      {tight && (
        <p>
          Tightest margin <LiveNum v={tight.e.margin_min} units="min" file={tf} k={`timeline.${s.id}.${tight.i}.margin_min`} manifest={tree.manifest} hash={hash} /> (
          {marginLabel(tight.e.margin_binding)}
          {tight.e.station ? `, ${tight.e.event} ${tight.e.station}` : ''})
        </p>
      )}
    </section>
  )
}

/** How the route was chosen (D97): auto (the engine's choice) or the user's order with its stops. */
export function PlanRouteMode({ record }: { record: RunRecord }) {
  const r = recordRoute(record)
  return (
    <section class="live-route-mode" data-route-mode={r.mode}>
      <p>
        Route mode: <b>{r.mode}</b> {r.mode === 'ordered' ? '(your stops, computed in the order given)' : '(the engine chose the stations and their order)'}
      </p>
      {r.mode === 'ordered' && r.stops && r.stops.length > 0 && (
        <ol class="live-route-stops">
          {stopTexts(r.stops).map((t) => (
            <li>{t}</li>
          ))}
        </ol>
      )}
    </section>
  )
}

export interface PlanActionsProps {
  record: RunRecord
  hash: string
  /** Absolute permalink (planmount.tsx: location origin + path + #/plan/{hash}). */
  permalink: string
}

/** Play, provenance, JSON export and the permalink. */
export function PlanActions({ record, hash, permalink }: PlanActionsProps) {
  const ex = exportPlanInputs(record.inputs)
  return (
    <section class="live-card live-actions">
      <p>
        <a class="live-btn live-play" href={planUrl(hash, 'play')}>
          Play this plan
        </a>{' '}
        <a class="live-btn live-export" href={ex.href} download={ex.fileName}>
          Export {ex.fileName}
        </a>{' '}
        <a class="live-btn" href={planUrl(hash, 'provenance')}>
          Provenance
        </a>
      </p>
      <p class="caption">
        Permalink: <a class="live-permalink" href={planUrl(hash)}>{permalink}</a>
      </p>
    </section>
  )
}

export interface ImportPanelProps {
  state: ImportState
  /** Called with the picked file (planmount.tsx wires it to importPlanFile). */
  onFile: (file: File) => void
}

/** File picker for a plan_inputs.json and the import's progress. */
export function ImportPanel({ state, onFile }: ImportPanelProps) {
  const busy = state.kind === 'reading' || state.kind === 'checking' || state.kind === 'computing'
  return (
    <section class="live-card live-import">
      <h3>Open a plan_inputs.json</h3>
      <input
        type="file"
        accept="application/json,.json"
        disabled={busy}
        onChange={(e) => {
          const f = (e.currentTarget as HTMLInputElement).files?.[0]
          if (f) onFile(f)
        }}
      />
      <p class="caption">
        Checked here first against plan_inputs.schema.json (unknown fields refused), at most {UPLOAD_MAX_BYTES} bytes and a title of at most {TITLE_MAX_CHARS} characters.
      </p>
      <ImportStatus state={state} />
    </section>
  )
}

function InputsBlock({ inputs }: { inputs: unknown }) {
  return <pre class="live-inputs">{canonicalJson(inputs)}</pre>
}

export function ImportStatus({ state }: { state: ImportState }) {
  switch (state.kind) {
    case 'idle':
      return null
    case 'reading':
      return <p class="muted">Reading the file…</p>
    case 'rejected':
      return (
        <div class="live-invalid" role="alert">
          <p class="live-reason">This file is not a valid plan_inputs.json:</p>
          <ul class="live-errors">
            {state.errors.map((e) => (
              <li>{e}</li>
            ))}
          </ul>
        </div>
      )
    case 'checking':
      return <p class="muted">Asking the server for the plan's hash…</p>
    case 'offline':
      return (
        <div class="live-offline" role="status">
          <p>{OFFLINE_LABEL}. The file is valid; its inputs:</p>
          <InputsBlock inputs={state.inputs} />
        </div>
      )
    case 'computing':
      return (
        <div>
          <p class="live-label">{LIVE_LABEL}</p>
          <p>
            Computing the plan{state.job ? ` ${state.job.hash}` : ''}
            {state.job?.stage ? ` · stage ${state.job.stage}` : ''}
            {state.job?.status === 'queued' ? ' · queued' : ''}…
          </p>
        </div>
      )
    case 'failed':
      return (
        <div class="live-failed" role="alert">
          <p>The import failed: {state.message}</p>
          <InputsBlock inputs={state.inputs} />
        </div>
      )
    case 'opened':
      return <p class="live-ok">Opening plan {state.hash}…</p>
  }
}

export interface PlanPageProps {
  load: Extract<PlanLoad, { state: 'ok' }>
  permalink: string
  /** SIM_EXPORT_ENABLED. */
  simEnabled: boolean
  importState: ImportState
  onImportFile: (file: File) => void
  /** "My plans" (D97); absent: not shown. */
  plans?: MyPlansProps
}

/** #/plan/{hash}: the result read-only. The map (when mounted) draws through ConsoleMap. */
export function PlanPage({ load, permalink, simEnabled, importState, onImportFile, plans }: PlanPageProps) {
  const { hash, record, tree, base } = load
  const title = typeof record.inputs.title === 'string' ? record.inputs.title : null
  return (
    <Page>
      <PlanTag hash={hash} origin={record.origin} />
      <h1>
        Plan <code>{hash}</code>
        {title ? <span class="muted"> · {title}</span> : null}
      </h1>
      {record.status !== 'done' && <p class="live-label">Run status: {record.status}. Files not written yet are left out.</p>}
      {tree.errors.length > 0 && (
        <ul class="live-errors">
          {tree.errors.map((e) => (
            <li>
              {e.path}: {e.message}
            </li>
          ))}
        </ul>
      )}
      <RangeFlags flags={record.range_flags} />
      <PlanHeadline tree={tree} hash={hash} />
      <PlanRouteMode record={record} />
      <PlanRouteSection tree={tree} hash={hash} />
      <PlanActions record={record} hash={hash} permalink={permalink} />
      {plans && <SavePlan hash={hash} id={planId(hash, record.inputs)} snap={plans.snap} onSave={plans.onSave} />}
      <SimSlot enabled={simEnabled} manifest={tree.manifest} base={base} />
      <ImportPanel state={importState} onFile={onImportFile} />
      {plans && <MyPlans {...plans} />}
    </Page>
  )
}

/** #/plan: import, and "My plans" when given. */
export function ImportPage({ state, onFile, plans }: ImportPanelProps & { plans?: MyPlansProps }) {
  return (
    <Page>
      <h1>Open a plan</h1>
      <p>A plan is shared as a permalink (#/plan/&#123;hash&#125;) or as its plan_inputs.json file. No account is needed.</p>
      <ImportPanel state={state} onFile={onFile} />
      {plans && <MyPlans {...plans} />}
    </Page>
  )
}

/** #/plan/{hash}/provenance (F35 verify view): the run record. */
export function ProvenancePage({ load }: { load: Extract<PlanLoad, { state: 'ok' }> }) {
  const { record: r, hash } = load
  const rows: [string, ComponentChildren][] = [
    ['Origin', <span class="live-origin">{r.origin}</span>],
    ['Label', <span class="live-origin-label">{labelFor(r.origin)}</span>],
    ['Status', r.status],
    ['Route mode', <span class="live-route-mode-value">{recordRoute(r).mode}</span>],
    ['Engine tree (git HEAD:pipeline)', <code>{r.engine.tree}</code>],
    ['Engine commit', <code>{r.engine.commit}</code>],
    ['Config hash', <code>{r.engine.config_hash}</code>],
    ['Terrain hash', <code>{r.terrain_hash}</code>],
    ['Contracts', `web ${r.engine.web_contract_version ?? '?'} · backend ${r.engine.backend_contract_version ?? '?'} · run record ${r.contract_version}`],
    ['Started (UTC)', r.started_utc],
    ['Finished (UTC)', r.finished_utc ?? 'not finished'],
    ['Files', `${r.files.length} (each with sha256 and contract)`],
  ]
  return (
    <Page>
      <PlanTag hash={hash} origin={r.origin} />
      <h1>
        Provenance of plan <code>{hash}</code>
      </h1>
      <p>
        <a href={planUrl(hash)}>Back to the plan</a>
      </p>
      <table class="mini live-prov-table">
        <tbody>
          {rows.map(([k, v]) => (
            <tr>
              <th>{k}</th>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Timings</h3>
      {r.stages.length ? (
        <table class="mini live-stages">
          <thead>
            <tr>
              <th>Stage</th>
              <th>Started (UTC)</th>
              <th class="r">Seconds</th>
            </tr>
          </thead>
          <tbody>
            {r.stages.map((s) => (
              <tr>
                <td>{s.name}</td>
                <td>{s.started_utc ?? ''}</td>
                <td class="r">{String(s.seconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p class="muted">No stages recorded (a precomputed tree is not run by the server).</p>
      )}
      <RangeFlags flags={r.range_flags} />
      {r.infeasible && (
        <p class="live-failed">
          Infeasible from leg {r.infeasible.leg} ({r.infeasible.from} → {r.infeasible.to}), binding: {r.infeasible.binding}
        </p>
      )}
      {r.error && <p class="live-failed">Error: {r.error}</p>}
      <h3>Inputs (plan_inputs.json, defaults filled)</h3>
      <InputsBlock inputs={r.inputs} />
    </Page>
  )
}

/** Header of #/plan/{hash}/play; the HUD mounts below it (planmount.tsx). */
export function PlayHeader({ load }: { load: Extract<PlanLoad, { state: 'ok' }> }) {
  return (
    <div class="live-play-head">
      <PlanTag hash={load.hash} origin={load.record.origin} />
      <p>
        Playing plan <code>{load.hash}</code> in the 2D HUD · <a href={planUrl(load.hash)}>back to the plan</a>
      </p>
    </div>
  )
}
