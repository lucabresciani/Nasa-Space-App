import type { Route } from '../router'

/** A page: renders into `el`, may return a cleanup function. */
export type View = (el: HTMLElement, route: Route) => void | (() => void) | Promise<void | (() => void)>
