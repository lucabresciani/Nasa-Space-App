#!/usr/bin/env python3
"""Cut the MARVIS logotype out of the approved title mockup and draw the menu chevron.

Outputs (white RGB everywhere, the shape lives in alpha):
    logo_m.png  logo_a.png  logo_r.png  logo_t_slab.png  logo_t_helmet.png  logo_i.png  logo_s.png
    logo_layout.txt     placement of the seven sprites (sprite px, origin bottom-left, y up)
    icon_chevron.png    64x64 right-pointing chevron

How the pieces are obtained
    Bronze pieces (M A R helmet I S): alpha is the linear coverage of bronze #AC8057 over the dark
    sky, measured on the R-B difference (the sky and the slab sit at R-B = -5, the bronze at +85,
    neutral stars at 0). Only pixels within a few px of a solid bronze-hued connected component
    are kept, so star specks cannot leak in; the anti-aliased edge itself is never thresholded.
    Slab (the dark parallelogram behind the helmet): it is a perfectly flat #0B0C11 fill, so its
    four sides are least-squares fitted on the boundary of that flat region and the parallelogram
    is rasterised analytically (x4 supersampling) straight at the export scale.

Usage:
    python extract_logo.py --mockup "Assets/FINAL TITLE - PAUSE SCREEN.png" \
                           --out-dir Assets/Mars/UI/Resources/Title [--preview preview.png]

Needs numpy and Pillow. The Unity .meta files are not written here (their GUIDs must stay stable).
"""
import argparse
import os

import numpy as np
from PIL import Image, ImageFilter

Image.MAX_IMAGE_PIXELS = None

# Region of the mockup that holds the logotype. Origin and size are multiples of 5 source px so
# that the 0.6x export (5 px -> 3 px) lands on whole pixels.
ROI = (300, 250, 4200, 1100)          # x0, y0, x1, y1 in the 8550x4800 mockup
MOCKUP_SIZE = (8550, 4800)
SCALE_NUM, SCALE_DEN = 3, 5           # export scale 0.6

BRONZE = (172, 128, 87)               # #AC8057
SLAB = (11, 12, 17)                   # #0B0C11
SKY = (7, 6, 11)                      # #07060B, used by the preview only

# alpha = clamp((R-B - LO) / (HI - LO)); with sky at -5 and bronze at +85 this is the coverage,
# with an 8 percent dead zone at both ends (symmetric: alpha 0.5 = coverage 0.5).
D_LO, D_HI = 2.0, 78.0
CORE_D = 45                           # "solid bronze" for the component analysis
HUE_LO, HUE_HI = 0.30, 0.66           # (G-B)/(R-B); the bronze is 0.48
LETTER_MIN_AREA = 20000               # source px; a letter is far larger, a star far smaller
DETAIL_MIN_AREA = 150                 # source px; smallest helmet detail kept
SUPPORT_RADIUS = 3                    # source px of anti-aliased rim kept around the solid core
# Lanczos rings by a few percent on both sides of an edge; this toe/shoulder removes the halo.
RING_LO, RING_HI = 0.035, 0.965
MARGIN = 2                            # transparent px around every exported sprite
SLAB_SS = 4                           # supersampling of the slab and of the chevron

PIECES = ("m", "a", "r", "t_helmet", "i", "s")       # left to right
DRAW_ORDER = ("t_slab", "m", "a", "r", "t_helmet", "i", "s")
CAP_LETTERS = ("m", "a", "r", "i", "s")


# ----------------------------------------------------------------------------- components

def label_components(mask):
    """8-connected components of a boolean image, run based. Returns (labels int32, areas, boxes)."""
    h, w = mask.shape
    parent = []

    def find(i):
        root = i
        while parent[root] != root:
            root = parent[root]
        while parent[i] != root:
            parent[i], i = root, parent[i]
        return root

    rows = []                          # per row: list of (x_start, x_end_exclusive, run_id)
    prev = []
    for y in range(h):
        line = mask[y]
        edge = np.flatnonzero(np.diff(np.concatenate(([0], line.view(np.int8), [0]))))
        cur = []
        for s, e in zip(edge[0::2], edge[1::2]):
            rid = len(parent)
            parent.append(rid)
            for ps, pe, pid in prev:
                if ps <= e and pe >= s:            # touches, diagonals included
                    ra, rb = find(rid), find(pid)
                    if ra != rb:
                        parent[max(ra, rb)] = min(ra, rb)
            cur.append((int(s), int(e), rid))
        rows.append(cur)
        prev = cur

    labels = np.zeros((h, w), np.int32)
    remap, areas, boxes = {}, [0], [None]
    for y, cur in enumerate(rows):
        for s, e, rid in cur:
            root = find(rid)
            lab = remap.get(root)
            if lab is None:
                lab = len(areas)
                remap[root] = lab
                areas.append(0)
                boxes.append([s, y, e, y + 1])
            labels[y, s:e] = lab
            areas[lab] += e - s
            b = boxes[lab]
            b[0], b[2], b[3] = min(b[0], s), max(b[2], e), y + 1
    return labels, areas, boxes


