// Edit-route panel (R5, D97 §3): Plan rail section in live builds. RoutePanelView is a pure function
// of its props (tests render it without hooks); RoutePanel binds it to the controller's signals.
//   mode       Engine chooses (auto: no route sent) / My order (ordered)
//   stations   the six stations: checkbox + drag handle; checked ones first in route order; Alt+Up/Down
//              moves the focused one (keyboard alternative of the drag); validity per stop
//   compute    Compute plan -> one live job; stages appear as they finish (nominal band and route
//              first); the result carries "Computed live · your route" and a provenance link
//   infeasible the first failing leg, its limit and the time short; that leg is marked in the legs list
//              and on the map; nothing is reordered
// Every edit is one undo step (route store); Ctrl+Z / Ctrl+Shift+Z inside the panel, or the buttons.
import { signal, useSignalValue, type ReadSignal } from '../../state/signal'
import { Button, IconButton } from '../../ui/components/Button'
import { cx, Icon } from '../../ui/components/Icon'
import type { ComputeState, RouteController } from './controller'
import { isStationStop, ROUTE_LIMITS, type PlanRoute, type RouteCheck, type StationGeo, type StopCheck } from './model'
import { failureText, fill, LIMIT_TEXT, ROUTE_PROBLEM_TEXT, ROUTE_TEXT as T, STOP_PROBLEM_TEXT } from './text'
import { AddPointButton, GhostSummary, PointRowBody } from './map/rows'
import './route.css'

export interface RouteRow {
  id: string
  name: string
  checked: boolean
  /** index in route.stops, null when unchecked */
  index: number | null
  check: StopCheck | null
  /** WP6: a free point (W1, W2, …) and its label; absent for a station */
  point?: { label: string | undefined }
}

/** Checked stations and free points first, in route order, then the unchecked stations in stations.json order. */
export function routeRows(route: PlanRoute, stations: readonly StationGeo[], check: RouteCheck): RouteRow[] {
  const name = (id: string) => stations.find((s) => s.id === id)?.name ?? id
  const rows: RouteRow[] = []
  let w = 0
  route.stops.forEach((s, i) => {
    if (isStationStop(s)) rows.push({ id: s.station, name: name(s.station), checked: true, index: i, check: check.stops[i] ?? null })
    else rows.push({ id: `W${++w}`, name: s.label ?? '', checked: true, index: i, check: check.stops[i] ?? null, point: { label: s.label } })
  })
  for (const s of stations) if (!rows.some((r) => r.id === s.id)) rows.push({ id: s.id, name: s.name ?? s.id, checked: false, index: null, check: null })
  return rows
}

function stopStatus(c: StopCheck | null): { text: string; state: 'valid' | 'invalid' | 'unknown' } | null {
  if (!c) return null
  if (c.valid === false)
    return { state: 'invalid', text: c.problems.map((p) => fill(STOP_PROBLEM_TEXT[p], { m: ROUTE_LIMITS.minStopSpacingM, n: ROUTE_LIMITS.maxStops })).join(', ') }
  return c.valid ? { state: 'valid', text: T.stopValid } : { state: 'unknown', text: T.stopUnknown }
}

export interface RoutePanelViewProps {
  ctl: RouteController
  route: PlanRoute
  check: RouteCheck
  compute: ComputeState
  hash: string | undefined
  canUndo: boolean
  canRedo: boolean
  dragging: number | null
  /** live planning can take a job now */
  live: boolean
  /** why it cannot (offline, warming, heavy jobs off); null = the generic reason */
  reason?: string | null
}


function StageList({ c }: { c: Extract<ComputeState, { kind: 'running' | 'done' | 'failed' }> }) {
  const layers = c.stage?.layers ?? []
  const first = layers.includes('bands') && layers.includes('route')
  const rest = ['isochrones', 'edges', 'partner'].some((l) => layers.includes(l)) && (c.kind !== 'running' || (c.job?.stagesDone.length ?? 0) > 1)
  return (
    <div class="hl-route__stages" data-trust="live">
      <h4 class="hl-route__subtitle">{T.stagesTitle}</h4>
      <ol class="hl-route__stagelist">
        <li class={cx('hl-route__stage', first && 'is-shown')} data-stage="first">
          {T.stageFirst} · {first ? T.stageShown : T.stageWaiting}
        </li>
        <li class={cx('hl-route__stage', rest && 'is-shown')} data-stage="rest">
          {T.stageRest} · {rest ? T.stageShown : T.stageWaiting}
        </li>
      </ol>
      {c.kind === 'running' && c.job ? (
        <p class="hl-route__progress" role="status">
          {c.job.stage ?? c.job.status} · {Math.round(c.job.progress * 100)} %
        </p>
      ) : null}
      {c.stage?.errors.length ? <p class="hl-route__warn">{c.stage.errors.join('; ')}</p> : null}
    </div>
  )
}

