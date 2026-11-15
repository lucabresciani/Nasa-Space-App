// WP6 (D97): ported from origin/waypoint-routing web/src/mission/physio.ts (N0CEO, Mission Planer), unchanged
// except import paths. Feeds the ghost route and its leg-time estimates (labelled "estimate").
// Suited walking cost per metre for the Mission Planer router: a TypeScript port of
// pipeline/engine/physio.py (governor, vo2, o2_litres, grade_table), every constant read from
// config/crew.yaml and config/variants.yaml (AGENTS rule 2). physio.test.ts checks it against values
// computed by the Python engine. Formulas (variants.yaml `formulas`; theta in rad, i = tan theta):
//   a(M)   = a_anchor * a_mult + alpha * (M - anchor.carried_kg),  a_anchor = (anchor.vo2 - V0) / anchor.speed
//   alpha  = ist2.level_increment / (span_kg * anchor.speed),
//            span_kg = (g_frac[1] - g_frac[0]) * g_earth * (system_kg + subject_kg) / g_mars
//   k      = (m_b + M) g sin(theta) / (eta m_b) * 60 / j_per_ml        (theta > 0, else 0)
//   cost   = a + k (theta >= 0),  a * clamp(f(i) / f(0), lo, hi) (theta < 0)
//   v*     = min(v_safe(|theta|), (effort_cap VO2max - V0) / cost)
//   VO2    = V0 + cost v*;  O2 [L/m] = VO2 m_b (1 / v* / 60) / 1000;  pace = 1 / v*
//   impassable when |theta| > nogo_deg or v* = 0.
import crewRaw from '../../../../../config/crew.yaml'
import variantsRaw from '../../../../../config/variants.yaml'
import { cfg } from '../../../config'

const SEC_PER_MIN = 60
const ML_PER_L = 1000
const VARIANT_PREFIX: Record<string, string> = { opt: 'optimistic', nom: 'nominal', con: 'conservative' }

export interface Params {
  variant: string
  eta: number
  V0: number
  aMult: number
  nogoDeg: number
  mB: number
  carriedKg: number
  g: number
  vo2max: number
  effortCap: number
  anchorVo2: number
  anchorSpeed: number
  anchorCarriedKg: number
  alpha: number
  jPerMl: number
  vSafe: { maxDeg: number; v: number }[] // ascending max_deg
  minetti: number[] // c5..c0
  downhillClamp: [number, number]
}

function n(root: unknown, path: string): number {
  const v = cfg<unknown>(root, path)
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`config value not a number: ${path}`)
  return v
}

/** Minetti f(i) coefficients c5..c0 from the variants.yaml formula text (as physio._parse_minetti). */
export function parseMinetti(text: string): number[] {
  const rhs = text.split('=', 2)[1].split('#', 1)[0].replace(/\s/g, '')
  const coef = [0, 0, 0, 0, 0, 0]
  for (const m of rhs.matchAll(/([+-]?)([\d.]+)(i)?(?:\^(\d))?/g)) {
    const deg = m[3] ? (m[4] ? Number(m[4]) : 1) : 0
    coef[deg] = Number(m[2]) * (m[1] === '-' ? -1 : 1)
  }
  return [5, 4, 3, 2, 1, 0].map((d) => coef[d])
}

