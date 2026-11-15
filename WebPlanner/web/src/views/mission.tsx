// "/mission" Mission Planer: the main planning area where waypoints are made. Left: the 2D map
// (HiRISE basemap, reachable-area boundary, pad, waypoints, legs, way home). Right: estimated times
// and consumption, then the waypoint list and the boundary picker. Click the map to add a
// waypoint; each leg is routed in the browser (src/mission/router.ts), the way home from the last
// waypoint is WS2's (pointer field, T_home, O2 home).
// Each waypoint carries a note, quick tags and a planned stop time (station work: EVA time + O2).
// The plan lives in the address (#/mission?plan=…, mission/share.ts) and in this browser, so it can be
// shared as a link and survives a reload.
// Later (PDF "Mission Planer"): O2 / radiation budget dropdown, reachable foundries.
// Embedded in the MARVIS simulator (marvis/bridge.ts) the export card also starts the EVA there, and
// the simulator's EVA log comes back as a debrief card with the walked track on the map.
import '../mission/mission.css'
import { render } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { CITED, CONFIG } from '../config'
import { DataProblem, DummyNote } from '../components/labels'
import { BASEMAP_CREDIT, basemapSources } from '../map/basemap'
import { dataUrl, DATA_MODE } from '../env'
import { BUDGET_CONSTANTS, missionBudget, stopMinutes, type MissionBudget } from '../mission/budget'
import { loadMissionData, type MissionData } from '../mission/data'
import { MissionMap } from '../mission/missionMap'
import { MapsControl } from '../mission/MapsControl'
import { boundaryOptions, defaultBoundary, legPairs, moveWaypoint, removeWaypoint, replaceWaypoint, routeLegs, toggleTag, WAYPOINT_TAGS, type LonLat, type Waypoint } from '../mission/plan'
import { LegRouter, type Leg } from '../mission/router'
import { decodePlan, encodePlan } from '../mission/share'
import { stationWaypoint } from '../mission/stations'
import { data } from '../data/loader'
import type { Station } from '../data/types'
import { href, type Route } from '../router'
import { buildTrack, legProfile, missionMargin } from '../mission/margin'
import { buildMission, downloadJson, finalizeMission } from '../mission/export'
import { detect, fetchEvaLog, sendMission, trackLonLat, watchState, type EvaLog } from '../marvis/bridge'
import { THEME } from '../theme'
import { ensureManifest } from './common'
import type { View } from './types'

