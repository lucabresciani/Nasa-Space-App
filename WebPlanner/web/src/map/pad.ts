// Rover pad (F8). C 14:58 / contract pad v1.1.2: pad.json `pad` is the pad *in use* (= config/site.yaml
// pad_default, user 11:24) with the F8 rule evaluated there; without pad.json (a tree that lacks it)
// the app uses pad_default itself, labelled. WS2's F8 siting result is only a proposal: siting.png +
// siting_png.json, plus the pad.json `proposal` block {adopted: false, pad, alternatives, tie, ...}.
// A proposal never becomes the pad.
import type { PadChecks, PadFile, PadProposalBlock } from '../data/types'

export interface PadMarkerInfo {
  lon: number
  lat: number
  /** Data file the position was read from (null = config/site.yaml). */
  file: string | null
  sourceLabel: string
  title: string
}

export function padMarker(p: PadFile | null, cfg: { lon: number; lat: number }): PadMarkerInfo {
  if (p) {
    const official = citesD21(p.pad.source)
    return {
      lon: p.pad.lon,
      lat: p.pad.lat,
      file: 'pad.json',
      sourceLabel: official ? 'pad.json: the official pad, most feasible EVAs (D21), frozen (D42)' : 'pad.json, the pad in use',
      title: official ? 'Official rover pad (pad.json; D21: most feasible EVAs; frozen, D42)' : `Rover pad in use (pad.json: ${p.pad.source ?? 'pad_default'})`,
    }
  }
  return {
    lon: cfg.lon,
    lat: cfg.lat,
    file: null,
    sourceLabel: 'config/site.yaml pad_default (the pad in use)',
    title: 'Rover pad in use: config/site.yaml pad_default (kept by the user, 14 Nov 11:24)',
  }
}

export type RuleLabel = 'passed' | 'NOT passed' | 'not evaluated'

export interface PadRuleCheck {
  score: number | null
  maxSlopeDeg: number | null
  assessedPct: number | null
  rulePassed: boolean | null
  ruleLabel: RuleLabel
}

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

function ruleCheck(score: unknown, c: Partial<PadChecks> | undefined): PadRuleCheck {
  const passed = typeof c?.rule_passed === 'boolean' ? c.rule_passed : null
  return {
    score: n(score),
    maxSlopeDeg: n(c?.max_slope_deg),
    assessedPct: n(c?.assessed_pct_30min),
    rulePassed: passed,
    ruleLabel: passed === true ? 'passed' : passed === false ? 'NOT passed' : 'not evaluated',
  }
}

/** The F8 rule evaluated at the pad in use (pad.json `pad`). */
export interface PadInUse extends PadRuleCheck {
  source: string | null
  /** D21 / D42: pad.json names the official pad (source cites D21). */
  official: boolean
  /** D21 score (`score_kind` d21_feasible_eva_count): feasible EVAs from this pad; null on pre-D21 files. */
  feasibleEvas: number | null
  /** Manifest key of the F8 score shown in `score`: pad.f8_score on D21 files, else pad.score. */
  f8Key: 'pad.score' | 'pad.f8_score'
}

/** pad.json `source` cites D21 (word match, as WS3's pad_observer: not "D210"). */
export function citesD21(source: string | null | undefined): boolean {
  return !!source && /\bD21\b/.test(source)
}

export function padInUse(p: PadFile | null): PadInUse | null {
  if (!p) return null
  const q = p.pad as PadFile['pad'] & { score_kind?: string; f8_score?: number | null }
  const d21 = q.score_kind === 'd21_feasible_eva_count'
  const src = s(q.source)
  return {
    ...ruleCheck(d21 ? q.f8_score : q.score, q.checks),
    source: src,
    official: citesD21(src) && !/^config\/site\.yaml pad_default/.test(src ?? ''),
    feasibleEvas: d21 ? n(q.score) : null,
    f8Key: d21 ? 'pad.f8_score' : 'pad.score',
  }
}

export interface PadProposal extends PadRuleCheck {
  lon: number
  lat: number
  elevM: number | null
  /** Every ranked alternative as written (rank 1 is normally the proposal itself). */
  ranked: { rank: number; lon: number; lat: number; elevM: number | null; score: number | null; isProposal: boolean }[]
  /** Ranked alternatives other than the proposal itself (map markers). */
  alternatives: { rank: number; lon: number; lat: number; score: number | null }[]
  /** Every alternative has the proposal's score: the rule cannot tell them apart. */
  tied: boolean
  tie: { topScore: number | null; nAtTop: number | null; nCandidates: number | null; tiebreak: string | null; note: string | null } | null
  rule: string | null
  note: string | null
  checksNote: string | null
  stations: string[]
  noAccess: [string, string][]
}

/** The pad.json `proposal` block (F8 siting result, contract v1.1.2: `proposal.pad.*`), or null. */
export function padProposal(p: PadFile | null): PadProposal | null {
  const b: PadProposalBlock | undefined = p?.proposal
  const q = b?.pad
  if (!b || !q || n(q.lon) === null || n(q.lat) === null) return null
  const check = ruleCheck(q.score, q.checks)
  const same = (a: { lon: number; lat: number }) => a.lon === q.lon && a.lat === q.lat
  const all = [...(b.alternatives ?? [])].sort((x, y) => x.rank - y.rank)
  const alts = all.filter((a) => !same(a))
  const t = b.tie
  return {
    ...check,
    lon: q.lon,
    lat: q.lat,
    elevM: n(q.elev_m),
    ranked: all.map((a) => ({ rank: a.rank, lon: a.lon, lat: a.lat, elevM: n(a.elev_m), score: n(a.score), isProposal: same(a) })),
    alternatives: alts.map((a) => ({ rank: a.rank, lon: a.lon, lat: a.lat, score: n(a.score) })),
    tied: check.score !== null && alts.length > 0 && alts.every((a) => a.score === check.score),
    tie: t
      ? { topScore: n(t.top_score), nAtTop: n(t.n_blocks_at_top_score), nCandidates: n(t.n_candidate_blocks), tiebreak: s(t.tiebreak), note: s(t.note) }
      : null,
    rule: s(b.site_rule_version) ?? (typeof b.site_rule_version === 'number' ? String(b.site_rule_version) : null),
    note: s(b.note),
    checksNote: s(b.checks_note),
    stations: Array.isArray(b.stations) ? b.stations.filter((x): x is string => typeof x === 'string') : [],
    noAccess: b.no_access && typeof b.no_access === 'object' ? Object.entries(b.no_access).filter((e): e is [string, string] => typeof e[1] === 'string') : [],
  }
}

/** Python's round(): half to even. */
function roundHalfEven(x: number): number {
  const f = Math.floor(x)
  const d = x - f
  return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1
}

/** Side of the F8 pad block on the routing grid: WS2 siting.py takes the (2k+1)-cell square centred on the pad, k = round(block_m / grid / 2) (Python round). */
export function padBlockSideM(blockM: number, gridM: number): number {
  const k = Math.max(roundHalfEven(blockM / gridM / 2), 0)
  return (2 * k + 1) * gridM
}
