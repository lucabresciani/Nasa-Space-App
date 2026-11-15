// Preact wrapper around the A1 icon sprite (DESIGN §3.5). With a label the icon is announced;
// without one it is decorative. Size and colour come from CSS (.icon, currentColor).
import { iconHref, type IconName } from '../icons/icons'

export type { IconName }

/** Forced interaction state, for /styleguide only (real pointer and focus states still apply). */
export type ForcedState = 'hover' | 'focus' | 'active'

export function Icon({ name, label, class: cls }: { name: IconName; label?: string; class?: string }) {
  const c = ['icon', `icon-${name}`, cls].filter(Boolean).join(' ')
  return label ? (
    <svg class={c} role="img" aria-label={label}>
      <use href={iconHref(name)} />
    </svg>
  ) : (
    <svg class={c} aria-hidden="true" focusable="false">
      <use href={iconHref(name)} />
    </svg>
  )
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}
