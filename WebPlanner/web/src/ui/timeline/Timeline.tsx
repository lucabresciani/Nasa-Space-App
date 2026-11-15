// Timeline dock (DESIGN U5, §3.7 "Timeline: collapsed, expanded, playing, scrubbing", §4.4 keys;
// WS15 task 7, package A7). One time axis for the whole app: the scrubber reads and writes the shared
// mission clock (state/mission.ts missionClock), the same store the HUD, the map, the field and the
// thread follow, so the scrubber time and the HUD clock are one number.
//
//   controls   play / pause, speed (config/hud.yaml playback_speeds, D13 default 60×), EVA time
//   track      axis (0 … EVA length), dwell blocks, turn-back markers, O2 checkpoints, storm window and
//              tripwire ("hypothetical timing", D39), daylight end, the margin curve (fill by margin
//              class, binding term in its own lane), the scrub head
//   readouts   margin at the last published row (binding term), next turn-back
//
// Elevation profile: not drawn. The published route (route_*.geojson) has 2D coordinates and no
// elevation property, so there is no elevation along the route to plot (never invented).
// Colours: margin classes only (safe / caution / limit, §3.1). Binding terms have no colour token, so
// the binding is a labelled lane under the curve, not a hue.
import { useRef } from 'preact/hooks'
import { DerivedNum, Num } from '../../components/Num'
import { FIELD_LAYER } from '../../map/field/constants'
import { marginClass, type Binding } from '../../map/field/margin'
import type { ClockDriver } from '../../state/clock'
import { useSignalValue } from '../../state/signal'
import { linear, linePath, areaPath, pct, splitByClass, stepTicks, type Pt } from '../charts'
import { cx, Icon, IconButton, Readout, Segmented, Tag, TrustChip } from '../components'
import { t } from '../copy'
import { BINDING_COPY, dwellAt, fmtEva, nextTurnBack, rowAt, type TimelineModel } from './model'
import type { DockTicker } from './ticker'
import './timeline.css'

/** SVG user units of the chart (the viewBox; the chart stretches to the track, strokes do not scale). */
export const CHART_W = 1000
export const CHART_H = 100
/** Axis labels every this many EVA minutes (= the 30-min O2 checkpoint rhythm of DESIGN U5). */
const AXIS_STEP_MIN = 30

export interface ChartScales {
  x: (t: number) => number
  y: (m: number) => number
  /** inverse of y (chart units -> margin min), for tests and hit-testing */
  yInv: (py: number) => number
}

export function chartScales(m: TimelineModel): ChartScales {
  const x = linear([0, m.tMax], [0, CHART_W])
  const y = linear([m.yMin, m.yMax], [CHART_H, 0])
  const yInv = linear([CHART_H, 0], [m.yMin, m.yMax])
  return { x, y, yInv }
}

/** Class boundaries of the margin (red < 0, amber <= amber_min, green above: hud/alarms.ts rule via margin.ts). */
const AMBER_THRESHOLDS = (amber: number): number[] => [0, amber]

export interface TimelineProps {
  model: TimelineModel
  clock: ClockDriver
  ticker?: DockTicker
  /** config/hud.yaml margin_amber_min (default: margin.ts FIELD_LAYER.amberMin = the same value) */
  amberMin?: number
}

