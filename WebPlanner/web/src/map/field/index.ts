// WS16 task 2 (M2): public API of the GPU field layer (DESIGN U2 bands mode, §6.4).
//   fieldAt(lon, lat)  -> T_home (opt/nom/con), O2 home, cell state, unknown flag (WS15, WS18)
//   loadFieldData(kg)  -> decoded inputs for one suit mass (shared with the GPU layer)
//   loadFieldLayer()   -> lazy import of the shader + MapLibre custom layer
// This module is small and has no GL code; the shader chunk loads only through loadFieldLayer().
import { FIELD_QUERY_KEY } from './constants'
export { FIELD_LAYER, FIELD_QUERY_KEY, VARIANTS, VARIANT_OF, type CellState, type Variant } from './constants'
export { activeField, bandClass, FieldData, fieldAt, onFieldChange, setActiveField, type BandClass, type FieldSample } from './decode'
export { loadFieldData } from './load'
export { BINDING_LABEL, marginAt, marginClass, resolveMarginInputs, type Binding, type FieldClass, type MarginInputs } from './margin'
export { driveMargin, fieldModeQuery, loadFlownPlan, type MarginState } from './drive'
export { zeroEdgeLabels, type EdgeLabel } from './edgeLabels'
export {
  collapseBandClass,
  collapseFade,
  collapseFrame,
  collapseHeadline,
  collapseQuery,
  collapseT,
  COLLAPSE_MS,
  currentCollapse,
  easeInOut,
  flatMinutes,
  flatRadiusM,
  padGridMetres,
  playCollapse,
  resetCollapse,
  setCollapse,
  type CollapseFrame,
  type CollapseHeadline,
  type PlayOptions,
} from './collapse'

export const loadFieldLayer = () => import('./layer')

/**
 * Trust-chip hook (DESIGN §3.6): the homeline layer group is ◐ Modelled. The planning map sets
 * these data attributes on its container; the trust chip component (A2) attaches to them.
 */
export const FIELD_TRUST = {
  chip: 'modelled',
  attr: 'data-trust-bands',
  sourceAttr: 'data-trust-bands-source',
  renderAttr: 'data-bands-render', // 'gpu' | 'polygons'
} as const

/** False when the URL asks for the polygon bands (`?field=off`, in the search or the hash query). */
export function fieldRequested(search: string, hash: string): boolean {
  const q = new URLSearchParams(search)
  const h = hash.split('?')[1]
  if (h) new URLSearchParams(h).forEach((v, k) => q.set(k, v))
  const v = q.get(FIELD_QUERY_KEY)
  return !(v === 'off' || v === '0' || v === 'polygons')
}

/** WebGL2 exists in this browser (the map context itself is checked again when the layer is added). */
export function webgl2Available(): boolean {
  return typeof WebGL2RenderingContext !== 'undefined'
}
