// /station/:id — station card (F15): Navcam frame + skyline overlay and its error, predicted
// panorama, landmarks, timeline (arrive / leave / turn back), time home per scenario, binding margin
// term, contingency, tasks. Every number is read from stations.json, cards/<id>.json or the timeline.
import { CITED, CONFIG } from '../config'
import { accessFor, type AccessView } from '../data/access'
import { data } from '../data/loader'
import { partnerLabel } from '../data/partner'
import type { Card, PartnerFC, ScenariosIndex, Station, TimelineEvent } from '../data/types'
import { dataUrl } from '../env'
import { href, type Route } from '../router'
import { AssumedTag, DataProblem, DummyNote, StatusTag } from '../components/labels'
import { CfgNum, Num } from '../components/Num'
import { DragNote } from '../components/DragNote'
import { Page, preactView, Show, useLoad } from './page'
import { FAR_NOT_VALIDATED, scopeText } from './validation'

import { STORM_TIMING_NOTE, compassTick, homeFor, isHiddenLandmark, landmarkNote, marginLabel, type Landmark } from './decisions'
export { MARGIN_LABEL, marginLabel } from './decisions'

/** Manifest key of a landmark number (WS3 pipeline/horizon/cards.py: spaces become underscores). */
export function landmarkKey(station: string, name: string, f: 'bearing_deg' | 'dist_km'): string {
  return `landmark.${station}.${name.replace(/\s+/g, '_')}.${f}`
}

interface StationData {
  station: Station
  stations: Station[]
  card: Card | null
  cardError: unknown
  idx: ScenariosIndex | null
  timeline: TimelineEvent[] | null
  scenario: string | null
  /** Partner line of the card's scenario (D20: cart only + drag finding). */
  partner: { fc: PartnerFC | null; file: string; defaultFile: string | null } | null
}

async function loadStation(id: string): Promise<StationData> {
  const L = data()
  const stations = await L.stations()
  const station = stations.find((s) => s.id === id)
  if (!station) throw new Error(`no station "${id}" in stations.json`)
  const idx = await L.optional(() => L.scenarios())
  // A card that fails its contract is reported on the page, the rest of the card still shows.
  let card: Card | null = null
  let cardError: unknown = null
  try {
    card = await L.optional(() => L.card(station))
  } catch (e) {
    cardError = e
  }
  const scenario = card?.scenario ?? idx?.default ?? null
  const timeline = scenario ? await L.optional(() => L.timeline(scenario)) : null
  const entry = idx?.scenarios.find((x) => x.id === scenario) ?? null
  let partner: StationData['partner'] = null
  if (entry && idx) {
    const defaultFile = idx.scenarios.find((x) => x.id === idx.default)?.files.partner ?? null
    let fc: PartnerFC | null = null
    try {
      fc = await L.optional(() => L.partner(entry))
    } catch {
      fc = null // the console reports a partner file that fails its contract
    }
    partner = { fc, file: entry.files.partner, defaultFile }
  }
  return { station, stations, card, cardError, idx, timeline, scenario, partner }
}

function StationCard({ id }: { id: string }) {
  const l = useLoad(() => loadStation(id), [id])
  const title = l.state === 'ok' ? `${l.data.station.id} · ${l.data.station.name}` : `Station ${id}`
  return (
    <Page title={title} wide>
      <DummyNote />
      <Show l={l} what="Station card">
        {(d) => <CardBody d={d} />}
      </Show>
    </Page>
  )
}

const NO_CARD = 'not available yet (cards/*.json)'

