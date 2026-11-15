"""Station, pad and ring horizons, landmarks, panoramas, Navcam overlays and station-card
fragments (F12).

    python -m pipeline.horizon.cards

Observers (eye height ``horizon.yaml eye_height_m``):
  * pad: the official pad (D21, user 16:14): WS2 ``engine/public/pad.json``'s top-level pad when
    its ``source`` cites D21 and it is not marked as a proposal (a pre-D21 file only when that
    pad is ``site.yaml pad_default``); else pad_default. The ``proposal`` block is never read.
  * stations: WS2 ``engine/public/stations.json``. Access-cell rule (user decision 11:40): the
    observer stands at the station's access cell once WS2 publishes it; until then at the science
    coordinate, and the card is marked ``provisional``.

Outputs (web-facing ones under ``data/interim/horizon/public/``, mirroring the web tree; contracts
README "make web sources"):
  * ``horizons/{pad,S*}.json`` (pipeline-internal, horizon.schema.json)
  * ``public/cards/{S}.json`` card fragments (navcam, skyline_error_deg, panorama_png, landmarks;
    ``make web`` merges WS2's timeline part) and ``public/cards/{S}/{navcam,overlay,panorama}.png``
  * ``public/fp3d/horizon_ring.json`` far skyline ring for WS8
  * ``cards_run.json`` run report
"""

from __future__ import annotations

import csv
import datetime as dt
import json
import math
import re
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from pipeline.horizon import config as hcfg
from pipeline.horizon.geo import bearing_dist, great_circle, lonlat_to_xy
from pipeline.horizon.rays import HorizonProfile, curvature_drop

REPO = hcfg.REPO
HROOT = REPO / "data" / "interim" / "horizon"
PUBLIC = HROOT / "public"
HORIZONS = HROOT / "horizons"
ENGINE_PUBLIC = REPO / "data" / "interim" / "engine" / "public"
TERRAIN = REPO / "data" / "interim" / "terrain"
FRAGMENT_FIELDS = ["navcam", "skyline_error_deg", "panorama_png", "landmarks"]
CLASSES = ("near", "mid", "far")


def _now() -> str:
    return dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _rel(p: Path) -> str:
    p = Path(p)
    return str(p.relative_to(REPO)) if p.is_relative_to(REPO) else str(p)


# --------------------------------------------------------------------------------------------
# Observers
# --------------------------------------------------------------------------------------------

def _access(rec: dict) -> dict | None:
    """Access cell of a WS2 station record, whichever spelling WS2 uses; None if absent."""
    if rec.get("access_lon") is not None and rec.get("access_lat") is not None:
        return {k[len("access_"):]: v for k, v in rec.items() if k.startswith("access_")}
    for key in ("access", "access_cell"):
        a = rec.get(key)
        if isinstance(a, dict) and a.get("lon") is not None and a.get("lat") is not None:
            return dict(a)
    return None


def observer_from_station(rec: dict) -> dict:
    """Observer for a station card under the access-cell rule (user decision 11:40)."""
    o = {"id": rec["id"], "name": rec.get("name"),
         "science_lon": rec["lon"], "science_lat": rec["lat"]}
    acc = _access(rec)
    if acc is not None:
        o.update(lon=float(acc["lon"]), lat=float(acc["lat"]), position="access_cell",
                 provisional=False,
                 access={k: v for k, v in acc.items()
                         if k not in ("lon", "lat") and not isinstance(v, dict)} or None)
    elif "access_lon" in rec or rec.get("access_reason"):
        # WS2 has published its access cells and this station has none (e.g. no walkable cell
        # within access_radius_m): the horizon stays at the science coordinate, not provisional
        o.update(lon=rec["lon"], lat=rec["lat"], position="science_coordinate_no_access",
                 provisional=False,
                 note=f"no access cell (WS2: {rec.get('access_reason') or 'none published'}); "
                      "horizon at the science coordinate")
    else:
        o.update(lon=rec["lon"], lat=rec["lat"], position="science_coordinate",
                 provisional=True,
                 note="WS2 access cell not published yet: horizon at the science coordinate")
    return o


_D21 = re.compile(r"\bD21\b")


