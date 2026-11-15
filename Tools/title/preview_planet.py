"""Offline reference renderer for the MARVIS title planet (shader "Marvis/TitlePlanet").

numpy + Pillow port of the fragment math in Assets/Mars/UI/Resources/Title/MarvisPlanet.shader, used to check
orientation and the normal map's sign conventions without opening Unity.

Conventions (identical to the shader and the game):
  view space    +x right, +y up, +z toward the viewer (orthographic view of a unit sphere)
  planet space  +Y north pole; lon = atan2(n.x, n.z) (east positive toward +X); lat = asin(n.y)
  maps          equirectangular, u = lon / (2 pi) + 0.5, v = lat / pi + 0.5 (0 E in the centre column, north at the
                top row of the image); U wraps, V clamps; texel centres at (i + 0.5) / size like the GPU
  colour map    sRGB, decoded to linear before any math
  normal map    plain RGB in a LINEAR texture: (R, G, B) * 2 - 1 = (east, north, up) tangent-space normal
  rotation      Q = Rz(lean) * Rx(tilt) * Ry(spin) is the planet -> view rotation, where
                  Ry(a) maps (0,0,1) to (sin a, 0, cos a)   (spin > 0 moves surface features to the RIGHT;
                                                             the longitude facing the viewer is -spin)
                  Rx(a) maps (0,1,0) to (0, cos a, sin a)   (tilt > 0 tips the north pole toward the viewer)
                  Rz(a) maps (1,0,0) to (cos a, sin a, 0)   (lean > 0 rolls counter-clockwise on screen)
                The shader's _RotX/_RotY/_RotZ are the rows of Q^-1 = Q^T (view -> planet).
  sun           --sun is a view-space direction (normalised here), the shader's _SunDir
  output        linear result, straight alpha, composited in linear over #07060B, then sRGB-encoded

Differences from the GPU that do not change the picture: no mip chain (the maps are box-filtered once to roughly
the on-screen equator resolution instead), and fwidth(r) is the analytic pixel size in disc radii.

Usage:
  python preview_planet.py --color mars_color.jpg [--normal mars_normal.png] --out preview.png
         [--size 900] [--spin-deg 0] [--tilt-deg 0] [--lean-deg 0] [--sun 0.45,0.38,0.81]
         [--normal-strength 1.0] [--exposure 1.25]
Without --normal a flat normal is used.
"""

import argparse
import math

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

# Shader property defaults (Properties block of Marvis/TitlePlanet).
DISC_FRACTION = 0.8
NIGHT = 0.012
ATMO_STRENGTH = 0.55
HALO_STRENGTH = 0.45
HALO_WIDTH = 0.045
BACKGROUND_HEX = "07060B"


def srgb_to_linear(c):
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1.0 / 2.4) - 0.055)


# _AtmoColor default (0.93, 0.60, 0.38) is an sRGB colour in the inspector; the GPU receives it linearised.
ATMO_COLOR = srgb_to_linear([0.93, 0.60, 0.38])


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def rot_x(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]], dtype=np.float64)


def rot_y(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], dtype=np.float64)


def rot_z(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]], dtype=np.float64)


def planet_to_view(spin_deg, tilt_deg, lean_deg):
    return rot_z(math.radians(lean_deg)) @ rot_x(math.radians(tilt_deg)) @ rot_y(math.radians(spin_deg))


def load_map(path, width, linearise):
    """Load an equirect map as float RGB in 0..1, box-filtered to `width` x width/2 (never upscaled)."""
    img = Image.open(path)
    arr = np.asarray(img)
    if arr.dtype == np.uint16 or img.mode.startswith("I;16"):
        scale = 65535.0
    else:
        scale = 255.0
    if arr.ndim == 2:
        arr = np.stack([arr] * 3, axis=-1)
    arr = arr[..., :3].astype(np.float32) / scale
    if linearise:
        arr = srgb_to_linear(arr).astype(np.float32)
    h, w = arr.shape[:2]
    if width < w:
        nw, nh = int(width), max(1, int(round(width * h / w)))
        chans = [np.asarray(Image.fromarray(arr[..., k], mode="F").resize((nw, nh), Image.BOX)) for k in range(3)]
        arr = np.stack(chans, axis=-1)
    return arr


def sample_bilinear(tex, u, v):
    """GPU-style bilinear lookup: U repeats, V clamps, v = 0 is the BOTTOM row (image row h-1)."""
    h, w = tex.shape[:2]
    x = u * w - 0.5
    y = (1.0 - v) * h - 0.5  # image rows run top-down
    x0 = np.floor(x)
    y0 = np.floor(y)
    fx = (x - x0)[..., None]
    fy = (y - y0)[..., None]
    x0 = x0.astype(np.int64)
    y0 = y0.astype(np.int64)
    xa = np.mod(x0, w)
    xb = np.mod(x0 + 1, w)
    ya = np.clip(y0, 0, h - 1)
    yb = np.clip(y0 + 1, 0, h - 1)
    top = tex[ya, xa] * (1 - fx) + tex[ya, xb] * fx
    bot = tex[yb, xa] * (1 - fx) + tex[yb, xb] * fx
    return top * (1 - fy) + bot * fy


