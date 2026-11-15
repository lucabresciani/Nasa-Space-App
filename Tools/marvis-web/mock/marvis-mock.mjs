#!/usr/bin/env node
// marvis-mock.mjs: a stand-in for the Unity side of the MARVIS web bridge, for testing the HOMELINE
// web app without Unity. Plain Node (18+), no dependencies.
//
// DEV TOOL ONLY. The EVA log this mock produces (GET /marvis/mock/complete) is SYNTHETIC TEST DATA:
// the posted mission's own planned path, replayed a little slower and with a small sideways wobble.
// Nobody walked it and no simulator ran. Never show it as a result. The log says so itself
// (title, origin_label, o2_model, x_mock); the page's debrief card shows the title and origin_label.
//
// It serves a folder (the built web app) as static files and implements the bridge API in memory:
//   GET  /marvis/api/hello    {"app":"MARVIS","bridge":1,"version":"mock"}
//   GET  /marvis/api/state    {"seq","planner_visible","eva","mission_id","eva_log_seq","last_error"}
//   POST /marvis/api/mission  mission.json text, header X-Marvis: 1 -> {"ok":true,"mission_id"} | 422 {"ok":false,"error"}
//   GET  /marvis/api/eva-log  the latest (synthetic) eva_log document | 404 {"ok":false,"error":"no log"}
//   POST /marvis/api/close    header X-Marvis: 1 -> {"ok":true}
// The API answers 403 when the Host header is not 127.0.0.1:<port> or localhost:<port>, and to a
// POST without X-Marvis: 1. Every API answer is JSON, UTF-8, Cache-Control: no-store.
//
// Mock-only controls (GET, so they can be opened from a browser or curl):
//   /marvis/mock/complete            end the EVA: build the synthetic log, show the planner again
//   /marvis/mock/complete?ended=1    the same, but ended early (about 60 % of the way, complete = false)
//   /marvis/mock/fail-next?error=..  the next POST /marvis/api/mission answers 422 with this reason
//   /marvis/mock/show                planner_visible = true (what Unity does when the planner is opened)
//
// Usage:
//   node marvis-mock.mjs --root <folder with index.html> [--port 47815] [--out <file>] [--log-out <file>]
//     --out      every accepted mission is written here, byte for byte as it was posted
//     --log-out  every synthetic eva_log is written here
import http from 'node:http'
import { createReadStream, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, resolve, sep } from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
const ROOT = resolve(arg('--root', '.'))
const PORT = Number(arg('--port', '47815'))
const OUT = arg('--out', null)
const LOG_OUT = arg('--log-out', null)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.gz': 'application/octet-stream', // served as stored: no Content-Encoding, the app gunzips it itself
}

// ---------------------------------------------------------------- bridge state (in memory)
let seq = 0
let plannerVisible = true
let mission = null // the last accepted mission document
let missionAtMs = 0
let log = null // the latest synthetic eva_log
let logIsForMission = false // a log was produced since the last accepted mission
let logSeq = 0
let lastError = null
let failNext = null

function evaState() {
  if (!mission) return 'idle'
  if (!log || !logIsForMission) return 'running'
  return log.summary.complete ? 'complete' : 'ended'
}

function writeOut(path, text) {
  if (!path) return
  mkdirSync(dirname(resolve(path)), { recursive: true })
  writeFileSync(resolve(path), text)
}

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': buf.length })
  res.end(buf)
}

function readBody(req) {
  return new Promise((ok, fail) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 64 * 1024 * 1024) {
        fail(new Error('body too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')))
    req.on('error', fail)
  })
}

/** Why a posted document cannot be loaded as a mission, or null when it can. */
function missionProblem(doc) {
  if (!doc || typeof doc !== 'object') return 'not a JSON object'
  if (doc.kind !== 'homeline_mission') return 'kind is not homeline_mission'
  if (typeof doc.mission_id !== 'string' || !doc.mission_id) return 'no mission_id'
  if (!Array.isArray(doc.waypoints) || !doc.waypoints.length) return 'no waypoints'
  if (!Array.isArray(doc.path?.rows) || doc.path.rows.length < 2) return 'no path'
  if (typeof doc.frame?.pad?.lon !== 'number' || typeof doc.frame?.pad?.lat !== 'number') return 'no pad position'
  return null
}

