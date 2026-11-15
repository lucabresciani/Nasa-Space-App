// Form controls (DESIGN §3.7): segmented control and mode switch, toggle, slider (shows its value and
// unit), select, tabs. States: default, hover, focus-visible, disabled. Keyboard: arrow keys move
// within segmented controls and tabs (roving tabindex); everything else is a native control.
import { useId, useRef } from 'preact/hooks'
import { formatValue } from '../../prov/provenance'
import type { Mode } from '../../state/ui'
import { MODES } from '../../state/ui'
import { t } from '../copy'
import { cx, Icon, type ForcedState, type IconName } from './Icon'

export interface Option<T extends string> {
  value: T
  label: string
  icon?: IconName
  disabled?: boolean
}

/** Next enabled index from `from` in direction `dir`, wrapping; -1 when none. */
function step(items: { disabled?: boolean }[], from: number, dir: 1 | -1): number {
  for (let i = 1; i <= items.length; i++) {
    const j = (from + dir * i + items.length) % items.length
    if (!items[j].disabled) return j
  }
  return -1
}
const DIR: Record<string, 1 | -1> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }

function useRoving<T extends string>(items: { value: T; disabled?: boolean }[], onChange: (v: T) => void) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKeyDown = (i: number) => (e: KeyboardEvent) => {
    const dir = DIR[e.key]
    let j = dir ? step(items, i, dir) : e.key === 'Home' ? step(items, -1, 1) : e.key === 'End' ? step(items, items.length, -1) : -1
    if (j < 0) return
    e.preventDefault()
    onChange(items[j].value)
    refs.current[j]?.focus()
  }
  return { refs, onKeyDown }
}

export interface SegmentedProps<T extends string> {
  label: string
  options: Option<T>[]
  value: T
  onChange: (v: T) => void
  disabled?: boolean
  force?: ForcedState
  /** 'mode' = the larger top-bar mode switch. */
  size?: 'default' | 'mode'
}

export function Segmented<T extends string>({ label, options, value, onChange, disabled, force, size = 'default' }: SegmentedProps<T>) {
  const items = options.map((o) => ({ ...o, disabled: disabled || o.disabled }))
  const { refs, onKeyDown } = useRoving(items, onChange)
  const checkedIdx = Math.max(0, items.findIndex((o) => o.value === value))
  return (
    <div class={cx('hl-seg', size === 'mode' && 'hl-seg--mode')} role="radiogroup" aria-label={label} aria-disabled={disabled ? 'true' : undefined}>
      {items.map((o, i) => (
        <button
          type="button"
          role="radio"
          ref={(el) => void (refs.current[i] = el)}
          class="hl-seg__item"
          aria-checked={o.value === value ? 'true' : 'false'}
          tabIndex={i === checkedIdx ? 0 : -1}
          disabled={o.disabled}
          data-force={i === checkedIdx ? force : undefined}
          onClick={() => onChange(o.value)}
          onKeyDown={onKeyDown(i)}
        >
          {o.icon && <Icon name={o.icon} />}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  )
}

const MODE_ICON: Record<Mode, IconName> = { plan: 'map', fly: 'compass', report: 'file-text', evidence: 'shield-check' }

/** The four-mode switch of the top bar (DESIGN §4.1), labels from copy.json. */
export function ModeSwitch({ value, onChange, force }: { value: Mode; onChange: (m: Mode) => void; force?: ForcedState }) {
  const options = MODES.map((m) => ({ value: m, label: t(`modes.${m}.label`), icon: MODE_ICON[m] }))
  return <Segmented label={t('nav.modesMenu')} options={options} value={value} onChange={onChange} force={force} size="mode" />
}

export interface ToggleProps {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  force?: ForcedState
}

export function Toggle({ label, checked, onChange, disabled, force }: ToggleProps) {
  return (
    <button type="button" role="switch" class="hl-toggle" aria-checked={checked ? 'true' : 'false'} disabled={disabled} data-force={force} onClick={() => onChange(!checked)}>
      <span class="hl-toggle__label">{label}</span>
      <span class="hl-toggle__track" aria-hidden="true">
        <span class="hl-toggle__thumb" />
      </span>
    </button>
  )
}

export interface SliderProps {
  label: string
  min: number
  max: number
  step: number
  value: number
  /** Unit shown next to the value (formatValue unit names, e.g. 'min', 'mGy'). */
  units: string
  onChange: (v: number) => void
  disabled?: boolean
  force?: ForcedState
}

export function Slider({ label, min, max, step: st, value, units, onChange, disabled, force }: SliderProps) {
  const id = useId()
  const text = formatValue(value, units)
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0
  return (
    <div class={cx('hl-slider', disabled && 'is-disabled')}>
      <div class="hl-slider__head">
        <label for={id}>{label}</label>
        <output class="hl-slider__value" for={id}>
          {text}
        </output>
      </div>
      <input
        id={id}
        type="range"
        class="hl-slider__input"
        min={min}
        max={max}
        step={st}
        value={value}
        aria-valuetext={text}
        disabled={disabled}
        data-force={force}
        style={{ '--fill': `${pct}%` }}
        onInput={(e) => onChange(Number((e.target as HTMLInputElement).value))}
      />
    </div>
  )
}

export interface SelectProps<T extends string> {
  label: string
  options: Option<T>[]
  value: T
  onChange: (v: T) => void
  disabled?: boolean
  force?: ForcedState
}

export function Select<T extends string>({ label, options, value, onChange, disabled, force }: SelectProps<T>) {
  const id = useId()
  return (
    <div class={cx('hl-select', disabled && 'is-disabled')}>
      <label for={id}>{label}</label>
      <span class="hl-select__box">
        <select id={id} value={value} disabled={disabled} data-force={force} onChange={(e) => onChange((e.target as HTMLSelectElement).value as T)}>
          {options.map((o) => (
            <option value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
        <Icon name="chevron-down" />
      </span>
    </div>
  )
}

export interface TabsProps<T extends string> {
  label: string
  tabs: { id: T; label: string; icon?: IconName; disabled?: boolean }[]
  value: T
  onChange: (v: T) => void
  force?: ForcedState
}

export function Tabs<T extends string>({ label, tabs, value, onChange, force }: TabsProps<T>) {
  const items = tabs.map((x) => ({ ...x, value: x.id }))
  const { refs, onKeyDown } = useRoving(items, onChange)
  return (
    <div class="hl-tabs" role="tablist" aria-label={label}>
      {items.map((x, i) => (
        <button
          type="button"
          role="tab"
          ref={(el) => void (refs.current[i] = el)}
          class="hl-tabs__tab"
          aria-selected={x.id === value ? 'true' : 'false'}
          tabIndex={x.id === value ? 0 : -1}
          disabled={x.disabled}
          data-force={x.id === value ? force : undefined}
          onClick={() => onChange(x.id)}
          onKeyDown={onKeyDown(i)}
        >
          {x.icon && <Icon name={x.icon} />}
          {x.label}
        </button>
      ))}
    </div>
  )
}
