# Field shader interface — design contracts v1

**Version 1.0.0** (design contracts v1, DESIGN §6.4; frozen at merge. An additive change, such as
a new optional uniform or a new `fieldAt` key, is a minor bump; a breaking change is human-gated).
Sources: DESIGN §2.2 U2 (living homeline), U3 (collapse), §5.2 (mission state), §6.4;
`contracts/README.md` "Field PNGs" and "Cell states"; `docs/web-architecture.md` §8;
`config/design.yaml field_layer`. Reference implementation: the M1 spike
(`web/src/map/spike/decode.ts` is the CPU mirror of `shader.ts`).

This file fixes what the field layer reads and how it reads it. Colours, opacities, the hatch size and
the line width come from tokens (`web/src/ui/tokens.json`) and `config/design.yaml`. They are
not part of this interface. **No validated number changes:** the shader only reads published fields
and mission-state scalars.

## 1. Textures

| Uniform | Unit per count | File (relative to the data root) | Grid |
| --- | --- | --- | --- |
| `u_tHome[3]` | 0.1 min (`scale` in `fields/index.json`) | `fields/{v}_{suit}/t_home.png` for v = `opt`, `nom`, `con` at the plan's suit mass | field grid |
| `u_o2Home` | 0.01 L | `fields/nom_{suit}/o2_home.png` (nominal only) | field grid |
| `u_state` | class: 0 assessed, 1 blocked; A = 0 unknown | `terrain/cellstate.png` (`terrain/cellstate.json` gives its grid) | cell-state grid |

Live plans (F23) publish the same files under `results/{hash}/`, so the shader does not change.
Read each `scale` from `fields/index.json` at load time and never hard-code it. The values above are
the current `config/hud.yaml field_scales`.

### 1.1 Decode (exact)

Every texture is an 8-bit RGBA PNG with rows running north to south.

```
counts = R·256 + G          (B = 0)
value  = counts × scale     (fields/index.json fields.{key}.scale)
A = 255 → value present;  A = 0 → no value
```

In GLSL, with the texture uploaded as RGBA8 / UNSIGNED_BYTE:

```glsl
float counts = floor(c.r * 255.0 + 0.5) * 256.0 + floor(c.g * 255.0 + 0.5); // exact in highp
bool  known  = c.a > 0.5;
```

Upload settings: `UNPACK_PREMULTIPLY_ALPHA_WEBGL = false`,
`UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE`. Decode on the CPU with
`createImageBitmap(blob, {premultiplyAlpha: 'none', colorSpaceConversion: 'none'})`. Premultiplied
alpha would zero R and G wherever A = 0, and colour conversion would change the bytes.

### 1.2 Sampling

1. **Nearest only** (`TEXTURE_MIN/MAG_FILTER = NEAREST`, `CLAMP_TO_EDGE`). Linear filtering would
   mix the high and low bytes of `counts`, and it would mix valid texels with A = 0 texels.
2. **Manual bilinear on decoded values.** Pixel centres sit at `(i + 0.5) / size`. For grid uv
   (u east, v south, 0..1 over the outer pixel edges): `p = uv · size − 0.5`, `i0 = floor(p)`,
   `f = p − i0`. Fetch texels `i0`, `i0 + (1,0)`, `i0 + (0,1)` and `i0 + (1,1)` (each clamped to the
   grid), decode each one, then interpolate the decoded values with `f`.
3. **Unknown if any neighbour is unknown.** If any of the four texels has A = 0, the sample has no
   value. A value is never interpolated across a gap. This makes edges smooth but never
   optimistic.
4. **The cell state is a class, not a value.** Sample it nearest, with no bilinear step.
5. Outside the grid bounds (u or v outside [0, 1]) there is no value and nothing is drawn.

## 2. Grids

| Grid | Source of truth | Today (real data) |
| --- | --- | --- |
| Field grid (`t_home`, `o2_home`, …) | `fields/index.json` top-level `bounds` [w, s, e, n] (outer pixel edges), `width`, `height`, `res_m` | 1480 × 1480 at 5 m, bounds [137.319359, −4.868421, 137.444641, −4.743579] (the dummy tree has 1481²) |
| Cell-state grid | `terrain/cellstate.json` `bounds`, `width`, `height`, `res_m` | 2468 × 2468 at 3 m, bounds [137.319325, −4.868455, 137.444675, −4.743545] |