// ---------------------------------------------------------------- synthetic EVA log (TEST DATA)
const utc = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const r = (v, d) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d)

/** Linear interpolation of column `col` of `rows` (ascending in column `tCol`) at `t`, clamped; null without rows. */
function at(rows, tCol, col, t) {
  if (!rows.length) return null
  if (t <= rows[0][tCol]) return rows[0][col]
  for (let i = 1; i < rows.length; i++) {
    if (t <= rows[i][tCol]) {
      const a = rows[i - 1]
      const b = rows[i]
      const f = b[tCol] === a[tCol] ? 0 : (t - a[tCol]) / (b[tCol] - a[tCol])
      return a[col] + f * (b[col] - a[col])
    }
  }
  return rows[rows.length - 1][col]
}

/**
 * A plausible eva_log (contracts/bundle/eva_log.schema.json) made from the mission's own plan.
 * SYNTHETIC: the planned path, walked 6 % slower, with 4 % more O2 and up to 8 m off the route.
 */
function syntheticLog(m, endedEarly) {
  const SLOW = 1.06
  const O2X = 1.04
  const WOBBLE_M = 8
  const STEP_MIN = 5 / 60
  const DEG = Math.PI / 180
  const proj = Object.fromEntries([...String(m.frame.projection?.proj ?? '').matchAll(/\+(\w+)=(\S+)/g)].map((x) => [x[1], Number(x[2])]))
  const R = Number.isFinite(proj.R) ? proj.R : 3396190
  const cosTs = Math.cos((Number.isFinite(proj.lat_ts) ? proj.lat_ts : 0) * DEG)
  const pad = m.frame.pad
  // path columns: leg, s_m, x_m, y_m, z_m, t_eva_min, o2_used_l, t_home_min, o2_home_l
  const pts = m.path.rows.filter((p) => typeof p[5] === 'number' && typeof p[2] === 'number' && typeof p[3] === 'number')
  if (pts.length < 2) return null
  const planEnd = pts[pts.length - 1][5]
  const end = planEnd * SLOW * (endedEarly ? 0.6 : 1)
  const homeLeg = (m.legs ?? []).find((l) => l.kind === 'home')?.leg ?? -1
  // timeline columns: t_min, phase, wp, o2_used_l, t_home_min, o2_home_l, tasks_left_l, margin_min, binding
  const tl = m.timeline?.rows ?? []

  const rows = []
  let j = 0
  let dir = [1, 0]
  let lowest = null
  let lowestBinding = null
  let maxCross = 0
  let status = 'ON PLAN'
  const n = Math.floor(end / STEP_MIN + 1e-9)
  for (let i = 0; i <= n; i++) {
    const t = i * STEP_MIN
    const tp = t / SLOW
    while (j < pts.length - 2 && pts[j + 1][5] < tp) j++
    const a = pts[j]
    const b = pts[j + 1]
    const f = b[5] === a[5] ? 0 : Math.min(1, Math.max(0, (tp - a[5]) / (b[5] - a[5])))
    const len = Math.hypot(b[2] - a[2], b[3] - a[3])
    const moving = len > 1e-6
    if (moving) dir = [(b[2] - a[2]) / len, (b[3] - a[3]) / len]
    // sideways wobble: none while standing at a waypoint, fading in and out at the pad
    const side = moving ? WOBBLE_M * Math.sin(t * 1.3) * Math.min(1, tp, Math.max(0, planEnd - tp)) : 0
    const x = a[2] + f * (b[2] - a[2]) - dir[1] * side
    const y = a[3] + f * (b[3] - a[3]) + dir[0] * side
    const z = typeof a[4] === 'number' && typeof b[4] === 'number' ? a[4] + f * (b[4] - a[4]) : null
    const o2 = typeof a[6] === 'number' && typeof b[6] === 'number' ? a[6] + f * (b[6] - a[6]) : null
    const planMargin = at(tl, 0, 7, tp)
    const margin = planMargin === null ? null : planMargin - (t - tp)
    if (margin !== null && (lowest === null || margin < lowest)) {
      lowest = margin
      lowestBinding = tl.reduce((best, row) => (Math.abs(row[0] - tp) < Math.abs(best[0] - tp) ? row : best), tl[0])[8]
    }
    maxCross = Math.max(maxCross, Math.abs(side))
    status = !endedEarly && i === n ? 'EVA COMPLETE' : a[0] === homeLeg ? 'HEADING HOME' : 'ON PLAN'
    rows.push([
      r(t, 3),
      r(pad.lon + x / (R * cosTs) / DEG, 7),
      r(pad.lat + y / R / DEG, 7),
      r(z === null || typeof pad.elev_m !== 'number' ? null : pad.elev_m + z, 1),
      r(Math.abs(side), 1),
      r(t - tp, 2),
      r(o2 === null ? null : o2 * O2X, 2),
      r(o2 === null ? null : o2 * (O2X - 1), 2),
      r(margin, 1),
      status,
    ])
  }

  const events = [{ t_min: 0, kind: 'start', wp: null, detail: m.title ?? '' }]
  const waypoints = m.waypoints.map((w) => {
    const arrived = typeof w.arrive_t_min === 'number' && w.arrive_t_min * SLOW <= end ? w.arrive_t_min * SLOW : null
    const done = arrived !== null && typeof w.leave_t_min === 'number' && w.leave_t_min * SLOW <= end ? w.leave_t_min * SLOW : null
    if (arrived !== null) events.push({ t_min: r(arrived, 3), kind: 'arrive', wp: w.index })
    if (done !== null) events.push({ t_min: r(done, 3), kind: 'done', wp: w.index })
    return {
      index: w.index,
      state: done !== null ? 'done' : arrived !== null ? 'stopping' : 'upcoming',
      planned_arrive_min: w.arrive_t_min ?? null,
      planned_leave_min: w.leave_t_min ?? null,
      arrived_min: r(arrived, 3),
      done_min: r(done, 3),
      left_early: false,
    }
  })
  events.push(endedEarly ? { t_min: r(end, 3), kind: 'end', wp: null, detail: 'ended by the mock (test)' } : { t_min: r(end, 3), kind: 'complete', wp: null })

  const last = rows[rows.length - 1]
  const planO2 = pts[pts.length - 1][6]
  const now = Date.now()
  return {
    schema_version: '1.1.0',
    kind: 'homeline_eva_log',
    mission_id: m.mission_id,
    title: `SYNTHETIC TEST LOG: ${m.title ?? ''}`,
    created_utc: utc(now),
    started_utc: utc(missionAtMs || now),
    origin: 'unity_simulator', // the contract's only value; this document is NOT from the simulator (see x_mock)
    origin_label: 'SYNTHETIC TEST LOG from marvis-mock.mjs: no simulator ran, nobody walked this',
    label: 'Simulated EVA · real terrain and data',
    dummy: m.dummy === true,
    o2_model: 'mock (synthetic test data: the planned O2 times 1.04, not a simulator run)',
    x_mock: 'synthetic test data from Tools/marvis-web/mock/marvis-mock.mjs; not a result',
    pad: { lon: pad.lon, lat: pad.lat },
    summary: {
      complete: !endedEarly,
      eva_min: r(end, 3),
      planned_eva_min: r(typeof m.summary?.eva_min === 'number' ? m.summary.eva_min : planEnd, 3),
      final_status: status,
      waypoints_done: waypoints.filter((w) => w.state === 'done').length,
      waypoints_skipped: 0,
      stops_left_early: 0,
      lowest_margin_min: r(lowest, 2),
      lowest_binding: lowestBinding,
      max_cross_track_m: r(maxCross, 1),
      max_behind_min: r(end - end / SLOW, 2),
      o2_used_l: last[6],
      planned_o2_used_l: r(typeof planO2 === 'number' ? planO2 : null, 2),
    },
    waypoints,
    events,
    track: {
      columns: ['t_min', 'lon', 'lat', 'elev_m', 'cross_track_m', 'schedule_delta_min', 'o2_used_l', 'o2_delta_l', 'margin_min', 'status'],
      sample_every_min: r(STEP_MIN, 4),
      rows,
    },
  }
}

