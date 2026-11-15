"""Navcam frames at Curiosity drive ends (F12 overlay, F13 V2, F22 skyline fix, X8):
raw-image API query -> cache in data/raw/navcam/ -> data/interim/horizon/navcam_frames.json.

    python -m pipeline.horizon.navcam fetch [--dry-run] [--max-mb N]
    python -m pipeline.horizon.navcam rebuild          # navcam_frames.json from the cache only

API fields, frames and conventions: docs/discovery.md §3.3 (cited in horizon.yaml
``navcam_api``). The camera model is CAHVOR in the rover frame (+X fwd, +Y right, +Z down); the
attitude quaternion (w, x, y, z) rotates rover-frame vectors into the site frame (N, E, Down).

Selection (horizon.yaml ``navcam_selection``, WS3 assumptions): drive ends inside
site.yaml ``aoi_focus`` from MMGIS (drive ends only, discovery §3.1; D0's cached copy of
MSL_waypoints.json), stations whose stations.yaml rule names a drive end first, then
farthest-point order (distinct places first). At each stop, left Navcam frames with
the drive-end site/drive whose top-centre pixel looks at least ``top_row_min_el_deg`` above the
local level and whose bottom-centre pixel is at most ``bottom_row_max_el_deg`` (skyline can be in
frame); up to ``max_frames_per_stop`` with the widest azimuth spread. Every stop tried is listed
with its outcome (no silent drops).

Downloaded content is untrusted data: JSON is parsed with ``json`` only and every numeric field is
parsed by a strict number pattern; images are checked for JPEG magic and size. No API key is used
or stored (the API needs none; ``api_key`` parameters are stripped from any stored URL).
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

from pipeline.horizon import config as hcfg
from pipeline.horizon.cahvor import (
    CameraModel,
    matrix_to_ypr,
    pixels_to_az_el,
    quat_to_matrix,
)
from pipeline.horizon.geo import lonlat_to_xy

REPO = hcfg.REPO
CACHE = REPO / "data" / "raw" / "navcam"
OUT = REPO / "data" / "interim" / "horizon" / "navcam_frames.json"
WAYPOINTS_D0 = REPO / "data" / "raw" / "discovery" / "mmgis_MSL_waypoints.json"
USER_AGENT = "homeline-pipeline/0.1 (research; contact via repo)"

_NUM = r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"
_TUPLE = re.compile(rf"^\(\s*{_NUM}(?:\s*,\s*{_NUM})*\s*\)$")
_LMST = re.compile(r"^Sol-(\d{5})M(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)$")
_IMAGE_ID = re.compile(r"^[A-Za-z0-9_\-]+$")


# --------------------------------------------------------------------------------------------
# Parsing (pure)
# --------------------------------------------------------------------------------------------

def parse_tuple(s, n: int | None = None) -> list[float]:
    """'(a,b,c)' -> [a, b, c] (strict)."""
    s = str(s).strip()
    if not _TUPLE.match(s):
        raise ValueError(f"not a numeric tuple: {s[:80]!r}")
    vals = [float(v) for v in re.findall(_NUM, s)]
    if n is not None and len(vals) != n:
        raise ValueError(f"expected {n} numbers, got {len(vals)}")
    if not all(math.isfinite(v) for v in vals):
        raise ValueError("non-finite number")
    return vals


def parse_cahvor_components(s: str) -> dict:
    """camera_model_component_list 'C;A;H;V;O;R' (6 triples) -> contract camera_model dict."""
    parts = [p for p in str(s).split(";") if p.strip()]
    if len(parts) != 6:
        raise ValueError(f"CAHVOR needs 6 components, got {len(parts)}")
    vecs = [parse_tuple(p, 3) for p in parts]
    return {"type": "CAHVOR", **dict(zip("CAHVOR", vecs, strict=True)),
            "frame": hcfg.load()["navcam_api"]["camera_frame"]}


def parse_lmst(s) -> dict | None:
    """'Sol-05069M11:45:37.817' -> {sol, hours} (None if absent / other format)."""
    if s is None:
        return None
    m = _LMST.match(str(s).strip())
    if not m:
        return None
    sol, hh, mm, ss = int(m[1]), int(m[2]), int(m[3]), float(m[4])
    return {"sol": sol, "hours": hh + mm / 60.0 + ss / 3600.0}


def strip_key(url: str) -> str:
    """Remove any api_key query parameter from a URL before it is stored."""
    u = urllib.parse.urlsplit(url)
    q = [(k, v) for k, v in urllib.parse.parse_qsl(u.query, keep_blank_values=True)
         if k.lower() != "api_key"]
    return urllib.parse.urlunsplit(u._replace(query=urllib.parse.urlencode(q, safe=":+|,")))


def parse_item(item: dict) -> dict:
    """One raw-image API item (discovery §3.3 field names) -> frame record (contract fields +
    extras). Raises ValueError on anything malformed."""
    ext = item.get("extended") or {}
    image_id = str(item["imageid"])
    if not _IMAGE_ID.match(image_id):
        raise ValueError(f"unexpected image id {image_id[:40]!r}")
    if item.get("camera_model_type") != "CAHVOR":
        raise ValueError(f"camera_model_type {item.get('camera_model_type')!r} (Navcam: CAHVOR)")
    sub = [int(v) for v in parse_tuple(item["subframe_rect"], 4)]
    scale = int(item.get("scale_factor") or 1)
    if scale < 1:
        raise ValueError("scale_factor < 1")
    q = parse_tuple(item["attitude"], 4)
    url = strip_key(str(item.get("https_url") or item["url"]))
    if not url.startswith("https://mars.nasa.gov/"):
        raise ValueError(f"unexpected image host: {url[:60]!r}")
    rec = {
        "image_id": image_id,
        "instrument": str(item["instrument"]),
        "sol": int(item["sol"]),
        "site": int(item["site"]) if item.get("site") is not None else None,
        "drive": int(item["drive"]) if item.get("drive") is not None else None,
        "camera_model": parse_cahvor_components(item["camera_model_component_list"]),
        "attitude_quaternion": q,
        "lmst": ext.get("lmst"),
        "utc": _utc(item.get("date_taken")),
        "sample_type": ext.get("sample_type"),
        "scale_factor": scale,
        "subframe": sub,
        "width": max(1, sub[2] // scale),
        "height": max(1, sub[3] // scale),
        "mast_az_deg": _float_or_none(ext.get("mast_az")),
        "mast_el_deg": _float_or_none(ext.get("mast_el")),
        "camera_vector": (parse_tuple(item["camera_vector"], 3)
                          if item.get("camera_vector") else None),
        "xyz_site_m": parse_tuple(item["xyz"], 3) if item.get("xyz") else None,
        "spacecraft_clock": _float_or_none(item.get("spacecraft_clock")),
        "url": url,
    }
    return rec


def _float_or_none(v):
    if v is None or v == "":
        return None
    f = float(v)
    return f if math.isfinite(f) else None


def _utc(s):
    if not s:
        return None
    t = dt.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    return t.astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


# --------------------------------------------------------------------------------------------
# Geometry (pure)
# --------------------------------------------------------------------------------------------

def frame_model(rec: dict) -> CameraModel:
    cm = rec["camera_model"]
    return CameraModel(cm["type"], cm["C"], cm["A"], cm["H"], cm["V"], O=cm.get("O"),
                       R=cm.get("R"))


def rover_ypr(rec: dict) -> tuple[float, float, float]:
    """Rover yaw (deg from north, clockwise, [0, 360)), pitch, roll from the attitude."""
    return matrix_to_ypr(quat_to_matrix(rec["attitude_quaternion"]))


def a_vector_rover_az_el(rec: dict) -> tuple[float, float]:
    """Azimuth / elevation of the A vector in the rover frame (deg; az from +X toward +Y,
    el positive up = -Z): comparable with the label's mast_az / mast_el."""
    a = np.asarray(rec["camera_model"]["A"], dtype=float)
    return (math.degrees(math.atan2(a[1], a[0])) % 360.0,
            math.degrees(math.atan2(-a[2], math.hypot(a[0], a[1]))))