export function Timeline({ model, clock, ticker, amberMin }: TimelineProps) {
  const tNow = useSignalValue(clock.s.t)
  const playing = useSignalValue(clock.s.playing)
  const speed = useSignalValue(clock.s.speed)
  const tMax = useSignalValue(clock.s.tMax)
  const track = useRef<HTMLDivElement>(null)
  const drag = useRef<number | null>(null)
  const sc = chartScales(model)
  const P = (v: number) => pct(Math.min(Math.max(v, 0), tMax), 0, tMax)

  const play = () => {
    clock.toggle()
    if (clock.playing) ticker?.start()
  }
  const seekAt = (clientX: number) => {
    const r = track.current?.getBoundingClientRect?.()
    if (!r || !(r.width > 0)) return
    clock.seek(((clientX - r.left) / r.width) * clock.tMax)
  }
  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1
    let to: number | null = null
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') to = clock.t - step
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') to = clock.t + step
    else if (e.key === 'PageDown') to = clock.t - 10
    else if (e.key === 'PageUp') to = clock.t + 10
    else if (e.key === 'Home') to = 0
    else if (e.key === 'End') to = clock.tMax
    else if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault()
      e.stopPropagation()
      play()
      return
    } else return
    e.preventDefault()
    e.stopPropagation()
    clock.seek(to)
  }

  const row = rowAt(model, tNow)
  const tb = nextTurnBack(model, tNow)
  const dwell = dwellAt(model, tNow)
  const amber = amberMin ?? FIELD_LAYER.amberMin
  const cls = (v: number) => marginClass(v, amber)
  const pts: Pt[] = model.curve.map((r) => [r.t, r.margin as number])
  const runs = splitByClass(pts, AMBER_THRESHOLDS(amber), cls)
  const storm = model.storm
  const stormT0 = storm ? Math.max(0, storm.onset ?? storm.tripwire) : 0
  const stormT1 = storm ? Math.min(tMax, storm.end ?? tMax) : 0
  const valueText = `${fmtEva(tNow)} EVA`

  return (
    <div class={cx('hl-tl', playing && 'is-playing', drag.current !== null && 'is-scrubbing')} data-state={drag.current !== null ? 'scrubbing' : playing ? 'playing' : 'paused'}>
      <div class="hl-tl__controls">
        <div class="hl-tl__transport">
          <IconButton
            class="hl-tl__play"
            icon={playing ? 'pause' : 'play'}
            label={t(playing ? 'buttons.pause' : 'buttons.play')}
            pressed={playing}
            aria-keyshortcuts="Space"
            onClick={play}
            onKeyDown={(e: KeyboardEvent) => {
              // the native button click toggles; keep the shell's Space shortcut from toggling it again
              if (e.key === ' ' || e.key === 'Enter') e.stopPropagation()
            }}
          />
          <Segmented
            label={t('buttons.speed', { factor: speed })}
            options={clock.speeds.map((s) => ({
              value: String(s),
              label: `${s}×`,
            }))}
            value={String(speed)}
            onChange={(v) => clock.setSpeed(Number(v))}
          />
        </div>
        <div class="hl-tl__clock">
          <span class="hl-tl__clocklabel">{t('timeline.evaTime')}</span>
          <span class="hl-tl__clockvalue">
            <span class="hl-tl__hhmm">{fmtEva(tNow)}</span>
            <DerivedNum v={+tNow.toFixed(1)} units="min" how="mission clock minute (scrubber position)" />
          </span>
          <TrustChip kind="simulated" />
        </div>
      </div>

      <div
        ref={track}
        class="hl-tl__track"
        role="slider"
        tabIndex={0}
        aria-label={t('timeline.title')}
        aria-valuemin={0}
        aria-valuemax={tMax}
        aria-valuenow={+tNow.toFixed(2)}
        aria-valuetext={valueText}
        aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Space Home End"
        onKeyDown={onKey}
        onPointerDown={(e: PointerEvent) => {
          drag.current = e.pointerId
          if (ticker) ticker.scrubbing = true
          ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
          seekAt(e.clientX)
        }}
        onPointerMove={(e: PointerEvent) => {
          if (drag.current === e.pointerId) seekAt(e.clientX)
        }}
        onPointerUp={(e: PointerEvent) => {
          if (drag.current !== e.pointerId) return
          drag.current = null
          if (ticker) ticker.scrubbing = false
          ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
        }}
        onPointerCancel={() => {
          drag.current = null
          if (ticker) ticker.scrubbing = false
        }}
      >
        {/* lane 1: event labels */}
        <div class="hl-tl__labels" aria-hidden="true">
          {model.dwells.map((d) => (
            <span key={`dl${d.i0}`} class={cx('hl-tl__dwelllabel', dwell === d && 'is-current')} style={{ left: `${P((d.t0 + d.t1) / 2)}%` }}>
              {d.station}
            </span>
          ))}
          {groupClose(model.turnBacks, tMax).map((g) => (
            <span key={`tb${g[0].i}`} class="hl-tl__turnbacklabel" style={{ left: `${P(g[0].t)}%` }} title={`${t('timeline.turnBack')} ${g.map((m) => m.station ?? '').join(' ')}`}>
              <Icon name="turn-back" />
              {g.map((m) => m.station).join(' ')}
            </span>
          ))}
        </div>

        {/* lane 2: the chart */}
        <div class="hl-tl__plot">
          {storm && stormT1 > stormT0 && (
            <div
              class="hl-tl__storm"
              data-t0={stormT0}
              data-t1={stormT1}
              style={{
                left: `${P(stormT0)}%`,
                width: `${P(stormT1) - P(stormT0)}%`,
              }}
            />
          )}
          {model.dwells.map((d) => (
            <div
              key={`d${d.i0}`}
              class={cx('hl-tl__dwell', dwell === d && 'is-current')}
              data-station={d.station}
              data-t0={d.t0}
              data-t1={d.t1}
              style={{ left: `${P(d.t0)}%`, width: `${P(d.t1) - P(d.t0)}%` }}
              role="img"
              aria-label={`${t('cards.station.dwell')} ${d.station}`}
            />
          ))}
          <svg class="hl-tl__chart" viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
            {runs.map((r, k) => (
              <path key={`a${k}`} class={`hl-tl__area hl-tl__area--${r.cls}`} d={areaPath(r.pts, sc.x, sc.y, Math.max(0, model.yMin))} />
            ))}
            {model.yMin < 0 && <line class="hl-tl__zero" x1={0} x2={CHART_W} y1={sc.y(0)} y2={sc.y(0)} vector-effect="non-scaling-stroke" />}
            {runs.map((r, k) => (
              <path key={`l${k}`} class={`hl-tl__line hl-tl__line--${r.cls}`} data-cls={r.cls} d={linePath(r.pts, sc.x, sc.y)} vector-effect="non-scaling-stroke" />
            ))}
          </svg>
          {model.curve.map((r) => (
            <span
              key={`v${r.i}`}
              class={`hl-tl__vertex hl-tl__vertex--${cls(r.margin as number)}`}
              data-t={r.t}
              data-margin={r.margin}
              style={{
                left: `${P(r.t)}%`,
                top: `${(sc.y(r.margin as number) / CHART_H) * 100}%`,
              }}
            />
          ))}
          {model.checkpoints.map((c) => (
            <span key={`c${c.i}`} class="hl-tl__checkpoint" data-t={c.t} style={{ left: `${P(c.t)}%` }} title={t('timeline.oxygenCheckpoint')} />
          ))}
          {model.turnBacks.map((m) => (
            <span
              key={`t${m.i}`}
              class="hl-tl__turnback"
              data-station={m.station ?? ''}
              data-t={m.t}
              style={{ left: `${P(m.t)}%` }}
              role="img"
              aria-label={`${t('timeline.turnBack')} ${m.station ?? ''}`}
            />
          ))}
          {storm && storm.tripwire <= tMax && (
            <span
              class="hl-tl__tripwire"
              data-t={storm.tripwire}
              style={{ left: `${P(storm.tripwire)}%` }}
              role="img"
              aria-label={t('timeline.tripwire')}
              title={`${t('timeline.tripwire')} · ${t('tags.hypotheticalTiming.label')}${storm.halfwidthLabel ? ` (${storm.halfwidthLabel})` : ''}`}
            >
              <Icon name="tripwire" />
            </span>
          )}
          {model.daylightEnd !== null && model.daylightEnd <= tMax && (
            <span class="hl-tl__daylight" data-t={model.daylightEnd} style={{ left: `${P(model.daylightEnd)}%` }} role="img" aria-label={t('timeline.daylightEnd')} />
          )}
          <span class="hl-tl__head" data-t={tNow} style={{ left: `${P(tNow)}%` }} aria-hidden="true" />
        </div>

        {/* lane 3: binding term of the margin (rows that agree are joined; a change between rows is a gap) */}
        <div class="hl-tl__binding" aria-hidden="true">
          {model.bindingRuns.map((b, k) => (
            <span
              key={`b${k}`}
              class="hl-tl__bindingrun"
              data-binding={b.binding}
              data-t0={b.t0}
              data-t1={b.t1}
              style={{
                left: `${P(b.t0)}%`,
                width: `${Math.max(0, P(b.t1) - P(b.t0))}%`,
              }}
            >
              {bindingText(b.binding)}
            </span>
          ))}
        </div>

        {/* lane 4: axis */}
        <div class="hl-tl__axis" aria-hidden="true">
          {stepTicks(0, tMax, AXIS_STEP_MIN).map((v) => (
            <span key={`x${v}`} class="hl-tl__tick" data-t={v} style={{ left: `${P(v)}%` }}>
              {v % 60 === 0 ? fmtEva(v) : ''}
            </span>
          ))}
        </div>
      </div>

      <div class="hl-tl__side">
        <div class="hl-tl__events">
          {storm && (
            <span class="hl-tl__event">
              <Icon name="radiation" />
              {t('timeline.stormWindow')}
              <Tag kind="hypotheticalTiming" />
              <TrustChip kind="simulated" />
            </span>
          )}
          {model.daylightEnd !== null && (
            <span class="hl-tl__event" data-beyond={model.daylightEnd > tMax ? 'true' : undefined}>
              <Icon name="sun" />
              {t('timeline.daylightEnd')} <Num v={model.daylightEnd} file="conditions/clock.json" k="clock.eva.t_dark_min" units="min" />
              {model.daylightEnd > tMax && <Icon name="chevron-right" />}
              <TrustChip
                kind="modelled"
                prov={{
                  key: 'clock.eva.t_dark_min',
                  file: 'conditions/clock.json',
                  value: model.daylightEnd,
                }}
                align="end"
              />
            </span>
          )}
        </div>
        <div class="hl-tl__readouts">
          <Readout
            label={row?.binding ? `${t('glossary.margin')} · ${bindingText(row.binding)}` : t('glossary.margin')}
            v={row?.margin ?? null}
            file={model.file}
            k={row ? `timeline.${model.scenario}.${row.i}.margin_min` : undefined}
            units="min"
            chip="modelled"
            tone={row && row.margin !== null ? cls(row.margin) : undefined}
          />
          {tb && (
            <Readout label={`${t('timeline.turnBack')} ${tb.station ?? ''}`} icon="turn-back" v={tb.t} file={model.file} k={`timeline.${model.scenario}.${tb.i}.t_min`} units="min" chip="modelled" />
          )}
        </div>
      </div>
    </div>
  )
}

const bindingText = (b: Binding): string => t(BINDING_COPY[b])

/** Labels closer than this share of the axis are merged into one (turn-backs at 344–349 min). */
const MERGE_FRAC = 0.03
/** Group time-sorted markers whose labels would overlap; positions are not changed, only labels merged. */
function groupClose<M extends { t: number }>(ms: readonly M[], tMax: number): M[][] {
  const out: M[][] = []
  for (const m of [...ms].sort((a, b) => a.t - b.t)) {
    const g = out[out.length - 1]
    if (g && m.t - g[0].t <= MERGE_FRAC * tMax) g.push(m)
    else out.push([m])
  }
  return out
}
