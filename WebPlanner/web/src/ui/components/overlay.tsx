// Tooltip and popover (DESIGN §3.7: keyboard reachable). The tooltip opens on hover and on keyboard
// focus of its trigger and closes on Escape; the popover is a button-controlled non-modal dialog that
// closes on Escape (focus returns to its button) and on a pointer press outside.
import { cloneElement, isValidElement, type ButtonHTMLAttributes, type ComponentChildren, type VNode } from 'preact'
import { useEffect, useId, useRef, useState } from 'preact/hooks'
import { cx, type ForcedState } from './Icon'

export interface TooltipProps {
  text: string
  /** One element (button, link, chip) that receives aria-describedby. */
  children: VNode
  /** Forced open (style guide). */
  open?: boolean
  placement?: 'top' | 'bottom'
}

export function Tooltip({ text, children, open: forced, placement = 'top' }: TooltipProps) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const shown = forced || open
  const child = isValidElement(children) && shown ? cloneElement(children, { 'aria-describedby': id }) : children
  return (
    <span
      class="hl-tooltip-wrap"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocusIn={() => setOpen(true)}
      onFocusOut={() => setOpen(false)}
      onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
    >
      {child}
      {shown && (
        <span role="tooltip" id={id} class={cx('hl-tooltip', `hl-tooltip--${placement}`)}>
          {text}
        </span>
      )}
    </span>
  )
}

export interface PopoverProps {
  /** Content of the trigger button. */
  label: ComponentChildren
  /** Dialog title (also its accessible name). */
  title?: string
  children: ComponentChildren
  /** Initially open (style guide). */
  open?: boolean
  /** Classes and attributes for the trigger button (e.g. the trust chip). */
  buttonClass?: string
  buttonProps?: ButtonHTMLAttributes<HTMLButtonElement>
  force?: ForcedState
  align?: 'start' | 'end'
}

export function Popover({ label, title, children, open: initial = false, buttonClass = 'hl-btn hl-btn--secondary', buttonProps, force, align = 'start' }: PopoverProps) {
  const [open, setOpen] = useState(initial)
  const id = useId()
  const wrap = useRef<HTMLSpanElement>(null)
  const btn = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: Event) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const close = () => {
    setOpen(false)
    btn.current?.focus()
  }
  return (
    <span class="hl-popover-wrap" ref={wrap}>
      <button
        type="button"
        {...buttonProps}
        ref={btn}
        class={buttonClass}
        aria-expanded={open ? 'true' : 'false'}
        aria-controls={open ? id : undefined}
        aria-haspopup="dialog"
        data-force={force}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => open && e.key === 'Escape' && (e.preventDefault(), close())}
      >
        {label}
      </button>
      {open && (
        <div
          role="dialog"
          id={id}
          class={cx('hl-popover', `hl-popover--${align}`)}
          aria-label={title}
          onKeyDown={(e) => e.key === 'Escape' && (e.preventDefault(), e.stopPropagation(), close())}
        >
          {title && <div class="hl-popover__title">{title}</div>}
          {children}
        </div>
      )}
    </span>
  )
}
