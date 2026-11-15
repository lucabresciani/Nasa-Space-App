// WS16 task 2 (M2) + task 3 (M3): the field shader, bands mode and margin mode (DESIGN U2 implementation 2-4, §6.4). Lazy: only
// layer.ts imports it, and the planning map loads layer.ts with a dynamic import.
// CPU mirror + tests: decode.ts (decode, manual bilinear, band classification).
//
// Per fragment: fetch the four neighbours of each t_home texture with texelFetch (nearest; encoded
// bytes are never filtered), decode R*256 + G, interpolate the decoded counts bilinearly; any
// neighbour with A = 0 -> no value (-1). Cell state (own grid, nearest) decides the hatch:
// unknown terrain = grey hatch only, never a band or warning colour. Known terrain without a
// value (no route home) stays unfilled.
// Second cues (DESIGN §3.1): conservative = densest fill, nominal edge solid, optimistic edge
// dashed; the conservative edge is drawn (solid) only when it is the selected variant.

export const VS = `#version 300 es
uniform mat4 u_matrix;
in vec2 a_pos;   // mercator offset from the grid's NW corner
in vec2 a_uv;    // grid uv, v = 0 north
out vec2 v_uv;
void main() { v_uv = a_uv; gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0); }`

export const FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_t0;    // t_home optimistic   (RGBA8, NEAREST)
uniform sampler2D u_t1;    // t_home nominal
uniform sampler2D u_t2;    // t_home conservative
uniform sampler2D u_state; // cell-state code (R8: 0 assessed, 1 blocked, 2 unknown), own grid
uniform vec2 u_size;       // field grid px
uniform vec2 u_stateSize;  // state grid px
uniform vec4 u_stateXf;    // state uv = xy + field uv * zw
uniform float u_hasState;  // 0: no cell-state grid published -> no hatch from this layer
uniform float u_scale;     // min per count
uniform float u_budget;    // 30 or 60
uniform float u_variant;   // selected: 0 opt, 1 nom, 2 con
uniform float u_showBands, u_showHatch;
uniform float u_hatchPx;   // CSS px
uniform float u_dpr;       // device px per CSS px
uniform float u_lineHalfPx; // CSS px
uniform vec3 u_safe, u_unknown;
// ---- margin mode (M3, DESIGN U2 "Margin per pixel"; CPU mirror: margin.ts marginAt) ----
uniform float u_mode;      // 0 bands, 1 margin
uniform sampler2D u_o2;    // o2_home nominal (RGBA8, NEAREST)
uniform float u_o2Scale;   // L per count
uniform float u_hasO2;     // 0: no o2_home published -> margin mode draws nothing (none)
uniform float u_t, u_o2Left, u_reserve, u_o2Tasks, u_o2Rate, u_tDark, u_tauDose, u_tEva; // min, L, L/min
uniform float u_amber;     // min (hud.yaml margin_amber_min)
uniform vec3 u_caution, u_limit;
uniform vec2 u_opacity;    // tokens overlayOpacity min, max
// ---- collapse (M4, DESIGN U3; CPU mirror: collapseMath.ts collapseT / collapseBandClass) ----
uniform float u_k;         // 0 flat circle .. 1 real field (exact M2/M3 picture)
uniform float u_kFrom;     // reduced motion: picture cross-faded from
uniform float u_xfade;     // weight of the u_k picture (1 = no cross-fade)
uniform vec2 u_pad;        // pad, grid metres (x east of W edge, y south of N edge)
uniform float u_cell;      // m per field px (fields/index.json res_m)
uniform float u_flatSpeed; // m/s (D25)
uniform float u_hasPad;    // 0: no pad / res_m -> no collapse (T = T_home)
in vec2 v_uv;
out vec4 o;

// Per-fragment values shared by shade() (set once in main, before any branch).
float g_to, g_tn, g_tc, g_oh, g_flat;
vec2 g_sO, g_sN, g_sC, g_sH, g_sFlat, g_q;
bool g_inside, g_unknown;