export const view: View = async (el, route) => {
  const initial = route.name === 'mission' ? { plan: route.plan, add: route.add } : {}
  el.innerHTML = `<div class="console mission"><div class="console-map mission-map"></div><aside class="console-panel mission-panel"></aside></div>`
  const mapEl = el.querySelector<HTMLElement>('.mission-map')!
  const panelEl = el.querySelector<HTMLElement>('.mission-panel')!
  await ensureManifest()
  const handlers = { onAdd: (_lon: number, _lat: number) => {}, onMove: (_i: number, _lon: number, _lat: number) => {} }
  const mmap = new MissionMap(mapEl, { onAdd: (a, b) => handlers.onAdd(a, b), onMove: (i, a, b) => handlers.onMove(i, a, b) })
  const mapsEl = document.createElement('div')
  // The switcher sits inside the MapLibre container: keep its clicks from adding waypoints.
  for (const ev of ['mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'wheel']) mapsEl.addEventListener(ev, (e) => e.stopPropagation())
  mapEl.append(mapsEl)
  render(<MissionPanel mmap={mmap} handlers={handlers} mapsEl={mapsEl} initial={initial} />, panelEl)
  return () => {
    render(null, mapsEl)
    render(null, panelEl)
    mmap.destroy()
  }
}

type Handlers = { onAdd: (lon: number, lat: number) => void; onMove: (i: number, lon: number, lat: number) => void }

const fmtMin = (v: number | null, digits = 1) => (v === null ? '–' : `${v.toFixed(digits)} min`)
const fmtL = (v: number | null, digits = 1) => (v === null ? '–' : `${v.toFixed(digits)} L`)
const fmtM = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} km` : `${Math.round(v)} m`)

const SAVED_KEY = 'homeline.mission.plan'

function loadSaved(): string | null {
  try {
    return localStorage.getItem(SAVED_KEY)
  } catch {
    return null
  }
}
function save(plan: string): void {
  try {
    if (plan) localStorage.setItem(SAVED_KEY, plan)
    else localStorage.removeItem(SAVED_KEY)
  } catch {
    /* storage blocked: the link still holds the plan */
  }
}

type Initial = { plan?: string; add?: string }

/** MARVIS eva_log_seq of the last debrief the user dismissed: it stays away while the app is open. */
let dismissedLogSeq = 0

/** The last mission MARVIS accepted from this page: its id and the plan string (mission/share.ts) it was built from. */
let sent: { id: unknown; plan: string } | null = null

function MissionPanel({ mmap, handlers, mapsEl, initial }: { mmap: MissionMap; handlers: Handlers; mapsEl: HTMLElement; initial: Initial }) {
  const [d, setD] = useState<MissionData | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [step, setStep] = useState('scenarios and pad')
  const [wps, setWps] = useState<Waypoint[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [boundary, setBoundary] = useState('none')
  const [credit, setCredit] = useState<string | null>(null)
  const nextId = useRef(1)
  const cache = useRef(new Map<string, Leg | null>())
  const restored = useRef(false)
  // Science stations (stations.json): undefined while loading, null when they cannot be loaded.
  const [stations, setStations] = useState<Station[] | null | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  /** D39 storm switch: replay the 20 May 2024 RAD storm on this EVA's clock (dose term in the margin and the export) */
  const [storm, setStorm] = useState(false)
  /** served by the MARVIS simulator: the EVA can be started there and its log comes back */
  const [marvis, setMarvis] = useState(false)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [debrief, setDebrief] = useState<{ seq: number; log: EvaLog } | null>(null)
  const debriefEl = useRef<HTMLElement>(null)

  useEffect(() => {
    let alive = true
    void detect().then((yes) => alive && setMarvis(yes))
    return () => {
      alive = false
    }
  }, [])

  // A new EVA log in the simulator becomes the debrief, unless the user dismissed that one already.
  useEffect(() => {
    if (!marvis) return
    let alive = true
    let asked = 0
    const stop = watchState((s) => {
      const seq = Number(s.eva_log_seq) || 0
      if (seq <= dismissedLogSeq || seq === asked) return
      asked = seq
      void fetchEvaLog().then((log) => {
        if (!alive) return
        if (log) setDebrief({ seq, log })
        else asked = 0 // not there yet: ask again on the next state
      })
    })
    return () => {
      alive = false
      stop()
    }
  }, [marvis])

  const dismissDebrief = () => {
    if (debrief) dismissedLogSeq = debrief.seq
    setDebrief(null)
  }

  useEffect(() => {
    void mmap.setWalked(debrief ? trackLonLat(debrief.log) : null)
    if (debrief) debriefEl.current?.scrollIntoView({ block: 'nearest' })
  }, [debrief])

  // Load once.
  useEffect(() => {
    let alive = true
    loadMissionData(undefined, (s) => alive && setStep(s)).then(
      async (md) => {
        if (!alive) return
        setD(md)
        mmap.setPad({ lon: md.pad.lon, lat: md.pad.lat, title: md.pad.title })
        mmap.fitTo([[md.pad.lon, md.pad.lat]])
        if (md.tilejson) {
          await mmap.setBasemap(basemapSources(md.tilejson, (p) => dataUrl(p)))
          setCredit(md.tilejson.attribution ?? BASEMAP_CREDIT)
        }
        await mmap.setBoundaryData(md)
        // Maps switcher (bottom left of the map): satellite / topography / material.
        render(<MapsControl mmap={mmap} src={{ grid: md.tHome, elev: md.grid.elev, resM: md.grid.resM, hasBasemap: !!md.tilejson }} />, mapsEl)
        setBoundary(defaultBoundary(boundaryOptions(md.bands, md.isochrones, md.edges), CONFIG.walkbackBudgetsMin[0]))
      },
      (e) => alive && setError(e),
    )
    return () => {
      alive = false
    }
  }, [])

  const router = useMemo(() => (d ? new LegRouter(d.grid, d.model) : null), [d])
  const padCell = useMemo(() => {
    if (!d) return -1
    const p = d.tHome.pixelOf(d.pad.lon, d.pad.lat)
    return p ? p.row * d.tHome.width + p.col : -1
  }, [d])
  const options = useMemo(() => (d ? boundaryOptions(d.bands, d.isochrones, d.edges) : []), [d])

  /** Grid cell of a spot, or why it cannot be a waypoint. */
  const cellAt = (lon: number, lat: number): number | 'outside' | 'blocked' => {
    const p = d!.tHome.pixelOf(lon, lat)
    if (!p) return 'outside'
    const cell = p.row * d!.tHome.width + p.col
    return d!.grid.passable[cell] ? cell : 'blocked'
  }

  /** Snap a click to the routing grid: null + a notice when the spot cannot be walked from. */
  const snap = (lon: number, lat: number): number | null => {
    if (!d) return null
    const c = cellAt(lon, lat)
    if (c === 'outside') {
      setNotice('That spot is outside the terrain data: no waypoint added.')
      return null
    }
    if (c === 'blocked') {
      setNotice(`No walk home from that spot in ${d.scenario.id} (blocked, too steep, unknown terrain or not reached): no waypoint there.`)
      return null
    }
    setNotice(null)
    return c
  }

  useEffect(() => {
    let alive = true
    data()
      .stations()
      .then(
        (s) => alive && setStations(s),
        () => alive && setStations(null),
      )
    return () => {
      alive = false
    }
  }, [])

  /** Append a science station (its access cell, its dwell time) unless it is in the plan already. */
  const withStation = (list: Waypoint[], id: string): { list: Waypoint[]; msg: string } => {
    const s = stations?.find((x) => x.id === id)
    if (!s) return { list, msg: `No science station "${id}" in stations.json: nothing added.` }
    if (list.some((w) => w.station === id)) return { list, msg: `${id} is already in the plan.` }
    const w = stationWaypoint(s, d!.scenario.id)
    const c = w ? cellAt(w.lon, w.lat) : 'blocked'
    if (!w || typeof c !== 'number') return { list, msg: `${id} has no walkable access cell in ${d!.scenario.id}: not added.` }
    return { list: [...list, { ...w, id: nextId.current++, cell: c }], msg: `Added ${id} as waypoint #${list.length + 1}, with a ${w.stopMin}-min stop.` }
  }
  const addStation = (id: string) => {
    const r = withStation(wps, id)
    setNotice(r.msg)
    if (r.list !== wps) setWps(r.list)
  }

  // Restore once the data and stations are in: the link's plan, else this browser's last plan;
  // then the station from ?add= (from the Science stations page).
  useEffect(() => {
    if (!d || stations === undefined || restored.current) return
    restored.current = true
    const src = initial.plan ?? loadSaved() ?? ''
    const plan = decodePlan(src)
    if (plan === null && initial.plan) setNotice('The plan in this link is damaged or from another version: starting empty.')
    let out: Waypoint[] = []
    for (const w of plan ?? []) {
      const c = cellAt(w.lon, w.lat)
      if (typeof c === 'number') out.push({ ...w, id: nextId.current++, cell: c })
    }
    const lost = (plan ?? []).length - out.length
    if (lost) setNotice(`${lost} waypoint${lost === 1 ? '' : 's'} of the saved plan ${lost === 1 ? 'has' : 'have'} no walk home in ${d.scenario.id} and ${lost === 1 ? 'was' : 'were'} left out.`)
    if (initial.add) {
      const r = withStation(out, initial.add)
      out = r.list
      setNotice(r.msg)
    }
    setWps(out)
    // Drop ?add= from the address at once, so a reload does not add it again.
    const ps = encodePlan(out)
    history.replaceState(history.state, '', href(ps ? { name: 'mission', plan: ps } : { name: 'mission' }))
  }, [d, stations])

  // Keep the address and this browser's copy in step with the plan (replaceState: no re-render).
  const planStr = useMemo(() => encodePlan(wps), [wps])
  useEffect(() => {
    if (!restored.current) return
    save(planStr)
    const r: Route = planStr ? { name: 'mission', plan: planStr } : { name: 'mission' }
    history.replaceState(history.state, '', href(r))
    setCopied(false)
  }, [planStr])

  const copyLink = () => {
    navigator.clipboard?.writeText(location.href).then(
      () => setCopied(true),
      () => setNotice('Could not copy: copy the address from the browser bar instead.'),
    )
  }

  handlers.onAdd = (lon, lat) => {
    const cell = snap(lon, lat)
    if (cell === null) return
    setWps((w) => [...w, { id: nextId.current++, lon, lat, cell, note: '', tags: [], stopMin: 0 }])
  }
  handlers.onMove = (i, lon, lat) => {
    const cell = snap(lon, lat)
    if (cell === null) {
      setWps((w) => w.slice()) // redraw: the marker jumps back
      return
    }
    setWps((w) => replaceWaypoint(w, i, { ...w[i], lon, lat, cell }))
  }

  // Legs (cached) and the way home.
  const legs = useMemo<(Leg | null)[]>(() => {
    if (!router || padCell < 0) return []
    return routeLegs(legPairs(padCell, wps), (a, b) => router.route(a, b), cache.current)
  }, [router, padCell, wps])

  // Keyed on the cell only: editing a note or stop time must not recompute the way home.
  const lastCell = wps.length ? wps[wps.length - 1].cell : null
  const home = useMemo(() => {
    if (!d) return { tHomeMin: null, o2HomeL: null, path: null as { coords: LonLat[]; reachesPad: boolean } | null }
    if (lastCell === null) return { tHomeMin: 0, o2HomeL: 0, path: null }
    const ll = d.tHome.lonLatOf(Math.floor(lastCell / d.tHome.width), lastCell % d.tHome.width)
    const w = d.pointer?.pathFrom(ll[0], ll[1], [d.pad.lon, d.pad.lat]) ?? null
    return {
      tHomeMin: d.tHome.valueAt(ll[0], ll[1]),
      o2HomeL: d.o2Home ? d.o2Home.valueAt(ll[0], ll[1]) : null,
      path: w && w.startKnown && w.coords.length > 1 ? { coords: w.coords as LonLat[], reachesPad: w.reachesPad } : null,
    }
  }, [d, lastCell])

  const budget = useMemo(
    () => missionBudget(legs.map((l) => (l ? { timeMin: l.timeS / 60, o2L: l.o2L } : null)), home, wps.map((w) => w.stopMin)),
    [legs, home, wps],
  )

  // The planned margin over time; the storm switch (D39) adds the dose term when WS4's rad.json is loaded.
  const margin = useMemo(() => {
    if (!d || !wps.length || legs.some((l) => l === null)) return null
    const homeAt = (cell: number) => {
      const row = Math.floor(cell / d.tHome.width)
      const col = cell % d.tHome.width
      return { tHomeMin: d.tHome.valueAtPixel(row, col), o2HomeL: d.o2Home ? d.o2Home.valueAtPixel(row, col) : null }
    }
    const track = buildTrack(legs.map((l) => legProfile(l!, homeAt)), wps.map((w) => w.stopMin))
    return missionMargin(track, { tDarkMin: d.tDarkMin, rad: d.rad, storm })
  }, [d, legs, wps, storm])

  /** The finalized mission document of the current plan (mission.schema.json), or null without waypoints. */
  const missionDoc = async () => {
    if (!d || !wps.length) return null
    const w = d.tHome.width
    const elevAt = (lon: number, lat: number) => {
      const p = d.tHome.pixelOf(lon, lat)
      const v = p ? d.grid.elev[p.row * w + p.col] : NaN
      return Number.isFinite(v) ? v : null
    }
    const doc = buildMission({
      proj: CONFIG.analysisProj,
      pad: { kind: d.padKind, id: d.padId, lon: d.pad.lon, lat: d.pad.lat, elevM: d.padElevM, source: d.pad.sourceLabel },
      scenario: { id: d.scenario.id, variant: d.scenario.variant, suit_kg: d.scenario.suit_kg },
      planner: { gridResM: d.grid.resM, elevationResM: d.elevationResM, files: d.files },
      constants: { ...BUDGET_CONSTANTS, marginAmberMin: CONFIG.marginAmberMin },
      conditions: { evaStartLmst: d.evaStartLmst, tDarkMin: d.tDarkMin, storm, evaStartUtc: d.evaStartUtc, mslSol: d.mslSol, rad: d.rad },
      wps,
      legs,
      homePath: home.path?.coords ?? null,
      homeReachesPad: home.path?.reachesPad ?? false,
      budget,
      margin,
      cellLonLat: (c) => d.tHome.lonLatOf(Math.floor(c / w), c % w),
      elevAt,
      homeAt: (lon, lat) => ({ tHomeMin: d.tHome.valueAt(lon, lat), o2HomeL: d.o2Home ? d.o2Home.valueAt(lon, lat) : null }),
      label: CONFIG.simulatedLabel,
      dummy: DATA_MODE === 'dummy',
    })
    return finalizeMission(doc)
  }

  const exportMission = async () => {
    const fin = await missionDoc()
    if (fin) downloadJson(fin, `mission_${fin.mission_id}.json`)
  }

  /** Embedded in MARVIS: hand the same document to the simulator, which hides this planner and starts the EVA. */
  const startEva = async () => {
    setStarting(true)
    setStartError(null)
    const plan = planStr
    try {
      const fin = await missionDoc()
      if (!fin) return
      const r = await sendMission(fin)
      if (r.ok) {
        sent = { id: fin.mission_id, plan }
        dismissDebrief() // a debrief on screen belongs to the EVA before this one
      } else setStartError(r.error ?? 'no reason given')
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e))
    } finally {
      setStarting(false)
    }
  }

  // Draw.
  useEffect(() => {
    if (!d) return
    mmap.setWaypoints(wps.map((w, i) => ({ lon: w.lon, lat: w.lat, bad: legs[i] === null, info: waypointInfo(w) })))
    const toLL = (c: number): LonLat => d.tHome.lonLatOf(Math.floor(c / d.tHome.width), c % d.tHome.width)
    void mmap.setRoute(
      legs.map((l) => (l ? l.cells.map(toLL) : [])),
      home.path,
    )
  }, [d, wps, legs, home])

  useEffect(() => void mmap.showBoundary(options.find((o) => o.id === boundary)), [boundary, options])

  // Science stations on the map (popup: add as waypoint, details). The ref keeps the click current.
  const addRef = useRef(addStation)
  addRef.current = addStation
  const inPlan = wps.map((w) => w.station ?? '').join(',')
  useEffect(() => {
    if (!d || !stations) return
    const used = new Set(inPlan.split(','))
    mmap.setStations(
      stations.map((s) => ({ id: s.id, name: s.name, lon: s.lon, lat: s.lat, detailHref: href({ name: 'station', id: s.id }), inPlan: used.has(s.id) })),
      (id) => addRef.current(id),
    )
  }, [d, stations, inPlan])

  if (error) return <div class="panel-body"><DataProblem error={error} what="Mission Planer data" /></div>
  if (!d) return <div class="panel-body"><p class="muted">Loading {step}…</p></div>

  return (
    <div class="panel-body mp-body">
      <h2>Mission Planer</h2>
      <DummyNote />
      {marvis && (
        <div aria-live="polite">
          {debrief && (
            <Debrief
              log={debrief.log}
              // The newest log can be of an earlier mission, and the plan can have been edited since it was sent.
              samePlan={sent !== null && debrief.log.mission_id === sent.id && planStr === sent.plan}
              onDismiss={dismissDebrief}
              elRef={debriefEl}
            />
          )}
        </div>
      )}
      <p class="caption">
        Click the map to add a waypoint. Each leg is the fastest walk on the {d.grid.resM} m grid for <code>{d.scenario.id}</code>; the dashed line is the way home from the last waypoint.
      </p>
      {notice && <p class="mp-notice">{notice}</p>}

      <section class="mp-card">
        <h3>Estimated times and consumption</h3>
        <Estimates b={budget} n={wps.length} />
      </section>

      <section class="mp-card mp-export">
        {marvis && (
          <>
            <button type="button" class="mp-start" disabled={!wps.length || starting} aria-busy={starting} onClick={() => void startEva()} title={wps.length ? 'Send this plan to the MARVIS simulator and walk it there' : 'Add a waypoint first'}>
              {starting ? 'Starting the EVA…' : 'Start EVA in MARVIS'}
            </button>
            {startError && (
              <p class="mp-start-err" role="alert">
                <b>MARVIS did not start the EVA.</b> {startError}
              </p>
            )}
          </>
        )}
        <button type="button" class={marvis ? 'mp-clear mp-download' : undefined} disabled={!wps.length} onClick={() => void exportMission()} title="mission.json for the EVA simulator (contracts/bundle/mission.schema.json)">
          Download mission.json
        </button>
        {margin && (
          <span class="muted">
            {' '}lowest margin {margin.lowest.marginMin.toFixed(1)} min ({margin.lowest.binding})
          </span>
        )}
        <label class="mp-storm" title={d.rad ? 'D39: the storm series is shifted so its tripwire fires at the route\'s largest T_home; the dose term joins the margin' : 'rad.json (WS4) is not loaded: no storm series to replay'}>
          <input type="checkbox" checked={storm && !!d.rad} disabled={!d.rad} onChange={(e) => setStorm((e.target as HTMLInputElement).checked)} />{' '}
          Replay the 20 May 2024 storm during this EVA
        </label>
      </section>

      <section class="mp-card">
        <details open>
          <summary>
            Waypoints <span class="muted">({wps.length})</span>
          </summary>
          <WaypointList wps={wps} legs={legs} setWps={setWps} />
          {/* Not inside MARVIS: the address there is the simulator's own (127.0.0.1) and opens nowhere else. */}
          {wps.length > 0 && !marvis && (
            <div class="mp-share">
              <button type="button" class="mp-clear" onClick={copyLink}>
                {copied ? 'Link copied ✓' : 'Copy link to this plan'}
              </button>
              <span class="muted">Saved in this browser; the link opens the same plan anywhere.</span>
            </div>
          )}
        </details>
        <details open>
          <summary>Reachable-area boundary</summary>
          <label class="mp-select">
            <span class="sr-only">Boundary shown on the map</span>
            <select value={boundary} onChange={(e) => setBoundary((e.target as HTMLSelectElement).value)}>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <p class="caption">
            From <code>{boundaryFile(boundary, d)}</code> ({d.scenario.id}): the area from which the crew can walk back to the pad within that time.
          </p>
        </details>
      </section>

      <p class="caption mp-sources">
        <b>Estimates.</b> Leg times and leg O₂ are computed in your browser with the engine's walking model (<code>config/crew.yaml</code>, <code>config/variants.yaml</code>) on
        the {d.grid.resM} m grid with {d.elevationResM} m terrain heights (<code>{d.files.elevation}</code>), so they can differ from WS2's 3 m routes. Time home and O₂ home come
        from WS2's fields (<code>{d.files.tHome}</code>
        {d.files.o2Home ? (
          <>
            , <code>{d.files.o2Home}</code>
          </>
        ) : null}
        ). O₂ capacity: primary supply per <code>{CITED.o2PrimaryL.source}</code> (computed from its formula); reserve: {CITED.o2ReserveMinAtEffortCap.value} min at the effort cap; EVA limit: {CITED.evaH.value} h. Planned time at a waypoint is station work at the station task rate (<code>crew.yaml</code> <code>o2_margin.station_task_rate_btu_h</code>, {BUDGET_CONSTANTS.stationRateLMin.toFixed(3)} L/min); tags and notes are labels only.
        {credit ? ` Basemap: ${credit}.` : ''}
      </p>
    </div>
  )
}

