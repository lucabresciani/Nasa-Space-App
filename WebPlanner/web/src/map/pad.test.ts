import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CITED, CONFIG } from '../config'
import { schemaFor } from '../data/contracts'
import { checkSchema } from '../data/schema'
import type { PadFile } from '../data/types'
import { padBlockSideM, padInUse, padMarker, padProposal } from './pad'

const dummy = JSON.parse(readFileSync(resolve(__dirname, '../../public/data-dummy/pad.json'), 'utf8')) as PadFile

// WS2 session 5 pad.json (commit 9ae1ca7, contract pad v1.1.2), verbatim: `pad` = pad_default in use, the F8
// result in `proposal.pad.*` with its own alternatives, tie and checks_note.
const REAL: PadFile = {
  dummy: false,
  pad: {
    lon: 137.382,
    lat: -4.806,
    elev_m: -3627.8,
    score: 0.0,
    checks: {
      assessed_pct_30min: 100.0,
      max_slope_deg: 28.06,
      rule_passed: false
    },
    source: 'config/site.yaml pad_default (kept by the user, 14 Nov 11:24)'
  },
  alternatives: [],
  hop_options: [],
  site_rule_version: 'site.yaml siting: sum of station values with conservative T_home <= 30 min; tiebreak lower elevation than the value-weighted station centroid',
  proposal: {
    adopted: false,
    note: 'F8 siting proposal for S (WS2 pipeline/engine/siting.py); pad_default is kept; S decides. Not used by any route, band or number in the plan.',
    pad: {
      lon: 137.402443,
      lat: -4.769028,
      elev_m: -3811.3,
      score: 0.475,
      checks: {
        assessed_pct_30min: null,
        max_slope_deg: 3.95,
        rule_passed: null
      }
    },
    alternatives: [
      {
        rank: 1,
        lon: 137.402443,
        lat: -4.769028,
        elev_m: -3811.3,
        score: 0.475
      },
      {
        rank: 2,
        lon: 137.405846,
        lat: -4.764625,
        elev_m: -3810.1,
        score: 0.475
      },
      {
        rank: 3,
        lon: 137.393301,
        lat: -4.776468,
        elev_m: -3779.5,
        score: 0.475
      }
    ],
    hop_options: [],
    site_rule_version: 'site.yaml siting: sum of station values with conservative T_home <= 30 min; tiebreak lower elevation than the value-weighted station centroid',
    tie: {
      top_score: 0.475,
      n_blocks_at_top_score: 5,
      n_candidate_blocks: 742,
      tiebreak: 'lower elevation than the value-weighted station centroid (site.yaml siting.tiebreak)',
      note: '5 candidate blocks share the top score 0.475: the rule cannot tell them apart; the tiebreak alone picks rank 1'
    },
    stations: [
      'S4'
    ],
    no_access: {
      S1: '38 assessed cells within 50 m, none with a walk home in this scenario',
      S2: '191 assessed cells within 50 m, none with a walk home in this scenario'
    },
    checks_note: 'assessed_pct_30min and rule_passed are null: the 1764 m flat disc around the proposed pad leaves the 3 m routing grid (the proposed pad is 1510 m from the nearest grid edge), so the disc cannot be assessed'
  }
}
const IN_USE: PadFile = { ...REAL, proposal: undefined }
// Session-3 assumed shape (proposal.lon/lat at the top of the block): not the contract, must not be read.
const OLD_SHAPE = { ...IN_USE, proposal: { lon: 137.402443, lat: -4.769028, score: 0.475 } } as unknown as PadFile

describe('pad marker: the pad in use', () => {
  it('pad.json pad = pad_default (contract v1.1.2)', () => {
    const m = padMarker(REAL, CONFIG.padDefault)
    expect([m.lon, m.lat]).toEqual([CONFIG.padDefault.lon, CONFIG.padDefault.lat])
    expect(m.file).toBe('pad.json')
    expect(m.title).toContain('pad_default')
  })
  it('the proposal never moves the pad', () => {
    expect([padMarker(REAL, CONFIG.padDefault).lon, padMarker(REAL, CONFIG.padDefault).lat]).not.toEqual([REAL.proposal!.pad.lon, REAL.proposal!.pad.lat])
  })
  it('falls back to config/site.yaml pad_default, labelled (a tree without pad.json)', () => {
    const m = padMarker(null, CONFIG.padDefault)
    expect([m.lon, m.lat]).toEqual([CONFIG.padDefault.lon, CONFIG.padDefault.lat])
    expect(m.file).toBeNull()
    expect(m.sourceLabel).toContain('pad_default')
  })
  it('dummy pad.json still reads', () => expect(padMarker(dummy, CONFIG.padDefault).file).toBe('pad.json'))
})

