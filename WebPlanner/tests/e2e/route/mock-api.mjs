// WP8a (D97): tiny local mock of the live API for the route end-to-end harness (drive-route.mjs --mock).
// Answers only what the route flow reads, in the shapes of contracts/backend (v1.2.0):
//   GET  /api/v1/health                      {ok, engine_warm, queue_length, heavy_jobs}
//   GET  /api/v1/engine/version              placeholder identity (contracts example zeros)
//   GET  /api/v1/defaults                    config/backend.yaml ranges + crew.yaml defaults (openapi Defaults)
//   POST /api/v1/jobs                        a staged job (scripted clock), or a 422 naming the stop (Error.stop)
//   GET  /api/v1/jobs/{id}                   job state from the job's clock
//   GET  /api/v1/results/{hash}/provenance   run record (route_mode, feasibility) once done
//   GET  /api/v1/results/{hash}/{path}       the result tree, stage by stage (see TREE below)
//   POST /api/v1/plans/import                {hash, inputs, computed}
//   GET  /__mock/info                        {officialHash, jobs}: harness bookkeeping, not an API path
// Every other API path answers 404 {error: "not_in_mock"}. CORS: the request Origin is echoed (the
// web runs on a Vite port 4200-4299, the mock on 8150-8199, so the browser keeps web security on).
//
// TREE: a route job's files are the official static tree (web/public/data, same names and contracts)
// gated by stage, except route_nom_104.geojson, which is synthesized from the submitted stops IN THE
// GIVEN ORDER (straight legs between station access points), so the harness can check that nothing is
// reordered. Numbers are placeholders, not results.
//   nominal  manifest.json, scenarios/index.json (default scenario only, range [null, null]),
//            scenarios/bands_104.geojson, scenarios/nom_104/{isochrones,edges}.geojson, route_nom_104.geojson
//   bands    the full scenarios/index.json and every scenario's bands/isochrones/edges
//   partner  scenarios/*/partner.geojson
// The official plan (hash of contracts/backend/examples/plan_inputs.official.json) is served as
// "precomputed" with the whole static tree, for the official-permalink check.
//
// FEASIBILITY (the infeasible variant): a placeholder time model, not the engine. Walk = straight
// distance x DETOUR at SPEED_M_MIN, dwell = stations.json dwell_min (30) per stop; budget =
// eva.duration_h x 60 - reserve_min (390 - 30 = 360 min). Leg i fails when its arrival time plus the
// straight walk home exceeds the budget (the home leg: its arrival). limit "EVA duration", shortfall =
// the overrun in minutes, legs_planned = i. With the official pad: S4, S1, S2 is feasible and
// S4, S1, S2, S7, S8 fails (printed by `node mock-api.mjs --explain S4,S1,S2,S7,S8`).
//
// usage: node mock-api.mjs [--port 8170] [--stage-ms 1500] [--repo <checkout with web/public/data>]
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, normalize, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const STAGES = ['nominal', 'bands', 'partner', 'route', 'summary']
const DETOUR = 1.25
const SPEED_M_MIN = 40
const MARS_R = 3389500

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

/** Canonical JSON (sorted keys) as the hash input. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}

/** Mock result hash: inputs without title; auto route removed; ordered route in order, labels dropped (D57 rule). */
export function mockHash(inputs) {
  const { title: _t, contract_version: _c, ...rest } = inputs ?? {}
  const r = rest.route
  if (!r || r.mode !== 'ordered') delete rest.route
  else rest.route = { mode: 'ordered', stops: r.stops.map((s) => ('station' in s ? { station: s.station } : { lon: s.lon, lat: s.lat })) }
  return createHash('sha256').update(canonical(rest)).digest('hex').slice(0, 16)
}

function distM(a, b) {
  const rad = Math.PI / 180
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad)
  const y = (b.lat - a.lat) * rad
  return Math.hypot(x, y) * MARS_R
}