function boundaryFile(id: string, d: MissionData): string {
  if (id.startsWith('band:')) return d.files.bands
  if (id.startsWith('iso:')) return d.files.isochrones
  if (id.startsWith('edges:')) return d.files.edges
  return '–'
}

function Row({ k, v, cls, title }: { k: string; v: string; cls?: string; title?: string }) {
  return (
    <div class={`mp-row${cls ? ` ${cls}` : ''}`} title={title}>
      <span>{k}</span>
      <b>{v}</b>
    </div>
  )
}

const sign = (v: number | null) => (v === null ? '' : v < 0 ? 'mp-bad' : 'mp-ok')

function Estimates({ b, n }: { b: MissionBudget; n: number }) {
  if (!b.legsKnown) return <p class="mp-notice">A leg could not be routed (see the waypoint list): times and O₂ are unknown until it is moved or removed.</p>
  return (
    <div class="mp-est">
      <Row k={n ? `Time home from #${n}` : 'Time home'} v={fmtMin(b.tHomeMin)} title="WS2 T_home at the last waypoint (fastest walk back to the pad)" />
      <Row k="Walk out (all legs)" v={fmtMin(b.walkMin)} />
      <Row k="Time at waypoints" v={fmtMin(b.stopMin)} title="Sum of the planned stop times" />
      <Row k="EVA total" v={b.evaMin === null ? '–' : `${b.evaMin.toFixed(1)} of ${b.evaLimitMin} min`} />
      <Row k="Time margin" v={fmtMin(b.timeMarginMin)} cls={sign(b.timeMarginMin)} title="EVA limit − walk out − time home" />
      <div class="mp-sep" />
      <Row k="O₂ left at the last waypoint" v={fmtL(b.o2LeftL)} title={`${b.o2CapacityL.toFixed(1)} L primary supply − ${fmtL(b.o2UsedL)} used (legs + ${b.o2StopsL.toFixed(1)} L at stops)`} />
      {b.stopMin > 0 && <Row k="O₂ for stops" v={fmtL(b.o2StopsL)} title={`${b.stopMin.toFixed(0)} min × ${BUDGET_CONSTANTS.stationRateLMin.toFixed(3)} L/min station task rate`} />}
      <Row k="O₂ needed (home + reserve)" v={b.o2NeedL === null ? '–' : `${b.o2NeedL.toFixed(1)} L`} title={`O₂ home ${fmtL(b.o2HomeL)} + reserve ${b.reserveL.toFixed(1)} L`} />
      <Row k="O₂ margin" v={b.o2MarginL === null ? '–' : `${b.o2MarginL.toFixed(1)} L · ${b.o2MarginMin!.toFixed(0)} min at max effort`} cls={sign(b.o2MarginL)} />
    </div>
  )
}