describe('F8 rule at the pad in use', () => {
  it('pad_default fails the rule: score 0, block max slope 28.06 deg, disc 100 % assessed', () => {
    const u = padInUse(REAL)!
    expect([u.score, u.maxSlopeDeg, u.assessedPct, u.rulePassed]).toEqual([0, 28.06, 100, false])
    expect(u.ruleLabel).toBe('NOT passed')
    expect(u.source).toContain('pad_default')
  })
  it('none without pad.json', () => expect(padInUse(null)).toBeNull())
  it('pre-D21 file: the pad score is the F8 score (key pad.score), not the official pad', () => {
    const u = padInUse(REAL)!
    expect([u.official, u.feasibleEvas, u.f8Key]).toEqual([false, null, 'pad.score'])
  })
  it('D21 / D42 official pad (WS2 session 7 pad.json): score = 38 feasible EVAs, F8 score from pad.f8_score, rule passed', () => {
    const d21: PadFile = {
      ...REAL,
      pad: {
        lon: 137.401783,
        lat: -4.77748,
        elev_m: -3742.4,
        score: 38,
        checks: { assessed_pct_30min: 100.0, max_slope_deg: 4.86, rule_passed: true },
        source: 'D21 (user 2026-11-14 16:14): the candidate pad with the most feasible EVAs (nominal 104 kg; tiebreaks: reachable % of the assessed flat 30-min disc, then lower elevation); pipeline/engine/padpick.py',
        f8_score: 0.4744,
        score_kind: 'd21_feasible_eva_count',
        id: 'rank1',
      } as PadFile['pad'],
    }
    const u = padInUse(d21)!
    expect([u.official, u.feasibleEvas, u.score, u.f8Key, u.rulePassed, u.maxSlopeDeg]).toEqual([true, 38, 0.4744, 'pad.f8_score', true, 4.86])
  })
  it('pad block side: site.yaml block_m 20 on the 3 m route grid = 7 cells = 21 m (WS2 siting.py)', () => {
    expect(padBlockSideM(CITED.sitingBlockM.value, CITED.routeGridM.value)).toBe(21)
    expect(padBlockSideM(20, 3)).toBe(21)
    expect(padBlockSideM(10, 10)).toBe(10)
  })
})

describe('F8 siting proposal (pad.json `proposal`, contract v1.1.2 shape)', () => {
  it('none without pad.json or without the block', () => {
    expect(padProposal(null)).toBeNull()
    expect(padProposal(IN_USE)).toBeNull()
  })
  it('the session-3 assumed shape (proposal.lon/lat) is not read', () => expect(padProposal(OLD_SHAPE)).toBeNull())
  it('reads proposal.pad.*; null disc check = "not evaluated", with checks_note', () => {
    const p = padProposal(REAL)!
    expect([p.lon, p.lat, p.elevM, p.score, p.maxSlopeDeg]).toEqual([137.402443, -4.769028, -3811.3, 0.475, 3.95])
    expect(p.assessedPct).toBeNull()
    expect(p.rulePassed).toBeNull()
    expect(p.ruleLabel).toBe('not evaluated')
    expect(p.checksNote).toContain('leaves the 3 m routing grid')
    expect(p.rule).toBe(REAL.proposal!.site_rule_version)
    expect(p.note).toContain('S decides')
  })
  it('tie: 5 of 742 blocks at the top score 0.475; all ranks listed, rank-1 duplicate off the map markers', () => {
    const p = padProposal(REAL)!
    expect(p.tie).toMatchObject({ topScore: 0.475, nAtTop: 5, nCandidates: 742 })
    expect(p.tie!.tiebreak).toContain('lower elevation')
    expect(p.tied).toBe(true)
    expect(p.ranked.map((a) => [a.rank, a.isProposal])).toEqual([
      [1, true],
      [2, false],
      [3, false],
    ])
    expect(p.alternatives.map((a) => a.rank)).toEqual([2, 3])
  })
  it('stations scored and stations without access', () => {
    const p = padProposal(REAL)!
    expect(p.stations).toEqual(['S4'])
    expect(p.noAccess.map(([k]) => k)).toEqual(['S1', 'S2'])
  })
  it('the real shape validates against contracts/pad.schema.json (browser checker)', () => {
    expect(checkSchema(REAL, schemaFor('pad.json')!)).toEqual([])
  })
})
