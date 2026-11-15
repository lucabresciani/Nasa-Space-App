// "My plans" list and the "Save to My plans" control (D97 §3.7). Pure function components of their
// props (no hooks), like the other live views; planmount.tsx owns the store and redraws after each
// action. Shown on #/plan (the list) and #/plan/{hash} (save, then the list), live builds only.
import './plans.css'
import { exportPlanInputs } from '../planio'
import { planUrl } from '../plan'
import { routeText } from './route'
import { savedPlanInputs, type PlansSnapshot } from './store'

/** What the plan views need to show and change "My plans". */
export interface MyPlansProps {
  snap: PlansSnapshot
  /** Last action's error (a bad title …); null when none. */
  error: string | null
  /** Save the plan on screen (its result hash). */
  onSave: (hash: string) => void
  /** Rename / delete a saved entry by its id (SavedPlan.id). */
  onRename: (id: string, title: string) => void
  onRemove: (id: string) => void
}

export const PLANS_TITLE = 'My plans'
export const PLANS_CAPTION = 'Saved plans stay in this browser only; nothing is sent to the server.'

const when = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`

/** The list: open, rename, export and delete each saved plan. Works with an empty or missing storage. */
export function MyPlans({ snap, error, onRename, onRemove }: MyPlansProps) {
  return (
    <section class="live-card live-myplans" aria-labelledby="live-myplans-h">
      <h3 id="live-myplans-h">{PLANS_TITLE}</h3>
      {snap.note && (
        <p class="live-plans-note" role="status">
          {snap.note}
        </p>
      )}
      {error && (
        <p class="live-failed" role="alert">
          {error}
        </p>
      )}
      {snap.plans.length === 0 ? (
        <p class="muted live-plans-empty">No saved plans yet. Open a plan and choose "Save to {PLANS_TITLE}".</p>
      ) : (
        <ul class="live-plans">
          {snap.plans.map((p) => {
            const ex = exportPlanInputs(savedPlanInputs(p))
            return (
              <li class="live-myplan" data-hash={p.hash} key={p.id}>
                <a class="live-plan-open" href={planUrl(p.hash)}>
                  {p.title}
                </a>
                <p class="caption">
                  Route {routeText(p.route)} · plan <code>{p.hash}</code> · saved {when(p.saved_utc)}
                </p>
                <form
                  class="live-plan-rename"
                  onSubmit={(e) => {
                    e.preventDefault()
                    const input = (e.currentTarget as HTMLFormElement).elements.namedItem('title') as HTMLInputElement | null
                    if (input) onRename(p.id, input.value)
                  }}
                >
                  <label>
                    Title <input name="title" type="text" value={p.title} />
                  </label>{' '}
                  <button type="submit" class="live-btn">
                    Rename
                  </button>{' '}
                  <a class="live-btn live-plan-export" href={ex.href} download={ex.fileName}>
                    Export {ex.fileName}
                  </a>{' '}
                  <button type="button" class="live-btn live-plan-delete" onClick={() => onRemove(p.id)}>
                    Delete
                  </button>
                </form>
              </li>
            )
          })}
        </ul>
      )}
      <p class="caption">{PLANS_CAPTION}</p>
    </section>
  )
}

/** "Save to My plans" for the plan on screen (`id` = planId of its hash and inputs); says when it is saved already. */
export function SavePlan({ hash, id, snap, onSave }: { hash: string; id: string } & Pick<MyPlansProps, 'snap' | 'onSave'>) {
  const saved = snap.plans.some((p) => p.id === id)
  return (
    <p class="live-plan-save" data-saved={saved ? 'true' : 'false'}>
      <button type="button" class="live-btn" onClick={() => onSave(hash)}>
        {saved ? `Save again to ${PLANS_TITLE}` : `Save to ${PLANS_TITLE}`}
      </button>
      {saved && <span class="caption"> Saved in this browser.</span>}
    </p>
  )
}
