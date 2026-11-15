// The pad in use (pad.json `pad`, contract pad v1.1.4). Before D21 that was config/site.yaml
// pad_default (fails the F8 rule, C 15:31). D21 (user 16:14) / D42 (17:28, frozen): the official pad
// is the candidate with the most feasible EVAs (rank1); pad.score is then the feasible-EVA count and
// pad.f8_score the F8 score. The wording follows pad.source / score_kind. max_slope_deg is the steepest cell of the pad block (WS2's F8 block test), not the
// slope at the pad cell itself.
import { CITED, CONFIG } from '../config'
import { padBlockSideM, type PadInUse } from '../map/pad'
import { CfgNum, DerivedNum, Num } from './Num'

const F = 'pad.json'

export function padBlockSide(): number {
  return padBlockSideM(CITED.sitingBlockM.value, CITED.routeGridM.value)
}

/** "steepest slope in the 21 m pad block", the side derived from site.yaml siting.block_m on the route grid. */
export function PadBlockLabel() {
  return (
    <>
      steepest slope in the{' '}
      <DerivedNum
        v={padBlockSide()}
        units="m"
        how={`${CITED.sitingBlockM.source} (${CITED.sitingBlockM.value} m) on the ${CITED.routeGridM.value} m route grid (${CITED.routeGridM.source}): the odd-cell square centred on the pad, as WS2 siting.py`}
      />{' '}
      pad block
    </>
  )
}

/** pad.json still names pad_default (a pre-D21 file, or pad_default won the D21 screening). */
export function isPadDefault(source: string | null): boolean {
  return !source || /pad_default/.test(source)
}

export function PadInUseText({ u }: { u: PadInUse }) {
  const b = CONFIG.walkbackBudgetsMin[0]
  const name = u.official ? 'the official pad' : isPadDefault(u.source) ? 'pad_default' : 'the pad in pad.json'
  const rule = (
    <>
      <PadBlockLabel /> <Num v={u.maxSlopeDeg} units="deg" file={F} k="pad.checks.max_slope_deg" /> (rule: at most{' '}
      <CfgNum v={CITED.sitingMaxSlopeDeg.value} units="deg" source={CITED.sitingMaxSlopeDeg.source} />
      ); {b}-min flat disc assessed <Num v={u.assessedPct} units="%" file={F} k="pad.checks.assessed_pct_30min" />.{' '}
      {u.rulePassed === false ? (
        <b class="bad">{name} fails the F8 rule.</b>
      ) : u.rulePassed === true ? (
        <b class="ok">{name} passes the F8 rule.</b>
      ) : (
        <b>F8 rule not evaluated at {name}.</b>
      )}
    </>
  )
  if (u.official) {
    // D21 / D42: pad.json is the official pad (most feasible EVAs), frozen; pad.score is the feasible-EVA count.
    return (
      <>
        <p>
          <b>Pad in use: the official pad</b>, the candidate with the most feasible EVAs (D21):{' '}
          <Num v={u.feasibleEvas} file={F} k="pad.score" /> station combinations with a feasible route. <b>Frozen</b> (D42): it does not change again before
          submission. F8 siting score at this pad <Num v={u.score} file={F} k={u.f8Key} />; {rule}
        </p>
        <p class="caption">
          Source: {u.source ?? 'pad.json'}. The slope is the steepest cell in the block (the F8 block test), not the slope at the pad cell itself. Every route, band
          and number in the plan, the HUD, the 3D view and the station cards use this pad. The F8 siting score is the "F8 heatmap" layer; the other candidates are
          the Rover parking options.
        </p>
      </>
    )
  }
  return (
    <>
      <p>
        <b>Pad in use: {name}</b> <span class="muted">(source: {u.source ?? 'pad.json'})</span>. F8 rule at this pad: score <Num v={u.score} file={F} k={u.f8Key} />
        {u.score === 0 && <> (no station has a conservative walk home of {b} min or less)</>}; {rule}
      </p>
      <p class="caption">
        The slope is the steepest cell in the block (the F8 block test), not the slope at the pad cell itself. Every route, band and number in the plan, the HUD, the 3D
        view and the station cards use this pad. D21 (user, 14 Nov 16:14): the official pad is the candidate with the most feasible EVAs
        {isPadDefault(u.source) ? '; this pad.json names pad_default (see its source)' : ''}. The F8 siting score is the "F8 heatmap" layer.
      </p>
    </>
  )
}
