// WP6 interface text (free waypoints, ghost route). Kept next to the code as R5's text.ts does (the
// static app's copy.json must stay byte-identical, waypoint rule 4). Honesty rule: every ghost time
// says "estimate".
export const WAYPOINT_TEXT = {
  add: 'Add waypoint',
  addArmed: 'Click the map to place it',
  addCancel: 'Cancel adding (Escape)',
  addHint: 'Then click the map. Up to {n} points of your own.',
  blockedAuto: 'Waypoints need “My order”.',
  blockedTooManyFreePoints: 'At most {n} points of your own.',
  blockedTooManyStops: 'At most {n} stops.',
  blockedRunning: 'Wait for the plan being computed.',
  blockedNoMap: 'Needs the planning map.',
  labelField: 'Name of {name}',
  labelPlaceholder: '{name} (optional name)',
  delete: 'Delete {name}',
  markerTitle: '{name}{label}: drag to move',
  ghostTitle: 'Ghost route · estimate',
  ghostLoading: 'Ghost route · estimate: loading the terrain grid…',
  ghostUnavailable: 'Ghost route · estimate: not available in this browser.',
  ghostTotal: '≈ {min} min walking (estimate)',
  ghostTotalPartial: 'no total: a leg has no estimate',
  ghostLeg: '{from} → {to}',
  ghostLegTime: '≈ {min} min',
  ghostLegNone: 'no path on the browser grid',
  ghostNote: 'Browser estimate on the 5 m grid: walking only, no time at the stops, no margins. “Compute plan” gives the engine’s answer.',
  ghostDragging: 'Ghost route · estimate: updates when you drop {name}.',
  pad: 'Rover pad',
} as const

/** Minutes of an estimate, whole minutes ("< 1" under a minute): no false precision. */
export function estimateMin(s: number): string {
  const m = s / 60
  return m < 1 ? '< 1' : String(Math.round(m))
}