def pad_observer(engine_public: Path = ENGINE_PUBLIC, terrain: Path = TERRAIN) -> dict:
    """Pad observer = the official pad (D21, user 16:14 CET).

    WS2 ``pad.json``'s top-level ``pad`` is the official pad when its ``source`` cites D21 and it
    is not marked as a proposal. A pre-D21 file counts only when its top-level pad equals
    ``site.yaml pad_default`` at the file's 6-decimal precision (C 14:58). The ``proposal`` block
    is never read. Otherwise the pad is ``pad_default`` from config, with a ``source_note``
    saying why pad.json was ignored. ``terrain`` is kept for call compatibility."""
    default = hcfg.site()["pad_default"]
    out = {"id": "pad", "lon": default["lon"], "lat": default["lat"],
           "source": "config/site.yaml pad_default"}
    p = Path(engine_public) / "pad.json"
    if not p.exists():
        return out
    d = json.loads(p.read_text()).get("pad") or {}
    marked = any(bool(d.get(k)) for k in ("proposal", "is_proposal")) or \
        str(d.get("role", d.get("kind", ""))).lower() == "proposal"
    try:
        lon, lat = float(d["lon"]), float(d["lat"])
        same = (round(lon, 6), round(lat, 6)) == \
            (round(float(default["lon"]), 6), round(float(default["lat"]), 6))
    except (KeyError, TypeError, ValueError):
        lon = lat = None
        same = False
    cites = bool(_D21.search(str(d.get("source") or "")))
    if lon is not None and not marked and (cites or same):
        tag = " (D21 official pad)" if cites else " (pad_default)"
        return {"id": "pad", "lon": d["lon"], "lat": d["lat"], "source": f"WS2 {_rel(p)}{tag}",
                "pad_source": d.get("source")}
    why = ("marked as a proposal" if marked else "no top-level pad" if lon is None
           else "source does not cite D21 and the pad is not pad_default")
    out["source_note"] = (f"WS2 {_rel(p)} pad ({d.get('lon')}, {d.get('lat')}) ignored: {why} "
                          "(D21: the official pad is pad.json's top-level pad citing D21; the "
                          "proposal block is never read)")
    return out


# --------------------------------------------------------------------------------------------
# Landmarks (IAU gazetteer, docs/discovery.md 3.5)
# --------------------------------------------------------------------------------------------

def load_iau_landmarks(csv_path, lon: float, lat: float, max_km: float | None = None,
                       approval: str | None = None) -> list[dict]:
    """Gazetteer features within ``max_km`` (great circle) of (lon, lat), nearest first."""
    src = hcfg.load()["landmarks_source"]
    max_km = float(src["max_dist_km"] if max_km is None else max_km)
    approval = src["approval"] if approval is None else approval
    out = []
    with open(csv_path, newline="") as fh:
        for r in csv.DictReader(fh):
            if approval and r.get("approval") != approval:
                continue
            lo, la = float(r["center_lon"]), float(r["center_lat"])
            lo = lo - 360.0 if lo > 180.0 else lo
            _, d = great_circle(lon, lat, lo, la)
            if d <= max_km * 1000.0:
                out.append({"name": r["clean_name"], "type": r["type"], "lon": lo, "lat": la,
                            "diameter_km": float(r["diameter"]), "kind": "official",
                            "dist_from_pad_km": d / 1000.0})
    return sorted(out, key=lambda x: x["dist_from_pad_km"])


def landmark_view(obs: dict, lm: dict, engine, profile: HorizonProfile) -> dict:
    """Bearing, distance and elevation angle of a landmark's label point from an observer
    (obs: x, y, z = eye height in the analysis CRS; lon/lat optional). The visibility test uses
    grid geometry (same azimuths as the horizon profile); the reported bearing and distance are
    great-circle when both have lon/lat (they differ by < 0.1 deg, < 0.2 %)."""
    tol = float(hcfg.load()["landmark_rule"]["above_skyline_tol_deg"])
    if "x" in lm:
        lx, ly = float(lm["x"]), float(lm["y"])
    else:
        lx, ly = (float(v) for v in lonlat_to_xy(lm["lon"], lm["lat"]))
    b_grid, d = bearing_dist((obs["x"], obs["y"]), (lx, ly))
    z = engine.ground_z(lx, ly)
    el = (math.degrees(math.atan2(z - obs["z"] - float(curvature_drop(d)), d))
          if np.isfinite(z) and d > 0 else float("nan"))
    sky = float(profile.elevation_at(b_grid))
    above = bool(np.isfinite(el) and np.isfinite(sky) and el >= sky - tol)
    if all(k in obs for k in ("lon", "lat")) and all(k in lm for k in ("lon", "lat")):
        b, dd = great_circle(obs["lon"], obs["lat"], lm["lon"], lm["lat"])
    else:
        b, dd = b_grid, d
    return {"name": lm["name"], "bearing_deg": round(b, 2), "dist_km": round(dd / 1000.0, 2),
            "kind": lm.get("kind"), "el_deg": None if not np.isfinite(el) else round(el, 4),
            "skyline_el_deg": None if not np.isfinite(sky) else round(sky, 4),
            "above_skyline": above, "z_m": None if not np.isfinite(z) else round(float(z), 1),
            "bearing_grid_deg": round(b_grid, 3)}