def model_pixels_ok(rec: dict) -> tuple[bool, str | None]:
    """Image pixels equal model pixels only for full frames / subframes starting at (1, 1)
    (the offset convention for other subframes is unverified: discovery §8 WS3 #1)."""
    x0, y0 = rec["subframe"][:2]
    if (x0, y0) != (1, 1):
        return False, f"subframe origin ({x0},{y0}) != (1,1): pixel offset convention unverified"
    return True, None


def sky_geometry(rec: dict) -> dict:
    """Site-frame az/el of the centre column's top and bottom pixel and of the image centre."""
    m = frame_model(rec)
    q = rec["attitude_quaternion"]
    w, h = rec["width"], rec["height"]
    cx = (w - 1) / 2.0
    px = np.array([[cx, 0.0], [cx, h - 1.0], [cx, (h - 1) / 2.0]])
    az, el = pixels_to_az_el(m, q, px)
    return {"az_centre_deg": float(az[2]), "el_centre_deg": float(el[2]),
            "el_top_deg": float(el[0]), "el_bottom_deg": float(el[1])}


def camera_offset_site(rec: dict) -> list[float]:
    """Camera centre C relative to the rover-frame origin, in the site frame (N, E, Down), m."""
    return (quat_to_matrix(rec["attitude_quaternion"])
            @ np.asarray(rec["camera_model"]["C"], dtype=float)).tolist()