The analysis CRS is equirectangular, so both grids are axis-aligned in lon/lat. A field uv maps to a
cell-state uv by an affine transform (spike `gridXform`). With field bounds
`[fw, fs, fe, fn]` and state bounds `[tw, ts, te, tn]`:

```
state_u = (fw − tw)/(te − tw) + field_u · (fe − fw)/(te − tw)
state_v = (tn − fn)/(tn − ts) + field_v · (fn − fs)/(tn − ts)
```

Pass this transform as a `vec4` (offset u, offset v, scale u, scale v). Always read both grids from
their JSON files and never assume they match. `pointer.png` (3 m move index) is **not** a shader
input: a move index cannot be interpolated.

## 3. Uniforms (DESIGN §6.4)

| Uniform | Unit | From |
| --- | --- | --- |
| `u_tHome[3]` (textures) | 0.1 min per count | `fields/{scenario}/t_home.png` for opt, nom, con (§1) |
| `u_o2Home` (texture) | 0.01 L per count | `o2_home.png` nominal (§1) |
| `u_state` (texture) | class | cell state (§1) |
| `u_t` | min | Mission state: EVA clock, minutes since departure |
| `u_tDark` | min (on the EVA clock) | Mission state: pad-level darkness time from the Mars clock (`conditions/clock.json`; DESIGN U2 step 5). Per-cell horizon shading is not modelled, and the legend says so |
| `u_tauDose` | min | Mission state: dose leash τ for the current dose allowance (`conditions/rad.json` `leash`). Use a very large value (≥ 1e6) when no storm is active |
| `u_tEva` | min | Mission state: EVA length (`config/crew.yaml eva_h` × 60 = 390 by default) |
| `u_o2Left` | L | Mission state: O₂ left now (primary, `config/crew.yaml o2_budget.margin_uses`) |
| `u_reserve` | L | Mission state: O₂ reserve (D24: `reserve_min_at_effort_cap` × rate = 40.5 L) |
| `u_o2Rate` | L/min | 1.35, the effort-cap rate (`config/design.yaml field_layer.o2_rate_l_min`, D24/D45) |
| `u_budget` | min | 30 or 60 (bands mode, and the collapse circle) |
| `u_mode` | — | 0 = bands, 1 = margin (UI, storyboard `field.mode`) |
| `u_variant` | — | 0 = opt, 1 = nom, 2 = con (UI, storyboard `field.variant`) |
| `u_k` | — | collapse 0..1 (U3; storyboard `field.collapse`) |
| `u_pad` | m | Pad position in field-grid metres: x east of the west edge, y south of the north edge (the same axes as uv × size × `u_cell`) |
| `u_cell` | m | Field cell size, `fields/index.json res_m` (5) |
| `u_flatSpeed` | m/s | 0.98 (D25; `config/design.yaml field_layer.flat_speed_ms`) |
| `u_amber` | min | 10 (`config/hud.yaml margin_amber_min` = `config/design.yaml field_layer.amber_min`) |

The implementation may add helper uniforms such as grid sizes, the state transform, colours,
opacities, hatch size, line width or pixel ratio. Those are rendering details, not part of this
contract.

### 3.1 What the shader computes

The threshold time for a pixel (U3 collapse, with `d` the distance to the pad in grid metres):

```
d(x)      = length(uv · size · u_cell − u_pad)
T(x)      = mix(d(x) / u_flatSpeed / 60, T_home[u_variant](x), u_k)        // min
```

At `u_k` = 0 the 30-min edge is a circle of 1,764 m radius
(`config/design.yaml field_layer.flat_radius_m`).

The margin (U2, SPEC F4 with D24 and D28; the O₂ term is converted to minutes at the effort-cap
rate, the same convention as the WS2 margin code):

```
m(x) = min( (u_o2Left − u_reserve − O2_home(x)) / u_o2Rate,   // binding "O2"
            u_tDark − u_t − T(x),                             // "daylight"
            u_tauDose − T(x),                                 // "dose"
            u_tEva  − u_t − T(x) )                            // "EVA duration"
```

