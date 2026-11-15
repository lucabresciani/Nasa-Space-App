// UI-side route types of the live layer (R5, D97). The contract types (plan_inputs.route,
// run_record.route_mode / feasibility, Error.stop) are in ../types.ts since R0 (contracts/backend
// v1.2.0, #105); this file only adds what the panel needs on top: the stop shapes by name, the limit
// list for checks, the route 422 codes, and the readers below. Limits come from config/backend.yaml
// route.* (edit/route/model.ts ROUTE_LIMITS).
import type { PlanRoute as EditPlanRoute, RouteStop as EditRouteStop } from '../../edit/route/model'
import type { ApiErrorBody, Feasibility, RouteMode, RouteStop, RunRecord } from '../types'

export type { Feasibility, RouteMode, RouteStop } from '../types'

export type StationStop = Extract<RouteStop, { station: string }>
export type PointStop = Exclude<RouteStop, StationStop>

/** plan_inputs.route (v1.2.0). Missing = auto; ordered needs at least one stop; auto has none. */
export interface PlanRoute {
  mode: RouteMode
  stops?: RouteStop[]
}

/** run_record.feasibility.limit values (contract enum): O₂ at the effort-cap rule (D45), daylight, dose, EVA duration (D28). */
export const FEASIBILITY_LIMITS = ['O2', 'daylight', 'dose', 'EVA duration'] as const satisfies readonly Extract<Feasibility, { feasible: false }>['limit'][]
export type FeasibilityLimit = (typeof FEASIBILITY_LIMITS)[number]

export type RouteRunRecord = RunRecord
export type RouteErrorBody = ApiErrorBody

/** 422 codes of a route (openapi v1.2.0, Error.stop description). */
export const ROUTE_ERROR_CODES = [
  'route_too_many_stops',
  'route_too_many_free_points',
  'route_stop_spacing',
  'route_station_unknown',
  'route_station_duplicate',
  'route_point_outside_grid',
  'route_point_unassessed',
  'route_point_not_walkable',
  'route_point_unreachable',
  'route_label_too_long',
  'route_mode_conflict',
] as const
export type RouteErrorCode = (typeof ROUTE_ERROR_CODES)[number]

// Compile-time alignment: the edit model's route (what the panel builds) fits the contract.
type Assert<T extends true> = T
export type _StopFits = Assert<EditRouteStop extends RouteStop ? true : false>
export type _StopBack = Assert<RouteStop extends EditRouteStop ? true : false>
export type _ModeFits = Assert<EditPlanRoute['mode'] extends RouteMode ? true : false>

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const STOP_NAME = /^(pad|S[0-9]+|W[0-9]+)$/

/**
 * The route answer of a run record: v1.2.0 feasibility, else the v1.1 `infeasible` block (binding,
 * negative margin), else null (no answer recorded). A malformed block is an error, never guessed.
 */
export function readFeasibility(rec: unknown): { value: Feasibility | null; error: string | null } {
  if (!isObj(rec)) return { value: null, error: 'run record is not an object' }
  const f = rec.feasibility
  if (f !== undefined) {
    if (!isObj(f) || typeof f.feasible !== 'boolean') return { value: null, error: 'run_record.feasibility is malformed' }
    if (f.feasible) return { value: { feasible: true }, error: null }
    const ok =
      Number.isInteger(f.leg) &&
      (f.leg as number) >= 0 &&
      typeof f.from === 'string' &&
      STOP_NAME.test(f.from) &&
      typeof f.to === 'string' &&
      STOP_NAME.test(f.to) &&
      (FEASIBILITY_LIMITS as readonly unknown[]).includes(f.limit) &&
      typeof f.shortfall_min === 'number' &&
      f.shortfall_min >= 0
    if (!ok) return { value: null, error: 'run_record.feasibility (infeasible) is malformed' }
    return { value: f as Feasibility, error: null }
  }
  const inf = rec.infeasible
  if (isObj(inf) && Number.isInteger(inf.leg) && typeof inf.from === 'string' && typeof inf.to === 'string') {
    const limit = (FEASIBILITY_LIMITS as readonly unknown[]).includes(inf.binding) ? (inf.binding as FeasibilityLimit) : null
    if (!limit) return { value: null, error: `run_record.infeasible.binding ${String(inf.binding)} is not a route limit` }
    const m = typeof inf.margin_min === 'number' ? Math.abs(inf.margin_min) : NaN
    return { value: { feasible: false, leg: inf.leg as number, from: inf.from, to: inf.to, limit, shortfall_min: m }, error: null }
  }
  // no route answer recorded (a v1.1 record of a feasible plan has infeasible: null)
  return { value: null, error: null }
}

/**
 * The stop a 422 names: Error.stop (v1.2.0, carried on ApiError.stop), else the index in the detail
 * text, either the mock's "stops[i]" or the server's "stop i (Sx)". The index is 0-based either way.
 */
export function errorStop(body: { stop?: unknown; detail?: unknown } | null | undefined): number | null {
  if (!body) return null
  if (Number.isInteger(body.stop) && (body.stop as number) >= 0) return body.stop as number
  const d = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail ?? '')
  const m = /\bstops\[(\d+)\]|\bstop (\d+)\b/.exec(d)
  return m ? Number(m[1] ?? m[2]) : null
}
