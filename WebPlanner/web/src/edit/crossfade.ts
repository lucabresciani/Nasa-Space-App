// Homeline cross-fade for drag-the-rover (U15 "their homelines cross-fade"). The planning map draws
// the new pad's precomputed homeline itself (the console switches its files); this module lays the
// previous homeline over it as an afterimage that fades out over tokens.motion.dataMs, so the eye
// reads one homeline turning into the other. Reduced motion: no afterimage, the swap is instant.
// The afterimage is the previous pad's precomputed bands (already in the loader cache), never a
// computed shape.
import type { FilterSpecification, Map as MlMap } from 'maplibre-gl'
import type { BandsFC } from '../data/types'
import { TOKENS } from '../ui/tokens'

export const XFADE_ID = 'hl-edit-xfade'

/** Cross-fade length (ms): the data-change motion token; 0 under reduced motion. */
export function crossfadeMs(reduced: boolean): number {
  return reduced ? 0 : TOKENS.motion.dataMs[1]
}

/** Afterimage opacity at `t` ms into a fade of `ms` (1 → 0, linear; ends at 0 at once when ms = 0). */
export function afterimageOpacity(t: number, ms: number, start: number = TOKENS.overlayOpacity.max): number {
  if (ms <= 0) return 0
  return start * Math.max(0, 1 - t / ms)
}

/** The bands of one budget and variant (what the map shows for that plan). */
export function bandFilter(budget: number, variant: string): FilterSpecification {
  return ['all', ['==', ['get', 'budget'], budget], ['==', ['get', 'variant'], variant]] as unknown as FilterSpecification
}

export type MapLike = Pick<MlMap, 'addSource' | 'addLayer' | 'getLayer' | 'getSource' | 'removeLayer' | 'removeSource' | 'setPaintProperty'>

/**
 * Lay `from` (the previous plan's bands) over the map and fade it out. Returns a cancel function.
 * With ms = 0 (reduced motion) nothing is added.
 */
export function crossfadeFrom(map: MapLike, from: BandsFC | null, budget: number, variant: string, ms: number, raf: (cb: () => void) => unknown = requestAnimationFrame, setT: typeof setTimeout = setTimeout): () => void {
  clear(map)
  if (!from || ms <= 0) return () => clear(map)
  map.addSource(XFADE_ID, { type: 'geojson', data: from })
  map.addLayer({
    id: XFADE_ID,
    type: 'fill',
    source: XFADE_ID,
    filter: bandFilter(budget, variant),
    paint: { 'fill-color': TOKENS.color.safe, 'fill-opacity': afterimageOpacity(0, ms), 'fill-opacity-transition': { duration: ms, delay: 0 } },
  })
  let done = false
  raf(() => {
    if (!done && map.getLayer(XFADE_ID)) map.setPaintProperty(XFADE_ID, 'fill-opacity', 0)
  })
  const timer = setT(() => {
    done = true
    clear(map)
  }, ms + TOKENS.motion.hoverMs[1])
  return () => {
    done = true
    clearTimeout(timer as unknown as number)
    clear(map)
  }
}

function clear(map: MapLike): void {
  if (map.getLayer(XFADE_ID)) map.removeLayer(XFADE_ID)
  if (map.getSource(XFADE_ID)) map.removeSource(XFADE_ID)
}