/** A logged value with its unit (non-breaking space between them), '–' when unknown. */
const fmtNum = (v: number | null, digits: number, unit: string) => (typeof v !== 'number' ? '–' : `${v.toFixed(digits)}\u00a0${unit}`)

/**
 * EVA debrief (embedded in MARVIS): the simulator's own numbers from its eva_log, shown as they are. Nothing is computed here.
 * samePlan: the plan drawn on the map is the one this EVA was started with.
 */
function Debrief({ log, samePlan, onDismiss, elRef }: { log: EvaLog; samePlan: boolean; onDismiss: () => void; elRef: { current: HTMLElement | null } }) {
  const s = log.summary
  const endReason = s.complete ? undefined : log.events?.find((e) => e.kind === 'end')?.detail
  return (
    <section class="mp-card mp-debrief" ref={elRef} aria-labelledby="mp-debrief-title">
      <div class="mp-debrief-head">
        <h3 id="mp-debrief-title">EVA debrief</h3>
        <button type="button" class="mp-clear" onClick={onDismiss} title="Remove this card and the walked track from the map">
          Dismiss
        </button>
      </div>
      <p class="mp-debrief-label">
        <span class="tag tag-simulated">{log.label}</span>
        {log.origin_label && <span class="mp-debrief-origin">{log.origin_label}</span>}
      </p>
      <div class="mp-est">
        <Row k="Outcome" v={s.complete ? 'Completed' : 'Ended early'} cls={s.complete ? 'mp-ok' : 'mp-warn'} title={s.complete ? 'Back at the pad with every waypoint done or skipped' : endReason} />
        <Row k="EVA time" v={`${fmtNum(s.eva_min, 1, 'min')}, planned ${fmtNum(s.planned_eva_min, 1, 'min')}`} />
        <Row k="O₂ used" v={`${fmtNum(s.o2_used_l, 1, 'L')}, planned ${fmtNum(s.planned_o2_used_l, 1, 'L')}`} title={log.o2_model} />
        <Row k="Lowest margin" v={`${fmtNum(s.lowest_margin_min, 1, 'min')}${typeof s.lowest_margin_min === 'number' && s.lowest_binding ? `, bound by ${s.lowest_binding}` : ''}`} cls={sign(s.lowest_margin_min ?? null)} />
        <Row k="Waypoints" v={`${s.waypoints_done} done, ${s.waypoints_skipped} skipped${s.stops_left_early ? `, ${s.stops_left_early} left early` : ''}`} />
        <Row k="Largest cross-track distance" v={fmtNum(s.max_cross_track_m, 1, 'm')} title="Farthest the walk was from the route planned for this EVA" />
      </div>
      <div class="legend mp-debrief-legend">
        <ul>
          <li>
            <span class="sw sw-line" style={`--c:${THEME.route}`} aria-hidden="true" /> {samePlan ? 'Planned route' : 'Plan on the map now (may differ from the plan of this EVA)'}
          </li>
          <li>
            <span class="sw sw-line" style={`--c:${THEME.walked}`} aria-hidden="true" /> Walked in the simulator
          </li>
        </ul>
      </div>
      <p class="caption">
        {log.title ? `${log.title}. ` : ''}
        {endReason ? `Ended: ${endReason}. ` : ''}O₂ used is from the {log.o2_model}.
      </p>
    </section>
  )
}