def sky_test(rec: dict, sel: dict) -> tuple[bool, str | None, dict]:
    ok, why = model_pixels_ok(rec)
    if not ok:
        return False, why, {}
    g = sky_geometry(rec)
    if not (g["el_top_deg"] >= sel["top_row_min_el_deg"]):
        return False, f"top row at {g['el_top_deg']:.1f} deg < {sel['top_row_min_el_deg']}", g
    if not (g["el_bottom_deg"] <= sel["bottom_row_max_el_deg"]):
        return False, f"bottom row at {g['el_bottom_deg']:.1f} deg > " \
                      f"{sel['bottom_row_max_el_deg']}", g
    return True, None, g


def spread_pick(cands: list[dict], k: int) -> list[dict]:
    """Up to k frames with the widest azimuth spread: start from the frame with the highest
    top-row elevation (most sky), then repeatedly the frame farthest (in azimuth) from those
    already picked. Ties by image id (deterministic)."""
    if not cands:
        return []
    pool = sorted(cands, key=lambda r: (-r["geometry"]["el_top_deg"], r["image_id"]))
    picked = [pool.pop(0)]
    while pool and len(picked) < k:
        def gap(r):
            return min(abs((r["geometry"]["az_centre_deg"] - p["geometry"]["az_centre_deg"]
                            + 180.0) % 360.0 - 180.0) for p in picked)
        pool.sort(key=lambda r: (-gap(r), r["image_id"]))
        picked.append(pool.pop(0))
    return picked


# --------------------------------------------------------------------------------------------
# Stops (drive ends)
# --------------------------------------------------------------------------------------------

def load_drive_ends(path=WAYPOINTS_D0) -> list[dict]:
    d = json.loads(Path(path).read_text())
    out = []
    for f in d["features"]:
        p = f["properties"]
        out.append({"rmc": str(p["RMC"]), "site": int(p["site"]), "drive": int(p["drive"]),
                    "sol": int(p["sol"]), "lon": float(p["lon"]), "lat": float(p["lat"]),
                    "elev_geoid_m": float(p["elev_geoid"]), "yaw_deg": float(p["yaw"]),
                    "pitch_deg": float(p["pitch"]), "roll_deg": float(p["roll"])})
    return out


def nearest_sol_rmc(drive_ends: list[dict], sol: int) -> str | None:
    """Drive end nearest a sol (stations.yaml S4 rule); ties: the last drive of that sol."""
    if not drive_ends:
        return None
    return min(drive_ends, key=lambda d: (abs(d["sol"] - sol), -d["drive"]))["rmc"]


def in_aoi(de: dict, aoi: dict) -> bool:
    return aoi["west"] <= de["lon"] <= aoi["east"] and aoi["south"] <= de["lat"] <= aoi["north"]


