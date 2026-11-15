// Test helper: render a Preact VNode tree of hook-free function components to an HTML-like string
// (vitest runs in node, no DOM; the live views are pure functions of their props).
import { Fragment, type VNode } from 'preact'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function toHtml(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return esc(String(node))
  if (Array.isArray(node)) return node.map(toHtml).join('')
  const v = node as VNode<Record<string, unknown>>
  const { children, ...props } = (v.props ?? {}) as Record<string, unknown>
  if (v.type === Fragment) return toHtml(children)
  if (typeof v.type === 'function') return toHtml((v.type as (p: unknown) => unknown)(v.props))
  const attrs = Object.entries(props)
    .filter(([k, val]) => !k.startsWith('on') && val !== undefined && val !== null && val !== false && k !== 'key')
    .map(([k, val]) => (val === true ? ` ${k}` : ` ${k}="${esc(String(val))}"`))
    .join('')
  return `<${String(v.type)}${attrs}>${toHtml(children)}</${String(v.type)}>`
}

/** Visible text only (tags stripped, whitespace collapsed). */
export function textOf(node: unknown): string {
  return toHtml(node)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}