def render(color, normal, size, spin_deg, tilt_deg, lean_deg, sun, normal_strength, exposure):
    q = planet_to_view(spin_deg, tilt_deg, lean_deg)
    r_view_to_planet = q.T  # rows = _RotX, _RotY, _RotZ

    # Quad uv with (0,0) bottom-left: pixel centres, image row 0 is the top (uv.y = 1).
    c = (np.arange(size) + 0.5) / size
    uvx, uvy = np.meshgrid(c, 1.0 - c)

    disc = max(DISC_FRACTION, 1e-3)
    px = (uvx * 2 - 1) / disc
    py = (uvy * 2 - 1) / disc
    r = np.sqrt(px * px + py * py)
    z = np.sqrt(np.clip(1 - r * r, 0, 1))
    nV = np.stack([px, py, z], axis=-1)

    sV = np.asarray(sun, dtype=np.float64)
    sV = sV / max(np.linalg.norm(sV), 1e-5)

    nP = nV @ r_view_to_planet.T
    sP = r_view_to_planet @ sV

    cl_raw = np.sqrt(nP[..., 0] ** 2 + nP[..., 2] ** 2)
    lon = np.where(cl_raw > 1e-6, np.arctan2(nP[..., 0], nP[..., 2]), 0.0)
    lat = np.arcsin(np.clip(nP[..., 1], -1, 1))
    u = lon / (2 * math.pi) + 0.5
    v = lat / math.pi + 0.5

    albedo = sample_bilinear(color, u, v)
    if normal is not None:
        t = sample_bilinear(normal, u, v) * 2 - 1
    else:
        t = np.zeros(u.shape + (3,))
        t[..., 2] = 1
    t[..., 0] *= normal_strength
    t[..., 1] *= normal_strength

    cl = np.maximum(1e-4, cl_raw)[..., None]
    east = np.stack([nP[..., 2], np.zeros_like(cl_raw), -nP[..., 0]], axis=-1) / cl
    north = np.stack([-nP[..., 1] * nP[..., 0] / cl[..., 0], cl[..., 0], -nP[..., 1] * nP[..., 2] / cl[..., 0]], axis=-1)
    nb_raw = east * t[..., 0:1] + north * t[..., 1:2] + nP * t[..., 2:3]
    nb_len2 = np.sum(nb_raw * nb_raw, axis=-1, keepdims=True)
    nB = np.where(nb_len2 > 1e-6, nb_raw / np.sqrt(np.maximum(nb_len2, 1e-12)), nP)

    ndl0 = nP @ sP
    ndl = nB @ sP
    terminator = smoothstep(-0.10, 0.22, ndl0)
    diffuse = np.clip(ndl, 0, 1) * terminator
    surface = albedo * (NIGHT + exposure * diffuse)[..., None]

    rim = (1 - z) ** 3
    atmo_lit = smoothstep(-0.25, 0.55, ndl0)
    surface = surface + ATMO_COLOR * (ATMO_STRENGTH * rim * atmo_lit)[..., None]

    d = np.maximum(0, r - 1)
    rr = np.maximum(r, 1e-4)
    limb_lit = smoothstep(-0.2, 0.7, (px / rr) * sV[0] + (py / rr) * sV[1])
    halo_a = np.clip(np.exp(-d / max(HALO_WIDTH, 1e-5)) * HALO_STRENGTH * limb_lit, 0, 1)
    d_max = max(1e-4, 1 / disc - 1)
    halo_a = halo_a * (1 - smoothstep(0.6, 1.0, d / d_max))  # same window as the shader: zero at the quad edge

    aa = 2.0 / size / disc  # fwidth(r): one pixel in disc radii
    inside = 1 - smoothstep(1 - aa * 0.5, 1 + aa * 0.5, r)

    ins = inside[..., None]
    rgb = ATMO_COLOR * (1 - ins) + surface * ins
    a = halo_a * (1 - inside) + inside

    bg = srgb_to_linear([int(BACKGROUND_HEX[k:k + 2], 16) / 255.0 for k in (0, 2, 4)])
    out = rgb * a[..., None] + bg * (1 - a[..., None])
    return (linear_to_srgb(out) * 255 + 0.5).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--color", required=True)
    ap.add_argument("--normal")
    ap.add_argument("--out", required=True)
    ap.add_argument("--size", type=int, default=900)
    ap.add_argument("--spin-deg", type=float, default=0.0)
    ap.add_argument("--tilt-deg", type=float, default=0.0)
    ap.add_argument("--lean-deg", type=float, default=0.0)
    ap.add_argument("--sun", default="0.45,0.38,0.81")
    ap.add_argument("--normal-strength", type=float, default=1.0)
    ap.add_argument("--exposure", type=float, default=1.25)
    args = ap.parse_args()

    sun = [float(s) for s in args.sun.split(",")]
    if len(sun) != 3:
        ap.error("--sun needs x,y,z")

    # Roughly the on-screen texel density at the disc centre: the equator spans pi * disc diameter pixels.
    work_w = max(256, int(math.ceil(math.pi * args.size * DISC_FRACTION)))
    color = load_map(args.color, work_w, linearise=True)
    normal = load_map(args.normal, work_w, linearise=False) if args.normal else None

    img = render(color, normal, args.size, args.spin_deg, args.tilt_deg, args.lean_deg, sun,
                 args.normal_strength, args.exposure)
    Image.fromarray(img, mode="RGB").save(args.out)
    print(f"wrote {args.out} ({args.size}x{args.size})")


if __name__ == "__main__":
    main()
