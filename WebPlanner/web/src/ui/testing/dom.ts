// Minimal DOM for rendering Preact components in vitest (environment 'node', no jsdom in the repo and
// no new dependency allowed). It implements only what Preact 11 touches (createElementNS, text nodes,
// attributes, style, listeners, insertBefore/removeChild) plus small query helpers for tests.
// Not shipped: only *.test.tsx files import it.

type Listener = (e: FakeEvent) => void

export interface FakeEvent {
  type: string
  key?: string
  target: FakeNode | null
  currentTarget: FakeNode | null
  defaultPrevented: boolean
  bubbles: boolean
  preventDefault(): void
  stopPropagation(): void
  [k: string]: unknown
}

export class FakeNode {
  nodeType: number
  localName = ''
  nodeName = ''
  namespaceURI: string | null = null
  parentNode: FakeNode | null = null
  childNodes: FakeNode[] = []
  ownerDocument: FakeDocument | null = null
  data = ''
  attrs = new Map<string, string>()
  style: Record<string, string> & { setProperty(k: string, v: string): void; cssText: string }
  private listeners = new Map<string, Set<Listener>>()

  constructor(nodeType: number, name = '') {
    this.nodeType = nodeType
    this.localName = name
    this.nodeName = name.toUpperCase()
    const style = { cssText: '' } as FakeNode['style']
    Object.defineProperty(style, 'setProperty', { value: (k: string, v: string) => (style[k] = v), enumerable: false })
    this.style = style
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null
  }
  get nextSibling(): FakeNode | null {
    const p = this.parentNode
    if (!p) return null
    return p.childNodes[p.childNodes.indexOf(this) + 1] ?? null
  }
  get attributes(): { name: string; value: string }[] {
    return [...this.attrs].map(([name, value]) => ({ name, value }))
  }
  get textContent(): string {
    return this.nodeType === 3 ? this.data : this.childNodes.map((c) => c.textContent).join('')
  }
  set textContent(v: string) {
    if (this.nodeType === 3) this.data = v
    else this.childNodes.forEach((c) => (c.parentNode = null)), (this.childNodes = [])
  }

  /** HTML attribute names are case-insensitive (tabIndex = tabindex); SVG ones are not. */
  private an(k: string): string {
    return this.namespaceURI === 'http://www.w3.org/2000/svg' ? k : k.toLowerCase()
  }
  setAttribute(k: string, v: unknown): void {
    this.attrs.set(this.an(k), String(v))
  }
  getAttribute(k: string): string | null {
    return this.attrs.has(this.an(k)) ? this.attrs.get(this.an(k))! : null
  }
  hasAttribute(k: string): boolean {
    return this.attrs.has(this.an(k))
  }
  removeAttribute(k: string): void {
    this.attrs.delete(this.an(k))
  }

  insertBefore(n: FakeNode, ref: FakeNode | null): FakeNode {
    if (n.parentNode) n.parentNode.removeChild(n)
    n.parentNode = this
    const i = ref ? this.childNodes.indexOf(ref) : -1
    if (i < 0) this.childNodes.push(n)
    else this.childNodes.splice(i, 0, n)
    return n
  }
  appendChild(n: FakeNode): FakeNode {
    return this.insertBefore(n, null)
  }
  removeChild(n: FakeNode): FakeNode {
    const i = this.childNodes.indexOf(n)
    if (i >= 0) this.childNodes.splice(i, 1)
    n.parentNode = null
    return n
  }
  remove(): void {
    this.parentNode?.removeChild(this)
  }
  contains(n: FakeNode | null): boolean {
    for (let c: FakeNode | null = n; c; c = c.parentNode) if (c === this) return true
    return false
  }
  focus(): void {
    if (this.ownerDocument) this.ownerDocument.activeElement = this
  }

  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(fn)
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn)
  }
  /** Dispatch with bubbling through parentNode (and the document). */
  dispatch(type: string, init: Record<string, unknown> = {}): FakeEvent {
    let stopped = false
    const e: FakeEvent = {
      type,
      target: this,
      currentTarget: null,
      defaultPrevented: false,
      bubbles: true,
      preventDefault() {
        e.defaultPrevented = true
      },
      stopPropagation() {
        stopped = true
      },
      ...init,
    }
    for (let n: FakeNode | null = this; n && !stopped; n = n.parentNode ?? (n === this.ownerDocument?.body ? this.ownerDocument : null)) {
      e.currentTarget = n
      for (const fn of [...(n.listeners.get(type) ?? [])]) fn.call(n, e)
      if (n instanceof FakeDocument) break
    }
    return e
  }
}

export class FakeDocument extends FakeNode {
  body: FakeNode
  activeElement: FakeNode | null = null
  constructor() {
    super(9, '#document')
    this.body = this.createElementNS(null, 'body')
  }
  createElementNS(ns: string | null, name: string): FakeNode {
    const n = new FakeNode(1, name)
    n.namespaceURI = ns
    n.ownerDocument = this
    return n
  }
  createElement(name: string): FakeNode {
    return this.createElementNS('http://www.w3.org/1999/xhtml', name)
  }
  createTextNode(text: string): FakeNode {
    const n = new FakeNode(3, '#text')
    n.data = String(text)
    n.ownerDocument = this
    return n
  }
}

/** Install a fresh fake document as globalThis.document; returns a container in its body. */
export function installDom(): { document: FakeDocument; container: FakeNode } {
  const document = new FakeDocument()
  ;(globalThis as Record<string, unknown>).document = document
  const container = document.createElement('div')
  document.body.appendChild(container)
  return { document, container }
}

export function all(root: FakeNode, pred: (n: FakeNode) => boolean): FakeNode[] {
  const out: FakeNode[] = []
  const walk = (n: FakeNode) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 1 && pred(c)) out.push(c)
      walk(c)
    }
  }
  walk(root)
  return out
}

export const hasClass = (n: FakeNode, c: string): boolean => (n.getAttribute('class') ?? '').split(/\s+/).includes(c)
export const byClass = (root: FakeNode, c: string): FakeNode[] => all(root, (n) => hasClass(n, c))
export const byRole = (root: FakeNode, r: string): FakeNode[] => all(root, (n) => n.getAttribute('role') === r)
export const byTag = (root: FakeNode, tag: string): FakeNode[] => all(root, (n) => n.localName === tag)
export function one(list: FakeNode[], what = 'element'): FakeNode {
  if (list.length !== 1) throw new Error(`expected one ${what}, found ${list.length}`)
  return list[0]
}
