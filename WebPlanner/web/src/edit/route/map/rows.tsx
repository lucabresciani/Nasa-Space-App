// WP6: the free-waypoint parts of R5's stop list (panel.tsx renders them):
//   PointRowBody   name field (rename, Enter or leaving the field = one undo step) + delete
//   AddPointButton "Add waypoint": arms one map click (Escape cancels); disabled with the reason
//   GhostSummary   the ghost route's legs and total, every time labelled "estimate"
import { useSignalValue } from '../../../state/signal'
import { IconButton } from '../../../ui/components/Button'
import { cx, Icon } from '../../../ui/components/Icon'
import type { RouteController } from '../controller'
import { ROUTE_LIMITS } from '../model'
import { fill } from '../text'
import { editorOf, type WaypointEditor } from './editor'
import { LABEL_MAX_CHARS } from './points'
import { estimateMin, WAYPOINT_TEXT as W } from './text'
import './waypoints.css'

export interface PointRowProps {
  ctl: RouteController
  /** index in route.stops */
  index: number
  /** W1, W2, … */
  name: string
  label: string | undefined
  disabled: boolean
}

/**
 * A press in the label field belongs to the field (text selection), never to R5's row drag: the press
 * does not reach the row, and the row is not draggable until the button is released.
 */
function holdRow(e: Event): void {
  e.stopPropagation()
  const li = (e.currentTarget as Element | null)?.closest?.('li') as HTMLElement | null | undefined
  if (!li || !li.draggable || typeof window === 'undefined') return
  li.draggable = false
  const back = (): void => {
    li.draggable = true
    window.removeEventListener('pointerup', back, true)
    window.removeEventListener('pointercancel', back, true)
  }
  window.addEventListener('pointerup', back, true)
  window.addEventListener('pointercancel', back, true)
}

export function PointRowBody({ ctl, index, name, label, disabled }: PointRowProps) {
  const ed = editorOf(ctl)
  const commit = (el: HTMLInputElement) => {
    if (!ed.rename(index, el.value)) el.value = label ?? ''
  }
  return (
    <span class="hl-route__point">
      <span class="hl-route__id">{name}</span>
      <input
        // a new label from the store (undo, redo) resets the field
        key={`${name}:${label ?? ''}`}
        type="text"
        name="label"
        class="hl-route__label-input"
        defaultValue={label ?? ''}
        maxLength={LABEL_MAX_CHARS}
        placeholder={fill(W.labelPlaceholder, { name })}
        aria-label={fill(W.labelField, { name })}
        disabled={disabled}
        onChange={(e) => commit(e.currentTarget as HTMLInputElement)}
        onKeyDown={(e) => {
          // the field owns its keys: Ctrl+Z edits the text, Alt+arrows move the caret
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            commit(e.currentTarget as HTMLInputElement)
          } else if (e.key === 'Escape') (e.currentTarget as HTMLInputElement).value = label ?? ''
        }}
        onPointerDown={holdRow}
        onMouseDown={(e) => e.stopPropagation()}
        onDragStart={(e) => {
          // selecting text never starts a row drag (R5's onDragStart on the <li> never hears it)
          e.preventDefault()
          e.stopPropagation()
        }}
      />
      <IconButton icon="x" label={fill(W.delete, { name })} class="hl-route__delete" data-route-action="delete-point" disabled={disabled} onClick={() => ed.remove(index)} />
    </span>
  )
}

const BLOCKED_TEXT: Record<string, string> = {
  auto: W.blockedAuto,
  tooManyFreePoints: fill(W.blockedTooManyFreePoints, { n: ROUTE_LIMITS.maxFreePoints }),
  tooManyStops: fill(W.blockedTooManyStops, { n: ROUTE_LIMITS.maxStops }),
  running: W.blockedRunning,
  noMap: W.blockedNoMap,
}

export function AddPointButton({ ctl }: { ctl: RouteController }) {
  const ed = editorOf(ctl)
  const adding = useSignalValue(ed.adding)
  const blocked = useSignalValue(ed.blocked)
  const why = blocked ? BLOCKED_TEXT[blocked] : null
  return (
    <div class="hl-route__add">
      <button
        type="button"
        class={cx('hl-btn', 'hl-btn--secondary', 'hl-route__addbtn', adding && 'is-armed')}
        data-route-action="add-point"
        aria-pressed={adding ? 'true' : 'false'}
        disabled={!!blocked && !adding}
        title={why ?? undefined}
        onClick={() => ed.toggleAdd()}
      >
        <Icon name={adding ? 'x' : 'crosshair'} />
        {adding ? W.addCancel : W.add}
      </button>
      <span class="hl-route__note" role="status">
        {adding ? W.addArmed : (why ?? fill(W.addHint, { n: ROUTE_LIMITS.maxFreePoints }))}
      </span>
    </div>
  )
}

const nameOf = (n: string) => (n === 'pad' ? W.pad : n)

function GhostBody({ ed }: { ed: WaypointEditor }) {
  const g = useSignalValue(ed.ghost)
  const drag = useSignalValue(ed.dragging)
  if (drag) return <p class="hl-route__note">{fill(W.ghostDragging, { name: drag })}</p>
  if (g.kind === 'loading') return <p class="hl-route__note">{W.ghostLoading}</p>
  if (g.kind === 'unavailable') return <p class="hl-route__note">{W.ghostUnavailable}</p>
  if (g.kind !== 'ready') return null
  const { legs, totalS } = g.ghost
  return (
    <>
      <p class="hl-route__ghost-title">
        <span>{W.ghostTitle}</span>
        <span class="hl-route__ghost-total">{totalS === null ? W.ghostTotalPartial : fill(W.ghostTotal, { min: estimateMin(totalS) })}</span>
      </p>
      <ol class="hl-route__ghost-legs">
        {legs.map((l) => (
          <li class="hl-route__ghost-leg" data-leg={l.leg} data-routed={l.routed ? 'true' : 'false'}>
            <span>{fill(W.ghostLeg, { from: nameOf(l.from), to: nameOf(l.to) })}</span>
            <span class="hl-route__ghost-time">{l.timeS === null ? W.ghostLegNone : fill(W.ghostLegTime, { min: estimateMin(l.timeS) })}</span>
          </li>
        ))}
      </ol>
      <p class="hl-route__note">{W.ghostNote}</p>
    </>
  )
}

/** The ghost summary; gone once a computed live result is drawn (the run record is the answer). */
export function GhostSummary({ ctl }: { ctl: RouteController }) {
  const ed = editorOf(ctl)
  const shown = useSignalValue(ed.ghostShown)
  useSignalValue(ed.ghost)
  if (!shown) return null
  return (
    <div class="hl-route__ghost" data-route-ghost="estimate" data-state={ed.ghost.peek().kind}>
      <GhostBody ed={ed} />
    </div>
  )
}
