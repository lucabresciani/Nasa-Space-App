// WS16 M1 spike: the field shader (WebGL2), shared by both rendering paths.
// - custom layer: draws a lat-strip mesh of the field grid in the map's own GL context
// - canvas path: draws a full-screen quad into an off-screen WebGL2 canvas at field resolution,
//   which MapLibre uploads as a canvas source.
// CPU mirror + tests: decode.ts. DESIGN U2 (decode, manual bilinear, colouring), §6.4 uniforms.

export const VS_MAP = `#version 300 es
uniform mat4 u_matrix;
in vec2 a_pos;   // mercator offset from the grid's NW corner
in vec2 a_uv;    // grid uv, v = 0 north
out vec2 v_uv;
void main() { v_uv = a_uv; gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0); }`

export const VS_CANVAS = `#version 300 es
in vec2 a_pos;   // clip space quad
in vec2 a_uv;
out vec2 v_uv;
void main() { v_uv = a_uv; gl_Position = vec4(a_pos, 0.0, 1.0); }`

export const FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_t0; // t_home optimistic  (RGBA8, NEAREST)
uniform sampler2D u_t1; // t_home nominal
uniform sampler2D u_t2; // t_home conservative
uniform sampler2D u_state; // cell state, own grid (A = 0 unknown)
uniform vec2 u_size;      // field grid px
uniform vec2 u_stateSize; // state grid px
uniform vec4 u_stateXf;   // state uv = xy + field uv * zw
uniform float u_scale;    // min per count
uniform float u_budget, u_t, u_tEva, u_amber;
uniform float u_mode;     // 0 bands, 1 margin
uniform float u_variant;  // 0 opt, 1 nom, 2 con
uniform float u_unknownSrc; // 0 cell state, 1 t_home A = 0 (debug)
uniform float u_hatchPx, u_pxScale, u_lineHalfPx;
uniform vec3 u_safe, u_caution, u_limit, u_unknown;
uniform vec2 u_opacity;   // tokens overlayOpacity min, max
in vec2 v_uv;
out vec4 o;

float decode(sampler2D s, ivec2 p, out bool known) {
  vec4 c = texelFetch(s, p, 0);
  known = c.a > 0.5;
  return floor(c.r * 255.0 + 0.5) * 256.0 + floor(c.g * 255.0 + 0.5);
}
// Manual bilinear on decoded values; -1 if any neighbour is unknown.
float field(sampler2D s, vec2 uv) {
  vec2 p = uv * u_size - 0.5;
  vec2 i0 = floor(p);
  vec2 f = p - i0;
  ivec2 mx = ivec2(u_size) - 1;
  ivec2 a = ivec2(i0);
  bool k0, k1, k2, k3;
  float v0 = decode(s, clamp(a, ivec2(0), mx), k0);
  float v1 = decode(s, clamp(a + ivec2(1, 0), ivec2(0), mx), k1);
  float v2 = decode(s, clamp(a + ivec2(0, 1), ivec2(0), mx), k2);
  float v3 = decode(s, clamp(a + ivec2(1, 1), ivec2(0), mx), k3);
  if (!(k0 && k1 && k2 && k3)) return -1.0;
  return mix(mix(v0, v1, f.x), mix(v2, v3, f.x), f.y) * u_scale;
}
void main() {
  // Every sample and derivative first (derivatives must be in uniform control flow).
  float to = field(u_t0, v_uv);
  float tn = field(u_t1, v_uv);
  float tc = field(u_t2, v_uv);
  float tv = u_variant < 0.5 ? to : (u_variant < 1.5 ? tn : tc);
  float m = u_tEva - u_t - tv;
  float wN = max(fwidth(tn), 1e-6);
  float wV = max(fwidth(tv), 1e-6);
  bool inside = all(greaterThanEqual(v_uv, vec2(0.0))) && all(lessThanEqual(v_uv, vec2(1.0)));

  vec2 suv = u_stateXf.xy + v_uv * u_stateXf.zw;
  ivec2 sp = clamp(ivec2(floor(suv * u_stateSize)), ivec2(0), ivec2(u_stateSize) - 1);
  bool stateIn = all(greaterThanEqual(suv, vec2(0.0))) && all(lessThan(suv, vec2(1.0)));
  bool unknownTerrain = u_unknownSrc < 0.5 ? (!stateIn || texelFetch(u_state, sp, 0).a < 0.5) : (tv < 0.0);

  vec4 col = vec4(0.0);
  if (!inside) {
    col = vec4(0.0);
  } else if (unknownTerrain) {
    // Grey hatch (never a warning colour). Screen space in the custom layer; grid space in the
    // canvas path (u_pxScale converts).
    vec2 q = gl_FragCoord.xy * u_pxScale;
    float h = mod(q.x + q.y, u_hatchPx);
    float line = 1.0 - smoothstep(1.0, 2.0, h);
    col = vec4(u_unknown, u_opacity.y * line);
  } else if (u_mode < 0.5) {
    float a = 0.0;
    if (to >= 0.0 && to <= u_budget) a = u_opacity.x;
    if (tn >= 0.0 && tn <= u_budget) a = 0.5 * (u_opacity.x + u_opacity.y);
    if (tc >= 0.0 && tc <= u_budget) a = u_opacity.y;
    col = vec4(u_safe, a);
    // nominal edge: constant-width line from screen-space derivatives
    if (tn >= 0.0 && abs(tn - u_budget) / wN < u_lineHalfPx) col = vec4(u_safe, 1.0);
  } else if (tv >= 0.0) {
    vec3 c = m < 0.0 ? u_limit : (m < u_amber ? u_caution : u_safe);
    col = vec4(c, 0.5 * (u_opacity.x + u_opacity.y));
    if (abs(m) / wV < u_lineHalfPx) col = vec4(u_limit, 1.0);
  }
  o = vec4(col.rgb * col.a, col.a); // premultiplied
}`

export interface FieldTextures {
  size: [number, number]
  scale: number
  t: [Uint8Array | Uint8ClampedArray, Uint8Array | Uint8ClampedArray, Uint8Array | Uint8ClampedArray]
  state: { rgba: Uint8Array | Uint8ClampedArray; size: [number, number]; xform: [number, number, number, number] }
}

export interface FieldUniforms {
  mode: 0 | 1
  variant: 0 | 1 | 2
  unknownSrc: 0 | 1
  budget: number
  t: number
  tEva: number
  amber: number
  hatchPx: number
  /** gl_FragCoord -> hatch px (1 / devicePixelRatio for the map; grid scale for the canvas path). */
  pxScale: number
  lineHalfPx: number
  colors: { safe: [number, number, number]; caution: [number, number, number]; limit: [number, number, number]; unknown: [number, number, number] }
  opacity: [number, number]
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`)
  return s
}

