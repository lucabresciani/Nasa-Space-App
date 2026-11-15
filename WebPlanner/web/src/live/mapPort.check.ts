// Compile-time only (tsc --noEmit): the real ConsoleMap fits the adapter's ConsoleMapLike, so the
// wiring consoleMapPort(cmap) type-checks. Type-only import: nothing from src/map/ reaches the bundle.
import type { ConsoleMap } from '../map/consoleMap'
import { consoleMapPort, type ConsoleMapLike, type MapPort } from './mapPort'

export type ConsoleMapFits = ConsoleMap extends ConsoleMapLike ? true : never
export const consoleMapFits: ConsoleMapFits = true
export const wireConsoleMap: (cm: ConsoleMap) => MapPort = (cm) => consoleMapPort(cm)