// ---------------------------------------------------------------- handlers
async function api(req, res, path, query) {
  const host = req.headers.host
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return sendJson(res, 403, { ok: false, error: 'bad Host header' })
  if (req.method === 'POST' && req.headers['x-marvis'] !== '1') return sendJson(res, 403, { ok: false, error: 'missing X-Marvis header' })
  const route = `${req.method} ${path}`

  if (route === 'GET /marvis/api/hello') return sendJson(res, 200, { app: 'MARVIS', bridge: 1, version: 'mock' })
  if (route === 'GET /marvis/api/state') {
    return sendJson(res, 200, { seq, planner_visible: plannerVisible, eva: evaState(), mission_id: mission?.mission_id ?? null, eva_log_seq: logSeq, last_error: lastError })
  }
  if (route === 'POST /marvis/api/mission') {
    const text = await readBody(req)
    let doc = null
    let problem = failNext
    failNext = null
    if (!problem) {
      try {
        doc = JSON.parse(text)
        problem = missionProblem(doc)
      } catch (e) {
        problem = `not JSON: ${e.message}`
      }
    }
    seq++
    if (problem) {
      lastError = problem
      console.log(`[mock] mission rejected: ${problem}`)
      return sendJson(res, 422, { ok: false, error: problem })
    }
    mission = doc
    missionAtMs = Date.now()
    logIsForMission = false
    lastError = null
    plannerVisible = false
    writeOut(OUT, text)
    console.log(`[mock] mission ${doc.mission_id} accepted (${doc.waypoints.length} waypoints, ${text.length} chars)${OUT ? ` -> ${OUT}` : ''}`)
    return sendJson(res, 200, { ok: true, mission_id: doc.mission_id })
  }
  if (route === 'GET /marvis/api/eva-log') return log ? sendJson(res, 200, log) : sendJson(res, 404, { ok: false, error: 'no log' })
  if (route === 'POST /marvis/api/close') {
    plannerVisible = false
    seq++
    console.log('[mock] planner closed')
    return sendJson(res, 200, { ok: true })
  }

  if (route === 'GET /marvis/mock/complete') {
    if (!mission) return sendJson(res, 409, { ok: false, error: 'no mission posted yet' })
    const made = syntheticLog(mission, query.get('ended') === '1')
    if (!made) return sendJson(res, 409, { ok: false, error: 'the mission path has no timed rows' })
    log = made
    logIsForMission = true
    logSeq++
    seq++
    plannerVisible = true
    writeOut(LOG_OUT, JSON.stringify(log))
    console.log(`[mock] synthetic eva_log #${logSeq} for ${mission.mission_id} (${log.track.rows.length} track rows, complete = ${log.summary.complete})`)
    return sendJson(res, 200, { ok: true, eva_log_seq: logSeq, complete: log.summary.complete })
  }
  if (route === 'GET /marvis/mock/fail-next') {
    failNext = query.get('error') || 'rejected by the mock (test)'
    return sendJson(res, 200, { ok: true, error: failNext })
  }
  if (route === 'GET /marvis/mock/show') {
    plannerVisible = true
    seq++
    return sendJson(res, 200, { ok: true })
  }
  return sendJson(res, 404, { ok: false, error: 'unknown API path' })
}

function serveStatic(req, res, path) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' })
    return res.end()
  }
  let rel
  try {
    rel = decodeURIComponent(path)
  } catch {
    rel = null
  }
  const file = rel === null ? null : resolve(ROOT, `.${rel === '/' ? '/index.html' : rel}`)
  let st = null
  if (file && (file === ROOT || file.startsWith(ROOT + sep))) {
    try {
      st = statSync(file)
    } catch {
      st = null
    }
  }
  if (!st || !st.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('Not found')
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname.startsWith('/marvis/api/') || url.pathname.startsWith('/marvis/mock/')) {
    api(req, res, url.pathname, url.searchParams).catch((e) => sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }))
  } else serveStatic(req, res, url.pathname)
})
server.on('error', (e) => {
  console.error(`[mock] ${e.message}`)
  process.exit(1)
})
server.listen(PORT, '127.0.0.1', () => console.log(`[mock] MARVIS mock on http://127.0.0.1:${PORT}/ serving ${ROOT} (synthetic test data only)`))