float decode(sampler2D s, ivec2 p, out bool known) {
  vec4 c = texelFetch(s, p, 0);
  known = c.a > 0.5;
  return floor(c.r * 255.0 + 0.5) * 256.0 + floor(c.g * 255.0 + 0.5);
}
// Manual bilinear on decoded values; -1 if any of the four neighbours has no value.
// g = analytic gradient (value per grid pixel), 0 where there is no value.
float fieldS(sampler2D s, vec2 uv, float scale, out vec2 g) {
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
  g = vec2(0.0);
  if (!(k0 && k1 && k2 && k3)) return -1.0;
  g = vec2(mix(v1 - v0, v3 - v2, f.y), mix(v2 - v0, v3 - v1, f.x)) * scale;
  return mix(mix(v0, v1, f.x), mix(v2, v3, f.x), f.y) * scale;
}
float field(sampler2D s, vec2 uv, out vec2 g) { return fieldS(s, uv, u_scale, g); }
// Screen-space gradient (per device px) from the grid gradient g and the grid-px derivatives J.
vec2 screenGrad(vec2 g, vec2 jx, vec2 jy) { return vec2(dot(g, jx), dot(g, jy)); }
// Coverage of a constant-width screen-space line where t crosses the budget (antialiased 1 px ramp).
// The width uses the analytic gradient, never fwidth(t): t jumps to -1 next to cells without a
// value, and fwidth would draw false lines there.
float edge(float t, vec2 sg) {
  if (t < 0.0) return 0.0;
  float w = max(abs(sg.x) + abs(sg.y), 1e-6);
  float d = abs(t - u_budget) / w; // device px from the contour
  return clamp(u_lineHalfPx * u_dpr + 0.5 - d, 0.0, 1.0);
}
// T at collapse k with its screen gradient (contract §3.1): mix(flat, T_home, k), exact at k = 0 and
// k = 1; no T_home value (-1) counts as infinite time: flat / (1 - k), gone at k = 1.
float blendT(float th, vec2 sth, float k, out vec2 sg) {
  if (k >= 1.0 || u_hasPad < 0.5) { sg = sth; return th; }
  if (k <= 0.0) { sg = g_sFlat; return g_flat; }
  if (th < 0.0) { float w = 1.0 / (1.0 - k); sg = g_sFlat * w; return g_flat * w; }
  sg = g_sFlat + (sth - g_sFlat) * k;
  return g_flat + (th - g_flat) * k;
}
// Dash mask along a contour (tangent from its screen-space gradient), period u_hatchPx.
float dashMask(vec2 sg) {
  vec2 tang = normalize(vec2(-sg.y, sg.x) + 1e-9);
  return step(mod(dot(g_q, tang), u_hatchPx), 0.5 * u_hatchPx);
}
// The picture at collapse k, premultiplied.
vec4 shade(float k) {
  if (!g_inside) return vec4(0.0);
  bool collapsing = u_hasPad > 0.5 && k < 1.0;
  vec4 hatch = vec4(0.0);
  if (g_unknown && u_showHatch > 0.5) {
    // grey diagonal hatch in screen space (never a warning colour)
    float h = mod(g_q.x + g_q.y, u_hatchPx);
    float line = 1.0 - smoothstep(1.0, 2.0, h);
    hatch = vec4(u_unknown * u_opacity.y * line, u_opacity.y * line);
  }
  if (g_unknown && !collapsing) return hatch;
  vec4 col = vec4(0.0);
  if (u_mode > 0.5) {
    if (u_showBands > 0.5 && u_hasO2 > 0.5) {
      // T(x) of the selected variant, collapsed by k, and O2_home(x), both manual bilinear
      float th = g_to; vec2 sth = g_sO;
      if (u_variant > 0.5) { th = g_tn; sth = g_sN; }
      if (u_variant > 1.5) { th = g_tc; sth = g_sC; }
      if (th >= 0.0 && g_oh >= 0.0) {
        vec2 sT;
        float T = blendT(th, sth, k, sT);
        // WS2 margin(): terms in the order O2, daylight, dose, EVA duration; ties -> first
        float m = (u_o2Left - u_o2Tasks - u_reserve - g_oh) / u_o2Rate;
        vec2 sm = -g_sH / u_o2Rate;
        float d = u_tDark - u_t - T;
        if (d < m) { m = d; sm = -sT; }
        d = u_tauDose - T;
        if (d < m) { m = d; sm = -sT; }
        d = u_tEva - u_t - T;
        if (d < m) { m = d; sm = -sT; }
        vec3 c = u_safe; float a = u_opacity.x;
        if (m <= u_amber) { c = u_caution; a = 0.5 * (u_opacity.x + u_opacity.y); }
        if (m < 0.0) { c = u_limit; a = u_opacity.y; }
        col = vec4(c, a);
        // zero-margin edge: constant-width screen-space line from the analytic gradient
        float w = max(abs(sm.x) + abs(sm.y), 1e-6);
        float cov = clamp(u_lineHalfPx * u_dpr + 0.5 - abs(m) / w, 0.0, 1.0);
        col = mix(col, vec4(u_limit, 1.0), cov);
      }
    }
  } else if (u_showBands > 0.5) {
    vec2 sO, sN, sC;
    float to = blendT(g_to, g_sO, k, sO);
    float tn = blendT(g_tn, g_sN, k, sN);
    float tc = blendT(g_tc, g_sC, k, sC);
    float a = 0.0;
    if (to >= 0.0 && to <= u_budget) a = u_opacity.x;
    if (tn >= 0.0 && tn <= u_budget) a = 0.5 * (u_opacity.x + u_opacity.y);
    if (tc >= 0.0 && tc <= u_budget) a = u_opacity.y;
    col = vec4(u_safe, a);
    // optimistic edge dashed; nominal (and selected conservative) solid. During the collapse the
    // solid edges start dashed: k = 0 is NASA's dashed flat circle (DESIGN U3).
    float solid = collapsing ? mix(dashMask(sN), 1.0, max(k, 0.0)) : 1.0;
    float cov = edge(to, sO) * dashMask(sO);
    cov = max(cov, edge(tn, sN) * solid);
    if (u_variant > 1.5) cov = max(cov, edge(tc, sC) * (collapsing ? mix(dashMask(sC), 1.0, max(k, 0.0)) : 1.0));
    col = mix(col, vec4(u_safe, 1.0), cov);
  }
  vec4 pm = vec4(col.rgb * col.a, col.a); // premultiplied
  // unknown terrain while collapsing: NASA's flat world first, the hatch fades in with k
  if (g_unknown) pm = mix(pm, hatch, clamp(k, 0.0, 1.0));
  return pm;
}
void main() {
  // Derivatives first (uniform control flow): grid px per device px, smooth everywhere.
  vec2 gp = v_uv * u_size;
  vec2 jx = dFdx(gp);
  vec2 jy = dFdy(gp);
  vec2 gO, gN, gC, gH;
  g_to = field(u_t0, v_uv, gO);
  g_tn = field(u_t1, v_uv, gN);
  g_tc = field(u_t2, v_uv, gC);
  g_oh = fieldS(u_o2, v_uv, u_o2Scale, gH);
  g_sO = screenGrad(gO, jx, jy);
  g_sN = screenGrad(gN, jx, jy);
  g_sC = screenGrad(gC, jx, jy);
  g_sH = screenGrad(gH, jx, jy);
  // flat walk time (D25): grid-metre distance from the pad / speed, and its analytic gradient
  vec2 dm = gp * u_cell - u_pad;
  float dist = length(dm);
  g_flat = dist / u_flatSpeed / 60.0;
  g_sFlat = screenGrad(u_cell * dm / max(dist, 1e-6) / (u_flatSpeed * 60.0), jx, jy);
  g_inside = all(greaterThanEqual(v_uv, vec2(0.0))) && all(lessThanEqual(v_uv, vec2(1.0)));

  vec2 suv = u_stateXf.xy + v_uv * u_stateXf.zw;
  ivec2 sp = clamp(ivec2(floor(suv * u_stateSize)), ivec2(0), ivec2(u_stateSize) - 1);
  bool stateIn = all(greaterThanEqual(suv, vec2(0.0))) && all(lessThan(suv, vec2(1.0)));
  float code = floor(texelFetch(u_state, sp, 0).r * 255.0 + 0.5);
  g_unknown = u_hasState > 0.5 && (!stateIn || code > 1.5);
  g_q = gl_FragCoord.xy / u_dpr; // CSS px

  vec4 c = shade(u_k);
  // reduced motion (DESIGN §3.4): cross-fade two end pictures, never an intermediate k
  if (u_xfade < 1.0) c = mix(shade(u_kFrom), c, u_xfade);
  o = c;
}`

export interface FieldTextureData {
  size: [number, number]
  scale: number
  /** RGBA8 bytes of the three t_home grids (opt, nom, con), encoded as the PNGs. */
  t: [Uint8Array, Uint8Array, Uint8Array]
  /** o2_home nominal (RGBA8 bytes as the PNG) and its scale (L per count); null = not published. */
  o2: { bytes: Uint8Array; scale: number } | null
  /** Cell-state codes (one byte per cell); null = not published (no hatch from this layer). */
  state: { code: Uint8Array; size: [number, number]; xform: [number, number, number, number] } | null
}

export interface BandsUniforms {
  budget: number
  variant: 0 | 1 | 2
  showBands: boolean
  showHatch: boolean
  hatchPx: number
  dpr: number
  lineHalfPx: number
  colors: { safe: [number, number, number]; unknown: [number, number, number] }
  opacity: [number, number]
  /** Collapse (M4): k, cross-fade source and weight, pad (grid m), cell (m), flat speed (m/s); null = no collapse (k = 1). */
  collapse: { k: number; kFrom: number; xfade: number; pad: [number, number]; cell: number; flatSpeed: number } | null
  /** Margin mode (M3); null = bands mode. Terms left out arrive as VERY_LARGE (margin.ts shaderScalars). */
  margin: {
    t: number
    o2Left: number
    reserve: number
    o2Tasks: number
    o2Rate: number
    tDark: number
    tauDose: number
    tEva: number
    amber: number
    caution: [number, number, number]
    limit: [number, number, number]
  } | null
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)
  if (!s) throw new Error('createShader failed')
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`field shader: ${gl.getShaderInfoLog(s)}`)
  return s
}

/** Upload bytes as a NEAREST texture (no premultiply, no colour conversion); the map shares this context. */
function upload(gl: WebGL2RenderingContext, bytes: Uint8Array, w: number, h: number, single: boolean): WebGLTexture {
  const tex = gl.createTexture()
  if (!tex) throw new Error('createTexture failed')
  gl.bindTexture(gl.TEXTURE_2D, tex)
  const prev = [gl.getParameter(gl.UNPACK_ALIGNMENT), gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL), gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL), gl.getParameter(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL)]
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
  if (single) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, bytes)
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes)
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
export class BandsProgram {
  private readonly prog: WebGLProgram
  private tex: WebGLTexture[] = []
  private readonly buf: WebGLBuffer
  private readonly vao: WebGLVertexArrayObject
  private readonly loc = new Map<string, WebGLUniformLocation | null>()
  private td: FieldTextureData | null = null
  private vertexCount = 0
  private readonly gl: WebGL2RenderingContext

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
    const p = gl.createProgram()
    if (!p) throw new Error('createProgram failed')
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS))
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FS))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`field shader link: ${gl.getProgramInfoLog(p)}`)
    this.prog = p
    const buf = gl.createBuffer()
    const vao = gl.createVertexArray()
    if (!buf || !vao) throw new Error('buffer allocation failed')
    this.buf = buf
    this.vao = vao
  }

  setTextures(td: FieldTextureData): void {
    const gl = this.gl
    this.tex.forEach((t) => gl.deleteTexture(t))
    const [w, h] = td.size
    const st = td.state ?? { code: new Uint8Array(1), size: [1, 1] as [number, number] }
    const o2 = td.o2 ? upload(gl, td.o2.bytes, w, h, false) : upload(gl, new Uint8Array(4), 1, 1, false)
    this.tex = [...td.t.map((d) => upload(gl, d, w, h, false)), upload(gl, st.code, st.size[0], st.size[1], true), o2]
    this.td = td
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
    return this.loc.get(name) ?? null
  }

  draw(un: BandsUniforms, matrix: Float32Array): void {
    const gl = this.gl
    const td = this.td
    if (!td) return
    gl.useProgram(this.prog)
    ;['u_t0', 'u_t1', 'u_t2', 'u_state', 'u_o2'].forEach((name, i) => {
      gl.activeTexture(gl.TEXTURE0 + i)
      gl.bindTexture(gl.TEXTURE_2D, this.tex[i])
      gl.uniform1i(this.u(name), i)
    })
    gl.uniformMatrix4fv(this.u('u_matrix'), false, matrix)
    gl.uniform2f(this.u('u_size'), td.size[0], td.size[1])
    gl.uniform2f(this.u('u_stateSize'), td.state?.size[0] ?? 1, td.state?.size[1] ?? 1)
    gl.uniform4fv(this.u('u_stateXf'), td.state?.xform ?? [0, 0, 1, 1])
    gl.uniform1f(this.u('u_hasState'), td.state ? 1 : 0)
    gl.uniform1f(this.u('u_scale'), td.scale)
    gl.uniform1f(this.u('u_budget'), un.budget)
    gl.uniform1f(this.u('u_variant'), un.variant)
    gl.uniform1f(this.u('u_showBands'), un.showBands ? 1 : 0)
    gl.uniform1f(this.u('u_showHatch'), un.showHatch ? 1 : 0)
    gl.uniform1f(this.u('u_hatchPx'), un.hatchPx)
    gl.uniform1f(this.u('u_dpr'), un.dpr)
    gl.uniform1f(this.u('u_lineHalfPx'), un.lineHalfPx)
    gl.uniform3fv(this.u('u_safe'), un.colors.safe)
    gl.uniform3fv(this.u('u_unknown'), un.colors.unknown)
    gl.uniform2f(this.u('u_opacity'), un.opacity[0], un.opacity[1])
    const cl = un.collapse
    gl.uniform1f(this.u('u_hasPad'), cl ? 1 : 0)
    gl.uniform1f(this.u('u_k'), cl ? cl.k : 1)
    gl.uniform1f(this.u('u_kFrom'), cl ? cl.kFrom : 1)
    gl.uniform1f(this.u('u_xfade'), cl ? cl.xfade : 1)
    gl.uniform2f(this.u('u_pad'), cl ? cl.pad[0] : 0, cl ? cl.pad[1] : 0)
    gl.uniform1f(this.u('u_cell'), cl ? cl.cell : 1)
    gl.uniform1f(this.u('u_flatSpeed'), cl ? cl.flatSpeed : 1)
    const mg = un.margin
    gl.uniform1f(this.u('u_mode'), mg ? 1 : 0)
    gl.uniform1f(this.u('u_hasO2'), td.o2 ? 1 : 0)
    gl.uniform1f(this.u('u_o2Scale'), td.o2?.scale ?? 1)
    if (mg) {
      gl.uniform1f(this.u('u_t'), mg.t)
      gl.uniform1f(this.u('u_o2Left'), mg.o2Left)
      gl.uniform1f(this.u('u_reserve'), mg.reserve)
      gl.uniform1f(this.u('u_o2Tasks'), mg.o2Tasks)
      gl.uniform1f(this.u('u_o2Rate'), mg.o2Rate)
      gl.uniform1f(this.u('u_tDark'), mg.tDark)
      gl.uniform1f(this.u('u_tauDose'), mg.tauDose)
      gl.uniform1f(this.u('u_tEva'), mg.tEva)
      gl.uniform1f(this.u('u_amber'), mg.amber)
      gl.uniform3fv(this.u('u_caution'), mg.caution)
      gl.uniform3fv(this.u('u_limit'), mg.limit)
    }
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