HIDDEN_KEYS = ("name", "kind", "bearing_deg", "dist_km", "above_skyline", "display")


def classify_landmarks(views: list[dict], rule: dict | None = None,
                       hidden_rule: dict | None = None) -> tuple[list[dict], str | None]:
    """landmarks.yaml rule + D33 (user 16:20). Visible = centre above the computed skyline: up to
    ``max_n``, nearest first, ``display`` = label (drawn at their elevation). Hidden = below the
    skyline, at any distance: all listed after the visible ones, nearest first, as bearing-only
    items (name, kind, bearing, distance, above_skyline false, ``display`` = bearing_tick; no
    elevation). Fewer than ``min_n`` visible are reported in the note, never padded."""
    cfg = hcfg.load()
    r = cfg["landmark_rule"] if rule is None else rule
    h = cfg["hidden_landmarks"] if hidden_rule is None else hidden_rule
    vis = sorted((v for v in views if v["above_skyline"]), key=lambda v: v["dist_km"])
    vis = [{**v, "display": h["visible_display"]} for v in vis[: int(r["max_n"])]]
    hid = sorted((v for v in views if not v["above_skyline"]), key=lambda v: v["dist_km"])
    hid = [{k: v for k, v in {**v, "above_skyline": False, "display": h["display"]}.items()
            if k in HIDDEN_KEYS} for v in hid]
    note = None
    if len(vis) < int(r["min_n"]):
        note = (f"{len(vis)} landmark(s) rise above the computed skyline (fewer than "
                f"{r['min_n']}); {len(hid)} {h['label']} are listed as bearing-only ticks (D33)")
    return vis + hid, note


def overlay_items(stop: dict, landmarks: list[dict], engine, profile: HorizonProfile) -> list[dict]:
    """Landmarks for the Navcam overlay (D33): only those above the skyline seen from the frame's
    own stop (``stop``: x, y, z eye; ``profile``: the stop horizon), at their grid bearing."""
    out = []
    for lm in landmarks:
        v = landmark_view(stop, lm, engine, profile)
        if v["above_skyline"]:
            out.append({"name": lm["name"], "bearing_deg": v["bearing_grid_deg"]})
    return out


# --------------------------------------------------------------------------------------------
# Panorama strip
# --------------------------------------------------------------------------------------------

def pano_xy(meta: dict, az_deg: float, el_deg: float) -> tuple[float, float]:
    """Pixel (x, y) of (azimuth, elevation) on a panorama rendered by ``render_panorama``."""
    p = meta["px_per_deg"]
    return (az_deg % 360.0) * p, meta["top_px"] + (meta["el_top_deg"] - el_deg) * p


def _font(px: int):
    try:
        return ImageFont.load_default(size=px)
    except TypeError:  # Pillow without FreeType sizes
        return ImageFont.load_default()


