// Hash router (SPEC F17). Hash routes survive GitHub Pages (no SPA fallback) and work logged out.
// Pages: / (planning console), /station/:id, /trade, /conditions, /scorecard, /cuff, /about.
// Mount slot for another workstream: /hud (WS7).
// Removed views (D98, D99): /nav (navigation add-on) redirects to EVIDENCE, /hud3d (first-person 3D)
// redirects to the 2D HUD; their mode paths #/evidence/nav and #/fly/3d redirect the same way.
//
// Mode routes (DESIGN §4.2, WS15 task 4 / A4). PLAN keeps the root and its old URLs (`#/`,
// `#/station/:id`, `#/trade`): `#/plan/{hash}` is the plan-permalink namespace (§4.2 "any mode with
// that plan loaded", F28, owned by src/live/), so PLAN cannot live under `#/plan`. The other modes:
//   FLY       #/fly/hud  #/fly/conditions                   (#/fly = #/fly/hud)
//   REPORT    #/report/cuff                                  (#/report = #/report/cuff until U10)
//   EVIDENCE  #/evidence/scorecard[?key=K]  #/evidence/about  (#/evidence = scorecard)
// parseRoute accepts the old and the new paths; the shell replaces an old hash by canonicalHref
// (redirectFor), so every old link and deep link keeps working. href() still writes the old paths,
// which every layout understands (the legacy layout never redirects).

export type Route =
  | { name: 'console' }
  | { name: 'station'; id: string }
  | { name: 'trade' }
  | { name: 'conditions' }
  | { name: 'scorecard'; key?: string }
  | { name: 'cuff' }
  | { name: 'about' }
  | { name: 'hud' }
  /** MARVIS build: the Mission Planer. plan: a shared plan string (mission/share.ts); add: a station id to append as a waypoint */
  | { name: 'mission'; plan?: string; add?: string }
  | { name: 'notfound'; path: string }

const SIMPLE = ['trade', 'conditions', 'cuff', 'about', 'hud'] as const

type ModeView = 'hud' | 'conditions' | 'cuff' | 'scorecard' | 'about'
/** New canonical path of every view outside PLAN (DESIGN §4.2). */
export const MODE_PATHS: Readonly<Record<ModeView, string>> = {
  hud: '/fly/hud',
  conditions: '/fly/conditions',
  cuff: '/report/cuff',
  scorecard: '/evidence/scorecard',
  about: '/evidence/about',
}
/** The view a bare mode path shows (#/fly, #/report, #/evidence). */
const MODE_ROOT: Readonly<Record<string, ModeView>> = { fly: 'hud', report: 'cuff', evidence: 'scorecard' }
const MODE_PATH_VIEW: Readonly<Record<string, ModeView>> = Object.fromEntries(Object.entries(MODE_PATHS).map(([v, p]) => [p, v as ModeView]))
/**
 * Paths of removed views and the view they now open (the shell then redirects to its canonical hash):
 * D98 the navigation add-on (/nav) -> EVIDENCE; D99 the first-person 3D view (/hud3d) -> FLY 2D HUD.
 */
export const REMOVED_PATHS: Readonly<Record<string, ModeView>> = {
  '/nav': 'scorecard',
  '/evidence/nav': 'scorecard',
  '/hud3d': 'hud',
  '/fly/3d': 'hud',
}

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '')
  const [pathPart, query = ''] = raw.split('?', 2)
  const path = '/' + pathPart.split('/').filter(Boolean).join('/')
  const segs = path.split('/').filter(Boolean)
  const params = new URLSearchParams(query)

  if (segs.length === 0) return { name: 'console' }
  if (Object.hasOwn(REMOVED_PATHS, path)) return { name: REMOVED_PATHS[path] }
  const [head, ...rest] = segs
  if (Object.hasOwn(MODE_ROOT, head) && rest.length <= 1) {
    const sub = `/${head}/${rest[0] ?? ''}`
    const view = rest.length === 0 ? MODE_ROOT[head] : Object.hasOwn(MODE_PATH_VIEW, sub) ? MODE_PATH_VIEW[sub] : undefined
    if (view === 'scorecard') {
      const key = params.get('key')
      return key ? { name: 'scorecard', key } : { name: 'scorecard' }
    }
    if (view) return { name: view }
  }
  if (head === 'station' && rest.length === 1) return { name: 'station', id: decodeURIComponent(rest[0]) }
  if (head === 'scorecard' && rest.length === 0) {
    const key = params.get('key')
    return key ? { name: 'scorecard', key } : { name: 'scorecard' }
  }
  if (head === 'mission' && rest.length === 0) {
    const r: Route = { name: 'mission' }
    const plan = params.get('plan')
    const add = params.get('add')
    if (plan) r.plan = plan
    if (add) r.add = add
    return r
  }
  if (rest.length === 0 && (SIMPLE as readonly string[]).includes(head)) {
    return { name: head as (typeof SIMPLE)[number] }
  }
  return { name: 'notfound', path }
}

