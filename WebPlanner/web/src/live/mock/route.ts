// Mock answers for route jobs (R5, D97) on contracts/backend v1.2.0 (R0, #105): plan_inputs.route,
// run_record.route_mode / feasibility, Error.stop and the route_* 422 codes. The run record is the
// recorded example examples/run_record.route_infeasible.json (S4, S1, S2 fails on S1 -> S2, O2);
// R0 adds no web mocks, these are the only ones. Hashes and numbers are placeholders, not results.
//
// withRouteMock(inner) answers, ahead of `inner` (mock/fetch.ts createMockFetch):
//   POST /jobs with an ordered route   422 for a refused route, else a staged job under its own hash
//   GET  /jobs/{route job id}          the next state of that job
//   GET  /results/{route hash}/...     the staged mock tree (mock/result.ts) and the route run record
//   GET  /engine/version               a placeholder identity (the plain mock has none), so hashes show
// Anything else goes to `inner`.
import { API_PREFIX } from '../config'
import { canonicalJson } from '../planio'
import type { ApiErrorBody, EngineVersion, Job, JobRequest, PlanInputs } from '../types'
import routeInfeasibleExample from '../../../../contracts/backend/examples/run_record.route_infeasible.json'
import { ROUTE_LIMITS } from '../../edit/route/model'
import type { Feasibility, PlanRoute, RouteErrorBody, RouteRunRecord, RouteStop } from '../route/types'
import { crewJobScript } from './fixtures'
import { mockHash, type MockCall, type MockFetch } from './fetch'
import { mockResultFile } from './result'

/** Placeholder engine identity (GET /engine/version) of the dev mock. */
export const MOCK_ENGINE_VERSION: EngineVersion = {
  engine_tree: '0'.repeat(40),
  commit: '0'.repeat(40),
  config_hash: `sha256:${'0'.repeat(64)}`,
  web_contract_version: '1.1.5',
  backend_contract_version: '1.2.0',
  terrain_hash: `sha256:${'0'.repeat(64)}`,
}

/** Recorded: contracts/backend/examples/run_record.route_infeasible.json (S4, S1, S2: leg S1 -> S2 breaks O2). */
export const RUN_RECORD_ROUTE_INFEASIBLE = routeInfeasibleExample as RouteRunRecord
const EXAMPLE_F = RUN_RECORD_ROUTE_INFEASIBLE.feasibility as Extract<Feasibility, { feasible: false }>
/** The pair whose leg the mock reports as infeasible, with the example's limit and shortfall. */
export const MOCK_INFEASIBLE_LEG = { from: EXAMPLE_F.from, to: EXAMPLE_F.to, limit: EXAMPLE_F.limit, shortfall_min: EXAMPLE_F.shortfall_min }

const isStation = (s: RouteStop): s is { station: string } => typeof (s as { station?: unknown }).station === 'string'
const names = (stops: readonly RouteStop[]) => {
  let w = 0
  return stops.map((s) => (isStation(s) ? s.station : `W${++w}`))
}

/** The 422 the server gives a refused route (first problem only, naming the stop), or null. */
export function routeRefusal(route: PlanRoute, stations: readonly string[] = ['S1', 'S2', 'S4', 'S6', 'S7', 'S8']): RouteErrorBody | null {
  const stops = route.stops ?? []
  if (route.mode === 'ordered' && !stops.length) return { error: 'invalid_input', detail: 'route.stops: at least one stop for mode ordered', stop: null }
  if (stops.length > ROUTE_LIMITS.maxStops) return { error: 'route_too_many_stops', detail: `route: at most ${ROUTE_LIMITS.maxStops} stops`, stop: null }
  const seen = new Set<string>()
  for (const [i, s] of stops.entries()) {
    if (!isStation(s)) continue
    if (!stations.includes(s.station)) return { error: 'route_station_unknown', detail: `stops[${i}]: ${s.station} is not in stations.json`, stop: i }
    if (seen.has(s.station)) return { error: 'route_station_duplicate', detail: `stops[${i}]: ${s.station} is already in the route`, stop: i }
    seen.add(s.station)
  }
  return null
}