function WaypointList({ wps, legs, setWps }: { wps: Waypoint[]; legs: (Leg | null)[]; setWps: (f: (w: Waypoint[]) => Waypoint[]) => void }) {
  if (!wps.length) return <p class="muted mp-empty">No waypoints yet: click the map.</p>
  return (
    <>
      <ol class="mp-list">
        {wps.map((w, i) => {
          const l = legs[i]
          return (
            <li key={w.id} class={l === null ? 'mp-li-bad' : ''}>
              <div class="mp-li-head">
                <span class="mp-num">{i + 1}</span>
                <span class="mp-leg">
                  {i === 0 ? 'Pad' : `#${i}`} → #{i + 1}
                  {w.station && (
                    <a class="mp-st-link" href={href({ name: 'station', id: w.station })} title="Open the station card">
                      {w.station} details →
                    </a>
                  )}
                </span>
                <span class="mp-actions">
                  <button type="button" title="Move up" aria-label={`Move waypoint ${i + 1} up`} disabled={i === 0} onClick={() => setWps((x) => moveWaypoint(x, i, -1))}>
                    ↑
                  </button>
                  <button type="button" title="Move down" aria-label={`Move waypoint ${i + 1} down`} disabled={i === wps.length - 1} onClick={() => setWps((x) => moveWaypoint(x, i, 1))}>
                    ↓
                  </button>
                  <button type="button" title="Delete" aria-label={`Delete waypoint ${i + 1}`} onClick={() => setWps((x) => removeWaypoint(x, i))}>
                    ✕
                  </button>
                </span>
              </div>
              <div class="mp-li-body">
                {l ? (
                  <>
                    {(l.timeS / 60).toFixed(1)} min · {fmtM(l.distM)} · {l.o2L.toFixed(1)} L O₂
                  </>
                ) : (
                  <span class="mp-bad">no walkable route from the previous point</span>
                )}
              </div>
              <WaypointEditor w={w} n={i + 1} onChange={(nw) => setWps((x) => x.map((y) => (y.id === w.id ? nw : y)))} />
            </li>
          )
        })}
      </ol>
      <button type="button" class="mp-clear" onClick={() => setWps(() => [])}>
        Clear all
      </button>
    </>
  )
}