export function loadWorld(repo) {
  const data = join(repo, 'web/public/data')
  const ex = join(repo, 'contracts/backend/examples')
  const stations = readJson(join(data, 'stations.json'))
  const pad = readJson(join(data, 'pad.json')).pad
  return { repo, data, ex, stations, pad, index: readJson(join(data, 'scenarios/index.json')), official: readJson(join(ex, 'plan_inputs.official.json')) }
}

/** Stops with names (station id or W1, W2, ...) and positions; null position = unknown station. */
function namedStops(world, stops) {
  let w = 0
  return stops.map((s) => {
    if ('station' in s) {
      const st = world.stations.find((x) => x.id === s.station)
      return { name: s.station, at: st ? { lon: st.access_lon ?? st.lon, lat: st.access_lat ?? st.lat } : null, dwell: st?.dwell_min ?? 30 }
    }
    return { name: `W${++w}`, at: { lon: s.lon, lat: s.lat }, dwell: 30 }
  })
}

/** 422 body for a refused route (first problem, naming the stop), else null. Rules of openapi Error.stop. */
export function refusal(world, route, limits) {
  const stops = route.stops ?? []
  if (route.mode === 'auto' && stops.length) return { error: 'route_mode_conflict', detail: 'route: an auto route has no stops', stop: null }
  if (route.mode !== 'ordered') return null
  if (!stops.length) return { error: 'invalid_input', detail: 'route.stops: at least one stop for mode ordered', stop: null }
  if (stops.length > limits.max_stops) return { error: 'route_too_many_stops', detail: `route: at most ${limits.max_stops} stops`, stop: limits.max_stops }
  const free = stops.map((s, i) => ('station' in s ? -1 : i)).filter((i) => i >= 0)
  if (free.length > limits.max_free_points) return { error: 'route_too_many_free_points', detail: `route: at most ${limits.max_free_points} free points`, stop: free[limits.max_free_points] }
  const seen = new Set()
  const named = namedStops(world, stops)
  for (const [i, s] of stops.entries()) {
    if ('station' in s) {
      if (!named[i].at) return { error: 'route_station_unknown', detail: `stops[${i}]: ${s.station} is not in stations.json`, stop: i }
      if (seen.has(s.station)) return { error: 'route_station_duplicate', detail: `stops[${i}]: ${s.station} is already in the route`, stop: i }
      seen.add(s.station)
    } else if (s.label !== undefined && [...String(s.label)].length > 80) return { error: 'route_label_too_long', detail: `stops[${i}].label: too long`, stop: i }
  }
  return null
}

/** Placeholder legs and feasibility (see FEASIBILITY in the header). */
export function mockPlan(world, inputs) {
  const pad = { lon: inputs.pad.lon, lat: inputs.pad.lat }
  const stops = namedStops(world, inputs.route?.stops ?? [])
  const budget = (inputs.eva?.duration_h ?? 6.5) * 60 - (inputs.eva?.reserve_min ?? 30)
  const pts = [{ name: 'pad', at: pad, dwell: 0 }, ...stops, { name: 'pad', at: pad, dwell: 0 }]
  const legs = []
  let t = 0
  let feasibility = { feasible: true }
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1]
    const len = distM(a.at, b.at) * DETOUR
    const walk = len / SPEED_M_MIN
    const t0 = t
    const t1 = t + walk
    const home = i + 1 === pts.length - 1 ? 0 : (distM(b.at, pad) * DETOUR) / SPEED_M_MIN
    const need = t1 + (i + 1 === pts.length - 1 ? 0 : b.dwell) + home
    if (need > budget) {
      feasibility = { feasible: false, leg: i, from: a.name, to: b.name, limit: 'EVA duration', shortfall_min: +(need - budget).toFixed(1), legs_planned: i }
      break
    }
    legs.push({ leg: i + 1, from: a.name, to: b.name, a: a.at, b: b.at, t0, t1, len })
    t = t1 + b.dwell
  }
  return { legs, feasibility, budget }
}

