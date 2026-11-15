"""Predicted skyline on a Navcam frame (F12 step 4): project the horizon profile through the
attitude chain and the camera model, then draw a transparent RGBA PNG overlay. Styling from
horizon.yaml ``overlay`` (assumed)."""

from __future__ import annotations

import numpy as np
from PIL import Image, ImageDraw

from pipeline.horizon import config as hcfg
from pipeline.horizon.cahvor import CameraModel, project_az_el
from pipeline.horizon.rays import HorizonProfile


def skyline_pixels(profile: HorizonProfile, model: CameraModel, q, size) -> list[np.ndarray]:
    """Projected skyline as polylines (each (N, 2) px), split where the skyline leaves the frame
    or is unknown. Segments that cross the frame edge keep their outside endpoint."""
    w, h = size
    ok = np.isfinite(profile.elevation_deg) & np.isfinite(profile.distance_m)
    px = np.full((profile.az_deg.size, 2), np.nan)
    if ok.any():
        px[ok] = project_az_el(model, q, profile.az_deg[ok], profile.elevation_deg[ok],
                               profile.distance_m[ok])
    good = np.isfinite(px).all(axis=1)
    inside = good & (px[:, 0] >= 0) & (px[:, 0] <= w - 1) & (px[:, 1] >= 0) & (px[:, 1] <= h - 1)
    n = px.shape[0]
    keep = inside.copy()
    for i in np.nonzero(inside)[0]:  # keep one outside neighbour so lines reach the frame edge
        for j in ((i - 1) % n, (i + 1) % n):
            if good[j]:
                keep[j] = True
    lines, cur = [], []
    order = np.arange(n)
    if keep.all():
        lines.append(px)
        return lines
    start = int(np.argmin(keep))  # start at a gap so wrap-around lines stay whole
    for i in np.roll(order, -start):
        if keep[i]:
            cur.append(px[i])
        elif cur:
            if len(cur) > 1:
                lines.append(np.array(cur))
            cur = []
    if len(cur) > 1:
        lines.append(np.array(cur))
    # drop polylines whose points jump across the image (wrap behind the camera)
    return [ln for ln in lines if np.all(np.abs(np.diff(ln[:, 0])) < w)]


def rows_from_polylines(lines, width: int) -> np.ndarray:
    """Topmost skyline row at each integer column (linear interpolation; NaN where none)."""
    rows = np.full(width, np.inf)
    for ln in lines:
        for (x0, y0), (x1, y1) in zip(ln[:-1], ln[1:], strict=True):
            lo, hi = sorted((x0, x1))
            cols = np.arange(max(0, int(np.ceil(lo))), min(width - 1, int(np.floor(hi))) + 1)
            if cols.size == 0:
                continue
            y = y0 if x1 == x0 else y0 + (cols - x0) * (y1 - y0) / (x1 - x0)
            rows[cols] = np.minimum(rows[cols], y)
    rows[~np.isfinite(rows)] = np.nan
    return rows


def skyline_rows(profile: HorizonProfile, model: CameraModel, q, size) -> np.ndarray:
    return rows_from_polylines(skyline_pixels(profile, model, q, size), size[0])


def render_overlay(size, lines, ticks=None, cfg: dict | None = None) -> Image.Image:
    """Transparent RGBA image of the projected skyline; ``ticks`` = [{x, label, [y]}]."""
    c = (hcfg.load() if cfg is None else cfg)["overlay"]
    w, h = size
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    for ln in lines:
        draw.line([tuple(p) for p in ln], fill=tuple(c["line_rgba"]), width=c["line_width_px"])
    if ticks:
        rows = rows_from_polylines(lines, w)
        for t in ticks:
            x = float(t["x"])
            col = int(round(min(max(x, 0), w - 1)))
            y = float(t.get("y", rows[col]))
            if not np.isfinite(y):
                continue
            draw.line([(x, y - c["line_width_px"]), (x, y - c["tick_len_px"])],
                      fill=tuple(c["tick_rgba"]), width=c["line_width_px"])
            if t.get("label"):
                draw.text((x + 3, y - c["tick_len_px"] - 11), str(t["label"]),
                          fill=tuple(c["tick_rgba"]))
    return img


def frame_camera(frame: dict) -> tuple[CameraModel, np.ndarray]:
    """Camera model and attitude quaternion of a navcam_frames.json record."""
    cm = frame["camera_model"]
    model = CameraModel(cm["type"], cm["C"], cm["A"], cm["H"], cm["V"], O=cm.get("O"),
                        R=cm.get("R"), E=cm.get("E"), linearity=cm.get("linearity"))
    return model, np.asarray(frame["attitude_quaternion"], dtype=float)


def az_ticks(profile: HorizonProfile, model: CameraModel, q, size, items) -> list[dict]:
    """Ticks ``{x, y, label}`` where each item's bearing (``{name, bearing_deg}``) meets the
    predicted skyline inside the frame; items behind the camera or outside are left out."""
    w, h = size
    out = []
    for it in items:
        az = float(it["bearing_deg"])
        el = float(profile.elevation_at(az))
        d = float(profile.distance_at(az))
        if not (np.isfinite(el) and np.isfinite(d)):
            continue
        x, y = project_az_el(model, q, np.array([az]), np.array([el]), d)[0]
        if np.isfinite(x) and np.isfinite(y) and 0 <= x <= w - 1 and 0 <= y <= h - 1:
            out.append({"x": float(x), "y": float(y), "label": it["name"]})
    return out


def composite(grey, overlay: Image.Image, detected_rows=None, cfg: dict | None = None):
    """RGB check image: the Navcam frame, the predicted-skyline overlay on top and (optional) the
    sky detector's rows (NaN = none) in ``overlay.detected_rgba``."""
    c = (hcfg.load() if cfg is None else cfg)["overlay"]
    base = Image.fromarray(np.asarray(grey, dtype=np.uint8)).convert("RGBA")
    if detected_rows is not None:
        det = Image.new("RGBA", base.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(det)
        rows = np.asarray(detected_rows, dtype=float)
        seg: list = []
        for x, y in enumerate(rows):
            if np.isfinite(y):
                seg.append((float(x), float(y)))
            elif seg:
                if len(seg) > 1:
                    draw.line(seg, fill=tuple(c["detected_rgba"]), width=c["line_width_px"])
                seg = []
        if len(seg) > 1:
            draw.line(seg, fill=tuple(c["detected_rgba"]), width=c["line_width_px"])
        base = Image.alpha_composite(base, det)
    return Image.alpha_composite(base, overlay).convert("RGB")