/** Unlinked dev page (WS16 M1 field-shader spike): never in NAV_ITEMS; main.ts lazy-loads it. */
export const isSpikeHash = (hash: string): boolean => /^#?\/spike\/?(\?|$)/.test(hash)

/** Unlinked dev page (WS15 A2 style guide, DESIGN U0): never in NAV_ITEMS; main.ts lazy-loads it. */
export const isStyleguideHash = (hash: string): boolean => /^#?\/styleguide\/?(\?|$)/.test(hash)

export function href(route: Route): string {
  switch (route.name) {
    case 'console':
      return '#/'
    case 'station':
      return `#/station/${encodeURIComponent(route.id)}`
    case 'scorecard':
      return route.key ? `#/scorecard?key=${encodeURIComponent(route.key)}` : '#/scorecard'
    case 'mission': {
      const q = new URLSearchParams()
      if (route.plan) q.set('plan', route.plan)
      if (route.add) q.set('add', route.add)
      const qs = q.toString()
      return qs ? `#/mission?${qs}` : '#/mission'
    }
    case 'notfound':
      return `#${route.path}`
    default:
      return `#/${route.name}`
  }
}

/** The canonical (mode) hash of a route, DESIGN §4.2. PLAN routes keep their URLs. */
export function canonicalHref(route: Route): string {
  if (Object.hasOwn(MODE_PATHS, route.name)) {
    const path = MODE_PATHS[route.name as ModeView]
    return route.name === 'scorecard' && route.key ? `#${path}?key=${encodeURIComponent(route.key)}` : `#${path}`
  }
  return href(route)
}

/**
 * Where the shell should send `hash`: its canonical mode hash when it is an old (or bare mode) path,
 * else null. Query parameters other than the route's own (e.g. legacy) are kept. Unknown paths are
 * not redirected (they render "Not found", and #/plan/... stays with the live layer).
 */
export function redirectFor(hash: string): string | null {
  const route = parseRoute(hash)
  if (route.name === 'notfound') return null
  const [pathPart, query = ''] = hash.replace(/^#/, '').split('?', 2)
  const path = '/' + pathPart.split('/').filter(Boolean).join('/')
  const target = canonicalHref(route)
  const [tPath, tQuery = ''] = target.slice(1).split('?', 2)
  if (path === tPath) return null
  const params = new URLSearchParams(tQuery)
  for (const [k, v] of new URLSearchParams(query)) if (!params.has(k)) params.set(k, v)
  const qs = params.toString()
  return `#${tPath}${qs ? `?${qs}` : ''}`
}

/**
 * The `legacy` switch (DESIGN U0 "?legacy=view", kit rule 10): from the page query (`?legacy=1#/trade`,
 * survives navigation) or the hash query (`#/trade?legacy=1`). null when absent.
 */
export function legacyParam(search: string, hash: string): string | null {
  const fromSearch = new URLSearchParams(search.replace(/^\?/, '')).get('legacy')
  if (fromSearch !== null) return fromSearch
  const q = hash.replace(/^#/, '').split('?', 2)[1]
  return q === undefined ? null : new URLSearchParams(q).get('legacy')
}

/** True when `route` renders in the old layout: legacy=1|true|all|'' for every view, or a comma list of route names. */
export function isLegacy(param: string | null, route: Route): boolean {
  if (param === null) return false
  const v = param.trim().toLowerCase()
  if (v === '' || v === '1' || v === 'true' || v === 'all') return true
  return v.split(',').some((n) => n.trim() === route.name.toLowerCase())
}

/** Top navigation, in display order. The hud slot is listed but owned by WS7. */
export const NAV_ITEMS: { route: Route; label: string }[] = [
  { route: { name: 'console' }, label: 'Plan' },
  { route: { name: 'trade' }, label: 'Trade' },
  { route: { name: 'conditions' }, label: 'Conditions' },
  { route: { name: 'cuff' }, label: 'Cuff card' },
  { route: { name: 'hud' }, label: 'HUD' },
  { route: { name: 'scorecard' }, label: 'Scorecard' },
  { route: { name: 'about' }, label: 'About' },
]