def order_stops(drive_ends: list[dict], first: list[dict], min_spacing_m: float) -> list[dict]:
    """Stations with a drive-end rule first, then farthest-point order over the rest; drive ends
    closer than ``min_spacing_m`` to an already-ordered stop are left out (same place)."""
    by_rmc = {d["rmc"]: d for d in drive_ends}
    x, y = lonlat_to_xy(np.array([d["lon"] for d in drive_ends]),
                        np.array([d["lat"] for d in drive_ends]))
    xy = np.column_stack([x, y])
    idx = {d["rmc"]: i for i, d in enumerate(drive_ends)}
    order, chosen = [], []
    for f in first:
        rmc = f.get("rmc") or nearest_sol_rmc(drive_ends, f["nearest_sol"])
        if rmc in by_rmc and idx[rmc] not in chosen:
            order.append({**by_rmc[rmc], "station": f["station"]})
            chosen.append(idx[rmc])
    if not chosen:  # deterministic start: the most recent drive end
        i0 = max(range(len(drive_ends)), key=lambda i: (drive_ends[i]["sol"], drive_ends[i]["rmc"]))
        order.append({**drive_ends[i0], "station": None})
        chosen.append(i0)
    dmin = np.min(np.linalg.norm(xy[:, None, :] - xy[None, chosen, :], axis=2), axis=1)
    while True:
        i = int(np.argmax(dmin))
        if not dmin[i] >= min_spacing_m:
            break
        order.append({**drive_ends[i], "station": None})
        dmin = np.minimum(dmin, np.linalg.norm(xy - xy[i], axis=1))
    return order


# --------------------------------------------------------------------------------------------
# Cache + fetch
# --------------------------------------------------------------------------------------------

def _ssl_context() -> ssl.SSLContext:
    """CA bundle: certifi when installed (uv-managed CPython on NixOS has no system default
    store), else the platform default."""
    try:
        import certifi  # noqa: PLC0415

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


class BudgetExceeded(RuntimeError):
    pass


class Cache:
    """data/raw/navcam/ with index.json {files: {rel: {url, bytes, sha256, fetched_utc}}}."""

    def __init__(self, root=CACHE, max_mb: float | None = None, timeout_s: float = 60,
                 retries: int = 2, offline: bool = False):
        self.root = Path(root)
        self.index_path = self.root / "index.json"
        self.index = (json.loads(self.index_path.read_text()) if self.index_path.exists()
                      else {"files": {}})
        self.max_bytes = None if max_mb is None else int(max_mb * 1e6)
        self.timeout_s, self.retries, self.offline = timeout_s, retries, offline
        self.downloaded_now = 0

    @property
    def total_bytes(self) -> int:
        return int(sum(f["bytes"] for f in self.index["files"].values()))

    def _save_index(self):
        self.index["total_bytes"] = self.total_bytes
        self.index["updated_utc"] = _now()
        self.index_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.index_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.index, indent=1, sort_keys=True))
        tmp.replace(self.index_path)

    def _download(self, url: str) -> bytes:
        if self.offline:
            raise FileNotFoundError(f"not cached (offline): {url}")
        if self.max_bytes is not None and self.total_bytes >= self.max_bytes:
            raise BudgetExceeded(f"cache budget {self.max_bytes / 1e6:.0f} MB reached")
        last = None
        for attempt in range(self.retries + 1):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=self.timeout_s,  # noqa: S310
                                            context=_ssl_context()) as r:
                    return r.read()
            except urllib.error.HTTPError as e:
                if e.code < 500:  # client error: retrying will not help
                    raise RuntimeError(f"HTTP {e.code}: {url}") from e
                last = e
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                last = e
                if isinstance(getattr(e, "reason", None), ssl.SSLError):
                    raise RuntimeError(f"TLS error (no retry): {e}") from e
                time.sleep(1.0 + attempt)
        raise RuntimeError(f"download failed after {self.retries + 1} tries: {url}: {last}")

    def get(self, url: str, rel: str) -> Path:
        url = strip_key(url)
        path = self.root / rel
        if rel in self.index["files"] and path.exists():
            return path
        data = self._download(url)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".part")
        tmp.write_bytes(data)
        tmp.replace(path)
        self.index["files"][rel] = {"url": url, "bytes": len(data),
                                    "sha256": hashlib.sha256(data).hexdigest(),
                                    "fetched_utc": _now()}
        self.downloaded_now += len(data)
        self._save_index()
        return path

    def get_json(self, url: str, rel: str):
        return json.loads(self.get(url, rel).read_text())


