// WS16 task 11 (M11, U7): overlays public API. ConsoleMap calls installOverlays once the style is
// loaded; inside the shell the layer manager goes into the left rail (A4 registerRailSection).
import { h } from 'preact'
import { registerRailSection } from '../../ui/shell/store'
import { LayerPanel } from './LayerPanel'
import { OverlayLayers, type OverlayDeps, type OverlayMap } from './layers'

export { OVERLAYS, overlayById, type OverlayId } from './catalog'
export { overlayOn, overlayOpacity, resetOverlays, setOverlay, setOverlayOpacity } from './state'
export { OverlayLayers, layerIds } from './layers'

export const LAYERS_RAIL_ID = 'layers'

export function installOverlays(map: OverlayMap, deps: OverlayDeps, inShell: boolean): () => void {
  const layers = new OverlayLayers(map, deps)
  const off = inShell ? registerRailSection({ id: LAYERS_RAIL_ID, modes: ['plan'], title: 'nav.rail.layers', icon: 'layers', render: () => h(LayerPanel, {}) }) : () => {}
  return () => {
    off()
    layers.destroy()
  }
}
