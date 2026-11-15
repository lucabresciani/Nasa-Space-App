// Crew panel (F26): four inputs with their defaults and ranges from GET /defaults, the suit mass and
// the O2 reserve shown fixed, and an out-of-range flag before submit. Pure function component of
// CrewState (no hooks), so tests render it without a DOM. Hidden unless the live controls are
// (offline, warming or checking: U1's banner shows instead).
import { LIVE_LABEL } from './config'
import { bannerFor } from './health'
import { checkField, CREW_FIELD_TEXT, CREW_FIELDS, EXTRAPOLATION_TEXT, FIXED_TEXT, invalidFields, type CrewActions, type CrewState, type FieldSpec } from './crew'

/** Text for the pad tool when the crew blocks "Compute full plan", or null. */
export function crewBlockedText(state: CrewState): string | null {
  if (state.defaults.kind !== 'ready' || !state.text) return null
  const bad = invalidFields(state.defaults.spec, state.text)
  return bad.length ? `Crew: ${bad.map((f) => CREW_FIELD_TEXT[f].label.toLowerCase()).join(', ')} is not a number.` : null
}

const range = (s: FieldSpec, units: string) => `${s.min} to ${s.max} ${units}, default ${s.default}`

export interface CrewPanelProps {
  state: CrewState
  actions: CrewActions
  /** Provenance link of the panel: the engine identity that answers (client.root + /engine/version). */
  engineHref: string
}

export function CrewPanel({ state, actions, engineHref }: CrewPanelProps) {
  if (!bannerFor(state.live).controls) return null
  const d = state.defaults
  return (
    <section class="live-crew" aria-label="Live crew">
      <h2>Crew</h2>
      <p class="live-label">
        {LIVE_LABEL} · <a class="live-prov" href={engineHref}>provenance: engine version</a>
      </p>
      {d.kind === 'idle' || d.kind === 'loading' ? <p class="muted">Loading the crew defaults…</p> : null}
      {d.kind === 'error' ? (
        <p class="live-failed" role="alert">
          No crew defaults from the server ({d.message}); full plans use the default crew.{' '}
          <button type="button" class="live-btn" onClick={() => actions.retry()}>
            Try again
          </button>
        </p>
      ) : null}
      {d.kind === 'ready' && state.text ? (
        <>
          <table class="mini live-crew-fields">
            <tbody>
              {CREW_FIELDS.map((f) => {
                const spec = d.spec.fields[f]
                const { label, units } = CREW_FIELD_TEXT[f]
                const c = checkField(spec, state.text![f])
                const id = `live-crew-${f}`
                return (
                  <tr key={f} data-field={f} data-check={c.kind}>
                    <th>
                      <label for={id}>{label}</label>
                    </th>
                    <td>
                      <input
                        id={id}
                        name={f}
                        type="number"
                        step="any"
                        inputMode="decimal"
                        value={state.text![f]}
                        aria-invalid={c.kind === 'invalid' || c.kind === 'outside' ? 'true' : undefined}
                        onInput={(e) => actions.set(f, (e.currentTarget as HTMLInputElement).value)}
                      />{' '}
                      {units}
                      <div class="caption live-crew-range">Validated range {range(spec, units)}</div>
                      {c.kind === 'outside' ? (
                        <div class="live-extrapolation" role="alert">
                          {EXTRAPOLATION_TEXT}
                        </div>
                      ) : null}
                      {c.kind === 'invalid' ? (
                        <div class="live-failed" role="alert">
                          not a number
                        </div>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
              <tr data-field="suit_kg" data-check="fixed">
                <th>Suit mass</th>
                <td>
                  <span class="live-fixed">{d.spec.suitKg} kg</span> <span class="muted">fixed tonight</span>
                </td>
              </tr>
              <tr data-field="reserve_min" data-check="fixed">
                <th>O2 reserve</th>
                <td>
                  {d.spec.reserveMin !== null ? <span class="live-fixed">{d.spec.reserveMin} min at the effort cap</span> : <span class="muted">server default</span>}{' '}
                  <span class="muted">fixed tonight</span>
                </td>
              </tr>
            </tbody>
          </table>
          <p class="caption">{FIXED_TEXT}</p>
          <p class="caption">
            Only changed values are sent with "Compute full plan". The instant preview always uses the default crew.{' '}
            <button type="button" class="live-btn" onClick={() => actions.reset()}>
              Reset to defaults
            </button>
          </p>
        </>
      ) : null}
    </section>
  )
}