def _now() -> str:
    return dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def api_url(sol: int, instrument: str, sample_type: str, page: int) -> str:
    d0 = hcfg.load()["navcam_api"]
    sel = hcfg.load()["navcam_selection"]
    q = {"order": "date_taken asc", "per_page": sel["per_page"], "page": page,
         "condition_1": "msl:mission", "condition_2": f"{sol}:sol:in", "search": instrument,
         "extended": f"{sample_type}::sample_type::eq"}
    return d0["url"] + "?" + urllib.parse.urlencode(q, safe=":+|,")


def query_sol(cache: Cache, sol: int, instrument: str, sample_type: str) -> list[dict]:
    items, page = [], 0
    while True:
        rel = f"api/sol{sol:05d}_{instrument}_{sample_type}_p{page}.json"
        d = cache.get_json(api_url(sol, instrument, sample_type, page), rel)
        items.extend(d.get("items") or [])
        if not d.get("more"):
            return items
        page += 1


# --------------------------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------------------------

def stop_id(de: dict) -> str:
    """Observer id of a validation stop (horizons/{id}.json): 'v{site}_{drive}'."""
    return f"v{de['site']}_{de['drive']}"


def candidates_at_stop(cache: Cache, de: dict, sel: dict, instruments) -> tuple[list, list]:
    """(passing frame records, rejected [{image_id, reason}]) at one drive end."""
    passing, rejected = [], []
    for k in range(int(sel["max_extra_sols"]) + 1):
        sol = de["sol"] + k
        for inst in instruments:
            for st in sel["sample_types"]:
                for it in query_sol(cache, sol, inst, st):
                    if it.get("site") != de["site"] or it.get("drive") != de["drive"]:
                        continue
                    try:
                        rec = parse_item(it)
                    except (KeyError, ValueError, TypeError) as e:
                        rejected.append({"image_id": str(it.get("imageid")),
                                         "reason": f"parse: {e}"})
                        continue
                    ok, why, g = sky_test(rec, sel)
                    rec["geometry"] = g
                    if ok:
                        passing.append(rec)
                    else:
                        rejected.append({"image_id": rec["image_id"], "reason": why})
        if passing:
            break
    return passing, rejected


def stop_xy(de: dict, recs: list[dict] | None = None) -> tuple[float, float]:
    """Analysis-CRS position of the Navcam at a stop: the MMGIS drive end plus WS1's coreg shift,
    plus the mean horizontal camera offset from the rover origin (site N, E)."""
    x, y = (float(v) for v in lonlat_to_xy(de["lon"], de["lat"]))
    sh = coreg_shift()
    if sh is not None:
        x, y = x + sh[0], y + sh[1]
    if recs:
        off = np.mean([camera_offset_site(r) for r in recs], axis=0)
        x, y = x + float(off[1]), y + float(off[0])
    return x, y


def predicted_skyline_frac(rec: dict, profile) -> float:
    """Share of image columns whose predicted skyline row lies below the sky detector's top
    reference band and artefact border and above the bottom border, i.e. where V2 can test it."""
    from pipeline.horizon.overlay import skyline_rows  # noqa: PLC0415

    p = hcfg.load()["sky_detector_params"]
    b = int(hcfg.value(p["border_px"]))
    w, h = rec["width"], rec["height"]
    top = b + max(1, int(round(p["ref_top_frac"] * (h - 2 * b))))
    m = frame_model(rec)
    rows = skyline_rows(profile, m, rec["attitude_quaternion"], (w, h))
    ok = np.isfinite(rows) & (rows > top) & (rows < h - 1 - b)
    return float(np.mean(ok))


def filter_by_predicted_skyline(passing: list[dict], profile, min_frac: float):
    """(kept, rejected) using ``predicted_skyline_frac`` (stores it in rec['geometry'])."""
    kept, rejected = [], []
    for rec in passing:
        f = predicted_skyline_frac(rec, profile)
        rec["geometry"]["predicted_skyline_col_frac"] = round(f, 3)
        if f >= min_frac:
            kept.append(rec)
        else:
            rejected.append({"image_id": rec["image_id"],
                             "reason": f"predicted skyline testable in {f:.0%} of columns "
                                       f"< {min_frac:.0%}"})
    return kept, rejected


def check_jpeg(path: Path, rec: dict) -> str | None:
    from PIL import Image  # noqa: PLC0415

    raw = path.read_bytes()[:3]
    if raw[:2] != b"\xff\xd8":
        return "not a JPEG"
    with Image.open(path) as im:
        w, h = im.size
    if (w, h) != (rec["width"], rec["height"]):
        return f"image {w}x{h} != subframe {rec['width']}x{rec['height']}"
    return None


