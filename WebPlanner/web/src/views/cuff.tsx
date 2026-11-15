// /cuff — printable cuff card (F15): a route card with the timeline, O₂ at each event (incl. the
// 30-min O₂ checkpoints when the timeline has them) and the turn-back times, then one A6 card per
// station. Print CSS in style.css (@page A6).
import { data } from '../data/loader'
import type { Card, Station, TimelineEvent } from '../data/types'
import { DummyNote, SimulatedLabel } from '../components/labels'
import { Num } from '../components/Num'
import { CITED, CONFIG } from '../config'
import { homeFor, marginLabel } from './decisions'
import { preactView, Show, useLoad } from './page'

interface CuffData {
  scenario: string
  stations: { s: Station; c: Card | null }[]
  timeline: TimelineEvent[] | null
}

async function loadCuff(): Promise<CuffData> {
  const L = data()
  const idx = await L.optional(() => L.scenarios())
  const scenario = idx?.default ?? CONFIG.defaultScenario
  const st = await L.stations()
  const stations = await Promise.all(st.map(async (s) => ({ s, c: await L.optional(() => L.card(s)) })))
  const timeline = await L.optional(() => L.timeline(scenario))
  return { scenario, stations, timeline }
}

function Cuff() {
  const l = useLoad(loadCuff)
  return (
    <div class="cuff-page">
      <div class="no-print page">
        <h1>Cuff card</h1>
        <DummyNote />
        <p>
          A route card plus one A6 card per station. <button onClick={() => window.print()}>Print</button>
        </p>
      </div>
      <Show l={l} what="Cuff card">
        {(d) => {
          const tf = `timeline_${d.scenario}.json`
          return (
            <div class="cuff-cards">
              {d.timeline ? (
                <article class="cuff-card">
                  <h2>Route · {d.scenario}</h2>
                  <p class="cuff-sub">
                    <SimulatedLabel /> Minutes from EVA start.
                  </p>
                  <table>
                    <thead>
                      <tr>
                        <th>t</th>
                        <th>Event</th>
                        <th class="r">O₂ left</th>
                        <th class="r">Home</th>
                        <th class="r">Margin</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.timeline.map((e, i) => (
                        <tr class={/o2|checkpoint/i.test(e.event) ? 'cuff-o2' : ''}>
                          <td>
                            <Num v={e.t_min} file={tf} k={`timeline.${d.scenario}.${i}.t_min`} />
                          </td>
                          <td>
                            {e.event === 'turn_back' ? 'turn back by' : e.event}
                            {e.station ? ` ${e.station}` : ''}
                            {e.event === 'turn_back' && e.margin_binding ? ` (${marginLabel(e.margin_binding)})` : ''}
                          </td>
                          <td class="r">
                            <Num v={e.o2_left_L} units="L" file={tf} k={`timeline.${d.scenario}.${i}.o2_left_L`} />
                          </td>
                          <td class="r">
                            <Num v={e.t_home_min} file={tf} k={`timeline.${d.scenario}.${i}.t_home_min`} />
                          </td>
                          <td class="r">
                            <Num v={e.margin_min} file={tf} k={`timeline.${d.scenario}.${i}.margin_min`} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </article>
              ) : (
                <article class="cuff-card">
                  <h2>Route · {d.scenario}</h2>
                  <p class="cuff-sub">timeline_{d.scenario}.json not available yet.</p>
                </article>
              )}
              {d.stations.map(({ s, c }) => (
                <article class="cuff-card">
                  <h2>
                    {s.id} · {s.name}
                  </h2>
                  <p class="cuff-sub">{s.objective}</p>
                  <dl>
                    <dt>Arrive</dt>
                    <dd>
                      <Num v={c?.timeline.arrive ?? null} units="min" file={s.card} k={`card.${s.id}.timeline.arrive`} />
                    </dd>
                    <dt>Leave</dt>
                    <dd>
                      <Num v={c?.timeline.leave ?? null} units="min" file={s.card} k={`card.${s.id}.timeline.leave`} />
                    </dd>
                    <dt class="strong">TURN BACK BY</dt>
                    <dd class="strong">
                      <Num v={c?.timeline.turn_back ?? null} units="min" file={s.card} k={`card.${s.id}.timeline.turn_back`} />
                      {c?.turn_back_binding ? ` (${marginLabel(c.turn_back_binding)})` : ''}
                    </dd>
                    <dt>Home from here</dt>
                    <dd>
                      {homeFor(s, d.scenario).kind === 'unreachable' ? (
                        CITED.unreachableLabel.value
                      ) : (
                        <Num v={s.t_home_min[d.scenario] ?? null} units="min" file="stations.json" k={`t_home_min.${s.id}.${d.scenario}`} />
                      )}
                    </dd>
                    <dt>Binding limit</dt>
                    <dd>{c ? marginLabel(c.margin_binding) : 'unknown'}</dd>
                  </dl>
                  <p class="cuff-contingency">{c ? c.contingency : 'Station card file not available yet.'}</p>
                  <ul>
                    {s.tasks.map((t) => (
                      <li>{t}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          )
        }}
      </Show>
    </div>
  )
}

export const view = preactView(() => <Cuff />)