def render_panorama(profile: HorizonProfile, marks: list[dict], cfg: dict | None = None):
    """Equirectangular strip (north at the left edge, azimuth increasing to the right, same
    scale on both axes): sky above the computed skyline, ground below, unknown azimuths left as
    sky with no line; visible landmarks as ticks at (bearing, elevation) with "name dist km"
    labels; hidden ones (``display`` bearing_tick, D33) as bearing-only ticks in a bottom band
    (``meta['strip_height_px']`` = the strip without that band)."""
    pc = (hcfg.load() if cfg is None else cfg)["panorama"]
    ppd = float(pc["px_per_deg"])
    el = np.asarray(profile.elevation_deg, dtype=float)
    hidden = [m for m in marks if m.get("display") == "bearing_tick"]
    marks = [m for m in marks if m.get("display") != "bearing_tick"]
    mark_el = [m["el_deg"] for m in marks if m.get("el_deg") is not None]
    lo = math.floor(np.nanmin(el) - pc["el_margin_deg"]) if np.isfinite(el).any() else -5
    hi = math.ceil(max([np.nanmax(el) if np.isfinite(el).any() else 0.0, *mark_el])
                   + pc["el_margin_deg"])
    hi = max(hi, lo + int(pc["min_el_span_deg"]))
    w = int(round(360 * ppd))
    top = int(pc["label_band_px"])
    h = top + int(round((hi - lo) * ppd))
    meta = {"px_per_deg": ppd, "el_top_deg": hi, "el_bottom_deg": lo, "top_px": top,
            "width": w, "height": h, "az_left_deg": 0.0,
            "observer": profile.observer, "eye_height_m": profile.eye_height_m}
    font = _font(int(pc["font_px"]))
    band_h, hidden_rows = _hidden_band_layout(hidden, ppd, w, font, int(pc["font_px"]), cfg)
    meta["strip_height_px"] = h
    meta["height"] = h + band_h
    img = Image.new("RGB", (w, h + band_h), tuple(pc["sky_rgb"]))
    draw = ImageDraw.Draw(img)
    xs = np.arange(w)
    az = (xs + 0.5) / ppd
    e = profile.elevation_at(az)
    ys = top + (hi - e) * ppd
    for x, y in zip(xs, ys, strict=True):
        if np.isfinite(y):
            draw.line([(int(x), int(math.ceil(y))), (int(x), h - 1)], fill=tuple(pc["ground_rgb"]))
    seg: list = []
    for x, y in zip(xs, ys, strict=True):
        if np.isfinite(y):
            seg.append((float(x), float(y)))
        elif seg:
            if len(seg) > 1:
                draw.line(seg, fill=tuple(pc["line_rgb"]), width=1)
            seg = []
    if len(seg) > 1:
        draw.line(seg, fill=tuple(pc["line_rgb"]), width=1)
    for i, c in enumerate("NESW"):
        draw.text((i * 90 * ppd + 3, h - pc["font_px"] - 3), c, fill=tuple(pc["line_rgb"]),
                  font=font)
    last_x, row = -1e9, 0
    for m in sorted(marks, key=lambda m: m["bearing_deg"]):
        mel = m.get("el_deg")
        if mel is None:
            mel = float(profile.elevation_at(m["bearing_deg"]))
        if not np.isfinite(mel):
            continue
        x, y = pano_xy(meta, m["bearing_deg"], mel)
        draw.line([(x, y - 2), (x, y - 12)], fill=tuple(pc["tick_rgb"]), width=2)
        label = f"{m['name']} {m['dist_km']:.1f} km"
        tw = draw.textlength(label, font=font)
        row = row + 1 if x - last_x < tw + 6 else 0
        ty = max(0.0, min(y - 14, top) - (row + 1) * (pc["font_px"] + 2))
        tx = min(x + 2, w - tw - 2)
        draw.line([(x, ty + pc["font_px"]), (x, y - 12)], fill=tuple(pc["tick_rgb"]), width=1)
        draw.text((tx, ty), label, fill=tuple(pc["tick_rgb"]), font=font)
        last_x = x
    if hidden:
        _draw_hidden(draw, profile, meta, hidden_rows, font, cfg)
    return img, meta


def _hidden_label(m: dict, cfg: dict | None = None) -> str:
    lab = (hcfg.load() if cfg is None else cfg)["hidden_landmarks"]["label"]
    return f"{m['name']} {m['dist_km']:.1f} km ({lab})"


def _hidden_band_layout(hidden: list[dict], ppd: float, w: int, font, font_px: int,
                        cfg: dict | None = None) -> tuple[int, list[tuple]]:
    """Bottom band for the bearing-only ticks (D33): (band height px, [(mark, x, tx, row)]).
    Labels are stacked greedily into rows so they never overlap."""
    if not hidden:
        return 0, []
    ph = (hcfg.load() if cfg is None else cfg)["panorama_hidden"]
    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    rows_end: list[float] = []
    out = []
    for m in sorted(hidden, key=lambda m: m["bearing_deg"] % 360.0):
        x = (m["bearing_deg"] % 360.0) * ppd
        tw = probe.textlength(_hidden_label(m, cfg), font=font)
        tx = max(2.0, min(x + 2, w - tw - 2))
        row = next((i for i, e in enumerate(rows_end) if e + 6 < tx), len(rows_end))
        if row == len(rows_end):
            rows_end.append(0.0)
        rows_end[row] = tx + tw
        out.append((m, x, tx, row))
    band_h = int(ph["tick_len_px"]) + len(rows_end) * (font_px + 2) + 4
    return band_h, out


