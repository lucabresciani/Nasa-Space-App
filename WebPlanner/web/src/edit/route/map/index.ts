// WP6 (D97): free waypoints on the map for the Edit-route panel (R5). Entry used by the live mount
// (live/route/mount.tsx, a lazy chunk behind VITE_LIVE): with VITE_LIVE off nothing here is in the
// static bundle (map.test.ts walks the static module graph).
import { Marker } from 'maplibre-gl'
import type { RouteController } from '../controller'
import { disposeEditor, editorOf } from './editor'
import { attachWaypointMap, type WaypointConsoleMap } from './layer'

export { editorOf, type WaypointEditor } from './editor'

/** Is this console map a real one (MapLibre map with events and a container)? Fakes in tests are not. */
function isWaypointMap(cm: unknown): cm is WaypointConsoleMap {
  const m = (cm as { map?: Record<string, unknown> } | null)?.map
  return !!m && typeof m.on === 'function' && typeof m.off === 'function' && typeof m.getContainer === 'function' && typeof (cm as { whenReady?: unknown }).whenReady === 'function'
}

/** Markers, click-to-add and the ghost route of `ctl` on the console map. Returns the disposer. */
export function installWaypointMap(ctl: RouteController, cmap: unknown): () => void {
  const ed = editorOf(ctl)
  const detach = isWaypointMap(cmap) ? attachWaypointMap(ed, cmap, { makeMarker: (el) => new Marker({ element: el, draggable: true }) }) : () => {}
  return () => {
    detach()
    disposeEditor(ctl)
  }
}
