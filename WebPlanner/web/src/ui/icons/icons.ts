// Icon sprite access (DESIGN §3.5, D73). Every icon is a <symbol id="i-NAME"> in sprite.svg,
// drawn with currentColor, so an icon takes the text colour of its parent.
//
//   import { iconSvg } from '../ui/icons/icons'
//   el.innerHTML = iconSvg('play', { label: 'Play' })   // or { label: undefined } = decorative
//
// sprite.svg is fetched once as a separate asset (Vite ?url), not inlined in JS.
import spriteUrl from './sprite.svg?url'
import { ICON_NAMES, type IconName } from './names.gen'

export { ICON_NAMES, type IconName }

/** URL of one symbol, for <use href="…">. */
export function iconHref(name: IconName): string {
  return `${spriteUrl}#i-${name}`
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/**
 * SVG markup for one icon. With a label the icon is announced (role="img" + aria-label);
 * without one it is decorative (aria-hidden). Size comes from CSS (class "icon"), not from here.
 */
export function iconSvg(name: IconName, opts: { label?: string; className?: string } = {}): string {
  const cls = ['icon', `icon-${name}`, opts.className].filter(Boolean).join(' ')
  const a11y = opts.label ? `role="img" aria-label="${escapeAttr(opts.label)}"` : 'aria-hidden="true" focusable="false"'
  return `<svg class="${escapeAttr(cls)}" ${a11y}><use href="${iconHref(name)}"></use></svg>`
}