function ResultView({ c }: { c: Extract<ComputeState, { kind: 'done' }> }) {
  const r = c.result
  const f = r.feasibility
  return (
    <div class="hl-route__result" data-trust="live" data-hash={r.hash}>
      <p class="hl-route__label">
        {T.computedLabel} ·{' '}
        <a class="hl-route__prov" href={r.provenanceHref}>
          {T.provenance} {r.hash}
        </a>
        {r.engineCommit ? <span class="hl-route__commit"> · engine {r.engineCommit.slice(0, 8)}</span> : null}
      </p>
      {r.recordError ? <p class="hl-route__warn">{r.recordError}</p> : null}
      {f === null ? <p class="hl-route__note">{T.feasibilityUnknown}</p> : null}
      {f?.feasible ? <p class="hl-route__ok">{T.feasible}</p> : null}
      {f && !f.feasible ? (
        <div class="hl-route__infeasible" role="alert" data-leg={f.leg} data-limit={f.limit}>
          <p class="hl-route__infeasible-title">
            <Icon name="triangle-alert" /> {T.infeasibleTitle}
          </p>
          <p class="hl-route__infeasible-leg">{fill(T.infeasibleLeg, { n: f.leg + 1, from: f.from, to: f.to })}</p>
          <p class="hl-route__infeasible-limit">{fill(T.infeasibleLimit, { limit: LIMIT_TEXT[f.limit as keyof typeof LIMIT_TEXT] ?? f.limit })}</p>
          <p class="hl-route__infeasible-short">
            {f.shortfallMin === null ? (
              T.infeasibleShortUnknown
            ) : (
              <span class="num" data-trust="live" title={`${T.computedLabel} · run record ${r.hash}`}>
                {fill(T.infeasibleShort, { min: f.shortfallMin.toFixed(1) })}
              </span>
            )}
          </p>
          <p class="hl-route__note">{T.infeasibleNote}</p>
        </div>
      ) : null}
    </div>
  )
}