function parseClamp(text: string): [number, number] {
  const m = /clamp\(\s*f\(i\)\s*\/\s*f\(0\)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/.exec(text)
  if (!m) throw new Error(`cannot parse downhill clamp from ${text}`)
  return [Number(m[1]), Number(m[2])]
}

/** Params for a scenario id such as 'nom_104' (variant prefix + suit mass), like physio.scenario_params. */
export function scenarioParams(sid: string): Params {
  const [pre, suit] = sid.split('_')
  const variant = VARIANT_PREFIX[pre]
  if (!variant || !Number.isFinite(Number(suit))) throw new Error(`unknown scenario id ${sid}`)
  const v = cfg<Record<string, unknown>>(variantsRaw, `variants.${variant}`)
  if (typeof v.nogo_deg !== 'number') throw new Error(`variants.${variant}.nogo_deg is not a number`)
  const ws = 'ist2.weight_span'
  const gFrac = cfg<[number, number]>(variantsRaw, `${ws}.g_frac`)
  const spanKg =
    ((gFrac[1] - gFrac[0]) * n(variantsRaw, 'ist2.g_earth_ms2') * (n(variantsRaw, `${ws}.system_kg`) + n(variantsRaw, `${ws}.subject_kg`))) /
    n(crewRaw, 'g_mars')
  const anchorSpeed = n(crewRaw, 'anchor.speed_ms')
  const formulas = cfg<Record<string, string>>(variantsRaw, 'formulas')
  return {
    variant,
    eta: Number(v.eta),
    V0: Number(v.V0),
    aMult: Number(v.a_mult),
    nogoDeg: v.nogo_deg,
    mB: n(crewRaw, 'body_mass_kg'),
    carriedKg: Number(suit) + n(crewRaw, 'tools_kg'),
    g: n(crewRaw, 'g_mars'),
    vo2max: n(crewRaw, 'vo2max_ml_kg_min'),
    effortCap: n(crewRaw, 'effort_cap_frac'),
    anchorVo2: n(crewRaw, 'anchor.vo2_ml_kg_min'),
    anchorSpeed,
    anchorCarriedKg: n(crewRaw, 'anchor.carried_kg'),
    alpha: n(variantsRaw, 'ist2.level_increment_ml_kg_min') / (spanKg * anchorSpeed),
    jPerMl: n(crewRaw, 'o2_energy_j_per_ml'),
    vSafe: cfg<{ max_deg: number; v: number }[]>(crewRaw, 'v_safe_ms')
      .map((r) => ({ maxDeg: r.max_deg, v: r.v }))
      .sort((a, b) => a.maxDeg - b.maxDeg),
    minetti: parseMinetti(formulas.minetti_f),
    downhillClamp: parseClamp(formulas.vo2_downhill),
  }
}

function polyval(c: number[], x: number): number {
  let y = 0
  for (const k of c) y = y * x + k
  return y
}

export interface PerMetre {
  pace: number // s/m, Infinity = impassable
  o2: number // L/m, Infinity = impassable
}

export interface GradeModel {
  /** Exact model at grade theta (rad). */
  exact(theta: number): PerMetre
  /** Lookup table (variants.yaml numerics.grade_table_step_deg, linear interpolation), as the engine routes. */
  lookup(theta: number): PerMetre
  /** Smallest pace over all grades (s/m): the A* heuristic factor. */
  minPace: number
  nogoDeg: number
}

export function gradeModel(p: Params): GradeModel {
  const aAnchor = (p.anchorVo2 - p.V0) / p.anchorSpeed
  const a = aAnchor * p.aMult + p.alpha * (p.carriedKg - p.anchorCarriedKg)
  const cap = p.effortCap * p.vo2max
  const f0 = polyval(p.minetti, 0)
  const [lo, hi] = p.downhillClamp

  const vSafe = (deg: number): number => {
    for (const r of p.vSafe) if (Math.abs(deg) <= r.maxDeg) return r.v
    return 0
  }
  const exact = (theta: number): PerMetre => {
    const deg = (theta * 180) / Math.PI
    let cost: number
    if (theta >= 0) {
      const k = theta > 0 ? (((p.mB + p.carriedKg) * p.g * Math.sin(theta)) / (p.eta * p.mB)) * (SEC_PER_MIN / p.jPerMl) : 0
      cost = a + k
    } else {
      const f = polyval(p.minetti, Math.tan(theta)) / f0
      cost = a * Math.min(hi, Math.max(lo, f))
    }
    const v = Math.min(vSafe(deg), Math.max(cap - p.V0, 0) / cost)
    if (!(Math.abs(deg) <= p.nogoDeg + 1e-9) || !(v > 0)) return { pace: Infinity, o2: Infinity }
    const vo2 = p.V0 + cost * v
    return { pace: 1 / v, o2: (vo2 * p.mB * (1 / v / SEC_PER_MIN)) / ML_PER_L }
  }

  const step = n(variantsRaw, 'numerics.grade_table_step_deg')
  const count = Math.round(180 / step) + 1
  const dStep = 180 / (count - 1)
  const pace = new Float64Array(count)
  const o2 = new Float64Array(count)
  let minPace = Infinity
  for (let i = 0; i < count; i++) {
    const r = exact(((-90 + i * dStep) * Math.PI) / 180)
    pace[i] = r.pace
    o2[i] = r.o2
    if (r.pace < minPace) minPace = r.pace
  }
  const lookup = (theta: number): PerMetre => {
    const x = ((theta * 180) / Math.PI + 90) / dStep
    const i = Math.min(count - 2, Math.max(0, Math.floor(x)))
    const t = x - i
    const p0 = pace[i]
    const p1 = pace[i + 1]
    if (p0 === Infinity || p1 === Infinity) {
      // At a no-go boundary: the engine interpolates to inf; a node exactly on the table point still counts.
      if (t === 0 && p0 !== Infinity) return { pace: p0, o2: o2[i] }
      if (t === 1 && p1 !== Infinity) return { pace: p1, o2: o2[i + 1] }
      return { pace: Infinity, o2: Infinity }
    }
    return { pace: p0 + (p1 - p0) * t, o2: o2[i] + (o2[i + 1] - o2[i]) * t }
  }
  return { exact, lookup, minPace, nogoDeg: p.nogoDeg }
}