/** Upload an RGBA byte grid as an RGBA8 NEAREST texture (no premultiply, no colour conversion). */
function uploadRGBA(gl: WebGL2RenderingContext, rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): WebGLTexture {
  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, tex)
  // The map shares this context: save and restore the unpack state it may rely on.
  const prev = [gl.getParameter(gl.UNPACK_ALIGNMENT), gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL), gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL), gl.getParameter(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL)]
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength))
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, prev[0])
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, prev[1])
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, prev[2])
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, prev[3])
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return tex
}

/** Program + textures + one vertex buffer; `draw` binds everything it uses. */
export class FieldProgram {
  readonly prog: WebGLProgram
  private readonly tex: WebGLTexture[]
  private readonly buf: WebGLBuffer
  private readonly vao: WebGLVertexArrayObject
  private readonly loc = new Map<string, WebGLUniformLocation | null>()
  private readonly ft: FieldTextures
  vertexCount = 0
  readonly gl: WebGL2RenderingContext

  constructor(gl: WebGL2RenderingContext, vs: string, ft: FieldTextures) {
    this.gl = gl
    this.ft = ft
    const p = gl.createProgram()!
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs))
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FS))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(p)}`)
    this.prog = p
    const [w, h] = ft.size
    this.tex = [...ft.t.map((d) => uploadRGBA(gl, d, w, h)), uploadRGBA(gl, ft.state.rgba, ft.state.size[0], ft.state.size[1])]
    this.buf = gl.createBuffer()!
    this.vao = gl.createVertexArray()!
  }

  /** Interleaved [x, y, u, v] triangle-strip vertices. */
  setVertices(data: Float32Array): void {
    const gl = this.gl
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(this.prog, 'a_pos')
    const aUv = gl.getAttribLocation(this.prog, 'a_uv')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(aUv)
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8)
    gl.bindVertexArray(null)
    this.vertexCount = data.length / 4
  }

  private u(name: string): WebGLUniformLocation | null {
    if (!this.loc.has(name)) this.loc.set(name, this.gl.getUniformLocation(this.prog, name))
    return this.loc.get(name)!
  }

  draw(un: FieldUniforms, matrix?: Float32Array): void {
    const gl = this.gl
    gl.useProgram(this.prog)
    ;['u_t0', 'u_t1', 'u_t2', 'u_state'].forEach((name, i) => {
      gl.activeTexture(gl.TEXTURE0 + i)
      gl.bindTexture(gl.TEXTURE_2D, this.tex[i])
      gl.uniform1i(this.u(name), i)
    })
    if (matrix) gl.uniformMatrix4fv(this.u('u_matrix'), false, matrix)
    gl.uniform2f(this.u('u_size'), this.ft.size[0], this.ft.size[1])
    gl.uniform2f(this.u('u_stateSize'), this.ft.state.size[0], this.ft.state.size[1])
    gl.uniform4fv(this.u('u_stateXf'), this.ft.state.xform)
    gl.uniform1f(this.u('u_scale'), this.ft.scale)
    gl.uniform1f(this.u('u_budget'), un.budget)
    gl.uniform1f(this.u('u_t'), un.t)
    gl.uniform1f(this.u('u_tEva'), un.tEva)
    gl.uniform1f(this.u('u_amber'), un.amber)
    gl.uniform1f(this.u('u_mode'), un.mode)
    gl.uniform1f(this.u('u_variant'), un.variant)
    gl.uniform1f(this.u('u_unknownSrc'), un.unknownSrc)
    gl.uniform1f(this.u('u_hatchPx'), un.hatchPx)
    gl.uniform1f(this.u('u_pxScale'), un.pxScale)
    gl.uniform1f(this.u('u_lineHalfPx'), un.lineHalfPx)
    gl.uniform3fv(this.u('u_safe'), un.colors.safe)
    gl.uniform3fv(this.u('u_caution'), un.colors.caution)
    gl.uniform3fv(this.u('u_limit'), un.colors.limit)
    gl.uniform3fv(this.u('u_unknown'), un.colors.unknown)
    gl.uniform2f(this.u('u_opacity'), un.opacity[0], un.opacity[1])
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, this.vertexCount)
    gl.bindVertexArray(null)
  }

  dispose(): void {
    const gl = this.gl
    this.tex.forEach((t) => gl.deleteTexture(t))
    gl.deleteBuffer(this.buf)
    gl.deleteVertexArray(this.vao)
    gl.deleteProgram(this.prog)
  }
}