def _draw_hidden(draw, profile: HorizonProfile, meta: dict, rows: list[tuple], font,
                 cfg: dict | None = None) -> None:
    """Hidden landmarks (D33): a dashed line through the ground from the skyline down at the
    bearing (no elevation), and a tick + "name dist km (below skyline)" in the bottom band."""
    c = hcfg.load() if cfg is None else cfg
    ph, fpx = c["panorama_hidden"], int(c["panorama"]["font_px"])
    rgb = tuple(ph["tick_rgb"])
    h, hb = meta["strip_height_px"], meta["height"]
    draw.rectangle([(0, h), (meta["width"] - 1, hb - 1)], fill=tuple(ph["band_rgb"]))
    on, off = (int(v) for v in ph["dash_px"])
    tl = int(ph["tick_len_px"])
    for m, x, _tx, row in rows:
        e = float(profile.elevation_at(m["bearing_deg"]))
        y0 = math.ceil(pano_xy(meta, m["bearing_deg"], e)[1]) + 1 if np.isfinite(e) else h // 2
        for y in range(int(y0), h, on + off):
            draw.line([(x, y), (x, min(y + on - 1, h - 1))], fill=rgb, width=1)
        draw.line([(x, h), (x, h + tl)], fill=rgb, width=2)
        if row:
            draw.line([(x, h + tl), (x, h + tl + 2 + row * (fpx + 2) + fpx // 2)], fill=rgb,
                      width=1)
    for m, _x, tx, row in rows:     # labels last, on band-coloured boxes over other leaders
        ty = h + tl + 2 + row * (fpx + 2)
        label = _hidden_label(m, c)
        draw.rectangle([(tx - 1, ty), (tx + draw.textlength(label, font=font) + 1, ty + fpx + 1)],
                       fill=tuple(ph["band_rgb"]))
        draw.text((tx, ty), label, fill=rgb, font=font)


# --------------------------------------------------------------------------------------------
# Far skyline ring for WS8
# --------------------------------------------------------------------------------------------

def ring_doc(engine, obs: dict, min_range_m: float | None = None,
             eye_height_m: float | None = None) -> dict:
    """Horizon from ``obs`` counting only terrain at least ``min_range_m`` away (default
    site.yaml planning_radius_m: the near 8 m mesh covers the rest). Each azimuth gives the
    horizon point as east/north offsets from the observer and its terrain height z_m
    (back-computed from the elevation angle, so elev_deg = atan((z_m - z_eye - d^2/2R)/d))."""
    cfg = hcfg.load()
    if min_range_m is None:
        min_range_m = float(hcfg.site()["planning_radius_m"])
    eye = float(cfg["eye_height_m"] if eye_height_m is None else eye_height_m)
    x, y = (float(obs["x"]), float(obs["y"])) if "x" in obs else \
        (float(v) for v in lonlat_to_xy(obs["lon"], obs["lat"]))
    prof = engine.horizon(x, y, eye_height_m=eye, min_dist_m=float(min_range_m))
    z_eye = float(prof.observer["z"])
    d = np.asarray(prof.distance_m, dtype=float)
    el = np.asarray(prof.elevation_deg, dtype=float)
    z = z_eye + d * np.tan(np.radians(el)) + curvature_drop(d)
    a = np.radians(prof.az_deg)

    def f(v, nd):
        return [None if not np.isfinite(t) else round(float(t), nd) for t in v]

    zg = prof.observer.get("z_ground")
    return {
        "observer": {"id": obs.get("id"), "lon": obs.get("lon"), "lat": obs.get("lat"),
                     "x": round(x, 2), "y": round(y, 2), "eye_height_m": eye,
                     "z_ground_m": None if zg is None else round(zg, 2),
                     "z_eye_m": None if not np.isfinite(z_eye) else round(z_eye, 2),
                     "source": obs.get("source")},
        "az_step_deg": prof.az_step_deg,
        "min_range_m": float(min_range_m),
        "max_range_m": float(cfg["sampling"][-1]["to_m"]),
        "crs": hcfg.analysis_proj(),
        "azimuth_convention": "deg clockwise from grid north (analysis CRS)",
        "radius_m": hcfg.mars_radius_m(),
        "notes": "elev_deg includes the curvature drop d^2/2R; z_m is the terrain height of the "
                 "horizon point (areoid, m); east_m/north_m are offsets from the observer in the "
                 "analysis CRS; null = unknown (no DEM data)",
        "az_deg": [round(float(v), 4) for v in prof.az_deg],
        "elev_deg": f(el, 5), "dist_m": f(d, 1), "z_m": f(z, 2),
        "east_m": f(d * np.sin(a), 1), "north_m": f(d * np.cos(a), 1),
        "source": list(prof.source),
    }


# --------------------------------------------------------------------------------------------
# Navcam frame, overlay and card fragment
# --------------------------------------------------------------------------------------------

def nearest_suitable_frame(xy, frames: list[dict], v2_by_id: dict):
    """(frame, distance m) of the nearest frame (``x``, ``y`` = its stop's camera position) whose
    V2 entry is ok and not rejected by the manual check; (None, None) if there is none."""
    best, best_d = None, None
    for f in frames:
        e = v2_by_id.get(f["image_id"]) or {}
        if e.get("status") != "ok" or e.get("manual_ok") is False:
            continue
        d = math.hypot(f["x"] - xy[0], f["y"] - xy[1])
        if best_d is None or d < best_d:
            best, best_d = f, d
    return best, best_d


def tag_station_frames(doc: dict, picks: dict) -> dict:
    """Set ``station`` on the card frames in navcam_frames.json (C request for WS9 F22).

    ``picks``: station id -> {image_id, dist_m, position}. Tags from an earlier card run
    (``station_source == "card_frame"``) are cleared first; a station tag from the stop rule
    (S4 drive end) is kept. A frame chosen by several stations keeps them all in ``stations``
    and the first (station order) in ``station``."""
    for f in doc["frames"]:
        if f.get("station_source") == "card_frame":
            f["station"] = None
            for k in ("station_source", "stations", "station_dist_m", "station_observer"):
                f.pop(k, None)
    by_id = {f["image_id"]: f for f in doc["frames"]}
    for sid, pk in picks.items():
        f = by_id.get(pk["image_id"])
        if f is None:
            continue
        if f.get("station_source") != "card_frame":
            f.update(station=sid, station_source="card_frame", stations=[],
                     station_dist_m={}, station_observer={})
        f["stations"].append(sid)
        f["station_dist_m"][sid] = None if pk.get("dist_m") is None else round(pk["dist_m"], 1)
        f["station_observer"][sid] = pk.get("position")
    return doc


def card_fragment(station_id: str, *, observer: dict, frame: dict | None,
                  frame_dist_m: float | None, frame_errors: dict | None, landmarks: list[dict],
                  landmarks_note: str | None, panorama: bool = True) -> dict:
    """WS3's part of cards/{S}.json (C decision 11:42; make web merges WS2's timeline part)."""
    base = f"cards/{station_id}"
    if frame is not None:
        navcam = {"sol": frame.get("sol"), "image_id": frame["image_id"],
                  "url_local": f"{base}/navcam.png", "overlay_png": f"{base}/overlay.png",
                  "stop_id": frame.get("stop_id"),
                  "dist_to_observer_m": None if frame_dist_m is None else round(frame_dist_m, 1),
                  "credit": "NASA/JPL-Caltech (Curiosity Navcam)"}
    else:
        navcam = {"sol": None, "image_id": None, "url_local": None, "overlay_png": None}
    errs = {c: None if not frame_errors or frame_errors.get(c) is None
            else round(float(frame_errors[c]), 3) for c in CLASSES}
    return {
        "station": station_id,
        "producer": "WS3 pipeline/horizon/cards.py",
        "provisional": bool(observer.get("provisional")),
        "observer": observer,
        "navcam": navcam,
        "skyline_error_deg": errs,
        "skyline_error_scope": ("median |detected - predicted| skyline elevation per distance "
                                "class on this card's Navcam frame (automatic sky detector, no "
                                "manual review, D7; far class not validated: the far rim is "
                                "hidden by haze in north-facing frames)") if frame else None,
        "panorama_png": f"{base}/panorama.png" if panorama else None,
        "landmarks": [{k: lm[k] for k in ("name", "bearing_deg", "dist_km", "kind",
                                          "above_skyline", "display") if k in lm}
                      for lm in landmarks],
        "landmarks_note": landmarks_note,
        "built_utc": _now(),
    }


def _frame_xy(frames: list[dict], horizons_dir: Path) -> list[dict]:
    """Frames with the camera position their stop horizon was computed at (x, y)."""
    out, cache = [], {}
    for f in frames:
        sid = f.get("stop_id")
        if sid not in cache:
            p = horizons_dir / f"{sid}.json"
            cache[sid] = HorizonProfile.read_json(p) if p.exists() else None
        prof = cache[sid]
        if prof is None:
            continue
        out.append({**f, "x": float(prof.observer["x"]), "y": float(prof.observer["y"]),
                    "_profile": prof})
    return out


def _write_overlay(frame: dict, landmarks: list[dict], engine, out_dir: Path) -> list[str]:
    """Navcam frame as PNG + transparent overlay (frame's stop horizon; ticks only for the
    landmarks visible from that stop, D33). Returns the ticked landmark names."""
    from pipeline.horizon.overlay import (  # noqa: PLC0415
        az_ticks,
        frame_camera,
        render_overlay,
        skyline_pixels,
    )

    prof = frame["_profile"]
    grey = Image.open(REPO / frame["local_path"]).convert("L")
    size = grey.size
    out_dir.mkdir(parents=True, exist_ok=True)
    grey.save(out_dir / "navcam.png", optimize=True)
    model, q = frame_camera(frame)
    stop = {"x": frame["x"], "y": frame["y"], "z": float(prof.observer["z"])}
    items = overlay_items(stop, landmarks, engine, prof)
    ticks = az_ticks(prof, model, q, size, items)
    render_overlay(size, skyline_pixels(prof, model, q, size), ticks).save(
        out_dir / "overlay.png", optimize=True)
    return [t.get("label") for t in ticks]


def _slug(name: str) -> str:
    return "".join(ch if ch.isalnum() else "_" for ch in name).strip("_")


def run(*, engine=None, stations_json: Path | None = None, public: Path = PUBLIC,
        horizons_dir: Path = HORIZONS, record_manifest: bool = True, log=print) -> dict:
    from pipeline.horizon.contracts import validate  # noqa: PLC0415

    cfg = hcfg.load()
    if engine is None:
        from pipeline.horizon.bands import load_engine  # noqa: PLC0415

        engine = load_engine()
    eye = float(cfg["eye_height_m"])
    report: dict = {"built_utc": _now(), "eye_height_m": eye, "observers": {}, "cards": {}}

    # pad horizon + far ring
    pad = pad_observer()
    px, py = (float(v) for v in lonlat_to_xy(pad["lon"], pad["lat"]))
    pad.update(x=px, y=py)
    prof = engine.horizon(px, py, eye_height_m=eye)
    prof.meta = {"kind": "pad", "lon": pad["lon"], "lat": pad["lat"], "height_kind": "eye",
                 "position": pad["source"]}
    prof.write_json(horizons_dir / "pad.json", observer_id="pad")
    validate(json.loads((horizons_dir / "pad.json").read_text()), "horizon.schema.json")
    report["observers"]["pad"] = {k: pad[k] for k in ("lon", "lat", "source", "pad_source",
                                                      "source_note") if k in pad}
    if pad.get("source_note"):
        log(f"pad: {pad['source_note']}")
    ring = ring_doc(engine, pad)
    validate(ring, "horizon_ring.schema.json")
    rp = public / "fp3d" / "horizon_ring.json"
    rp.parent.mkdir(parents=True, exist_ok=True)
    rp.write_text(json.dumps(ring, separators=(",", ":")))
    log(f"pad ({pad['source']}): horizon + ring -> {_rel(rp)}")

    # stations
    sj = Path(stations_json or ENGINE_PUBLIC / "stations.json")
    if not sj.exists():
        log(f"{sj}: missing (WS2); no station cards")
        return report
    stations = json.loads(sj.read_text())
    src = cfg["landmarks_source"]
    landmarks = load_iau_landmarks(REPO / src["csv"], pad["lon"], pad["lat"])
    v2 = json.loads((HROOT / "validation" / "v2.json").read_text())
    v2_by_id = {f["image_id"]: f for f in v2["frames"]}
    frames = _frame_xy(json.loads((HROOT / "navcam_frames.json").read_text())["frames"],
                       horizons_dir)
    cards_dir = public / "cards"
    if cards_dir.exists():
        shutil.rmtree(cards_dir)  # own output tree: no stale cards for removed stations
    cards_dir.mkdir(parents=True)
    picks: dict = {}
    for rec in stations:
        sid = rec["id"]
        obs = observer_from_station(rec)
        x, y = (float(v) for v in lonlat_to_xy(obs["lon"], obs["lat"]))
        prof = engine.horizon(x, y, eye_height_m=eye)
        prof.meta = {"kind": "station", "station": sid, "lon": obs["lon"], "lat": obs["lat"],
                     "height_kind": "eye", "position": obs["position"],
                     "provisional": obs["provisional"]}
        prof.write_json(horizons_dir / f"{sid}.json", observer_id=sid)
        z = float(prof.observer["z"])
        o = {"x": x, "y": y, "z": z, "lon": obs["lon"], "lat": obs["lat"]}
        views = [landmark_view(o, lm, engine, prof) for lm in landmarks]
        picked, note = classify_landmarks(views)
        sdir = cards_dir / sid
        sdir.mkdir(parents=True, exist_ok=True)
        pano_ok = bool(np.isfinite(prof.elevation_deg).any())
        if pano_ok:
            img, meta = render_panorama(prof, picked)
            img.save(sdir / "panorama.png", optimize=True)
        frame, fdist = nearest_suitable_frame((x, y), frames, v2_by_id)
        errs, overlay_names = None, []
        if frame is not None:
            picks[sid] = {"image_id": frame["image_id"], "dist_m": fdist,
                          "position": obs["position"]}
            overlay_names = _write_overlay(frame, landmarks, engine, sdir)
            errs = {c: v2_by_id[frame["image_id"]]["summary"][c]["median_abs_deg"]
                    for c in CLASSES}
        frag = card_fragment(sid, observer=obs, frame=frame, frame_dist_m=fdist,
                             frame_errors=errs, landmarks=picked, landmarks_note=note,
                             panorama=pano_ok)
        validate(frag, "card.schema.json", properties=FRAGMENT_FIELDS)
        (cards_dir / f"{sid}.json").write_text(json.dumps(frag, indent=1))
        report["observers"][sid] = {k: obs[k] for k in ("lon", "lat", "position", "provisional")}
        report["cards"][sid] = {"frame": frame and frame["image_id"],
                                "frame_stop": frame and frame.get("stop_id"),
                                "frame_dist_m": None if fdist is None else round(fdist, 1),
                                "skyline_error_deg": frag["skyline_error_deg"],
                                "landmarks": [(v["name"], v["bearing_deg"], v["dist_km"],
                                               v["el_deg"], v["skyline_el_deg"],
                                               v["above_skyline"]) for v in views],
                                "picked": [(p["name"], p["display"]) for p in picked],
                                "overlay_landmarks": overlay_names, "note": note}
        if record_manifest:
            _record_card(sid, frag)
        log(f"{sid}: {obs['position']}{' (provisional)' if obs['provisional'] else ''}; frame "
            f"{frame and frame['image_id']} at {fdist and round(fdist)} m; landmarks "
            f"{[(p['name'], p['display']) for p in picked]}; overlay {overlay_names}")
    # C request (WS9 F22): tag each card frame with its station in navcam_frames.json
    fj = HROOT / "navcam_frames.json"
    nf = tag_station_frames(json.loads(fj.read_text()), picks)
    validate(nf, "navcam_frames.schema.json")
    fj.write_text(json.dumps(nf, indent=1))
    report["station_frames"] = {sid: pk["image_id"] for sid, pk in picks.items()}
    log(f"navcam_frames.json station tags: {report['station_frames']}")
    (HROOT / "cards_run.json").write_text(json.dumps(report, indent=1))
    return report


def _record_card(sid: str, frag: dict) -> None:
    from pipeline.provenance.manifest import record  # noqa: PLC0415

    rel = f"cards/{sid}.json"
    record(f"navcam_sol.{sid}", frag["navcam"]["sol"], "sol", file=rel, script=__file__)
    for c in CLASSES:
        record(f"skyline_error_deg.{sid}.{c}", frag["skyline_error_deg"][c], "deg", file=rel,
               script=__file__)
    for lm in frag["landmarks"]:
        k = f"landmark.{sid}.{_slug(lm['name'])}"
        record(f"{k}.bearing_deg", lm["bearing_deg"], "deg", file=rel, script=__file__)
        record(f"{k}.dist_km", lm["dist_km"], "km", file=rel, script=__file__)


def main(argv=None) -> int:
    import argparse  # noqa: PLC0415

    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--no-manifest", action="store_true")
    a = ap.parse_args(argv)
    run(record_manifest=not a.no_manifest)
    return 0


if __name__ == "__main__":
    sys.exit(main())