def dilate(mask, radius):
    img = Image.fromarray(mask.astype(np.uint8) * 255, "L")
    return np.asarray(img.filter(ImageFilter.MaxFilter(2 * radius + 1))) > 0


# ----------------------------------------------------------------------------- bronze pieces

def bronze_pieces(rgb, log):
    """Full-resolution coverage (float32 0..1, ROI sized) of each of the six bronze pieces."""
    r, g, b = (rgb[..., i].astype(np.int32) for i in range(3))
    d = r - b
    hue = (g - b) / np.maximum(d, 1)
    core = (d > CORE_D) & (hue > HUE_LO) & (hue < HUE_HI)
    labels, areas, boxes = label_components(core)

    big = [i for i in range(1, len(areas)) if areas[i] >= LETTER_MIN_AREA]
    # Column gaps between the big components give the six glyph boxes.
    cols = np.zeros(core.shape[1], bool)
    for i in big:
        cols[boxes[i][0]:boxes[i][2]] = True
    edge = np.flatnonzero(np.diff(np.concatenate(([0], cols.view(np.int8), [0]))))
    spans = list(zip(edge[0::2].tolist(), edge[1::2].tolist()))
    if len(spans) != len(PIECES):
        raise SystemExit("expected %d glyph columns, found %d: %r" % (len(PIECES), len(spans), spans))

    alpha = np.clip((d - D_LO) / (D_HI - D_LO), 0.0, 1.0).astype(np.float32)
    out, dropped, kept = {}, [], set()
    for n, (key, (cx0, cx1)) in enumerate(zip(PIECES, spans)):
        inside = [i for i in big if boxes[i][0] >= cx0 and boxes[i][2] <= cx1]
        gy0 = min(boxes[i][1] for i in inside)
        gy1 = max(boxes[i][3] for i in inside)
        keep = list(inside)
        if key == "t_helmet":
            # The crest is cut into separate bands by its dark lines and sticks out of the face's
            # column and rows: every bronze part between R and I that is not a speck belongs to it.
            hx0, hx1 = spans[n - 1][1], spans[n + 1][0]
            for i in range(1, len(areas)):
                bx0, by0, bx1, by1 = boxes[i]
                if i in inside or not (bx0 >= hx0 and bx1 <= hx1):
                    continue
                if areas[i] >= DETAIL_MIN_AREA:
                    keep.append(i)
                else:
                    dropped.append((key, areas[i], bx0 + ROI[0], by0 + ROI[1]))
            gy0 = min(boxes[i][1] for i in keep)
            gy1 = max(boxes[i][3] for i in keep)
            log("  helmet parts (area, x, y): %r" % [
                (areas[i], boxes[i][0] + ROI[0], boxes[i][1] + ROI[1]) for i in keep])
        for i in range(1, len(areas)):
            if key == "t_helmet" or i in inside:
                continue
            bx0, by0, bx1, by1 = boxes[i]
            if bx0 >= cx0 and bx1 <= cx1 and by0 >= gy0 and by1 <= gy1:
                dropped.append((key, areas[i], bx0 + ROI[0], by0 + ROI[1]))   # warm star in a box
        kept.update(keep)
        solid = np.isin(labels, keep)
        out[key] = alpha * dilate(solid, SUPPORT_RADIUS)
        log("  %-8s columns %d-%d rows %d-%d, %d component(s), %d px solid" % (
            key, cx0 + ROI[0], cx1 + ROI[0] - 1, gy0 + ROI[1], gy1 + ROI[1] - 1, len(keep),
            int(solid.sum())))
    outside = sum(1 for i in range(1, len(areas))
                  if i not in kept and not any(boxes[i][0] >= s and boxes[i][2] <= e for s, e in spans))
    log("  dropped: %d bronze-hued speck(s) outside the glyph columns, %d inside a glyph box %r" % (
        outside, len(dropped), dropped))
    return out


