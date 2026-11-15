// Where every number on the HUD panel comes from (AGENTS rule 6, SPEC F16). Field lookups are
// per pixel, so they are backed by the file-level manifest key `fields.<key>.sha256` that
// pipeline/export/fields_png.py records for each PNG; timeline / station / rad values are read
// from those files (WS5's provenance resolves them by file + value). The panel puts the keys and
// files on each row (data-manifest-key, data-source-files, tooltip).
import type { Readout } from './readout'
import type { StormState } from './storm'

export type PanelRow = 'tHome' | 'margin' | 'o2' | 'binding' | 'turn' | 'rover' | 'next' | 'slope' | 'partner' | 'sun' | 'dose' | 'trip'

export interface RowSource {
  keys: string[]
  files: string[]
}

export interface KeyContext {
  scenario: string
  consScenario?: string | null
  padFromFile?: boolean
  partnerFile?: string | null
  /** sun row (sun.ts sunSources: the observers actually shown); default t_dark_min + sun_series */
  sunSources?: RowSource | null
  /** storm switch state: when on, the trip row cites the tripwire time, ± label and the route T_home (D39) */
  storm?: StormState | null
}

export function readoutSources(r: Readout, k: KeyContext): Record<PanelRow, RowSource> {
  const { scenario, consScenario } = k
  const worst = r.worstRadiusM && r.worstRadiusM > 0 ? `_worst_${r.worstRadiusM}` : ''
  const field = (key: string): RowSource => ({ keys: [`fields.${key}.sha256`], files: [`fields/${key}.png`] })
  const join = (...xs: RowSource[]): RowSource => ({ keys: xs.flatMap((x) => x.keys), files: xs.flatMap((x) => x.files) })
  const file = (...files: string[]): RowSource => ({ keys: [], files })
  const timeline = file(`timeline_${scenario}.json`)
  const tHome = field(`${scenario}/t_home${worst}`)
  const o2Home = field(`${scenario}/o2_home${worst}`)
  // exact margin function (X2, D89): also O2_home, the D39 dose leash (rad.json storm series placed
  // at t*) and clock.json t_dark; the timeline reading (A-WS7-3) cites the timeline and T_home only
  const exact = r.marginSource !== 'timeline'
  const marginSrc = exact
    ? join(timeline, tHome, o2Home, { keys: [`route.${scenario}.dose.t_star_min`, 'clock.eva.t_dark_min'], files: ['conditions/rad.json', 'conditions/clock.json'] })
    : join(timeline, tHome)
  return {
    tHome: consScenario ? join(tHome, field(`${consScenario}/t_home`)) : tHome,
    margin: marginSrc,
    o2: join(timeline, o2Home),
    binding: exact ? marginSrc : timeline,
    turn: marginSrc,
    rover: join(field(`${scenario}/home_bearing`), file(k.padFromFile ? 'pad.json' : `route_${scenario}.geojson`)),
    next: join(timeline, file('stations.json')),
    slope: { keys: ['fields.slope.sha256'], files: ['fields/shared/slope.png', 'config/crew.yaml'] },
    partner: file(k.partnerFile ?? `scenarios/${scenario}/partner.geojson`),
    sun: k.sunSources ?? { keys: ['clock.eva.t_dark_min', 'clock.eva.sun_series'], files: ['conditions/clock.json'] },
    dose: file('conditions/rad.json'),
    trip: tripSources(k.storm ?? null, scenario),
  }
}

function tripSources(st: StormState | null, scenario: string): RowSource {
  if (!st?.on) return { keys: ['rad.leash.tau_min_at_peak'], files: ['conditions/rad.json'] }
  const keys = ['rad.storm_2024.tripwire_utc', 'rad.leash.tau_min_at_peak', `fields.${scenario}/t_home.sha256`]
  if (st.halfwidthLabel) keys.splice(1, 0, 'rad.storm_2024.tripwire_halfwidth_label')
  return { keys, files: ['conditions/rad.json', `route_${scenario}.geojson`, `fields/${scenario}/t_home.png`, 'config/conditions.yaml'] }
}
