// Short decision notes shared by the console and the scorecard (D22 cell slope, D45 planning rule).
// Numbers are config citations or derived from config, labelled so.
import { CITED } from '../config'
import { o2Reserve } from '../views/o2'
import { planningRuleNote } from '../views/decisions'
import { AssumedTag } from './labels'
import { CfgNum, DerivedNum } from './Num'

/** D22: what "slope" means for a cell (config citations). */
export function CellSlopeNote() {
  return (
    <span class="muted">
      {' '}
      (cell slope = <CfgNum v={CITED.routeGridM.value} units="m" source={CITED.routeGridM.source} /> plane fit over the nine 1 m elevations, plus a{' '}
      <CfgNum v={CITED.stepGuardDeg.value} units="deg" source={CITED.stepGuardDeg.source} /> step guard{CITED.stepGuardAssumed.value ? <> <AssumedTag note="Step guard: assumed (D22)" /></> : null}; the
      old max-slope grid is only a "rough footing" overlay, D22)
    </span>
  )
}

/** D45: the route DP's O₂ rule; the effort-cap rate is derived from config/crew.yaml. */
export function PlanningRuleNote() {
  const r = o2Reserve()
  const [before, after] = planningRuleNote('\u0000').split('\u0000')
  return (
    <>
      {before}
      <DerivedNum v={r.rateLMin} units="L/min" how={`${CITED.o2EffortRateFormula.source}: ${CITED.o2EffortRateFormula.value}`} />
      {after} <span class="muted">(D45)</span>
    </>
  )
}