The binding names are the `timeline.schema.json` `margin_binding` values. Classes are checked in this
order, which is the spike's `classify`:

1. cell state unknown (A = 0 in `u_state`) → `unknown`, grey diagonal hatch in screen space. Never a
   warning colour.
2. no `T_home` value for the variant (§1.2 rule 3), or no `O2_home` value in margin mode → `none`,
   which is neither coloured nor hatched (see §6).
3. bands mode: `T(x) ≤ u_budget` → `safe`, else `none`.
4. margin mode: `m < 0` → `limit`; `m ≤ u_amber` → `caution` (the HUD rule, D88); else `safe`. The zero-margin edge is
   drawn as a 1.5 px line in screen space.

Acceptance (U2): at every station and every 5 min along the route the margin equals
`timeline_*.json` within 0.5 min. With the precomputed band inputs, the 30-min edge lies within one
field cell (5 m) of the band contour.

## 4. Mission-state inputs (DESIGN §5.2)

The shader reads only these scalars, from the mission-state store. They are re-uploaded when any of
them changes, and at most `field_layer.update_hz_playing` (30) times per second during playback.

| Mission state | Uniform |
| --- | --- |
| clock: EVA minute | `u_t` |
| budgets: O₂ left, reserve, EVA length | `u_o2Left`, `u_reserve`, `u_tEva` |
| conditions: t_dark | `u_tDark` |
| conditions: τ_dose (storm on), dose allowance | `u_tauDose` |
| plan: suit mass → which `t_home` / `o2_home` files | texture binding |
| plan: pad | `u_pad` |
| UI: mode, variant, budget, collapse | `u_mode`, `u_variant`, `u_budget`, `u_k` |

## 5. `fieldAt(lon, lat)` (WS16 task 2; read by WS15 cards and readouts and by WS18)

`fieldAt` is a CPU lookup that gives exactly what the shader shows at that point: the same decode,
bilinear rule, unknown rule and classification. It is synchronous once the fields are loaded.

```ts
type Variant = 'opt' | 'nom' | 'con'
type FieldClass = 'safe' | 'caution' | 'limit' | 'none' | 'unknown'
type Binding = 'O2' | 'daylight' | 'dose' | 'EVA duration'

interface FieldSample {
  lon: number
  lat: number
  inside: boolean                                  // inside the field grid; false → everything below null / 'none'
  state: 'assessed' | 'blocked' | 'unknown' | null // cell state (nearest, 3 m grid); null outside its grid
  tHome: Record<Variant, number | null>            // min, manual bilinear; null = no value (§1.2)
  o2Home: number | null                            // L, nominal
  t: number | null                                 // min, T(x) for the current variant and u_k (§3.1)
  margin: number | null                            // min, m(x) for the current mission state; null if an input is null
  binding: Binding | null                          // the term that sets margin; null when margin is null
  cls: FieldClass                                  // the class drawn at this point (§3.1)
  variant: Variant                                 // the variant used for t, margin and cls
}

fieldAt(lon: number, lat: number): FieldSample | null   // null until the fields are loaded
```

Numbers are unrounded. The caller formats them (DESIGN §3.8) and shows the trust chip (`Modelled`).
`fieldAt` gives no elevation, because no elevation field is published (see §6).

## 6. Open questions

1. **What `t_home` A = 0 means (blocked or not reached, versus unknown).** M1 measured that `t_home`
   has A = 0 on 22.6 % of the grid for opt, 33.2 % for nom and 42.6 % for con. The cell state shows
   0 % unknown terrain and 24.4 % blocked. So `t_home` A = 0 is mostly blocked or unreached cells,
   not missing data. **Current rule:** hatch only where the **cell state** is unknown (A = 0 in
   `u_state`). Leave the other A = 0 field pixels uncoloured (`none`). Still open for WS16 task 2 and
   C: whether blocked cells get a separate look (`limit` = "blocked slope", DESIGN §3.1), and whether
   the field export should tell "blocked" apart from "not reached" (it would need a new code, an
   additive change).
2. **Cursor elevation (U1 acceptance: "cursor elevation equals the field value").** No elevation
   field is in `fields/index.json` today. If one is added, `fieldAt` gains an optional `elev_m`
   (an additive change).
