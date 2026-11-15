// /trade — trade table (F11): walkback budget (rows) x suit mass (columns). Each cell shows the
// science value reachable, % of the assessed disc reachable and the partner-line area, read from
// trade_table.json. Bars are drawn relative to the largest value of the same metric in the table.
import { CITED, CONFIG } from '../config'
import { accessFor } from '../data/access'
import { data } from '../data/loader'
import type { ScenariosIndex, Station, TradeCell, TradeTable } from '../data/types'
import { href } from '../router'
import { AssumedTag, DummyNote } from '../components/labels'
import { CfgNum, Num } from '../components/Num'
import { Page, preactView, Show, useLoad } from './page'
import { homeFor } from './decisions'

/** Every science value is 0 (WS2 con_*: no station has a conservative walk home within the budget). */
export function allScienceZero(t: TradeTable): boolean {
  const v = t.cells.flat().map((c) => c.science_value)
  return v.length > 0 && v.every((x) => x === 0)
}

const METRICS: { key: keyof TradeCell; label: string; units: string | null }[] = [
  { key: 'science_value', label: 'Science value reachable', units: null },
  { key: 'reachable_pct', label: 'Assessed disc reachable', units: '%' },
  { key: 'partner_area_km2', label: 'Partner-line area', units: 'km2' },
]

function maxOf(t: TradeTable, k: keyof TradeCell): number {
  let m = 0
  for (const row of t.cells) for (const c of row) if (typeof c[k] === 'number' && (c[k] as number) > m) m = c[k] as number
  return m
}

interface TradeData {
  t: TradeTable
  stations: Station[] | null
  idx: ScenariosIndex | null
}

async function loadTrade(): Promise<TradeData> {
  const L = data()
  const t = await L.trade()
  const [stations, idx] = await Promise.all([L.optional(() => L.stations()), L.optional(() => L.scenarios())])
  return { t, stations, idx }
}

/**
 * The science value counts stations whose *conservative* walk home fits the budget. Each station's
 * conservative walk home is shown from stations.json for every suit in the table; a null walk home
 * is "not reachable on foot" (D26), shown as is (D46).
 */
function ConservativeHome({ d, zero }: { d: TradeData; zero: boolean }) {
  const con = (kg: number) => d.idx?.scenarios.find((s) => s.variant === 'conservative' && s.suit_kg === kg)?.id ?? null
  const maxBudget = Math.max(...d.t.rows)
  return (
    <div class={zero ? 'finding' : ''}>
      <p>
        {zero ? (
          <>
            <b>Science value is 0 in every cell.</b> It counts the stations whose walk home under the <i>conservative</i> variant fits the budget, and no station is
            reachable within {maxBudget} min that way:
          </>
        ) : (
          <>
            <b>Conservative walk home per station</b> (the science value counts the stations whose conservative walk home fits the budget; conservative no-go{' '}
            <CfgNum v={CITED.nogoConservativeDeg.value} units="deg" source={CITED.nogoConservativeDeg.source} />, D23). Shown as is, not adjusted (D46):
          </>
        )}
      </p>
      {d.stations && (
        <table class="mini">
          <thead>
            <tr>
              <th>Conservative walk home</th>
              {d.t.cols.map((kg) => (
                <th class="r">{kg} kg suit</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {d.stations.map((s) => (
              <tr>
                <td>
                  <a href={href({ name: 'station', id: s.id })}>{s.id}</a>
                </td>
                {d.t.cols.map((kg) => {
                  const sid = con(kg)
                  if (!sid) return <td class="r muted">no scenario</td>
                  const h = homeFor(s, sid)
                  const a = accessFor(s, sid)
                  return (
                    <td class="r">
                      {h.kind === 'time' ? (
                        <Num v={h.v} units="min" file="stations.json" k={`t_home_min.${s.id}.${sid}`} />
                      ) : h.kind === 'unreachable' ? (
                        <span class="num-unknown" title={h.reason ?? a.reason ?? ''}>
                          {h.label}
                        </span>
                      ) : (
                        <span class="num-unknown">unknown</span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p class="caption">
        "{CITED.unreachableLabel.value}": no walkable cell with a walk home within <CfgNum v={CITED.accessRadiusM.value} units="m" source={CITED.accessRadiusM.source} /> of the
        science point (hover for WS2's reason). This is the honest result of the conservative variant, not a missing value.
      </p>
    </div>
  )
}

function TradeView() {
  const l = useLoad(loadTrade)
  return (
    <Page title="Trade: walkback × suit mass">
      <DummyNote />
      <p class="lead">
        How the walkback budget and the suit mass change the science a crew can reach and still get home from.
      </p>
      <Show l={l} what="Trade table">
        {(d) => {
          const t = d.t
          return (
          <>
          <div class="table-scroll">
            <table class="trade">
              <thead>
                <tr>
                  <th>Walkback</th>
                  {t.cols.map((kg) => (
                    <th>
                      {kg} kg suit
                      {kg === Math.min(...CONFIG.suitMassesKg) && kg !== CONFIG.defaultSuitKg ? (
                        <>
                          {' '}
                          <AssumedTag note="Our sensitivity value, not a NASA suit mass (SPEC F6)" />
                        </>
                      ) : null}
                      {kg === CONFIG.defaultSuitKg ? <span class="muted"> (default)</span> : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {t.rows.map((budget, i) => (
                  <tr>
                    <th>{budget} min</th>
                    {t.cols.map((kg, j) => {
                      const c = t.cells[i]?.[j]
                      return (
                        <td>
                          {c ? (
                            METRICS.map((m) => {
                              const v = c[m.key]
                              const max = maxOf(t, m.key)
                              return (
                                <div class="trade-metric">
                                  <span class="trade-label">
                                    {m.label}
                                    {m.key === 'reachable_pct' && typeof c.in_data_pct === 'number' && c.in_data_pct < 100 ? ' (part inside the terrain data)' : ''}
                                  </span>
                                  <Num v={v} units={m.units} file="trade_table.json" k={`trade.${budget}.${kg}.${m.key}`} />
                                  <span class="bar">
                                    <span style={{ width: typeof v === 'number' && max > 0 ? `${(100 * v) / max}%` : '0' }} />
                                  </span>
                                  {m.key === 'reachable_pct' && typeof c.in_data_pct === 'number' && c.in_data_pct < 100 && (
                                    <span class="caption">
                                      <Num v={c.in_data_pct} units="%" file="trade_table.json" k={`trade.${budget}.${kg}.in_data_pct`} /> of the circle lies inside the terrain data
                                    </span>
                                  )}
                                </div>
                              )
                            })
                          ) : (
                            <span class="num-unknown">no cell</span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {d.stations && d.idx && <ConservativeHome d={d} zero={allScienceZero(t)} />}
          </>
          )
        }}
      </Show>
      <p class="caption">
        Science value: Σ station value within the conservative homeline. Partner-line area: area inside the <CfgNum v={CITED.haulContourMin.value} units="min" source={CITED.haulContourMin.source} /> cart-haul line (D20); design
        question, every haul parameter is an assumed band.
      </p>
    </Page>
  )
}

export const view = preactView(() => <TradeView />)