function routeGeojson(plan) {
  return {
    type: 'FeatureCollection',
    features: plan.legs.map((l) => {
      const mid = { lon: (l.a.lon + l.b.lon) / 2, lat: (l.a.lat + l.b.lat) / 2 }
      const r = (x) => +x.toFixed(2)
      return {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[l.a.lon, l.a.lat], [mid.lon, mid.lat], [l.b.lon, l.b.lat]] },
        properties: { leg: l.leg, from: l.from, to: l.to, t_min: r(l.t1 - l.t0), o2_L: r((l.t1 - l.t0) * 1.35), length_m: +l.len.toFixed(1), t_start_min: r(l.t0), t_end_min: r(l.t1), times_min: [r(l.t0), r((l.t0 + l.t1) / 2), r(l.t1)] },
      }
    }),
  }
}

function defaultsDoc(world) {
  const yaml = world.yaml
  const backend = yaml.parse(readFileSync(join(world.repo, 'config/backend.yaml'), 'utf8'))
  const crew = yaml.parse(readFileSync(join(world.repo, 'config/crew.yaml'), 'utf8'))
  const get = (o, path) => path.split('.').reduce((v, k) => v?.[k], o)
  const ranges = {}
  for (const [k, v] of Object.entries(backend.ranges ?? {})) {
    if (!v || typeof v !== 'object') { ranges[k] = v; continue }
    const { default_ref, ...r } = v
    let def = r.default
    if (default_ref) { const [file, ...p] = default_ref.split('.'); def = get(file === 'crew' ? crew : backend, p.join('.')) }
    ranges[k] = { ...r, ...(def !== undefined ? { default: def } : {}) }
  }
  const d = (k) => ranges[k]?.default
  const { title: _t, ...official } = world.official
  return {
    inputs: {
      ...official,
      contract_version: '1.2.0',
      crew: { body_mass_kg: d('body_mass_kg'), suit_kg: d('suit_kg'), tools_kg: d('tools_kg'), vo2max_ml_kg_min: d('vo2max_ml_kg_min'), effort_cap_frac: d('effort_cap_frac') },
      eva: { reserve_min: d('reserve_min'), walkback_budgets_min: d('walkback_budget_min') },
    },
    ranges,
    stations: world.stations,
    pads: [],
    limits: backend.route,
  }
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')

export async function startMock({ port = 8170, host = '127.0.0.1', repo = resolve(HERE, '../../..'), stageMs = 1500, log = () => {} } = {}) {
  const world = loadWorld(repo)
  world.yaml = await import(pathToFileURL(join(repo, 'web/node_modules/yaml/dist/index.js')).href).catch(() => import('yaml'))
  const defaults = defaultsDoc(world)
  const limits = { max_stops: 8, max_free_points: 4, min_stop_spacing_m: 50, ...(defaults.limits ?? {}) }
  const runRecordExample = readJson(join(world.ex, 'run_record.route_infeasible.json'))
  const versionExample = runRecordExample.engine
  const officialHash = mockHash(world.official)
  /** hash -> {id, hash, inputs, t0, plan, cached} */
  const results = new Map()
  const jobs = new Map()
  results.set(officialHash, { id: null, hash: officialHash, inputs: { ...world.official, contract_version: '1.2.0' }, t0: Date.now() - 10 * stageMs * STAGES.length, plan: null, official: true })

  const stagesDone = (r) => (r.official ? STAGES : STAGES.filter((_, i) => Date.now() - r.t0 >= (i + 1) * stageMs))
  function jobOf(r) {
    const done = stagesDone(r)
    const finished = done.length === STAGES.length
    return {
      id: r.id, type: 'plan', hash: r.hash, status: finished ? 'done' : 'running', stage: finished ? null : STAGES[done.length],
      progress: +(done.length / STAGES.length).toFixed(2), stages_done: done, queue_position: null,
      result_url: `/api/v1/results/${r.hash}/`, attached: !!r.attached, error: null, retry_after_s: null,
    }
  }
  function runRecord(r) {
    const done = stagesDone(r)
    const route = r.inputs.route
    const ordered = route?.mode === 'ordered'
    const f = r.plan?.feasibility ?? null
    return {
      ...runRecordExample,
      contract_version: '1.2.0',
      hash: r.hash,
      origin: r.official ? 'precomputed' : 'computed_live',
      label: r.official ? 'Precomputed · official plan' : 'Computed live · not part of the validated scorecard',
      inputs: r.inputs,
      status: 'done',
      started_utc: iso(r.t0),
      finished_utc: iso(r.t0 + STAGES.length * stageMs),
      stages: done.map((name, i) => ({ name, started_utc: iso(r.t0 + i * stageMs), seconds: stageMs / 1000, files: [] })),
      files: [],
      range_flags: [],
      route_mode: ordered ? 'ordered' : 'auto',
      ...(ordered && f ? { feasibility: f, infeasible: f.feasible ? null : { leg: f.leg, from: f.from, to: f.to, margin_min: -f.shortfall_min, binding: f.limit } } : { feasibility: undefined, infeasible: null }),
      error: null,
      dummy: true,
    }
  }
  /** A result file at `path` once `done` stages finished; null = not written (404). */
  function resultFile(r, path) {
    const p = normalize(path)
    if (p.startsWith('..') || p.startsWith('/')) return null
    const done = stagesDone(r)
    const has = (s) => done.includes(s)
    const file = join(world.data, p)
    const staticDoc = () => (existsSync(file) ? readJson(file) : null)
    if (r.official) return p.endsWith('.json') || p.endsWith('.geojson') ? staticDoc() : null
    const def = world.index.default
    if (p === 'route_nom_104.geojson' || p === `route_${def}.geojson`) return has('nominal') ? routeGeojson(r.plan) : null
    if (p === 'manifest.json') return has('nominal') ? staticDoc() : null
    if (p === 'scenarios/index.json') {
      if (has('bands')) return staticDoc()
      if (!has('nominal')) return null
      const s = world.index.scenarios.find((x) => x.id === def)
      const { headline_60: _h, ...entry } = s
      return { ...world.index, scenarios: [{ ...entry, headline: { ...s.headline, range_pct: [null, null] } }] }
    }
    if (/^scenarios\/[a-z]+_\d+\/partner\.geojson$/.test(p)) return has('partner') ? staticDoc() : null
    const nomFiles = ['scenarios/bands_104.geojson', `scenarios/${def}/isochrones.geojson`, `scenarios/${def}/edges.geojson`]
    if (nomFiles.includes(p)) return has('nominal') ? staticDoc() : null
    if (p.startsWith('scenarios/')) return has('bands') ? staticDoc() : null
    return null // timeline, cards, ...: not written by the mock
  }

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin
    const cors = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Expose-Headers': 'Retry-After' } : {}
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? 'content-type', 'Access-Control-Max-Age': '600' })
      return res.end()
    }
    const url = new URL(req.url, 'http://mock')
    let body = null
    if (req.method === 'POST') {
      let raw = ''
      for await (const c of req) raw += c
      try { body = raw ? JSON.parse(raw) : null } catch { return send(422, { error: 'invalid_input', detail: 'body is not JSON' }) }
    }
    log(`${req.method} ${url.pathname}`)
    if (url.pathname === '/__mock/info') return send(200, { officialHash, stageMs, stages: STAGES, jobs: [...jobs.values()].map((r) => ({ id: r.id, hash: r.hash, route: r.inputs.route ?? null, feasibility: r.plan?.feasibility ?? null, job: jobOf(r) })) })
    if (!url.pathname.startsWith('/api/v1/')) return send(404, { error: 'not_found' })
    const path = url.pathname.slice('/api/v1'.length)
    if (req.method === 'GET' && path === '/health') return send(200, { ok: true, engine_warm: true, queue_length: 0, heavy_jobs: 'on' })
    if (req.method === 'GET' && path === '/engine/version')
      return send(200, { engine_tree: versionExample.tree, commit: versionExample.commit, config_hash: versionExample.config_hash, web_contract_version: versionExample.web_contract_version, backend_contract_version: '1.2.0', terrain_hash: runRecordExample.terrain_hash })
    if (req.method === 'GET' && path === '/defaults') { const { limits: _l, ...d } = defaults; return send(200, d) }
    if (req.method === 'POST' && path === '/jobs') {
      const inputs = body?.inputs
      if (!inputs?.pad || typeof inputs.pad.lon !== 'number') return send(422, { error: 'invalid_input', detail: 'inputs.pad: required' })
      if (inputs.route) {
        const bad = refusal(world, inputs.route, limits)
        if (bad) return send(422, bad)
      }
      const hash = mockHash(inputs)
      const known = results.get(hash)
      if (known) {
        known.attached = true
        return send(202, jobOf(known))
      }
      const r = { id: `j_mock_${hash}`, hash, inputs: { ...inputs, contract_version: inputs.contract_version ?? '1.2.0' }, t0: Date.now(), plan: mockPlan(world, inputs) }
      results.set(hash, r)
      jobs.set(r.id, r)
      return send(202, jobOf(r))
    }
    const jm = /^\/jobs\/([^/]+)$/.exec(path)
    if (req.method === 'GET' && jm) {
      const r = jobs.get(decodeURIComponent(jm[1]))
      return r ? send(200, jobOf(r)) : send(404, { error: 'unknown_job', detail: jm[1] })
    }
    const rm = /^\/results\/([0-9a-f]{16})\/(.*)$/.exec(path)
    if (req.method === 'GET' && rm) {
      const r = results.get(rm[1])
      if (!r) return send(404, { error: 'unknown_result', detail: rm[1] })
      if (rm[2] === 'provenance') return stagesDone(r).length === STAGES.length ? send(200, runRecord(r)) : send(404, { error: 'unknown_result', detail: `${rm[1]} is still running` })
      const doc = resultFile(r, decodeURIComponent(rm[2]))
      return doc === null ? send(404, { error: 'file_not_found', detail: rm[2] }) : send(200, doc)
    }
    if (req.method === 'POST' && path === '/plans/import') {
      if (!body?.pad) return send(422, { error: 'invalid_input', detail: 'pad: required' })
      if (body.route) {
        const bad = refusal(world, body.route, limits)
        if (bad) return send(422, bad)
      }
      const hash = mockHash(body)
      const r = results.get(hash)
      return send(200, { hash, inputs: body, computed: !!r && stagesDone(r).length === STAGES.length, range_flags: [] })
    }
    return send(404, { error: 'not_in_mock', detail: `${req.method} ${path}` })
  })
  await new Promise((ok, fail) => {
    server.once('error', fail)
    server.listen(port, host, ok)
  })
  return {
    url: `http://${host === '127.0.0.1' ? 'localhost' : host}:${port}`,
    officialHash,
    world,
    close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()) }),
  }
}

// ---- CLI ----
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
  const repo = resolve(arg('--repo', resolve(HERE, '../../..')))
  const explain = arg('--explain', null)
  if (explain) {
    const world = loadWorld(repo)
    const inputs = { pad: world.pad, route: { mode: 'ordered', stops: explain.split(',').map((s) => ({ station: s.trim() })) } }
    const p = mockPlan(world, inputs)
    console.log(JSON.stringify({ budget_min: p.budget, legs: p.legs.map((l) => `${l.leg} ${l.from}->${l.to} ${l.t0.toFixed(1)}-${l.t1.toFixed(1)} min`), feasibility: p.feasibility }, null, 1))
  } else {
    const m = await startMock({ port: Number(arg('--port', 8170)), stageMs: Number(arg('--stage-ms', 1500)), repo, log: process.argv.includes('--verbose') ? (s) => console.log(s) : () => {} })
    console.log(`mock API on ${m.url}/api/v1 (official hash ${m.officialHash}); Ctrl+C to stop`)
  }
}
