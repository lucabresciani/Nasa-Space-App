// WS16 task 8 (M8): the 3D part of U1, loaded with import() only when 3D is turned on (DESIGN §5.4
// lazy loading). Adds the terrain raster-dem source + setTerrain, a separate raster-dem source for the
// relief-shading (hillshade) layer, unlocks tilt and rotation, and drapes the U2 field layer.
//
// Field drape: MapLibre 6.18's experimental CustomLayerInterface.renderToTerrainTile. While terrain
// is on, the field layer's implementation gets a renderToTerrainTile that calls its own render() with
// a matrix mapping Mercator 0..1 onto the terrain tile's clip space (SW = (-1, -1), NE = (1, 1)), so
// the field is drawn into the same per-tile textures as the basemap and the fill/line layers and stays
// registered with the ground at every tilt. terrainTileRevision is bumped on every field update so the
// draped tiles redraw. Chosen over M1's canvas-source proposal: no 8.8 MB re-upload per update, the
// same shader and params in 2D and 3D (DESIGN: "2D and 3D pictures are identical"), and nothing to
// keep in step. RR must check it (experimental API); on a GL error the field layer's own fallback
// (polygons, which drape natively) takes over.
import type { CustomLayerInterface, Map as MlMap } from 'maplibre-gl'
import { TOKENS } from '../../ui/tokens'
import { TERRAIN } from './config'
import { DEM_SOURCE, demSource, type TerrainTiles } from './tiles'

export const RELIEF_LAYER_ID = 'relief-shading'

export interface TerrainHandle {
  /** terrain on (3D) or off (flat; the relief shading stays) */
  setTerrainOn(on: boolean, opts: { animate: boolean }): void
  setExaggeration(x: number): void
  /** relief light direction, deg clockwise from north; null = MapLibre's default light */
  setLightAzimuth(az: number | null): void
  /** drape the custom field layer (by id) while terrain is on; call again after it is (re)added */
  drapeField(layerId: string): void
  remove(): void
}

/** Mercator 0..1 -> terrain tile clip space for tile (z, x, y), column-major (CustomTerrainRenderInput). */
export function tileClipMatrix(z: number, x: number, y: number): Float64Array {
  const s = 2 ** (z + 1)
  // clip x = 2 (mx 2^z − x) − 1 ; clip y = 1 − 2 (my 2^z − y)   (north up)
  return Float64Array.from([s, 0, 0, 0, 0, -s, 0, 0, 0, 0, 1, 0, -2 * x - 1, 2 * y + 1, 0, 1])
}

type Drapeable = CustomLayerInterface & { terrainTileRevision?: number }

export function addTerrain(map: MlMap, tj: TerrainTiles, prefix: (p: string) => string, beforeId: string | undefined, initial: { exaggeration: number; azimuth: number | null }): TerrainHandle {
  const c = TOKENS.color
  if (!map.getSource(DEM_SOURCE.terrain)) map.addSource(DEM_SOURCE.terrain, demSource(tj, prefix))
  if (!map.getSource(DEM_SOURCE.relief)) map.addSource(DEM_SOURCE.relief, demSource(tj, prefix))
  if (!map.getLayer(RELIEF_LAYER_ID)) {
    map.addLayer(
      {
        id: RELIEF_LAYER_ID,
        type: 'hillshade',
        source: DEM_SOURCE.relief,
        paint: {
          'hillshade-illumination-anchor': 'map',
          ...(initial.azimuth !== null ? { 'hillshade-illumination-direction': initial.azimuth } : {}),
          'hillshade-shadow-color': c.shadow,
          'hillshade-highlight-color': c.light,
          'hillshade-accent-color': c.shadow,
        },
      },
      beforeId && map.getLayer(beforeId) ? beforeId : undefined,
    )
  }
  let exag = initial.exaggeration
  let on = false
  let draped: { id: string; impl: Drapeable } | null = null

  const drape = (): void => {
    if (!draped) return
    const { impl } = draped
    if (on && !impl.renderToTerrainTile) {
      impl.renderToTerrainTile = (gl, o) => {
        const m = tileClipMatrix(o.tileID.canonical.z, o.tileID.canonical.x, o.tileID.canonical.y)
        // the field layer's render() reads only defaultProjectionData.mainMatrix
        impl.render(gl, { defaultProjectionData: { mainMatrix: m } } as unknown as Parameters<CustomLayerInterface['render']>[1])
      }
      impl.terrainTileRevision = (impl.terrainTileRevision ?? 0) + 1
    } else if (!on && impl.renderToTerrainTile) {
      delete impl.renderToTerrainTile
    }
    map.triggerRepaint()
  }

  const handle: TerrainHandle = {
    setTerrainOn(next, { animate }) {
      on = next
      if (next) {
        map.setTerrain({ source: DEM_SOURCE.terrain, exaggeration: exag })
        map.setMaxPitch(TERRAIN.maxPitch3d)
        map.dragRotate.enable()
        map.touchZoomRotate.enableRotation()
        map.keyboard.enable()
      } else {
        map.setTerrain(null)
        map.dragRotate.disable()
        map.touchZoomRotate.disableRotation()
      }
      drape()
      const target = next ? { pitch: TERRAIN.pitch3d } : { pitch: 0, bearing: 0 }
      // reduced motion: no camera animation (DESIGN §3.5)
      if (animate) map.easeTo({ ...target, duration: TOKENS.motion.cameraMs[0] })
      else map.jumpTo(target)
      if (!next) {
        // maxPitch 0 once the camera is flat again (2D, as before M8)
        if (animate) map.once('moveend', () => !on && map.setMaxPitch(0))
        else map.setMaxPitch(0)
      }
    },
    setExaggeration(x) {
      exag = x
      if (on) map.setTerrain({ source: DEM_SOURCE.terrain, exaggeration: x })
    },
    setLightAzimuth(az) {
      if (!map.getLayer(RELIEF_LAYER_ID)) return
      map.setPaintProperty(RELIEF_LAYER_ID, 'hillshade-illumination-direction', az ?? undefined)
    },
    drapeField(layerId) {
      const l = map.getLayer(layerId) as unknown as { implementation?: Drapeable } | undefined
      const impl = l?.implementation
      if (!impl) return
      if (draped && draped.impl !== impl) delete draped.impl.renderToTerrainTile
      draped = { id: layerId, impl }
      drape()
    },
    remove() {
      on = false
      drape()
      map.setTerrain(null)
      if (map.getLayer(RELIEF_LAYER_ID)) map.removeLayer(RELIEF_LAYER_ID)
      for (const id of Object.values(DEM_SOURCE)) if (map.getSource(id)) map.removeSource(id)
    },
  }
  return handle
}

/** Bump the drape revision of a field layer so MapLibre redraws its terrain tiles (field update). */
export function bumpDrape(map: MlMap, layerId: string): void {
  const impl = (map.getLayer(layerId) as unknown as { implementation?: Drapeable } | undefined)?.implementation
  if (impl?.renderToTerrainTile) impl.terrainTileRevision = (impl.terrainTileRevision ?? 0) + 1
}
