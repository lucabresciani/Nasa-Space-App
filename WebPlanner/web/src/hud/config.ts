// HUD constants, read from config/hud.yaml, config/crew.yaml and config/conditions.yaml (D39
// storm_replay) (AGENTS.md rule 2: never a copy). index.ts passes the build-time-parsed YAML in;
// tests parse the same files with `yaml`.
import { parseStormReplayConfig, type StormReplayConfig } from './storm'

export interface HudConfig {
  playbackSpeeds: number[] // config/hud.yaml playback_speeds
  defaultSpeed: number // hud.yaml default_speed (D13)
  defaultLevel: 'minimal' | 'expanded' // hud.yaml default_level (D14)
  marginAmberMin: number // hud.yaml margin_amber_min
  worstCaseRadiiM: number[] // hud.yaml worst_case_radii_m (ascending)
  /** drift circle (core, D19): radius = max(sigma_floor_m, pct_of_distance % of distance since the last fix) (D12, D39) */
  fallbackDrift: { pctOfDistance: number; sigmaFloorM: number } // hud.yaml fallback_drift
  fixSigmaM: { rover: number; station: number } // hud.yaml fix_sigma_m
  simulatedLabel: string // hud.yaml labels.simulated
  evaMin: number // crew.yaml eva_h * 60 (playback / scrubber length)
  walkbackBudgetsMin: number[] // crew.yaml walkback_budgets_min (homeline budgets)
  vSafe: { maxDeg: number; v: number }[] // crew.yaml v_safe_ms (slope speed cap, ascending)
  /** conditions.yaml storm_replay (D39); null = conditions.yaml not passed (storm switch disabled) */
  stormReplay: StormReplayConfig | null
}

type Obj = Record<string, unknown>

function get(root: unknown, path: string, file: string): unknown {
  let cur: unknown = root
  for (const k of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(k in (cur as Obj))) {
      throw new Error(`config/${file}: missing ${path}`)
    }
    cur = (cur as Obj)[k]
  }
  return cur
}
function num(root: unknown, path: string, file: string): number {
  const v = get(root, path, file)
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`config/${file}: ${path} is not a number`)
  return v
}
function nums(root: unknown, path: string, file: string): number[] {
  const v = get(root, path, file)
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'number')) {
    throw new Error(`config/${file}: ${path} is not a number list`)
  }
  return v as number[]
}

export function parseHudConfig(hud: unknown, crew: unknown, conditions?: unknown): HudConfig {
  const level = get(hud, 'default_level', 'hud.yaml')
  if (level !== 'minimal' && level !== 'expanded') throw new Error('config/hud.yaml: bad default_level')
  const label = get(hud, 'labels.simulated', 'hud.yaml')
  if (typeof label !== 'string' || !label) throw new Error('config/hud.yaml: labels.simulated missing')
  const vs = get(crew, 'v_safe_ms', 'crew.yaml')
  if (!Array.isArray(vs)) throw new Error('config/crew.yaml: v_safe_ms is not a list')
  const cfg: HudConfig = {
    playbackSpeeds: nums(hud, 'playback_speeds', 'hud.yaml'),
    defaultSpeed: num(hud, 'default_speed', 'hud.yaml'),
    defaultLevel: level,
    marginAmberMin: num(hud, 'margin_amber_min', 'hud.yaml'),
    worstCaseRadiiM: [...nums(hud, 'worst_case_radii_m', 'hud.yaml')].sort((a, b) => a - b),
    fallbackDrift: {
      pctOfDistance: num(hud, 'fallback_drift.pct_of_distance', 'hud.yaml'),
      sigmaFloorM: num(hud, 'fallback_drift.sigma_floor_m', 'hud.yaml'),
    },
    fixSigmaM: {
      rover: num(hud, 'fix_sigma_m.rover', 'hud.yaml'),
      station: num(hud, 'fix_sigma_m.station', 'hud.yaml'),
    },
    simulatedLabel: label,
    evaMin: num(crew, 'eva_h', 'crew.yaml') * 60,
    walkbackBudgetsMin: nums(crew, 'walkback_budgets_min', 'crew.yaml'),
    vSafe: vs
      .map((r, i) => ({ maxDeg: num(r, 'max_deg', `crew.yaml v_safe_ms[${i}]`), v: num(r, 'v', `crew.yaml v_safe_ms[${i}]`) }))
      .sort((a, b) => a.maxDeg - b.maxDeg),
    stormReplay: conditions === undefined ? null : parseStormReplayConfig(conditions),
  }
  if (!cfg.playbackSpeeds.includes(cfg.defaultSpeed)) throw new Error('config/hud.yaml: default_speed not in playback_speeds')
  return cfg
}

/** Slope speed cap v_safe(θ) from crew.yaml (a table lookup, not the F3 governor); null = no-go. */
export function vSafeAt(cfg: HudConfig, slopeDeg: number): number | null {
  for (const r of cfg.vSafe) if (slopeDeg <= r.maxDeg) return r.v
  return null
}