COREG = REPO / "data" / "interim" / "terrain" / "coreg.json"


def coreg_shift() -> tuple[float, float] | None:
    """WS1 coreg.json (dx, dy) in m, added to MMGIS positions (its ``sign`` field); None if
    absent."""
    if not COREG.exists():
        return None
    d = json.loads(COREG.read_text())
    return float(d["dx"]), float(d["dy"])


def coreg_note() -> str:
    sh = coreg_shift()
    if sh is None:
        return "MMGIS MSL_waypoints drive end (WS1 coreg.json not available: not co-registered)"
    return f"MMGIS MSL_waypoints drive end + WS1 coreg.json shift dx={sh[0]} m, dy={sh[1]} m"


def frame_record(rec: dict, de: dict, path: Path) -> dict:
    ypr = rover_ypr(rec)
    a_az, a_el = a_vector_rover_az_el(rec)
    off = camera_offset_site(rec)
    out = {k: v for k, v in rec.items() if k != "geometry"}
    out.update({
        "station": de.get("station"),
        "stop_id": stop_id(de),
        "rmc": de["rmc"],
        "lon": de["lon"], "lat": de["lat"],
        "position_source": coreg_note(),
        "drive_end_sol": de["sol"],
        "mmgis_yaw_pitch_roll_deg": [de["yaw_deg"], de["pitch_deg"], de["roll_deg"]],
        "rover_yaw_pitch_roll_deg": [round(v, 4) for v in ypr],
        "a_vector_rover_az_el_deg": [round(a_az, 4), round(a_el, 4)],
        "camera_offset_site_ned_m": [round(v, 4) for v in off],
        "camera_height_above_rover_origin_m": round(-off[2], 4),
        "pointing_site": {k: round(v, 3) for k, v in rec["geometry"].items()},
        "local_path": str(path.relative_to(REPO)) if path.is_relative_to(REPO) else str(path),
    })
    return out


def _log(msg: str) -> None:
    print(msg, flush=True)


