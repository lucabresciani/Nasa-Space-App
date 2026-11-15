// WS16 task 2 (M2): the GPU field layer, bands mode, as a MapLibre custom WebGL2 layer drawing in
// the map's own context (M1 decision proposal: custom layer for 2D and tilt without terrain; the
// canvas-source path for terrain comes with U1). Lazy: loaded by the planning map with import().
import { MercatorCoordinate, type CustomLayerInterface, type Map as MlMap } from 'maplibre-gl'
import tokens from '../../ui/tokens.json'
import { FIELD_LAYER, VARIANTS, type Variant } from './constants'
import { gridXform, hexToRgb01, type Bounds, type DecodedGrid, type FieldData } from './decode'
import { shaderScalars, type MarginInputs } from './margin'
import { BandsProgram, type BandsUniforms, type FieldTextureData } from './shader'

export const FIELD_LAYER_ID = 'field-bands'

/** Strips in latitude so the linear-in-lat grid stays exact under Mercator (x is linear in lon). */
const LAT_STRIPS = 64

/** Mercator mesh of the grid, relative to its NW corner (float32 precision at high zoom). */
export function gridMesh(b: Bounds): { origin: [number, number]; verts: Float32Array } {
  const [w, s, e, n] = b
  const o = MercatorCoordinate.fromLngLat([w, n])
  const out: number[] = []
  for (let i = 0; i <= LAT_STRIPS; i++) {
    const v = i / LAT_STRIPS
    const lat = n - v * (n - s)
    const pw = MercatorCoordinate.fromLngLat([w, lat])
    const pe = MercatorCoordinate.fromLngLat([e, lat])
    out.push(pw.x - o.x, pw.y - o.y, 0, v, pe.x - o.x, pe.y - o.y, 1, v)
  }
  return { origin: [o.x, o.y], verts: new Float32Array(out) }
}

/** M * translate(ox, oy, 0), column-major, in float64 before the float32 upload. */
function translated(m: ArrayLike<number>, ox: number, oy: number): Float32Array {
  const r = Float32Array.from(m)
  for (let i = 0; i < 4; i++) r[12 + i] = m[i] * ox + m[4 + i] * oy + m[12 + i]
  return r
}

/** Decoded grid -> the PNG's RGBA8 bytes again (R = counts >> 8, G = counts & 255, A = 255 / 0). */
function encode(g: DecodedGrid): Uint8Array {
  const out = new Uint8Array(g.width * g.height * 4)
  for (let i = 0, j = 0; i < g.counts.length; i++, j += 4) {
    if (!g.known[i]) continue
    out[j] = g.counts[i] >> 8
    out[j + 1] = g.counts[i] & 255
    out[j + 3] = 255
  }
  return out
}

export function textureData(fd: FieldData): FieldTextureData {
  const g = fd.t.nom
  return {
    size: [g.width, g.height],
    scale: g.scale,
    t: [encode(fd.t.opt), encode(fd.t.nom), encode(fd.t.con)],
    // o2_home must sit on the t_home grid (contract §1); otherwise margin mode draws nothing
    o2: fd.o2 && fd.o2.width === g.width && fd.o2.height === g.height ? { bytes: encode(fd.o2), scale: fd.o2.scale } : null,
    state: fd.state ? { code: fd.state.code, size: [fd.state.width, fd.state.height], xform: gridXform(fd.bounds, fd.state.bounds) } : null,
  }
}

export interface BandsParams {
  budget: number
  variant: Variant
  showBands: boolean
  showHatch: boolean
  /** Margin mode inputs at the clock minute (M3); null = bands mode. */
  margin: MarginInputs | null
  /** Collapse (M4): k, cross-fade pair and the pad in grid metres; null = the real field (k = 1). */
  collapse: { k: number; kFrom: number; xfade: number; pad: [number, number] } | null
}

export interface FieldLayerHandle {
  readonly id: string
  update(p: Partial<BandsParams>): void
  setData(fd: FieldData): void
  remove(): void
}

/**
 * Add the bands-mode field layer below `beforeId`. `onError` is called once if WebGL2 or the
 * shader is unavailable; the caller then shows the polygon bands (fallback, DESIGN U2 item 8).
 */
export function addFieldLayer(map: MlMap, fd: FieldData, initial: BandsParams, beforeId: string | undefined, onError: (e: unknown) => void): FieldLayerHandle {
  let mesh = gridMesh(fd.bounds)
  let cell = fd.resM
  let pending: FieldData | null = fd
  let prog: BandsProgram | null = null
  let failed = false
  let params = { ...initial }
  const c = tokens.color
  const fail = (e: unknown): void => {
    if (failed) return
    failed = true
    prog?.dispose()
    prog = null
    onError(e)
  }
  const layer: CustomLayerInterface = {
    id: FIELD_LAYER_ID,
    type: 'custom',
    renderingMode: '2d',
    onAdd(_m, gl) {
      try {
        if (typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) throw new Error('the map context is not WebGL2')
        prog = new BandsProgram(gl)
      } catch (e) {
        fail(e)
      }
    },
    render(gl, opts) {
      if (!prog || failed) return
      try {
        if (pending) {
          prog.setTextures(textureData(pending))
          cell = pending.resM
          mesh = gridMesh(pending.bounds)
          prog.setVertices(mesh.verts)
          pending = null
        }
        if (!params.showBands && !params.showHatch) return
        const un: BandsUniforms = {
          budget: params.budget,
          variant: VARIANTS.indexOf(params.variant) as 0 | 1 | 2,
          showBands: params.showBands,
          showHatch: params.showHatch,
          hatchPx: FIELD_LAYER.hatchPx,
          dpr: devicePixelRatio || 1,
          lineHalfPx: tokens.line.fieldEdgePx / 2,
          colors: { safe: hexToRgb01(c.safe), unknown: hexToRgb01(c.unknown) },
          opacity: [tokens.overlayOpacity.min, tokens.overlayOpacity.max],
          collapse: params.collapse && cell !== null ? { ...params.collapse, cell, flatSpeed: FIELD_LAYER.flatSpeedMs } : null,
          margin: params.margin
            ? { ...shaderScalars(params.margin), amber: FIELD_LAYER.amberMin, caution: hexToRgb01(c.caution), limit: hexToRgb01(c.limit) }
            : null,
        }
        // A flat overlay: MapLibre may leave depth/stencil tests on for custom layers (it marks its
        // GL state dirty after a custom render, so nothing needs restoring here).
        gl.disable(gl.DEPTH_TEST)
        gl.disable(gl.STENCIL_TEST)
        gl.disable(gl.CULL_FACE)
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        // mercator 0..1 -> clip (MapLibre 6: modelViewProjectionMatrix is in world pixels, not 0..1)
        prog.draw(un, translated(opts.defaultProjectionData.mainMatrix, mesh.origin[0], mesh.origin[1]))
      } catch (e) {
        fail(e)
      }
    },
    onRemove() {
      prog?.dispose()
      prog = null
    },
  }
  map.addLayer(layer, beforeId && map.getLayer(beforeId) ? beforeId : undefined)
  return {
    id: FIELD_LAYER_ID,
    update(p) {
      params = { ...params, ...p }
      map.triggerRepaint()
    },
    setData(next) {
      pending = next
      map.triggerRepaint()
    },
    remove() {
      if (map.getLayer(FIELD_LAYER_ID)) map.removeLayer(FIELD_LAYER_ID)
    },
  }
}
