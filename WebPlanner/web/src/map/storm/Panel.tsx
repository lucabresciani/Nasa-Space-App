// WS16 task 12 (M12): storm mode overlays (DESIGN U9): the timing note, the alarm banner at the
// tripwire, the dose-ring legend (map) and the dose-rate curve (timeline dock). Every number goes
// through <Num> (manifest key) or <DerivedNum> (browser-computed, says how) and carries a trust chip.
// Every container that shows a storm visual carries the "hypothetical timing" note (D39); there is
// no prop to leave it out. Text from copy.json only. No animation (reduced motion: nothing to stop).
import type { ComponentChildren } from 'preact'
import { DerivedNum, Num } from '../../components/Num'
import { Icon, Tag, TrustChip } from '../../ui/components'
import { t } from '../../ui/copy'
import { curveRuns, STORM_KEYS, type StormModel, type StormView } from './model'

/** Copy text with one {placeholder} replaced by a node (so the number keeps its manifest link). */
export function withNode(text: string, marker: string, node: ComponentChildren): ComponentChildren {
  const parts = text.split(marker)
  return parts.length === 2 ? [parts[0], node, parts[1]] : text
}
const MARK = '\u0000'

/** The note "Hypothetical storm timing (…)" (copy storm.note) with its tag; shown with every storm visual. */
export function TimingNote() {
  return (
    <p class="hl-storm__note" data-storm-note="">
      <Tag kind="hypotheticalTiming" />
      <span>{t('storm.note')}</span>
    </p>
  )
}

/** The leash from rad.json (leash.tau_min_at_peak), shown to the minute, linked to its manifest key. */
function LeashNum({ m }: { m: StormModel }) {
  return <Num v={m.leashMin} file={STORM_KEYS.file} k={STORM_KEYS.leash} dp={0} />
}

/** Alarm banner at the tripwire: copy alarms.radiationLeash, "Radiation: head home within {leash_min} min". */
export function StormBanner({ m }: { m: StormModel }) {
  const title = withNode(t('alarms.radiationLeash', { leash_min: MARK }), MARK, <LeashNum m={m} />)
  return (
    <div class="hl-banner hl-banner--limit hl-storm__banner" role="alert" data-storm-banner="">
      <Icon name="radiation" class="hl-banner__icon" />
      <div class="hl-banner__text">
        <div class="hl-banner__title">
          {title} <TrustChip kind="modelled" prov={{ key: STORM_KEYS.leash, file: STORM_KEYS.file, value: m.leashMin }} />
        </div>
      </div>
    </div>
  )
}

/** Map panel: title, the timing note, the tripwire minute and the dose-ring legend (leash now). */
export function StormPanel({ m, v }: { m: StormModel; v: StormView }) {
  const tStarProv = { key: STORM_KEYS.tStar(m.scenario), file: STORM_KEYS.tStarFile(m.scenario), value: m.tFire }
  return (
    <div class="hl-storm__overlay" data-storm-overlay="" data-fired={v.fired ? 'true' : 'false'}>
      {v.banner && <StormBanner m={m} />}
      <section class="hl-storm__panel" aria-label={t('storm.title')}>
        <h2 class="hl-storm__title">
          <Icon name="radiation" />
          {t('storm.title')}
          <TrustChip kind="simulated" />
        </h2>
        <TimingNote />
        <p class="hl-storm__row" data-storm-row="tripwire">
          <Icon name="tripwire" />
          <span class="hl-storm__label">{t('timeline.tripwire')}</span>
          <Num v={m.tFire} file={tStarProv.file} k={tStarProv.key} units="min" dp={0} />
          {m.halfwidthLabel && <Num v={m.halfwidthLabel} file={STORM_KEYS.file} k={STORM_KEYS.halfwidth} />}
          <TrustChip kind="simulated" prov={tStarProv} align="end" />
        </p>
        <p class="hl-storm__row" data-storm-row="ring">
          <span class="hl-storm__swatch" aria-hidden="true" />
          <span class="hl-storm__label">{t('storm.doseRing')}</span>
          {v.fired ? (
            <>
              <DerivedNum v={+v.ringLeashMin.toFixed(0)} units="min" how={`dose budget left = rad.json leash.tau_min_at_peak (${m.leashMin}) − (EVA minute − tripwire minute ${m.tFire}), floored at 0 (hud/storm.ts)`} />
              <TrustChip kind="simulated" prov={{ key: STORM_KEYS.leash, file: STORM_KEYS.file, value: m.leashMin }} align="end" />
            </>
          ) : (
            <>
              <LeashNum m={m} /> min
              <TrustChip kind="modelled" prov={{ key: STORM_KEYS.leash, file: STORM_KEYS.file, value: m.leashMin }} align="end" />
            </>
          )}
        </p>
      </section>
    </div>
  )
}

/**
 * Dose-rate curve over the timeline dock's plot lane (log scale, peak at the top), with the tripwire
 * threshold as a dashed line and a label: "Dose rate", the peak and the threshold with their chips,
 * and the timing note. Positioned in % of the EVA axis like the dock's own marks.
 */
export function StormCurve({ m, tMax }: { m: StormModel; tMax: number }) {
  const { runs, yOf } = curveRuns(m, tMax)
  const W = 1000
  const H = 100
  const d = runs.map((r) => r.map(([x, y], i) => `${i ? 'L' : 'M'}${(x * W).toFixed(2)},${((1 - y) * H).toFixed(2)}`).join('')).join('')
  const thr = m.thresholdUGyDay !== null ? (1 - yOf(m.thresholdUGyDay)) * H : null
  return (
    <div class="hl-storm-curve" data-storm-curve="" aria-hidden="false">
      <svg class="hl-storm-curve__svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
        {thr !== null && <line class="hl-storm-curve__threshold" x1={0} x2={W} y1={thr} y2={thr} vector-effect="non-scaling-stroke" />}
        <path class="hl-storm-curve__line" d={d} data-runs={runs.length} vector-effect="non-scaling-stroke" />
      </svg>
      <div class="hl-storm-curve__label">
        <span>{t('storm.doseRate')}</span>
        {m.peakUGyDay !== null && (
          <>
            <Num v={m.peakUGyDay} file={STORM_KEYS.file} k={STORM_KEYS.peak} units="uGy/day" />
            <TrustChip kind="real" prov={{ key: STORM_KEYS.peak, file: STORM_KEYS.file, value: m.peakUGyDay }} />
          </>
        )}
        {m.thresholdUGyDay !== null && (
          <>
            <span class="hl-storm-curve__sep">·</span>
            <span>{t('timeline.tripwire')}</span>
            <Num v={m.thresholdUGyDay} file={STORM_KEYS.file} k={STORM_KEYS.threshold} units="uGy/day" />
            <TrustChip kind="real" prov={{ key: STORM_KEYS.threshold, file: STORM_KEYS.file, value: m.thresholdUGyDay }} align="end" />
          </>
        )}
        <span class="hl-storm-curve__note" data-storm-note="" title={t('storm.note')}>
          <Tag kind="hypotheticalTiming" />
        </span>
      </div>
    </div>
  )
}