def build(*, dry_run: bool = False, max_mb: float | None = None, offline: bool = False,
          waypoints=WAYPOINTS_D0, out=OUT, cache_root=CACHE, log=_log, engine=None,
          horizons_dir=None) -> dict:
    """With ``engine`` (rays.HorizonEngine over the real bands), each stop's horizon is computed
    at Navcam height, written to ``horizons_dir/{stop_id}.json``, and frames are kept only where
    the predicted skyline is testable (``navcam_selection.min_predicted_skyline_col_frac``)."""
    cfg = hcfg.load()
    sel = cfg["navcam_selection"]
    aoi = hcfg.site()["aoi_focus"]
    drive_ends = [d for d in load_drive_ends(waypoints) if in_aoi(d, aoi)]
    stops = order_stops(drive_ends, sel["first_stops"], sel["min_stop_spacing_m"])
    log(f"{len(drive_ends)} drive ends in aoi_focus; {len(stops)} distinct stops in order")
    if dry_run:
        for s in stops[: sel["max_stops_tried"]]:
            log(f"  {s['rmc']:>10} sol {s['sol']} {s['lon']:.6f} {s['lat']:.6f} "
                f"{s.get('station') or ''}")
        return {"stops": stops[: sel["max_stops_tried"]]}
    cache = Cache(cache_root, max_mb=sel["max_total_mb"] if max_mb is None else max_mb,
                  timeout_s=sel["timeout_s"], retries=sel["retries"], offline=offline)
    instruments = sel["instruments"]
    frames, stop_log, n_ok, n_err = [], [], 0, 0
    for de in stops[: sel["max_stops_tried"]]:
        if n_err > sel["retries"]:  # consecutive failed stops: the network is down, stop
            log("  aborting: repeated download errors")
            break
        if n_ok >= sel["stops_wanted"]:
            break
        entry = {"rmc": de["rmc"], "stop_id": stop_id(de), "sol": de["sol"],
                 "station": de.get("station"), "lon": de["lon"], "lat": de["lat"]}
        try:
            passing, rejected = candidates_at_stop(cache, de, sel, instruments)
            if engine is not None and passing:
                prof = engine.horizon(*stop_xy(de, passing), eye_height_m=cfg["navcam_height_m"])
                prof.meta = {"kind": "stop", "rmc": de["rmc"], "lon": de["lon"],
                             "lat": de["lat"], "height_kind": "navcam",
                             "position": coreg_note() + " + mean camera offset"}
                hdir = Path(horizons_dir or OUT.parent / "horizons")
                prof.write_json(hdir / f"{stop_id(de)}.json", observer_id=stop_id(de))
                passing, rej2 = filter_by_predicted_skyline(
                    passing, prof, float(sel["min_predicted_skyline_col_frac"]))
                rejected += rej2
            picked = spread_pick(passing, sel["max_frames_per_stop"])
            got = []
            for rec in picked:
                path = cache.get(rec["url"], f"img/{rec['image_id']}.JPG")
                bad = check_jpeg(path, rec)
                if bad:
                    rejected.append({"image_id": rec["image_id"], "reason": bad})
                    continue
                got.append(frame_record(rec, de, path))
            entry.update({"status": "ok" if got else "no_frame", "n_candidates": len(passing),
                          "frames": [g["image_id"] for g in got],
                          "rejected_reasons": _count_reasons(rejected)})
            frames.extend(got)
            n_ok += bool(got)
        except BudgetExceeded as e:
            entry.update({"status": "budget", "error": str(e)})
            stop_log.append(entry)
            log(f"  {de['rmc']}: {e}")
            break
        except (RuntimeError, FileNotFoundError, ValueError, KeyError) as e:
            entry.update({"status": "error", "error": str(e)[:300]})
        n_err = n_err + 1 if entry["status"] == "error" else 0
        stop_log.append(entry)
        log(f"  {de['rmc']:>10} sol {de['sol']}: {entry['status']} "
            f"{len(entry.get('frames', []))} frames  (cache {cache.total_bytes / 1e6:.1f} MB)")
    doc = {
        "query": {
            "api": cfg["navcam_api"]["url"], "instruments": instruments,
            "sample_types": sel["sample_types"], "aoi_focus": aoi,
            "drive_ends_source": str(Path(waypoints).relative_to(REPO))
            if Path(waypoints).is_relative_to(REPO) else str(waypoints),
            "selection": {k: v for k, v in sel.items() if k != "assumed"},
            "built_utc": _now(), "cache_total_mb": round(cache.total_bytes / 1e6, 2),
            "downloaded_this_run_mb": round(cache.downloaded_now / 1e6, 2),
            "conventions": {k: v for k, v in cfg["navcam_api"].items() if k != "url"},
        },
        "stops": stop_log,
        "frames": frames,
    }
    from pipeline.horizon.contracts import validate  # noqa: PLC0415

    validate(doc, "navcam_frames.schema.json")
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1))
    log(f"wrote {out} : {len(frames)} frames at {n_ok} stops; cache "
        f"{cache.total_bytes / 1e6:.1f} MB ({cache.downloaded_now / 1e6:.1f} MB this run)")
    return doc


def _count_reasons(rejected: list[dict]) -> dict:
    out: dict[str, int] = {}
    for r in rejected:
        key = re.sub(r"-?\d+(\.\d+)?", "#", r["reason"])
        out[key] = out.get(key, 0) + 1
    return out


def load_frames(path=OUT) -> list[dict]:
    return json.loads(Path(path).read_text())["frames"]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch", help="query the API, cache frames, write navcam_frames.json")
    f.add_argument("--dry-run", action="store_true", help="list the stop order only")
    f.add_argument("--max-mb", type=float)
    r = sub.add_parser("rebuild", help="rebuild navcam_frames.json from the cache (no network)")
    for q in (f, r):
        q.add_argument("--no-horizons", action="store_true",
                       help="skip the stop horizons and the predicted-skyline frame filter")
    a = ap.parse_args(argv)
    engine = None
    if not a.no_horizons and not getattr(a, "dry_run", False):
        from pipeline.horizon.bands import load_engine  # noqa: PLC0415

        engine = load_engine()
    if a.cmd == "fetch":
        build(dry_run=a.dry_run, max_mb=a.max_mb, engine=engine)
    else:
        build(offline=True, engine=engine)
    return 0


if __name__ == "__main__":
    sys.exit(main())