/** Marker tooltip text: stop time, tags, note. */
function waypointInfo(w: Waypoint): string {
  const parts: string[] = []
  if (w.stopMin > 0) parts.push(`stop ${w.stopMin} min`)
  if (w.tags.length) parts.push(w.tags.join(', '))
  if (w.note.trim()) parts.push(w.note.trim())
  return parts.join(' · ')
}

function WaypointEditor({ w, n, onChange }: { w: Waypoint; n: number; onChange: (w: Waypoint) => void }) {
  const summary = waypointInfo(w)
  const o2 = w.stopMin * BUDGET_CONSTANTS.stationRateLMin
  return (
    <details class="mp-wpe">
      <summary>{summary || <span class="muted">Add stop time, tags, note</span>}</summary>
      <label class="mp-wpe-stop">
        <span>Planned stop</span>
        <input
          type="number"
          min={0}
          step={5}
          inputMode="numeric"
          placeholder="0"
          aria-label={`Planned stop time at waypoint ${n} in minutes`}
          value={w.stopMin || ''}
          onInput={(e) => onChange({ ...w, stopMin: stopMinutes(parseFloat((e.target as HTMLInputElement).value)) })}
        />
        <span>min</span>
        {w.stopMin > 0 && <span class="muted">≈ {o2.toFixed(1)} L O₂</span>}
      </label>
      <div class="mp-tags" role="group" aria-label={`Tags for waypoint ${n}`}>
        {WAYPOINT_TAGS.map((t) => (
          <button type="button" key={t} class={w.tags.includes(t) ? 'on' : ''} aria-pressed={w.tags.includes(t)} onClick={() => onChange({ ...w, tags: toggleTag(w.tags, t) })}>
            {t}
          </button>
        ))}
      </div>
      <textarea
        rows={2}
        placeholder="Note: resource, task, what to carry out here…"
        aria-label={`Note for waypoint ${n}`}
        value={w.note}
        onInput={(e) => onChange({ ...w, note: (e.target as HTMLTextAreaElement).value })}
      />
    </details>
  )
}
