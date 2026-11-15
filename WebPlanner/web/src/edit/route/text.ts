// Interface text of the Edit-route panel (R5). Kept here, not in ui/copy.json, because copy.json is
// bundled into the static app and the static build must stay byte-identical (waypoint rule 4); the
// live views (src/live/view.tsx) keep their text next to the code the same way. Wording follows
// DESIGN §3.8 (station, rover pad, margin, Computed live). Move into copy.json when D folds the live
// copy into the deck.
import type { RouteLimit, RouteFailure } from './controller'
import type { RouteProblem, StopProblem } from './model'

export const ROUTE_TEXT = {
  title: 'Edit route',
  modeLabel: 'Route',
  modeAuto: 'Engine chooses',
  modeOrdered: 'My order',
  autoNote: 'The engine chooses the stations and their order, as in the official plan.',
  orderedNote: 'Legs run from the rover pad through the checked stations in this order and back. Nothing is reordered.',
  stopsLabel: 'Stations',
  moveHint: 'Drag to reorder, or Alt+Up / Alt+Down',
  dragHandle: 'Move {station}',
  include: 'Include {station}',
  undo: 'Undo route change',
  redo: 'Redo route change',
  compute: 'Compute plan',
  computing: 'Computing your route…',
  cancel: 'Cancel',
  hash: 'Plan hash',
  hashPending: 'known once live planning answers',
  needsLive: 'Computing a route needs live planning.',
  checkingLive: 'Checking whether live planning is reachable…',
  heavyJobsOff: 'Live planning is not taking new plans now.',
  legs: 'Legs',
  stagesTitle: 'Staged result',
  stageFirst: 'Nominal band and route',
  stageRest: 'Other bands, edges and partner line',
  stageWaiting: 'waiting',
  stageShown: 'on the map',
  computedLabel: 'Computed live · your route',
  provenance: 'Provenance',
  feasible: 'Every leg keeps its margins.',
  infeasibleTitle: 'This order does not work',
  infeasibleLeg: 'Leg {n}: {from} → {to}',
  infeasibleLimit: 'Limit: {limit}',
  infeasibleShort: 'Short by {min} min',
  infeasibleShortUnknown: 'Short by — (not reported)',
  infeasibleNote: 'Change the order or drop a station; the route is computed exactly as given.',
  feasibilityUnknown: 'The run record gives no feasibility for this route.',
  failedTitle: 'The route was not computed',
  cancelled: 'Cancelled.',
  stopValid: 'valid',
  stopUnknown: 'not checked here',
  pad: 'Rover pad',
  dockNote: 'Route result on the map: the EVA timeline of the official plan is not shown.',
  dockOpen: 'Open this plan',
} as const

export const LIMIT_TEXT: Record<RouteLimit, string> = {
  O2: 'O₂ at the effort-cap rate (D45)',
  daylight: 'Daylight',
  'EVA duration': 'EVA length (D28)',
  dose: 'Radiation dose',
}

export const STOP_PROBLEM_TEXT: Record<StopProblem, string> = {
  unknownStation: 'not a station of this site',
  duplicate: 'already in the route',
  outsideGrid: 'outside the terrain grid',
  unassessed: 'no assessed terrain here',
  notWalkable: 'too steep to walk (20°)',
  unreachable: 'no way home from the rover pad',
  spacing: 'closer than {m} m to another stop or the rover pad',
  tooMany: 'more than {n} stops',
}

export const ROUTE_PROBLEM_TEXT: Record<RouteProblem, string> = {
  noStops: 'Check at least one station.',
  tooManyStops: 'At most {n} stops.',
  tooManyFreePoints: 'At most {n} points of your own.',
}

/** Server error codes of a 422 on a route (draft openapi v1.2.0 Error.stop). */
export const ROUTE_ERROR_TEXT: Record<string, string> = {
  route_too_many_stops: 'too many stops',
  route_too_many_free_points: 'too many points of your own',
  route_stop_spacing: 'two stops, or a stop and the rover pad, are too close',
  route_station_unknown: 'not a station of this site',
  route_station_duplicate: 'a station is in the route twice',
  route_point_outside_grid: 'outside the terrain grid',
  route_point_unassessed: 'no assessed terrain here',
  route_point_not_walkable: 'too steep to walk',
  route_point_unreachable: 'no path from the rover pad',
  route_label_too_long: 'the label is too long',
  route_mode_conflict: 'the route conflicts with the station settings',
  invalid_input: 'the server refused the inputs',
  rate_limited: 'too many plans at once; try again later',
  heavy_jobs_off: 'live planning is not taking new plans now',
  timeout: 'the plan took too long',
  client_timeout: 'the plan took too long',
  network: 'no answer from the live server',
}

export function fill(s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{([a-z_]+)\}/g, (_, k: string) => {
    const v = vars[k]
    if (v === undefined) throw new Error(`route text: no value for {${k}} in "${s}"`)
    return String(v)
  })
}

/** "Stop 2 (S4): too steep to walk" for a 422 naming a stop; otherwise the reason alone. */
export function failureText(f: RouteFailure, stopName: (i: number) => string | null): string {
  const reason = ROUTE_ERROR_TEXT[f.code] ?? f.message
  const head = f.status === 422 && f.stop !== null ? `Stop ${f.stop + 1}${stopName(f.stop) ? ` (${stopName(f.stop)})` : ''}: ` : ''
  const retry = f.retryAfterS ? ` (retry in ${f.retryAfterS} s)` : ''
  return `${head}${reason}${retry}`
}
