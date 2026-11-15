// Crew panel model (F26, WS13 brief task 6): body mass, carried tools, VO2max and effort cap, with
// their defaults and ranges from GET /defaults (config/backend.yaml ranges, never typed here).
// Out-of-range values are allowed and sent as typed (the server flags them in the run record's
// range_flags and does not clamp them, E10); the panel flags them before submit. The suit mass and
// the O2 reserve are shown, not editable: tonight's server refuses both (E10: a job error naming
// crew.suit_kg or the eva block). The job gets only the fields that differ from the defaults.
// UI-free: crewview.tsx renders CrewState; padmount.tsx joins it to the pad tool.
import type { ApiClient } from './client'
import { ApiError } from './client'
import { bannerFor, type LiveState } from './health'
import type { Defaults, PlanInputs, RangeSpec } from './types'

/** The crew fields the panel edits: the four build_plan crew overrides (E10 crew.overrides). */
export const CREW_FIELDS = ['body_mass_kg', 'tools_kg', 'vo2max_ml_kg_min', 'effort_cap_frac'] as const
export type CrewField = (typeof CREW_FIELDS)[number]

/** Field names and units on screen (plan_inputs.schema.json crew; effort cap is a fraction of VO2max). */
export const CREW_FIELD_TEXT: Record<CrewField, { label: string; units: string }> = {
  body_mass_kg: { label: 'Body mass', units: 'kg' },
  tools_kg: { label: 'Carried tools', units: 'kg' },
  vo2max_ml_kg_min: { label: 'VO2max', units: 'mL/kg/min' },
  effort_cap_frac: { label: 'Effort cap', units: 'fraction of VO2max' },
}

/** Shown next to a value outside its config range, before submit. */
export const EXTRAPOLATION_TEXT = 'outside the validated range: result is an extrapolation'
/** Why the suit mass and the O2 reserve cannot be changed tonight (E10 open items 1 and 2). */
export const FIXED_TEXT = 'Fixed tonight: the live engine plans only the default suit and O2 reserve, and refuses other values.'

export interface FieldSpec {
  min: number
  max: number
  /** The value the server fills when the field is omitted (GET /defaults inputs.crew). */
  default: number
}

/** What the panel needs from GET /defaults. */
export interface CrewSpec {
  fields: Record<CrewField, FieldSpec>
  /** inputs.crew.suit_kg: shown fixed. */
  suitKg: number
  /** inputs.eva.reserve_min: shown fixed (null if /defaults has none). */
  reserveMin: number | null
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** The panel's spec from a /defaults body; throws (with the missing key) when it is incomplete. */
export function crewSpecFrom(d: Defaults): CrewSpec {
  const crew = (d.inputs?.crew ?? {}) as Record<string, unknown>
  const eva = (d.inputs?.eva ?? {}) as Record<string, unknown>
  const fields = {} as Record<CrewField, FieldSpec>
  for (const f of CREW_FIELDS) {
    const r = (d.ranges ?? {})[f] as Partial<RangeSpec> | undefined
    if (!r || !isNum(r.min) || !isNum(r.max)) throw new Error(`GET /defaults has no range for crew.${f}`)
    const def = isNum(crew[f]) ? crew[f] : isNum(r.default) ? r.default : null
    if (def === null) throw new Error(`GET /defaults has no default for crew.${f}`)
    fields[f] = { min: r.min, max: r.max, default: def }
  }
  if (!isNum(crew.suit_kg)) throw new Error('GET /defaults has no inputs.crew.suit_kg')
  return { fields, suitKg: crew.suit_kg, reserveMin: isNum(eva.reserve_min) ? eva.reserve_min : null }
}

export type FieldCheck =
  | { kind: 'default'; value: number }
  | { kind: 'changed'; value: number }
  | { kind: 'outside'; value: number }
  | { kind: 'invalid'; text: string }

/** The typed text of one field against its spec. Nothing is clamped. */
export function checkField(spec: FieldSpec, text: string): FieldCheck {
  const t = text.trim()
  const v = t === '' ? NaN : Number(t)
  if (!Number.isFinite(v)) return { kind: 'invalid', text }
  if (v < spec.min || v > spec.max) return { kind: 'outside', value: v }
  return v === spec.default ? { kind: 'default', value: v } : { kind: 'changed', value: v }
}

export type CrewText = Record<CrewField, string>

export const defaultText = (spec: CrewSpec): CrewText =>
  Object.fromEntries(CREW_FIELDS.map((f) => [f, String(spec.fields[f].default)])) as CrewText

/**
 * The plan_inputs crew block: only the fields that differ from the defaults (out-of-range values
 * as typed), keys sorted; null when nothing changed. Throws on a field that is not a number.
 */
export function crewBlock(spec: CrewSpec, text: CrewText): Partial<Record<CrewField, number>> | null {
  const out: Partial<Record<CrewField, number>> = {}
  for (const f of [...CREW_FIELDS].sort()) {
    const c = checkField(spec.fields[f], text[f])
    if (c.kind === 'invalid') throw new Error(`crew.${f} is not a number`)
    if (c.kind !== 'default') out[f] = c.value
  }
  return Object.keys(out).length ? out : null
}

/** The fields whose text is not a number (they block "Compute full plan"). */
export const invalidFields = (spec: CrewSpec, text: CrewText): CrewField[] =>
  CREW_FIELDS.filter((f) => checkField(spec.fields[f], text[f]).kind === 'invalid')

export type DefaultsState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; spec: CrewSpec } | { kind: 'error'; message: string }