function CardBody({ d }: { d: StationData }) {
  const { station: s, card } = d
  const cf = s.card
  const c: Card = card ?? EMPTY_CARD
  const i = d.stations.findIndex((x) => x.id === s.id)
  const prev = d.stations[(i - 1 + d.stations.length) % d.stations.length]
  const next = d.stations[(i + 1) % d.stations.length]
  const events = (d.timeline ?? []).map((e, i) => ({ e, i })).filter(({ e }) => e.station === s.id)
  const tk = (i: number, f: string) => `timeline.${d.scenario}.${i}.${f}`
  const tfile = d.scenario ? `timeline_${d.scenario}.json` : ''
  const acc = d.scenario ? accessFor(s, d.scenario, card) : null

  return (
    <div class="card-grid">
      <section class="card-main">
        {s.objective && <p class="objective">{s.objective}</p>}
        {s.reachability_label && <p class="finding">{s.reachability_label} in every scenario (D26).</p>}
        {d.cardError != null && <DataProblem error={d.cardError} what={`Station card ${cf}`} />}
        {!card && d.cardError == null && <p class="muted">Station card file {NO_CARD}: Navcam, panorama, landmarks and timeline are missing; values below come from stations.json.</p>}
        <figure class="navcam">
          {c.navcam.url_local ? (
            <div class="navcam-stack">
              <img src={dataUrl(c.navcam.url_local)} alt={c.navcam.image_id ? `Navcam frame ${c.navcam.image_id}` : 'Navcam frame placeholder'} />
              {c.navcam.overlay_png && <img class="overlay" src={dataUrl(c.navcam.overlay_png)} alt="Predicted skyline overlay" />}
            </div>
          ) : (
            <div class="placeholder-box">Navcam frame: not available yet (WS3)</div>
          )}
          <figcaption>
            {c.navcam.image_id ? <StatusTag kind="real" /> : null} {typeof c.navcam.credit === 'string' ? c.navcam.credit : 'Curiosity Navcam'}
            {c.navcam.sol !== null ? (
              <>
                , sol <Num v={c.navcam.sol} file={cf} k={`navcam_sol.${s.id}`} />
              </>
            ) : null}
            {c.navcam.image_id ? `, ${c.navcam.image_id}` : c.navcam.url_local ? ' (placeholder image, no frame yet)' : ''}
 · <StatusTag kind="modelled" /> predicted skyline
            {c.navcam.overlay_png ? '' : ' (overlay not available yet)'}
            <br />
            Skyline error, near: <Num v={c.skyline_error_deg.near} units="deg" file={cf} k={`skyline_error_deg.${s.id}.near`} /> · mid:{' '}
            <Num v={c.skyline_error_deg.mid} units="deg" file={cf} k={`skyline_error_deg.${s.id}.mid`} /> · far (&gt; {FAR_KM} km):{' '}
            <Num v={c.skyline_error_deg.far} units="deg" file={cf} k={`skyline_error_deg.${s.id}.far`} />{' '}
            <span class="pending" title={FAR_NOT_VALIDATED}>
              far: not validated
            </span>
            {c.skyline_error_deg.near === null && c.skyline_error_deg.mid === null && c.navcam.image_id ? (
              <span class="muted"> (this frame has no near or mid skyline columns)</span>
            ) : null}
            <br />
            {scopeText(c.skyline_error_scope) && (
              <>
                <span class="muted">{scopeText(c.skyline_error_scope)}.</span>
                <br />
              </>
            )}
            <span class="muted">Far class: {FAR_NOT_VALIDATED}</span>
            <br />
            <span class="muted">The skyline check validates the DEM–camera–pose chain. It is not a hazard validation.</span>
          </figcaption>
        </figure>

        <figure class="panorama">
          {c.panorama_png ? (
            <img src={dataUrl(c.panorama_png)} alt="Predicted panorama from this station" />
          ) : (
            <div class="placeholder-box slim">Predicted panorama: not available yet (WS3)</div>
          )}
          <figcaption>
            <StatusTag kind="modelled" /> Predicted horizon from the elevation model at crew eye height
            {c.observer?.position === 'access_cell' ? ', seen from the access cell' : c.observer?.position === 'science_coordinate_no_access' ? ', seen from the science point (no access cell)' : ''}
            .
          </figcaption>
        </figure>

        <h3>Landmarks</h3>
        {c.landmarks.length > 0 && (
          <table class="mini">
            <thead>
              <tr>
                <th>Landmark</th>
                <th class="r">Bearing</th>
                <th class="r">Distance</th>
              </tr>
            </thead>
            <tbody>
              {c.landmarks.map((lm) => (
                <tr>
                  <td>
                    {lm.name}
                    {landmarkNote(lm) ? <span class="muted"> ({landmarkNote(lm)})</span> : null}
                  </td>
                  <td class="r">
                    <Num v={lm.bearing_deg} units="deg" file={cf} k={landmarkKey(s.id, lm.name, 'bearing_deg')} />
                  </td>
                  <td class="r">
                    <Num v={lm.dist_km} units="km" file={cf} k={landmarkKey(s.id, lm.name, 'dist_km')} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {card && c.landmarks.length === 0 && <p>No landmark qualifies from this station.</p>}
        {c.landmarks_note && <p class="caption">{c.landmarks_note}. The list is not padded.</p>}
        {c.landmarks.length > 0 && <Compass landmarks={c.landmarks} station={s.id} />}
      </section>

      <aside class="card-side">
        {acc && <AccessBlock s={s} a={acc} scenario={d.scenario!} />}

        <section class="kv">
          <h3>
            Timeline {d.scenario ? <code>{d.scenario}</code> : null} <StatusTag kind="simulated" />
          </h3>
          {card?.on_route === false && <p class="muted">Not on the planned route for this scenario.</p>}
          <dl>
            <dt>Arrive</dt>
            <dd>
              <Num v={c.timeline.arrive} units="min" file={cf} k={`card.${s.id}.timeline.arrive`} /> <span class="muted">into the EVA</span>
            </dd>
            <dt>Leave</dt>
            <dd>
              <Num v={c.timeline.leave} units="min" file={cf} k={`card.${s.id}.timeline.leave`} />
            </dd>
            <dt>Turn back by</dt>
            <dd class="strong">
              <Num v={c.timeline.turn_back} units="min" file={cf} k={`card.${s.id}.timeline.turn_back`} />
              {c.turn_back_binding ? <span class="muted"> · bound by {marginLabel(c.turn_back_binding)}</span> : null}
            </dd>
            <dt>Dwell</dt>
            <dd>
              {s.dwell_min === CITED.dwellMin.value ? (
                <CfgNum v={s.dwell_min} units="min" source={CITED.dwellMin.source} />
              ) : (
                <Num v={s.dwell_min} units="min" file="stations.json" k={`dwell_min.${s.id}`} />
              )}
            </dd>
            <dt>Binding margin</dt>
            <dd>{card ? marginLabel(c.margin_binding) : <span class="muted">{NO_CARD}</span>}</dd>
            {card && c.margin_min !== undefined && (
              <>
                <dt>Margin</dt>
                <dd>
                  <Num v={c.margin_min} units="min" file={cf} k={`card.${s.id}.margin_min`} />
                  {c.margin_binding === 'dose' && <span class="muted"> · {STORM_TIMING_NOTE}</span>}
                </dd>
              </>
            )}
          </dl>
        </section>

        <section class="kv">
          <h3>
            Walk home from the access cell <StatusTag kind="modelled" />
          </h3>
          <dl>
            {Object.keys(s.t_home_min).map((sc) => {
              const h = homeFor(s, sc)
              return (
                <>
                  <dt>{sc}</dt>
                  <dd>
                    {h.kind === 'time' ? (
                      <Num v={h.v} units="min" file="stations.json" k={`t_home_min.${s.id}.${sc}`} />
                    ) : h.kind === 'unreachable' ? (
                      <span class="num-unknown" title={h.reason ?? ''}>
                        {h.label}
                      </span>
                    ) : (
                      <span class="num-unknown">unknown</span>
                    )}
                  </dd>
                </>
              )
            })}
          </dl>
          {Object.keys(s.t_home_min).some((sc) => homeFor(s, sc).kind === 'unreachable') && (
            <p class="caption">"{CITED.unreachableLabel.value}": no cell within the access radius has a walk home in that scenario (hover for WS2's reason). Shown as is (D46).</p>
          )}
        </section>

        <section class="kv">
          <h3>Contingency</h3>
          <p>{card ? c.contingency : <span class="muted">{NO_CARD}</span>}</p>
          <p>
            {partnerLabel(d.partner?.fc ?? null)}: {s.in_partner_line === null ? <span class="num-unknown">unknown</span> : s.in_partner_line ? 'inside' : <b>outside</b>}{' '}
            <AssumedTag note="Partner line: design question; every haul parameter is an assumed band" />
          </p>
          <DragNote fc={d.partner?.fc ?? null} file={d.partner?.file ?? null} defaultFile={d.partner?.defaultFile ?? null} note={card?.drag_note} />
        </section>

        <section class="kv">
          <h3>Science</h3>
          <p>
            Value <Num v={s.value} file="stations.json" k={`stations.${s.id}.value`} />
          </p>
          <ul class="tasks">
            {s.tasks.map((t) => (
              <li>{t}</li>
            ))}
          </ul>
        </section>

        {events.length > 0 && (
          <section class="kv">
            <h3>
              Route events ({d.scenario}) <StatusTag kind="simulated" />
            </h3>
            <table class="mini">
              <thead>
                <tr>
                  <th>Event</th>
                  <th class="r">t</th>
                  <th class="r">O₂ left</th>
                  <th class="r">Margin</th>
                  <th>Bound by</th>
                </tr>
              </thead>
              <tbody>
                {events.map(({ e, i }) => (
                  <tr>
                    <td>{e.event}</td>
                    <td class="r">
                      <Num v={e.t_min} units="min" file={tfile} k={tk(i, 't_min')} />
                    </td>
                    <td class="r">
                      <Num v={e.o2_left_L} units="L" file={tfile} k={tk(i, 'o2_left_L')} />
                    </td>
                    <td class="r">
                      <Num v={e.margin_min} units="min" file={tfile} k={tk(i, 'margin_min')} />
                    </td>
                    <td>{e.margin_binding === undefined ? <span class="muted">–</span> : marginLabel(e.margin_binding)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <nav class="card-nav">
          <a href={href({ name: 'station', id: prev.id })}>← {prev.id}</a>
          <a href={href({ name: 'console' })}>Map</a>
          <a href={href({ name: 'cuff' })}>Cuff card</a>
          <a href={href({ name: 'station', id: next.id })}>{next.id} →</a>
        </nav>
      </aside>
    </div>
  )
}

/** Access-cell rule (user 11:40): science point, access cell, straight walk-in (not modelled). */
function AccessBlock({ s, a, scenario }: { s: Station; a: AccessView; scenario: string }) {
  const k = (f: string) => `${a.keyPrefix}.${f}`
  const w = a.walkIn
  return (
    <section class="kv">
      <h3>
        Access <code>{scenario}</code>
      </h3>
      {a.state === 'none' ? (
        <p>
          <b>
            No access cell within{' '}
            {a.radius_m !== null ? <CfgNum v={a.radius_m} units="m" source={CITED.accessRadiusM.source} /> : 'the access radius'}
          </b>
          {a.reason ? `: ${a.reason}` : ''}. No walk home is computed for {s.id}; the science point is shown as is, never snapped.
        </p>
      ) : a.state === 'unknown' ? (
        <p class="muted">No access-cell data for this scenario.</p>
      ) : (
        <>
          <dl>
            <dt>Science point</dt>
            <dd>the station coordinate (filled marker)</dd>
            <dt>Access cell</dt>
            <dd>
              {/* lon/lat are recorded per scenario from stations.json (access.{S}.{scenario}.lon/lat) */}
              <Num v={a.access!.lon} file="stations.json" k={`access.${s.id}.${scenario}.lon`} />,{' '}
              <Num v={a.access!.lat} file="stations.json" k={`access.${s.id}.${scenario}.lat`} />
            </dd>
            <dt>Walk-in</dt>
            <dd class="strong">
              <Num v={a.dist_m} units="m" file={a.file} k={k('dist_m')} />
            </dd>
            {w && (
              <>
                <dt>Rise</dt>
                <dd>
                  <Num v={w.rise_m ?? null} units="m" file={a.file} k={k('walk_in.rise_m')} />
                </dd>
                <dt>Slope, mean / max along</dt>
                <dd>
                  <Num v={w.mean_slope_deg ?? null} units="deg" file={a.file} k={k('walk_in.mean_slope_deg')} /> /{' '}
                  <Num v={w.max_slope_deg ?? null} units="deg" file={a.file} k={k('walk_in.max_slope_deg')} />
                </dd>
                <dt>Steepest terrain crossed</dt>
                <dd>
                  <Num v={w.max_terrain_slope_deg ?? null} units="deg" file={a.file} k={k('walk_in.max_terrain_slope_deg')} />
                </dd>
              </>
            )}
          </dl>
          <p class="caption">
            Walk-in is a straight line from the access cell to the science point and is <b>not modelled</b> (no time or O₂ for it). Access radius{' '}
            <CfgNum v={CITED.accessRadiusM.value} units="m" source={CITED.accessRadiusM.source} /> (decided, D27).
          </p>
        </>
      )}
    </section>
  )
}

// Far-field class boundary (config/horizon.yaml distance_classes_km, last value).
const FAR_KM = CONFIG.distanceClassesKm[CONFIG.distanceClassesKm.length - 1]

// Placeholder for a missing cards/<id>.json: every number null (shown "unknown"), no fake text.
const EMPTY_CARD: Card = {
  navcam: { sol: null, image_id: null, url_local: null, overlay_png: null },
  skyline_error_deg: { near: null, mid: null, far: null },
  panorama_png: null,
  landmarks: [],
  timeline: { arrive: null, leave: null, turn_back: null },
  margin_binding: undefined as unknown as Card['margin_binding'],
  contingency: '',
}

export const view = preactView((route: Route) => <StationCard id={route.name === 'station' ? route.id : ''} />)

/**
 * D33: compass of the station's landmarks. Hidden ones (display "bearing_tick") are bearing-only
 * ticks marked "below skyline"; visible ones get a solid tick. Bearings come from the card (the
 * table above prints them with their manifest keys); the drawing prints no number.
 */
function Compass({ landmarks, station }: { landmarks: Landmark[]; station: string }) {
  const W = 220
  const c = W / 2
  const R = 70
  const hidden = landmarks.filter(isHiddenLandmark)
  return (
    <figure class="compass">
      <svg viewBox={`0 0 ${W} ${W}`} width={W} height={W} role="img" aria-label={`Landmark bearings from ${station}: ${hidden.length} below the skyline`}>
        <circle cx={c} cy={c} r={R} class="compass-ring" />
        {[0, 90, 180, 270].map((b, i) => {
          const [, [x, y]] = compassTick(b, c, R + 4, 14)
          return (
            <text x={x} y={y + 4} text-anchor="middle" class="compass-cardinal">
              {'NESW'[i]}
            </text>
          )
        })}
        {landmarks.map((lm) => {
          const h = isHiddenLandmark(lm)
          const [[x0, y0], [x1, y1]] = compassTick(lm.bearing_deg, c, h ? R - 16 : R - 22, h ? 16 : 22)
          return (
            <line x1={x0} y1={y0} x2={x1} y2={y1} class={h ? 'compass-tick hidden' : 'compass-tick'}>
              <title>{`${lm.name}${h ? ' (below skyline)' : ''}`}</title>
            </line>
          )
        })}
        <circle cx={c} cy={c} r={3} class="compass-centre" />
      </svg>
      <figcaption>
        <StatusTag kind="modelled" /> Bearings from {station}, north up. {hidden.length > 0 ? <>Dashed ticks: below skyline (bearing only, D33): {hidden.map((l) => l.name).join(', ')}.</> : null}
        {landmarks.length > hidden.length ? ' Solid ticks: above the computed skyline.' : ''}
      </figcaption>
    </figure>
  )
}
