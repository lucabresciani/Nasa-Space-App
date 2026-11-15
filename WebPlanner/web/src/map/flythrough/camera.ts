// WS16 task 10 (M10): a camera pose (path.ts) on the MapLibre map. Mars lon/lat are drawn on an
// Earth-sized map (D4), so one true metre is ELEVATION_FACTOR map metres horizontally; heights are
// scaled by the same factor (and by the exaggeration while terrain is on), so the angles on screen are
// the true ones (DESIGN U1 item 2). MapLibre solves zoom from the camera point and the look-at point.
import { LngLat, type Map as MlMap } from 'maplibre-gl'
import { cameraOffset, type CameraPose, type Metric } from './path'

/** Metres per degree on the Mars sphere at a latitude (config/site.yaml crs.mars_radius_m). */
export function marsMetric(lat: number, radiusM: number): Metric {
  const mPerDegLat = (radiusM * Math.PI) / 180
  return { mPerDegLat, mPerDegLon: mPerDegLat * Math.cos((lat * Math.PI) / 180) }
}

export interface PoseScale {
  /** scale.elevation_factor */
  factor: number
  /** terrain exaggeration in effect (1 when terrain is off) */
  exaggeration: number
  /** config/site.yaml crs.mars_radius_m */
  radiusM: number
}

/** Move the map camera to a pose at once (no easing: the director owns time). */
export function jumpToPose(map: MlMap, pose: CameraPose, s: PoseScale): void {
  const metric = marsMetric(pose.target[1], s.radiusM)
  const { cam } = cameraOffset(pose, metric)
  const to = new LngLat(pose.target[0], pose.target[1])
  const terrainOn = !!map.getTerrain()
  const groundAlt = terrainOn ? (map.queryTerrainElevation(to) ?? 0) : 0
  const camAlt = groundAlt + pose.altM * s.factor * (terrainOn ? s.exaggeration : 1)
  // from directly above, MapLibre has no direction: nudge the camera 1 cm along the bearing
  const from = cam[0] === pose.target[0] && cam[1] === pose.target[1] ? new LngLat(cam[0] - 1e-9 * Math.sin((pose.bearing * Math.PI) / 180), cam[1] - 1e-9 * Math.cos((pose.bearing * Math.PI) / 180)) : new LngLat(cam[0], cam[1])
  const opt = map.calculateCameraOptionsFromTo(from, camAlt, to, groundAlt)
  map.jumpTo({
    center: to,
    ...(Number.isFinite(opt.zoom) ? { zoom: opt.zoom } : {}),
    bearing: pose.bearing,
    pitch: Math.min(pose.pitch, map.getMaxPitch()),
  })
}