/** The mock answer for a route as given: infeasible on the first leg S1 -> S2, else feasible. */
export function routeFeasibility(route: PlanRoute): Feasibility {
  const n = ['pad', ...names(route.stops ?? []), 'pad']
  for (let i = 0; i + 1 < n.length; i++) {
    if (n[i] === MOCK_INFEASIBLE_LEG.from && n[i + 1] === MOCK_INFEASIBLE_LEG.to)
      return { feasible: false, leg: i, from: n[i], to: n[i + 1], limit: MOCK_INFEASIBLE_LEG.limit, shortfall_min: MOCK_INFEASIBLE_LEG.shortfall_min, legs_planned: i }
  }
  return { feasible: true }
}

/** The route run record (v1.2.0): the recorded route example under this hash and inputs, with this answer. */
export function routeRunRecord(hash: string, inputs: PlanInputs, f: Feasibility): RouteRunRecord {
  return {
    ...RUN_RECORD_ROUTE_INFEASIBLE,
    contract_version: '1.2.0',
    hash,
    inputs,
    range_flags: [],
    route_mode: 'ordered',
    feasibility: f,
    infeasible: f.feasible ? null : { leg: f.leg, from: f.from, to: f.to, margin_min: -f.shortfall_min, binding: f.limit },
  }
}

/** The hash the mock files a route under (labels dropped, as the server hashes, D57). */
export function routeHash(inputs: PlanInputs): string {
  const r = inputs.route as PlanRoute
  const stops = (r.stops ?? []).map((s) => (isStation(s) ? s : { lon: s.lon, lat: s.lat }))
  return mockHash(canonicalJson({ ...inputs, title: undefined, route: { ...r, stops } }))
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export function withRouteMock(inner: (input: string, init?: RequestInit) => Promise<Response>): MockFetch {
  const jobs = new Map<string, { script: Job[]; idx: number; record: RouteRunRecord }>()
  const byHash = new Map<string, string>() // hash -> job id
  const calls: MockCall[] = (inner as Partial<MockFetch>).calls ?? []
  const fn = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase()
    const url = new URL(input, 'http://mock.invalid')
    const i = url.pathname.indexOf(`${API_PREFIX}/`)
    const path = i >= 0 ? url.pathname.slice(i + API_PREFIX.length) : url.pathname
    if (method === 'POST' && path === '/jobs' && typeof init.body === 'string') {
      const req = JSON.parse(init.body) as JobRequest
      const route = req.inputs?.route as PlanRoute | undefined
      if (route && route.mode === 'ordered') {
        calls.push({ method, path, body: req })
        const refused = routeRefusal(route)
        if (refused) return json(422, refused satisfies ApiErrorBody)
        const hash = routeHash(req.inputs)
        const id = `job-${hash}`
        const again = jobs.has(id)
        const script = crewJobScript(hash, id)
        jobs.set(id, { script, idx: 0, record: routeRunRecord(hash, req.inputs, routeFeasibility(route)) })
        byHash.set(hash, id)
        return json(202, again ? { ...script[0], attached: true } : script[0])
      }
    }
    const jm = /^\/jobs\/([^/]+)$/.exec(path)
    if (method === 'GET' && jm && jobs.has(decodeURIComponent(jm[1]))) {
      calls.push({ method, path, body: null })
      const j = jobs.get(decodeURIComponent(jm[1]))!
      j.idx = Math.min(j.idx + 1, j.script.length - 1)
      return json(200, j.script[j.idx])
    }
    const rm = /^\/results\/([0-9a-f]{16})\/(.+)$/.exec(path)
    if (method === 'GET' && rm && byHash.has(rm[1])) {
      calls.push({ method, path, body: null })
      const j = jobs.get(byHash.get(rm[1])!)!
      if (rm[2] === 'provenance') return j.script[j.idx].status === 'done' ? json(200, j.record) : json(404, { error: 'unknown_result', detail: rm[1] })
      const doc = mockResultFile(decodeURIComponent(rm[2]), j.script[j.idx].stages_done)
      return doc === null ? json(404, { error: 'file_not_found', detail: rm[2] }) : json(200, doc)
    }
    const res = await inner(input, init)
    if (method === 'GET' && path === '/engine/version' && res.status === 404) return json(200, MOCK_ENGINE_VERSION)
    return res
  }
  return Object.assign(fn, { calls })
}