export interface CrewState {
  live: LiveState
  defaults: DefaultsState
  /** The typed text per field (initialised to the defaults once /defaults answers). */
  text: CrewText | null
}

export interface CrewActions {
  set(field: CrewField, text: string): void
  reset(): void
  retry(): void
}

export interface CrewModel extends CrewActions {
  readonly state: CrewState
  setLive(s: LiveState): void
  subscribe(fn: (s: CrewState) => void): () => void
  /**
   * Plan inputs the crew adds to the job ({crew: changed fields}, or {} for the default crew), or
   * null while a field is not a number (the job is not sent; the panel says which field).
   */
  jobInputs(): PlanInputs | null
  dispose(): void
}

function message(e: unknown): string {
  if (e instanceof ApiError) return e.code === 'timeout' || e.code === 'network' ? `no answer from the live API (${e.code})` : `${e.code} (HTTP ${e.status})`
  return e instanceof Error ? e.message : String(e)
}

export function createCrew({ client }: { client: ApiClient }): CrewModel {
  let state: CrewState = { live: { kind: 'checking' }, defaults: { kind: 'idle' }, text: null }
  const subs = new Set<(s: CrewState) => void>()
  let req: AbortController | null = null
  const set = (patch: Partial<CrewState>) => {
    state = { ...state, ...patch }
    for (const fn of subs) fn(state)
  }

  async function load() {
    req?.abort()
    const ctl = (req = new AbortController())
    set({ defaults: { kind: 'loading' } })
    try {
      const spec = crewSpecFrom(await client.defaults({ signal: ctl.signal }))
      if (ctl.signal.aborted) return
      set({ defaults: { kind: 'ready', spec }, text: state.text ?? defaultText(spec) })
    } catch (e) {
      if (!ctl.signal.aborted) set({ defaults: { kind: 'error', message: message(e) } })
    }
  }

  return {
    get state() {
      return state
    },
    setLive(s) {
      set({ live: s })
      if (!bannerFor(s).controls) {
        req?.abort()
        if (state.defaults.kind === 'loading') set({ defaults: { kind: 'idle' } })
      } else if (state.defaults.kind === 'idle' || state.defaults.kind === 'error') void load()
    },
    subscribe(fn) {
      subs.add(fn)
      fn(state)
      return () => subs.delete(fn)
    },
    set(field, text) {
      if (!CREW_FIELDS.includes(field) || !state.text) return // suit_kg and the reserve are not editable
      set({ text: { ...state.text, [field]: text } })
    },
    reset() {
      if (state.defaults.kind === 'ready') set({ text: defaultText(state.defaults.spec) })
    },
    retry() {
      if (bannerFor(state.live).controls) void load()
    },
    jobInputs() {
      if (state.defaults.kind !== 'ready' || !state.text) return {} // no /defaults: the server's defaults
      const spec = state.defaults.spec
      if (invalidFields(spec, state.text).length) return null
      const block = crewBlock(spec, state.text)
      return block ? { crew: block } : {}
    },
    dispose() {
      req?.abort()
      subs.clear()
    },
  }
}
