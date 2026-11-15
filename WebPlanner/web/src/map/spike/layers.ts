// WS16 M1 spike: the two rendering paths for the GPU field layer.
//   A) customLayer(): CustomLayerInterface drawing in MapLibre's own WebGL2 context (flat map).
//   B) CanvasPath: off-screen WebGL2 canvas at field resolution -> MapLibre canvas source
//      (drapes on terrain; costs one texture upload per update). DESIGN U2 implementation 6-7.
import { MercatorCoordinate, type CanvasSource, type CustomLayerInterface, type Map as MlMap } from 'maplibre-gl'
import { FieldProgram, VS_CANVAS, VS_MAP, type FieldTextures, type FieldUniforms } from './shader'

export type Bounds = [number, number, number, number] // w, s, e, n (outer pixel edges)

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

/** M * translate(ox, oy, 0), column-major, computed in float64 before the float32 upload. */
export function translated(m: ArrayLike<number>, ox: number, oy: number): Float32Array {
  const r = Float32Array.from(m as ArrayLike<number>)
  for (let i = 0; i < 4; i++) r[12 + i] = m[i] * ox + m[4 + i] * oy + m[12 + i]
  return r
}

export interface PathStats {
  /** field draws (custom layer: map frames that drew the field; canvas: off-screen renders) */
  draws: number
  /** canvas path: texture uploads handed to MapLibre */
  uploads: number
  /** CPU ms spent issuing the last draw (GPU time is not measurable here) */
  lastCpuMs: number
}

export interface FieldPath {
  readonly kind: 'custom' | 'canvas'
  readonly label: string
  readonly stats: PathStats
  /** New uniforms; `playing` lets the canvas path drop to half resolution. */
  update(un: FieldUniforms, playing: boolean): void
  remove(): void
}

/** Path A: custom WebGL2 layer in the map context. */
export function addCustomLayer(map: MlMap, bounds: Bounds, ft: FieldTextures, initial: FieldUniforms, beforeId?: string): FieldPath {
  const mesh = gridMesh(bounds)
  let prog: FieldProgram | null = null
  let un = initial
  const stats: PathStats = { draws: 0, uploads: 0, lastCpuMs: 0 }
  const layer: CustomLayerInterface = {
    id: 'spike-field',
    type: 'custom',
    renderingMode: '2d',
    onAdd(_m, gl) {
      prog = new FieldProgram(gl as WebGL2RenderingContext, VS_MAP, ft)
      prog.setVertices(mesh.verts)
    },
    render(gl, opts) {
      if (!prog) return
      const t0 = performance.now()
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      prog.draw({ ...un, pxScale: 1 / devicePixelRatio }, translated(opts.modelViewProjectionMatrix, mesh.origin[0], mesh.origin[1]))
      stats.draws++
      stats.lastCpuMs = performance.now() - t0
    },
    onRemove() {
      prog?.dispose()
      prog = null
    },
  }
  map.addLayer(layer, beforeId)
  return {
    kind: 'custom',
    label: 'custom WebGL2 layer (map context, 2D)',
    stats,
    update(next) {
      un = next
      map.triggerRepaint()
    },
    remove() {
      if (map.getLayer(layer.id)) map.removeLayer(layer.id)
    },
  }
}

/** Path B: off-screen WebGL2 canvas at field resolution, handed to the map as a canvas source. */
export function addCanvasPath(map: MlMap, bounds: Bounds, ft: FieldTextures, initial: FieldUniforms, halfResAbovePx: number, beforeId?: string): FieldPath {
  const canvas = document.createElement('canvas')
  const [fw, fh] = ft.size
  canvas.width = fw
  canvas.height = fh
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false })
  if (!gl) throw new Error('WebGL2 unavailable for the off-screen field canvas')
  const prog = new FieldProgram(gl, VS_CANVAS, ft)
  // clip-space quad; canvas top row = north = v 0
  prog.setVertices(new Float32Array([-1, 1, 0, 0, 1, 1, 1, 0, -1, -1, 0, 1, 1, -1, 1, 1]))
  const stats: PathStats = { draws: 0, uploads: 0, lastCpuMs: 0 }
  const [w, s, e, n] = bounds
  map.addSource('spike-field', {
    type: 'canvas',
    canvas,
    animate: false, // uploads only when we pulse play()/pause() below, never every map frame
    coordinates: [
      [w, n],
      [e, n],
      [e, s],
      [w, s],
    ],
  })
  map.addLayer({ id: 'spike-field', type: 'raster', source: 'spike-field', paint: { 'raster-fade-duration': 0, 'raster-resampling': 'linear' } }, beforeId)

  const draw = (un: FieldUniforms, playing: boolean): void => {
    const t0 = performance.now()
    const half = playing && Math.max(fw, fh) > halfResAbovePx
    const cw = half ? Math.ceil(fw / 2) : fw
    const ch = half ? Math.ceil(fh / 2) : fh
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw
      canvas.height = ch
    }
    gl.viewport(0, 0, cw, ch)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.disable(gl.BLEND)
    // hatch period in grid px (screen-space is impossible here: the canvas is resampled by the map)
    prog.draw({ ...un, pxScale: fw / cw }, undefined)
    stats.draws++
    const src = map.getSource('spike-field') as CanvasSource | undefined
    if (src && typeof src.play === 'function') {
      // play() + pause() = exactly one texture upload (pause() runs prepare() while playing)
      src.play()
      src.pause()
      stats.uploads++
    }
    stats.lastCpuMs = performance.now() - t0
  }
  map.once('idle', () => draw(initial, false))
  draw(initial, false)

  return {
    kind: 'canvas',
    label: `canvas source (off-screen WebGL2 ${fw}x${fh}, half above ${halfResAbovePx}px while playing)`,
    stats,
    update(next, playing) {
      draw(next, playing)
    },
    remove() {
      if (map.getLayer('spike-field')) map.removeLayer('spike-field')
      if (map.getSource('spike-field')) map.removeSource('spike-field')
      prog.dispose()
    },
  }
}