export function RoutePanelView(p: RoutePanelViewProps) {
  const { ctl, route, check, compute: c } = p
  const ordered = route.mode === 'ordered'
  const rows = routeRows(route, ctl.stations, check)
  const running = c.kind === 'running'
  const failing = c.kind === 'done' && c.result.feasibility && !c.result.feasibility.feasible ? c.result.feasibility.leg : null
  const stopName = (i: number) => {
    const s = route.stops[i]
    return s ? (isStationStop(s) ? s.station : (s.label ?? null)) : null
  }

  const onKey = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase()
    if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) {
      e.preventDefault()
      e.stopPropagation() // the panel's own undo, not the plan-edit store's (shell shortcut)
      if (k === 'y' || e.shiftKey) ctl.redo()
      else ctl.undo()
    }
  }
  const onRowKey = (row: RouteRow) => (e: KeyboardEvent) => {
    if (!e.altKey || row.index === null || !ordered) return
    const dir = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0
    if (!dir) return
    e.preventDefault()
    e.stopPropagation()
    ctl.move(row.index, row.index + dir)
  }

  return (
    <div class="hl-route" onKeyDown={onKey} data-mode={route.mode} data-state={c.kind} data-feasible={c.kind === 'done' && c.result.feasibility ? String(c.result.feasibility.feasible) : undefined}>
      {/* the answer first: visible without scrolling the rail (R5-C); details below */}
      {c.kind === 'done' ? <ResultView c={c} /> : null}
      {c.kind === 'failed' ? (
        <div class="hl-route__failed" role="alert" data-status={c.failure.status} data-code={c.failure.code}>
          <p class="hl-route__infeasible-title">
            <Icon name="circle-alert" /> {T.failedTitle}
          </p>
          <p>{failureText(c.failure, stopName)}</p>
        </div>
      ) : null}
      {c.kind === 'cancelled' ? <p class="hl-route__note">{T.cancelled}</p> : null}
      {c.kind === 'running' || c.kind === 'done' || c.kind === 'failed' ? <StageList c={c} /> : null}
      <div class="hl-route__mode" role="radiogroup" aria-label={T.modeLabel}>
        {(['auto', 'ordered'] as const).map((m) => (
          <button
            type="button"
            role="radio"
            class="hl-route__modebtn"
            aria-checked={route.mode === m ? 'true' : 'false'}
            data-value={m}
            disabled={running}
            onClick={() => ctl.setMode(m)}
          >
            {m === 'auto' ? T.modeAuto : T.modeOrdered}
          </button>
        ))}
      </div>
      <p class="hl-route__note">{ordered ? T.orderedNote : T.autoNote}</p>

      <ol class="hl-route__stops" aria-label={T.stopsLabel} data-dragging={p.dragging !== null ? 'true' : undefined}>
        {rows.map((row) => {
          const st = stopStatus(row.check)
          const movable = ordered && row.index !== null && !running
          return (
            <li
              key={row.id}
              class={cx('hl-route__stop', row.checked && 'is-checked', p.dragging !== null && p.dragging === row.index && 'is-dragging')}
              data-station={row.point ? undefined : row.id}
              data-point={row.point ? row.id : undefined}
              data-index={row.index ?? undefined}
              data-validity={st?.state}
              tabIndex={movable ? 0 : undefined}
              aria-label={movable ? `${row.index! + 1}. ${row.id} ${row.name}. ${T.moveHint}` : undefined}
              draggable={movable}
              onKeyDown={onRowKey(row)}
              onDragStart={(e) => {
                if (!movable) return
                e.dataTransfer?.setData('text/plain', row.id)
                ctl.dragStart(row.index!)
              }}
              onDragOver={(e) => {
                if (p.dragging !== null && row.index !== null) e.preventDefault()
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (row.index !== null) ctl.dragDrop(row.index)
                else ctl.dragCancel()
              }}
              onDragEnd={() => ctl.dragCancel()}
            >
              <span class="hl-route__handle" aria-hidden="true" title={movable ? fill(T.dragHandle, { station: row.id }) : undefined}>
                {movable ? '⋮⋮' : ''}
              </span>
              {row.point ? (
                <span class="hl-route__check-slot">
                  <Icon name="user-point" />
                </span>
              ) : (
                <input
                  type="checkbox"
                  class="hl-route__check"
                  checked={row.checked}
                  disabled={!ordered || running}
                  aria-label={fill(T.include, { station: `${row.id} ${row.name}` })}
                  onChange={(e) => ctl.toggle(row.id, (e.currentTarget as HTMLInputElement).checked)}
                />
              )}
              <span class="hl-route__order">{row.index !== null && ordered ? row.index + 1 : ''}</span>
              {row.point ? (
                <PointRowBody ctl={ctl} index={row.index!} name={row.id} label={row.point.label} disabled={!ordered || running} />
              ) : (
                <span class="hl-route__name">
                  <span class="hl-route__id">{row.id}</span> {row.name}
                </span>
              )}
              {ordered && st ? (
                <span class={cx('hl-route__validity', `is-${st.state}`)} data-validity={st.state}>
                  {st.text}
                </span>
              ) : null}
            </li>
          )
        })}
      </ol>
      {ordered ? <p class="hl-route__hint">{T.moveHint}</p> : null}
      {ordered ? <AddPointButton ctl={ctl} /> : null}
      {check.route.length ? (
        <p class="hl-route__warn" role="status">
          {check.route.map((x) => fill(ROUTE_PROBLEM_TEXT[x], { n: x === 'tooManyFreePoints' ? ROUTE_LIMITS.maxFreePoints : ROUTE_LIMITS.maxStops })).join(' ')}
        </p>
      ) : null}

      {ordered ? <GhostSummary ctl={ctl} /> : null}

      {ordered && ctl.legs.peek().length ? (
        <ol class="hl-route__legs" aria-label={T.legs}>
          {ctl.legs.peek().map((l) => (
            <li class={cx('hl-route__leg', failing === l.leg && 'is-failing')} data-leg={l.leg} data-state={failing === null ? undefined : l.leg < failing ? 'planned' : l.leg === failing ? 'failing' : 'not-planned'}>
              {l.from === 'pad' ? T.pad : l.from} → {l.to === 'pad' ? T.pad : l.to}
            </li>
          ))}
        </ol>
      ) : null}

      <div class="hl-route__actions">
        <IconButton icon="undo-2" label={T.undo} disabled={!p.canUndo || running} onClick={() => ctl.undo()} />
        <IconButton icon="redo-2" label={T.redo} disabled={!p.canRedo || running} onClick={() => ctl.redo()} />
        {running ? (
          <Button variant="secondary" icon="x" onClick={() => ctl.cancel()} class="hl-route__cancel">
            {T.cancel}
          </Button>
        ) : null}
        <Button variant="live" icon="play" busy={running} disabled={!check.ok || !p.live || p.dragging !== null} onClick={() => ctl.computePlan()} class="hl-route__compute">
          {running ? T.computing : T.compute}
        </Button>
      </div>
      {!p.live ? (
        <p class="hl-route__note hl-route__reason" role="status">
          {T.needsLive}
          {p.reason ? ` ${p.reason}` : ''}
        </p>
      ) : null}
      <p class="hl-route__hash">
        {T.hash}: <code>{p.hash ?? T.hashPending}</code>
      </p>

    </div>
  )
}

const NO_REASON = signal<string | null>(null)

/** The panel bound to the controller (re-renders on every signal it shows). */
export function RoutePanel({ ctl, live, reason }: { ctl: RouteController; live: ReadSignal<boolean>; reason?: ReadSignal<string | null> }) {
  const why = useSignalValue(reason ?? NO_REASON)
  const props: RoutePanelViewProps = {
    ctl,
    route: useSignalValue(ctl.store.route),
    check: useSignalValue(ctl.check),
    compute: useSignalValue(ctl.compute),
    hash: useSignalValue(ctl.store.hash),
    canUndo: useSignalValue(ctl.store.canUndo),
    canRedo: useSignalValue(ctl.store.canRedo),
    dragging: useSignalValue(ctl.dragging),
    live: useSignalValue(live),
    reason: why,
  }
  useSignalValue(ctl.legs)
  return <RoutePanelView {...props} />
}