def export_scale(cov):
    """Resample a ROI-sized coverage map to the export scale (Lanczos) and remove the ringing."""
    h, w = cov.shape
    size = (w * SCALE_NUM // SCALE_DEN, h * SCALE_NUM // SCALE_DEN)
    small = np.asarray(Image.fromarray(cov.astype(np.float32), "F").resize(size, Image.LANCZOS))
    return np.clip((small - RING_LO) / (RING_HI - RING_LO), 0.0, 1.0)


# ----------------------------------------------------------------------------- slab

def fit_line(points):
    """Total least squares line through Nx2 points, with one outlier rejection pass.
    Returns (point on the line, unit direction)."""
    pts = np.asarray(points, np.float64)
    for _ in range(2):
        c = pts.mean(0)
        _, _, vt = np.linalg.svd(pts - c)
        direction, normal = vt[0], vt[1]
        dist = np.abs((pts - c) @ normal)
        good = dist <= max(1.0, 3.0 * dist.std())
        if good.all():
            break
        pts = pts[good]
    return c, direction, float(dist.max()), len(pts)


def intersect(l1, l2):
    (p, u), (q, v) = l1[:2], l2[:2]
    t = np.linalg.solve(np.array([u, -v]).T, q - p)
    return p + t[0] * u


def slab_corners(rgb, log):
    """Corners (ROI px, pixel-edge coordinates, clockwise from the left-most one) of the slab."""
    flat = np.all(rgb == np.array(SLAB, np.uint8), axis=2)
    # Opening: the sky hits the exact slab colour here and there; only a large flat area survives.
    opened = dilate(~dilate(~flat, 4), 4) & flat
    labels, areas, boxes = label_components(opened)
    main = int(np.argmax(areas))
    blob = labels == main
    ys, xs = np.nonzero(blob)
    log("  slab flat area %d px, bbox x %d-%d y %d-%d (mockup px)" % (
        areas[main], xs.min() + ROI[0], xs.max() + ROI[0], ys.min() + ROI[1], ys.max() + ROI[1]))

    left = (xs.min(), ys[xs == xs.min()].mean())       # extreme points ~ the four corners
    right = (xs.max(), ys[xs == xs.max()].mean())
    top = (xs[ys == ys.min()].mean(), ys.min())
    bottom = (xs[ys == ys.max()].mean(), ys.max())

    col_any = blob.any(0)
    col_top = np.where(col_any, blob.argmax(0), -1)
    col_bot = np.where(col_any, blob.shape[0] - 1 - blob[::-1].argmax(0), -1)
    row_any = blob.any(1)
    row_left = np.where(row_any, blob.argmax(1), -1)
    row_right = np.where(row_any, blob.shape[1] - 1 - blob[:, ::-1].argmax(1), -1)

    def span(a, b, trim=0.10):
        a, b = min(a, b), max(a, b)
        t = (b - a) * trim
        return np.arange(int(np.ceil(a + t)), int(np.floor(b - t)) + 1)

    # A flat pixel is a fully covered one; the true edge lies on average one pixel beyond the
    # centre of the last fully covered pixel, i.e. at index + 1.5 (far side) or index - 0.5 (near
    # side) in pixel-edge coordinates, along the scan direction.
    xt = span(left[0], top[0])
    yr = span(top[1], right[1])
    xb = span(bottom[0], right[0])
    yl = span(left[1], bottom[1])
    lines = {
        "top": fit_line(np.stack([xt + 0.5, col_top[xt] - 0.5], 1)),
        "right": fit_line(np.stack([row_right[yr] + 1.5, yr + 0.5], 1)),
        "bottom": fit_line(np.stack([xb + 0.5, col_bot[xb] + 1.5], 1)),
        "left": fit_line(np.stack([row_left[yl] - 0.5, yl + 0.5], 1)),
    }
    for name, (_, u, resid, n) in lines.items():
        ang = np.degrees(np.arctan2(u[1], u[0])) % 180.0
        log("  slab %-6s edge: %.3f deg from +x (y down), %d samples, max residual %.2f px" % (
            name, ang, n, resid))
    corners = np.array([
        intersect(lines["left"], lines["top"]),
        intersect(lines["top"], lines["right"]),
        intersect(lines["right"], lines["bottom"]),
        intersect(lines["bottom"], lines["left"]),
    ])
    for name, c in zip(("left", "top", "right", "bottom"), corners):
        log("  slab corner %-6s mockup px (%.2f, %.2f)" % (name, c[0] + ROI[0], c[1] + ROI[1]))
    return corners


def convex_coverage(poly, size, ss):
    """Coverage (float32 0..1) of a convex polygon (pixel-edge coordinates) on a size=(w, h) grid."""
    w, h = size
    xs = (np.arange(w * ss) + 0.5) / ss
    ys = (np.arange(h * ss) + 0.5) / ss
    gx, gy = np.meshgrid(xs, ys)
    inside_pos = np.ones(gx.shape, bool)
    inside_neg = np.ones(gx.shape, bool)
    n = len(poly)
    for i in range(n):
        (x0, y0), (x1, y1) = poly[i], poly[(i + 1) % n]
        cross = (x1 - x0) * (gy - y0) - (y1 - y0) * (gx - x0)
        inside_pos &= cross >= 0
        inside_neg &= cross <= 0
    inside = inside_pos | inside_neg
    return inside.reshape(h, ss, w, ss).mean((1, 3)).astype(np.float32)


# ----------------------------------------------------------------------------- output

def to_sprite(alpha):
    """White RGBA image from a float alpha map."""
    a8 = np.rint(np.clip(alpha, 0, 1) * 255).astype(np.uint8)
    rgba = np.full(a8.shape + (4,), 255, np.uint8)
    rgba[..., 3] = a8
    return Image.fromarray(rgba, "RGBA")


def tight_box(alpha, margin):
    a8 = np.rint(np.clip(alpha, 0, 1) * 255).astype(np.uint8)
    ys, xs = np.nonzero(a8)
    h, w = a8.shape
    x0, y0, x1, y1 = xs.min() - margin, ys.min() - margin, xs.max() + 1 + margin, ys.max() + 1 + margin
    if x0 < 0 or y0 < 0 or x1 > w or y1 > h:
        raise SystemExit("a piece touches the edge of the region of interest")
    return int(x0), int(y0), int(x1), int(y1)


def edge_position(profile, rising):
    """Sub-pixel position (pixel-edge coordinates) where a 0..1 profile crosses 0.5."""
    idx = np.flatnonzero(profile >= 0.5)
    i = idx[0] if rising else idx[-1]
    j = i - 1 if rising else i + 1
    if j < 0 or j >= len(profile) or profile[i] == profile[j]:
        return float(i if rising else i + 1)
    centre = i + (0.5 - profile[i]) / (profile[j] - profile[i]) * (j - i)
    return float(centre + 0.5)


def chevron(size=64, width=18.0, height=32.0, stroke=6.0, ss=SLAB_SS):
    """Right-pointing chevron, round caps and joins, centred; the outer extent is width x height."""
    half = stroke / 2.0
    c = size / 2.0
    pts = [(c - width / 2 + half, c - height / 2 + half),
           (c + width / 2 - half, c),
           (c - width / 2 + half, c + height / 2 - half)]
    g = (np.arange(size * ss) + 0.5) / ss
    gx, gy = np.meshgrid(g, g)
    dist = np.full(gx.shape, np.inf)
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        vx, vy = x1 - x0, y1 - y0
        t = np.clip(((gx - x0) * vx + (gy - y0) * vy) / (vx * vx + vy * vy), 0, 1)
        dist = np.minimum(dist, np.hypot(gx - (x0 + t * vx), gy - (y0 + t * vy)))
    cov = (dist <= half).reshape(size, ss, size, ss).mean((1, 3))
    return to_sprite(cov)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--mockup", required=True, help="FINAL TITLE - PAUSE SCREEN.png (8550x4800)")
    ap.add_argument("--out-dir", required=True, help="where the sprites and logo_layout.txt go")
    ap.add_argument("--preview", help="optional comparison image: mockup crop above the recomposed logo")
    args = ap.parse_args()
    log = print

    mock = Image.open(args.mockup).convert("RGB")
    if mock.size != MOCKUP_SIZE:
        raise SystemExit("mockup is %dx%d, expected %dx%d" % (mock.size + MOCKUP_SIZE))
    roi = mock.crop(ROI)
    rgb = np.asarray(roi)
    os.makedirs(args.out_dir, exist_ok=True)
    scale = SCALE_NUM / SCALE_DEN

    log("bronze pieces")
    alphas = {k: export_scale(v) for k, v in bronze_pieces(rgb, log).items()}
    log("slab")
    corners = slab_corners(rgb, log) * scale
    h, w = next(iter(alphas.values())).shape
    alphas["t_slab"] = convex_coverage(corners, (w, h), SLAB_SS)

    rects = {k: tight_box(alphas[k], MARGIN) for k in DRAW_ORDER}
    bx0 = min(r[0] for r in rects.values())
    by0 = min(r[1] for r in rects.values())
    bx1 = max(r[2] for r in rects.values())
    by1 = max(r[3] for r in rects.values())
    box_w, box_h = bx1 - bx0, by1 - by0

    tops, bottoms = {}, {}
    for k in CAP_LETTERS:
        prof = alphas[k].max(1)
        tops[k] = edge_position(prof, True)
        bottoms[k] = edge_position(prof, False)
        log("  cap %-2s top %.2f bottom %.2f (export px from the top of the region)" % (
            k, tops[k], bottoms[k]))
    cap_top = by1 - float(np.median(list(tops.values())))
    cap_bottom = by1 - float(np.median(list(bottoms.values())))

    lines = [
        "# MARVIS logotype layout. Units: sprite px (0.6x the 8550x4800 mockup); origin bottom-left of the box, y up.",
        "# Written by Tools/title/extract_logo.py; the glyph order is the draw order.",
        "box %d %d" % (box_w, box_h),
        "cap %s %s" % (("%.1f" % cap_bottom).rstrip("0").rstrip("."), ("%.1f" % cap_top).rstrip("0").rstrip(".")),
    ]
    for k in DRAW_ORDER:
        x0, y0, x1, y1 = rects[k]
        to_sprite(alphas[k][y0:y1, x0:x1]).save(os.path.join(args.out_dir, "logo_%s.png" % k), optimize=True)
        lines.append("glyph %s %d %d %d %d" % (k, x0 - bx0, by1 - y1, x1 - x0, y1 - y0))
    with open(os.path.join(args.out_dir, "logo_layout.txt"), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    log("\n".join(lines))
    log("box origin in the mockup: x %.2f, y(top) %.2f; box width / cap height = %.4f" % (
        ROI[0] + bx0 / scale, ROI[1] + by0 / scale, box_w / (cap_top - cap_bottom)))

    chevron().save(os.path.join(args.out_dir, "icon_chevron.png"), optimize=True)

    if args.preview:
        write_preview(args, roi, (bx0, by0, box_w, box_h))


def write_preview(args, roi, box):
    """Mockup crop (top) and the logo recomposed from the written files (bottom), same scale."""
    bx0, by0, box_w, box_h = box
    pad = 30
    scale = SCALE_NUM / SCALE_DEN
    small = roi.resize((roi.width * SCALE_NUM // SCALE_DEN, roi.height * SCALE_NUM // SCALE_DEN), Image.LANCZOS)
    ref = small.crop((bx0 - pad, by0 - pad, bx0 + box_w + pad, by0 + box_h + pad))
    comp = Image.new("RGB", ref.size, SKY)
    with open(os.path.join(args.out_dir, "logo_layout.txt"), encoding="utf-8") as f:
        for line in f:
            p = line.split()
            if not p or p[0] != "glyph":
                continue
            x, y, w, h = (int(v) for v in p[2:6])
            sprite = Image.open(os.path.join(args.out_dir, "logo_%s.png" % p[1]))
            assert sprite.size == (w, h), (p[1], sprite.size)
            tint = Image.new("RGB", sprite.size, SLAB if p[1] == "t_slab" else BRONZE)
            comp.paste(tint, (pad + x, pad + box_h - y - h), sprite.getchannel("A"))
    out = Image.new("RGB", (ref.width, ref.height * 2 + 6), (90, 90, 90))
    out.paste(ref, (0, 0))
    out.paste(comp, (0, ref.height + 6))
    out.save(args.preview)
    del scale


if __name__ == "__main__":
    main()
