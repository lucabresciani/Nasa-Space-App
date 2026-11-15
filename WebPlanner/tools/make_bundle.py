#!/usr/bin/env python3
"""Simulator handover (D41): one plan bundle per plan + the shared world pack, as zips.

Contracts: contracts/bundle/ (v1.0.0; README there). Both zips start with ``index.json``
(bundle.schema.json), which states the pad-local frame (metres, origin at the pad, x = east,
y = north, z = up) and lists every other entry with media type, bytes, sha256, units, frame,
contract and, for raw float32 grids (``.f32``), the grid header. The planner's own files are
copied verbatim under ``planner/`` (web contracts); the simulator-friendly files (route, points,
fields, terrain, sun, storm) are derived from them by stated rules, never recomputed.

Inputs: ``data/interim`` through ``tools/make_web.py``'s copy rules (the files ``make web``
would publish, incl. merged station cards), falling back to ``web/public/data``; plus
``data/interim/engine/summary.json`` (D39 t*), ``data/interim/terrain/grid.json`` (field grid
origins), WS1 cell-state rasters, ``data/interim/manifest/`` (provenance) and ``config/*.yaml``.

Deterministic: entries sorted (``index.json`` first), fixed zip timestamps and attributes,
deflate level 9, JSON written in a fixed key order. ``--check`` verifies zips (unzip, sha256,
validation). ``--fixture`` writes contracts/bundle/fixtures/official_pad_v1/.

Library entry for the backend (D53): ``build_plan_bundle(result_dir) -> bytes`` builds one plan
bundle from a result tree (``LayeredSources``: the tree's files over the static sources).
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import math
import sys
import zipfile
import zlib
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import cache
from pathlib import Path

import numpy as np
import yaml
from jsonschema import Draft202012Validator
from pyproj import Transformer

REPO = Path(__file__).resolve().parent.parent
if str(REPO) not in sys.path:  # run as a script: make `tools` and `pipeline` importable
    sys.path.insert(0, str(REPO))

from tools import make_web as mw  # noqa: E402
from tools import validate_contracts as vc  # noqa: E402

INTERIM = REPO / "data" / "interim"
PUBLIC = REPO / "web" / "public" / "data"
CONFIG = REPO / "config"
CONTRACTS = REPO / "contracts"
BUNDLE_CONTRACTS = CONTRACTS / "bundle"
FIXTURE_DIR = BUNDLE_CONTRACTS / "fixtures" / "official_pad_v1"
DEFAULT_OUT = REPO / "data" / "bundles"

CONTRACT_VERSION = "1.0.0"
GENERATOR = "tools/make_bundle.py"
LABEL = "Simulated EVA · real terrain and data"
ZIP_DATE = (1980, 1, 1, 0, 0, 0)
NODATA = -9999.0
ROUTE_STEP_M = 1.0
MAX_BYTES = 50 * 1024 * 1024
VARIANTS = {"opt": "optimistic", "nom": "nominal", "con": "conservative"}
CELLSTATE_TIFS = {"nominal": "cellstate_3m.tif", "conservative": "cellstate_3m_conservative.tif",
                  "optimistic": "cellstate_3m_optimistic.tif"}
ORIGIN_LABEL = {"precomputed": "precomputed, part of the validated scorecard",
                "computed_live": "computed live, not part of the validated scorecard"}
MEDIA = {".json": "application/json", ".geojson": "application/geo+json",
         ".yaml": "application/yaml", ".f32": "application/octet-stream",
         ".png": "image/png", ".jpg": "image/jpeg"}
FRAME_TEXT = {
    "unity": "Unity position = (x, z, y) = (east, up, north); a bearing b (deg clockwise from "
             "north) is a rotation of b degrees about Unity +y starting from Unity +z",
    "bearing": "degrees clockwise from grid north (+y of the analysis projection)",
}


# --------------------------------------------------------------------------------- frame ----
@dataclass
class Frame:
    """Pad-local metres: analysis-projection metres minus the pad's; z = areoid height - elev."""

    pad_id: str
    lon: float
    lat: float
    elev_m: float
    proj: str
    radius_m: float | None = None

    def __post_init__(self):
        r = self.radius_m or float(self.proj.split("+R=")[1].split()[0])
        self.geographic = f"Mars 2000 planetocentric, sphere R = {r:.0f} m"
        self._fwd = Transformer.from_crs(f"+proj=longlat +R={r:g} +no_defs", self.proj,
                                         always_xy=True)
        x, y = self._fwd.transform(self.lon, self.lat)
        self.pad_xy = (float(x), float(y))

    def local(self, lon, lat):
        x, y = self._fwd.transform(lon, lat)
        if np.ndim(x) == 0:
            return float(x) - self.pad_xy[0], float(y) - self.pad_xy[1]
        return np.asarray(x) - self.pad_xy[0], np.asarray(y) - self.pad_xy[1]

    def from_projected(self, x: float, y: float) -> tuple[float, float]:
        return x - self.pad_xy[0], y - self.pad_xy[1]

    def block(self) -> dict:
        return {
            "name": "pad-local", "units": "m",
            "axes": {"x": "east", "y": "north", "z": "up"}, "handedness": "right",
            "pad": {"id": self.pad_id, "lon": self.lon, "lat": self.lat, "elev_m": self.elev_m},
            "projection": {
                "proj": self.proj, "geographic": self.geographic,
                "pad_xy_m": [round(self.pad_xy[0], 4), round(self.pad_xy[1], 4)],
                "height_datum": "Mars areoid (WS1 DEM heights, m); z = height - pad elev_m"},
            **FRAME_TEXT,
        }


# --------------------------------------------------------------------------------- config ----
# D57: server-only settings (rate limits, CORS, gates) are not engine inputs; leaving them out keeps
# the config hash, the config snapshot and every result hash stable when a limit changes.
NON_ENGINE_CONFIG = ("backend.yaml", "design.yaml")  # D57; design.yaml: UI-only values


def config_files(config_dir: Path = CONFIG) -> list[Path]:
    return sorted((p for p in config_dir.glob("*.yaml") if p.name not in NON_ENGINE_CONFIG),
                  key=lambda p: p.name)


def config_hash(config_dir: Path = CONFIG) -> str:
    """sha256 over config/*.yaml sorted by name: utf-8 name, NUL, raw bytes, NUL (README)."""
    h = hashlib.sha256()
    for p in config_files(config_dir):
        h.update(p.name.encode("utf-8") + b"\0" + p.read_bytes() + b"\0")
    return f"sha256:{h.hexdigest()}"


def config_snapshot(config_dir: Path = CONFIG) -> tuple[dict, bytes]:
    files = {p.name: yaml.safe_load(p.read_text(encoding="utf-8")) for p in
             config_files(config_dir)}
    doc = {"schema_version": CONTRACT_VERSION, "config_hash": config_hash(config_dir),
           "files": files}
    yml = yaml.safe_dump(doc, sort_keys=False, allow_unicode=True).encode("utf-8")
    return doc, yml


# ---------------------------------------------------------------------------------- bytes ----
def dump_json(doc) -> bytes:
    return (json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def zip_bytes(entries: dict[str, bytes]) -> bytes:
    """Deterministic zip: index.json first, then entries sorted by path; fixed time/attrs."""
    names = (["index.json"] if "index.json" in entries else []) + sorted(
        n for n in entries if n != "index.json")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for n in names:
            zi = zipfile.ZipInfo(n, date_time=ZIP_DATE)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.create_system = 3
            zi.external_attr = 0o644 << 16
            z.writestr(zi, entries[n], compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    return buf.getvalue()


# ----------------------------------------------------------------------------------- grids ----
def grid_header(shape, cell_m, origin_m, nodata, units, value, **extra) -> dict:
    g = {"dtype": "float32", "byte_order": "little",
         "layout": "row-major, row 0 = north, column 0 = west",
         "shape": [int(shape[0]), int(shape[1])], "cell_m": float(cell_m),
         "origin_m": [round(float(origin_m[0]), 4), round(float(origin_m[1]), 4)],
         "nodata": nodata, "units": units, "value": value}
    g.update(extra)
    return g


def field_png_to_f32(png: bytes, scale: float) -> bytes:
    """WS7 RG-PNG (counts = R*256 + G, A = 0 unknown) -> float32 counts*scale, NODATA unknown."""
    from PIL import Image

    a = np.asarray(Image.open(io.BytesIO(png)).convert("RGBA"))
    counts = a[..., 0].astype(np.float64) * 256 + a[..., 1]
    v = (counts * scale).astype("<f4")
    v[a[..., 3] == 0] = NODATA
    return v.tobytes()


def f32(data: bytes, shape) -> np.ndarray:
    return np.frombuffer(data, dtype="<f4").reshape(shape)


class Terrain:
    """Heights (areoid m) from the world pack: 1 m near chunks, else the 8 m far grid."""

    def __init__(self, fp3d: dict, near: dict[tuple[int, int], np.ndarray], far: np.ndarray):
        cg = fp3d["chunk_grid"]
        self.x0, self.y0 = cg["origin_xy_m"]
        self.res = float(cg["res_m"])
        self.size = cg["chunk_px"] * self.res
        self.near = near
        self.far = far
        f = fp3d["far"]
        self.fx0, self.fy0 = f["origin_xy_m"]
        self.fres = float(f["res_m"])

    @staticmethod
    def _bilinear(a: np.ndarray, col: float, row: float) -> float | None:
        h, w = a.shape
        if not (-0.5 <= col <= w - 0.5 and -0.5 <= row <= h - 0.5):
            return None
        c = min(max(col, 0.0), w - 1.0)
        r = min(max(row, 0.0), h - 1.0)
        c0, r0 = min(int(c), w - 2), min(int(r), h - 2)
        fc, fr = c - c0, r - r0
        v = (a[r0, c0] * (1 - fc) * (1 - fr) + a[r0, c0 + 1] * fc * (1 - fr)
             + a[r0 + 1, c0] * (1 - fc) * fr + a[r0 + 1, c0 + 1] * fc * fr)
        return float(v) if math.isfinite(v) else None

    def height(self, x: float, y: float) -> float | None:
        """Projected (analysis CRS) x, y -> height; bilinear on cell centres."""
        i = math.floor((x - self.x0) / self.size)
        j = math.floor((self.y0 - y) / self.size)
        a = self.near.get((i, j))
        if a is not None:
            col = (x - (self.x0 + i * self.size)) / self.res - 0.5
            row = ((self.y0 - j * self.size) - y) / self.res - 0.5
            return self._bilinear(a, col, row)
        return self._bilinear(self.far, (x - self.fx0) / self.fres - 0.5,
                              (self.fy0 - y) / self.fres - 0.5)


# ----------------------------------------------------------------------------------- route ----
def resample_leg(xs, ys, ts, step_m: float = ROUTE_STEP_M):
    """Samples every step_m of 2-D arc length (plus the last vertex); linear in x, y, t."""
    xs, ys, ts = (np.asarray(v, dtype=np.float64) for v in (xs, ys, ts))
    cum = np.concatenate([[0.0], np.cumsum(np.hypot(np.diff(xs), np.diff(ys)))])
    length = float(cum[-1])
    s = np.arange(0.0, math.floor(length / step_m + 1e-9) * step_m + step_m / 2, step_m)
    if length - s[-1] > 1e-6:
        s = np.append(s, length)
    return s, np.interp(s, cum, xs), np.interp(s, cum, ys), np.interp(s, cum, ts)


def route_rows(leg: int, s, x, y, z, t, slope) -> list[list]:
    rows = []
    n = len(s)
    for k in range(n):
        speed = grade = None
        if k + 1 < n:
            ds = float(s[k + 1] - s[k])
            dt = float(t[k + 1] - t[k]) * 60.0
            speed = round(ds / dt, 4) if dt > 0 else None
            if z[k] is not None and z[k + 1] is not None and ds > 0:
                grade = round(math.degrees(math.atan2(z[k + 1] - z[k], ds)), 3)
        rows.append([leg, round(float(s[k]), 3), round(float(x[k]), 3), round(float(y[k]), 3),
                     None if z[k] is None else round(float(z[k]), 3), round(float(t[k]), 4),
                     speed, grade, slope[k]])
    return rows


# ------------------------------------------------------------------------------ conditions ----
def _utc(text: str) -> datetime:
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)


def storm_doc(rad: dict, t_star_min: float | None, source: str) -> dict:
    """D39: eva_min = t* + (utc - tripwire_utc) in minutes; mGy/h = uGy/day / 24000."""
    st = rad["storm_2024"]
    trip = _utc(st["tripwire_utc"])

    def eva(utc: str | None):
        if t_star_min is None or utc is None:
            return None
        return round(t_star_min + (_utc(utc) - trip).total_seconds() / 60.0, 4)

    rows = [[eva(u), u, v, None if v is None else round(v / 24000.0, 6)]
            for u, v in st["series"]]
    return {"schema_version": CONTRACT_VERSION, "t_star_min": t_star_min,
            "tripwire_utc": st["tripwire_utc"], "tripwire_eva_min": eva(st["tripwire_utc"]),
            "tripwire_threshold_uGy_day": st.get("tripwire_threshold_uGy_day"),
            "tripwire_rule": st.get("tripwire_rule"),
            "baseline_uGy_day": rad["baseline_uGy_day"], "peak_uGy_day": st.get("peak_uGy_day"),
            "peak_eva_min": eva(st.get("peak_utc")),
            "d_allow_mgy": (rad.get("leash") or {}).get("D_allow_mGy"),
            "units": {"eva_min": "min since EVA start (D31)", "utc": "storm-series UTC (2024)",
                      "uGy_day": "uGy/day (RAD dose in plastic)", "mGy_h": "mGy/h"},
            "columns": ["eva_min", "utc", "uGy_day", "mGy_h"], "rows": rows, "source": source}


def sun_doc(clock: dict, source: str) -> dict:
    e = clock["eva"]
    keys = ("t_dark_definition", "t_dark_min_by_observer", "t_dark_by_observer_definition")
    return {"schema_version": CONTRACT_VERSION, "start_utc": e["start_utc"],
            "start_lmst": e.get("start_lmst"), "eva_min": e.get("eva_min"),
            "columns": e["sun_series_columns"], "rows": e["sun_series"],
            "t_dark_min": e.get("t_dark_min"), **{k: e[k] for k in keys if k in e},
            "source": source}


# --------------------------------------------------------------------------------- geojson ----
def geojson_to_local(doc: dict, frame: Frame) -> dict:
    """Same GeoJSON with every position [lon, lat, ...] -> [x_m, y_m] (pad frame, mm)."""

    def conv(c):
        if c and isinstance(c[0], int | float):
            x, y = frame.local(c[0], c[1])
            return [round(x, 3), round(y, 3)]
        return [conv(q) for q in c]

    def walk(o):
        if isinstance(o, dict):
            out = {}
            for k, v in o.items():
                out[k] = conv(v) if k == "coordinates" else walk(v)
            return out
        if isinstance(o, list):
            return [walk(v) for v in o]
        return o

    out = walk(doc)
    out["frame"] = "pad-local"
    return out


# --------------------------------------------------------------------------------- sources ----
@dataclass
class Src:
    data: bytes
    path: str  # repo-relative
    web: str | None = None  # the web path it is published at, when it has one

    @property
    def sha(self) -> str:
        return sha256(self.data)

    def json(self):
        return json.loads(self.data)


class Sources:
    """Web path -> bytes: make web's copy rules over data/interim, then web/public/data."""

    def __init__(self, interim: Path = INTERIM, public: Path = PUBLIC):
        self.interim, self.public = interim, public
        self.web_map: dict[str, Path | bytes] = {}
        if interim.is_dir():
            p = mw.plan(interim)
            for c in p.copies:
                if c.kind == "copy":
                    self.web_map[c.dst.as_posix()] = c.src
            for card in p.cards:
                self.web_map[card.dst.as_posix()] = (
                    json.dumps(card.doc, indent=1, ensure_ascii=False) + "\n").encode("utf-8")
        self.manifest = self._manifest()

    def _rel(self, p: Path) -> str:
        try:
            return p.resolve().relative_to(REPO.resolve()).as_posix()
        except ValueError:
            try:
                return "data/interim/" + p.relative_to(self.interim).as_posix()
            except ValueError:
                return p.as_posix()

    def web(self, rel: str) -> Src | None:
        v = self.web_map.get(rel)
        if isinstance(v, bytes):
            return Src(v, f"make web card merge -> {rel}", rel)
        if isinstance(v, Path):
            return Src(v.read_bytes(), self._rel(v), rel)
        p = self.public / rel
        return Src(p.read_bytes(), self._rel(p), rel) if p.is_file() else None

    def need(self, rel: str) -> Src:
        s = self.web(rel)
        if s is None:
            raise FileNotFoundError(f"input {rel} not found in data/interim (make web rules) "
                                    "or web/public/data")
        return s

    def interim_file(self, rel: str) -> Src | None:
        p = self.interim / rel
        return Src(p.read_bytes(), "data/interim/" + rel) if p.is_file() else None

    def web_paths(self, prefix: str, suffix: str) -> list[str]:
        names = {k for k in self.web_map if k.startswith(prefix) and k.endswith(suffix)}
        names |= files_in_dir_of(self.public, prefix)
        return sorted(n for n in names if n.startswith(prefix) and n.endswith(suffix)
                      and "/" not in n[len(prefix):])

    def _manifest(self) -> dict:
        frag = self.interim / "manifest"
        out: dict = {}
        if frag.is_dir():
            for f in sorted(frag.glob("*.json")):
                out.update(json.loads(f.read_text(encoding="utf-8")))
        elif (self.public / "manifest.json").is_file():
            out = json.loads((self.public / "manifest.json").read_text(encoding="utf-8"))
        return {k: v for k, v in out.items() if isinstance(v, dict)}

    def prov(self, web_path: str | None, src: Src | None = None) -> list[dict]:
        names = {web_path, f"data/interim/{web_path}"} if web_path else set()
        if src is not None:
            names |= {src.path} | ({src.web, f"data/interim/{src.web}"} if src.web else set())
        return [e for e in self.manifest.values() if e.get("file") in names]


def files_in_dir_of(root: Path, prefix: str) -> set[str]:
    """Paths (relative to root) of the files in the folder a web-path prefix names:
    ``cards/`` -> root/cards/*, ``route_`` -> root/*."""
    d = root / prefix.rpartition("/")[0]
    return {p.relative_to(root).as_posix() for p in d.glob("*") if p.is_file()} \
        if d.is_dir() else set()


def newest(entries: list[dict]) -> dict | None:
    return max(entries, key=lambda e: (e.get("utc", ""), e.get("commit", ""))) if entries \
        else None


# ----------------------------------------------------------------------------- the entries ----
def entry(path: str, data: bytes, *, role: str, frame: str, units, contract: str | None,
          grid: dict | None = None, source: Src | None = None, transform: str = "copy",
          status: str | None = None, note: str | None = None) -> dict:
    e = {"path": path, "media_type": MEDIA[Path(path).suffix], "bytes": len(data),
         "sha256": sha256(data), "role": role, "frame": frame, "units": units,
         "contract": contract}
    if grid is not None:
        e["grid"] = grid
    if source is not None:
        e["source"] = {"path": source.path, "sha256": source.sha, "transform": transform}
    if status is not None:
        e["status"] = status
    if note is not None:
        e["note"] = note
    return e


def index_doc(*, kind: str, bundle_id: str, world_version: str, engine_commit: str,
              config_hash: str, created_utc: str, frame: Frame, bounds_m, files: list[dict],
              plan_id: str | None = None, notes: list[str] | None = None, **extra) -> dict:
    d = {"schema_version": CONTRACT_VERSION, "kind": kind, "bundle_id": bundle_id}
    if plan_id is not None:
        d["plan_id"] = plan_id
    d.update({"world_version": world_version, "engine_commit": engine_commit,
              "config_hash": config_hash, "contract_version": CONTRACT_VERSION,
              "created_utc": created_utc, "generator": GENERATOR, "label": LABEL,
              "frame": frame.block(), "bounds_m": [round(float(b), 3) for b in bounds_m]})
    d.update(extra)
    d["files"] = sorted(files, key=lambda e: e["path"])
    d["notes"] = notes or []
    d["dummy"] = False
    return d


class Builder:
    """Collects zip entries + their index rows."""

    def __init__(self):
        self.data: dict[str, bytes] = {}
        self.rows: list[dict] = []
        self.sources: list[Src] = []

    def add(self, path: str, data: bytes, **kw) -> None:
        if path in self.data:
            raise ValueError(f"duplicate entry {path}")
        self.data[path] = data
        self.rows.append(entry(path, data, **kw))
        if kw.get("source") is not None:
            self.sources.append(kw["source"])

    def copy(self, path: str, src: Src, *, role: str, frame: str, units=None,
             contract: str | None = "auto", status: str = "real", note: str | None = None):
        if contract == "auto":
            contract = vc.match_schema(path.split("/", 1)[1]) if path.startswith("planner/") \
                else None
        self.add(path, src.data, role=role, frame=frame, units=units, contract=contract,
                 source=src, status=status, note=note)


# ---------------------------------------------------------------------------------- world ----
@dataclass
class World:
    files: dict[str, bytes]
    index: dict
    terrain: Terrain
    sources: list[Src]


def load_frame(srcs: Sources, config_dir: Path = CONFIG) -> tuple[Frame, Src]:
    pad_src = srcs.need("pad.json")
    pad = pad_src.json()["pad"]
    site = yaml.safe_load((config_dir / "site.yaml").read_text(encoding="utf-8"))
    frame = Frame(pad_id=str(pad.get("id", "official")), lon=float(pad["lon"]),
                  lat=float(pad["lat"]), elev_m=float(pad["elev_m"]),
                  proj=site["crs"]["analysis_proj"],
                  radius_m=float(site["crs"]["mars_radius_m"]))
    return frame, pad_src


def grid_json(srcs: Sources) -> dict | None:
    g = srcs.interim_file("terrain/grid.json")
    return g.json() if g else None


def build_world(srcs: Sources, frame: Frame, chash: str, *, keep_chunks: int | None = None
                ) -> World:
    b = Builder()
    fp_src = srcs.need("fp3d/index.json")
    fp = fp_src.json()
    cg = fp["chunk_grid"]
    x0, y0 = cg["origin_xy_m"]
    px, res = int(cg["chunk_px"]), float(cg["res_m"])
    size = px * res
    zoff = round(-frame.elev_m, 4)
    q = fp["height"].get("quantum_m")
    datum = fp["height"].get("datum", "areoid heights (m)")
    chunks = sorted(cg["chunks"], key=lambda c: (c["j"], c["i"]))
    cropped = None
    if keep_chunks is not None and keep_chunks < len(chunks):
        def dist(c):
            cx = x0 + (c["i"] + 0.5) * size - frame.pad_xy[0]
            cy = y0 - (c["j"] + 0.5) * size - frame.pad_xy[1]
            return (math.hypot(cx, cy), c["j"], c["i"])
        chunks = sorted(sorted(chunks, key=dist)[:keep_chunks], key=lambda c: (c["j"], c["i"]))
        cropped = {"near_chunks_kept": keep_chunks, "near_chunks_total": len(cg["chunks"]),
                   "rule": "the near chunks whose centres are closest to the pad"}
    near: dict[tuple[int, int], np.ndarray] = {}
    for c in chunks:
        i, j = int(c["i"]), int(c["j"])
        gz = srcs.need(c["file"])
        raw = gzip.decompress(gz.data)
        if len(raw) != 4 * px * px:
            raise ValueError(f"{c['file']}: {len(raw)} bytes, expected {4 * px * px}")
        near[(i, j)] = f32(raw, (px, px))
        ox, oy = frame.from_projected(x0 + i * size, y0 - j * size)
        g = grid_header((px, px), res, (ox, oy), None, "m",
                        f"terrain height, {datum}; pad-local z = value + z_to_frame_m",
                        z_to_frame_m=zoff, **({"quantum": q} if q else {}))
        b.add(f"terrain/near/{i}_{j}.f32", raw, role="near terrain chunk (1 m)",
              frame="pad-local", units="m", contract=None, grid=g, source=gz,
              transform="gunzip", status="real")
        if c.get("tex"):
            t = srcs.need(c["tex"])
            b.copy(f"terrain/near_tex/{i}_{j}.jpg", t, role="texture of the near chunk "
                   f"{i}_{j} (same square, north up)", frame="pad-local", contract=None,
                   note="covers terrain/near/{i}_{j}.f32 exactly; HiRISE ortho, greyscale "
                        "where colour is missing".replace("{i}_{j}", f"{i}_{j}"))
    far_meta = fp["far"]
    far_src = srcs.need(far_meta["file"])
    far_raw = gzip.decompress(far_src.data)
    fshape = (int(far_meta["height"]), int(far_meta["width"]))
    far = f32(far_raw, fshape)
    fo = frame.from_projected(*far_meta["origin_xy_m"])
    fres = float(far_meta["res_m"])
    b.add("terrain/far.f32", far_raw, role=f"far terrain ({fres:g} m) over the planning area",
          frame="pad-local", units="m", contract=None,
          grid=grid_header(fshape, fres, fo, None, "m", "terrain height, areoid m; pad-local "
                           "z = value + z_to_frame_m", z_to_frame_m=zoff),
          source=far_src, transform="gunzip", status="real")
    if far_meta.get("tex"):
        b.copy("terrain/far_tex.jpg", srcs.need(far_meta["tex"]),
               role="texture over terrain/far.f32 (same extent, north up)", frame="pad-local",
               contract=None)
    ring = srcs.web("fp3d/horizon_ring.json")
    if ring:
        b.copy("horizon_ring.json", ring, role="far skyline ring around the pad (WS3)",
               frame="none", units={"az_deg": "deg clockwise from north", "elev_deg": "deg",
                                    "dist_m": "m", "z_m": "m (areoid)", "east_m": "m",
                                    "north_m": "m"},
               contract="horizon_ring.schema.json",
               note="east_m/north_m are offsets from the observer (the pad) = pad-local x, y")
    b.copy("planner/fp3d/index.json", fp_src, role="WS8 3D index (reference: chunk layout, "
           "sources, skyline check)", frame="lonlat", contract="fp3d_index.schema.json")
    # shared fields: slope (5 m) and the cell states of every variant (3 m)
    g = grid_json(srcs) or {}
    fidx_src = srcs.need("fields/index.json")
    fidx = fidx_src.json()
    slope = fidx["fields"].get("slope")
    if slope:
        s_src = srcs.need(slope["file"])
        b.add("terrain/slope.f32", field_png_to_f32(s_src.data, slope["scale"]),
              role="terrain slope (5 m fields grid, WS1)", frame="pad-local", units="deg",
              contract=None, grid=field_grid(fidx, slope, g, frame, "slope, deg"),
              source=s_src, transform="RG-PNG counts x scale -> float32 (A = 0 -> nodata)",
              status="real")
    for variant, tif in CELLSTATE_TIFS.items():
        cs = srcs.interim_file(f"terrain/{tif}")
        if cs is None:
            continue
        data, grid = cellstate_f32(cs, frame)
        b.add(f"terrain/cellstate_{variant}.f32", data,
              role=f"F1 cell states, {variant} no-go slope (3 m routing grid)",
              frame="pad-local", units="code", contract=None, grid=grid, source=cs,
              transform="GeoTIFF uint8 -> float32 (0 assessed, 1 blocked, 2 unknown; any "
                        "other code -> 2)", status="real")
    rows = b.rows
    version = "world-" + sha256(dump_json(sorted([r["path"], r["sha256"]] for r in rows)))[:12]
    prov = [e for s in b.sources for e in srcs.prov(None, s)] + srcs.prov("fp3d/index.json")
    top = newest(prov)
    bounds = [fo[0], fo[1] - fshape[0] * fres, fo[0] + fshape[1] * fres, fo[1]]
    notes = ["Sample grids by nearest cell for planner values (fields); heights may be "
             "interpolated. Heights are areoid metres, unscaled; add z_to_frame_m for pad-local z.",
             "Near chunks exist only in a corridor around the official route; use terrain/far.f32 "
             "elsewhere.",
             "Assumed or artistic elements (sky, haze, wind, rocks < 3 m, storm effects) are not "
             "in this pack and must be labelled as visual."]
    extra = {}
    if cropped:
        extra["cropped"] = cropped
        notes.append(f"CROPPED fixture: {keep_chunks} of {len(cg['chunks'])} near chunks (closest "
                     "to the pad); the full pack comes from the server or make bundle.")
    index = index_doc(kind="world", bundle_id=version, world_version=version,
                      engine_commit=top["commit"] if top else "unknown", config_hash=chash,
                      created_utc=top["utc"] if top else "unknown", frame=frame,
                      bounds_m=bounds, files=rows, notes=notes, **extra)
    files = dict(b.data)
    files["index.json"] = dump_json(index)
    return World(files, index, Terrain(fp, near, far), b.sources)


def field_grid(fidx: dict, e: dict, grid: dict, frame: Frame, value: str, **extra) -> dict:
    """Header for a fields-index entry (own grid keys when present, e.g. the 3 m pointer)."""
    w = int(e.get("width", fidx["width"]))
    h = int(e.get("height", fidx["height"]))
    res = float(e.get("res_m", fidx["res_m"]))
    nw = None
    for gg in (grid.get("grids") or {}).values():
        if float(gg["res_m"]) == res and int(gg["width"]) == w and int(gg["height"]) == h:
            nw = gg["nw_xy"]
    if nw is None:  # no grid.json: NW corner from the lon/lat bounds (6-decimal rounding)
        b = e.get("bounds", fidx["bounds"])
        nw = frame._fwd.transform(b[0], b[3])
    o = frame.from_projected(float(nw[0]), float(nw[1]))
    return grid_header((h, w), res, o, NODATA, e.get("units", ""), value,
                       quantum=float(e["scale"]), **extra)


def cellstate_f32(src: Src, frame: Frame) -> tuple[bytes, dict]:
    from rasterio.io import MemoryFile

    with MemoryFile(src.data) as mf, mf.open() as r:
        a = r.read(1)
        t = r.transform
    if t.b != 0 or t.d != 0 or t.e >= 0:
        raise ValueError(f"{src.path}: not a north-up raster")
    v = np.where((a == 0) | (a == 1), a, 2).astype("<f4")
    o = frame.from_projected(t.c, t.f)
    return v.tobytes(), grid_header(a.shape, t.a, o, None, "code",
                                    "0 assessed, 1 blocked, 2 unknown")


# ----------------------------------------------------------------------------------- plan ----
def build_plan(srcs: Sources, frame: Frame, pad_src: Src, world: World, chash: str,
               scenario: str, config_dir: Path = CONFIG, origin: str = "precomputed"
               ) -> tuple[dict[str, bytes], dict, dict]:
    b = Builder()
    sidx_src = srcs.need("scenarios/index.json")
    sc_row = next((s for s in sidx_src.json()["scenarios"] if s["id"] == scenario), None)
    if sc_row is None:
        raise ValueError(f"scenario {scenario} not in scenarios/index.json")
    variant, suit = sc_row["variant"], sc_row["suit_kg"]
    route_src = srcs.need(f"route_{scenario}.geojson")
    route = route_src.json()
    tl_src = srcs.need(f"timeline_{scenario}.json")
    st_src = srcs.need("stations.json")
    stations = st_src.json()
    clock_src, rad_src = srcs.need("conditions/clock.json"), srcs.need("conditions/rad.json")
    clock, rad = clock_src.json(), rad_src.json()
    fidx_src = srcs.need("fields/index.json")
    fidx = fidx_src.json()
    grid = grid_json(srcs) or {}
    summary = srcs.interim_file("engine/summary.json")
    t_star = None
    if summary is not None:
        t_star = (((summary.json().get("routes") or {}).get(scenario) or {}).get("dose")
                  or {}).get("t_star_min")
    legs = sorted((f for f in route["features"] if f["geometry"]["type"] == "LineString"),
                  key=lambda f: f["properties"]["leg"])
    stops = [f["properties"]["to"] for f in legs if f["properties"]["to"] != "pad"]

    # --- planner copies (web contracts, lon/lat)
    def planner(rel: str, role: str, units=None, src: Src | None = None):
        s = src or srcs.need(rel)
        b.copy(f"planner/{rel}", s, role=role, frame="lonlat" if rel.endswith(".geojson")
               or rel in ("stations.json", "pad.json") or rel.startswith("cards/")
               or rel.startswith("conditions/") else "none", units=units)
        return s

    planner("scenarios/index.json", "scenario index (headlines, file names)", src=sidx_src)
    planner(f"route_{scenario}.geojson", "planned route (engine vertices, lon/lat)",
            {"t_min": "min", "o2_L": "L", "length_m": "m", "times_min": "min"}, route_src)
    planner(f"timeline_{scenario}.json", "events: departure, arrival/departure per station, "
            "dwell, O2 checkpoints every 30 min, turn-back per station, margin and binding "
            "term", {"t_min": "min", "o2_left_L": "L", "t_home_min": "min",
                     "margin_min": "min"}, tl_src)
    planner("stations.json", "stations: id, name, objective, tasks, dwell, partner-line "
            "status, access cells", None, st_src)
    planner("pad.json", "official pad and the parking options", {"elev_m": "m"}, pad_src)
    for rel in srcs.web_paths("cards/", ".json"):
        planner(rel, "station card (landmarks, horizon, timeline part)")
    files = sc_row["files"]
    planner(files["bands"], "30/60-min home bands (nominal / conservative / optimistic)")
    planner(files["edges"], "band edge causes")
    planner(files["partner"], "partner line (cart haul, 60 min) and the drag finding (D20)")
    planner("conditions/rad.json", "RAD dose series, 2024 storm, leash", None, rad_src)
    planner("conditions/clock.json", "Mars clock, EVA start, sun series", None, clock_src)
    rems = srcs.web("conditions/rems.json")
    if rems:
        planner("conditions/rems.json", "REMS air/ground temperature and pressure for the "
                "season (HUD readouts)", None, rems)
    golden = srcs.need("physio/golden.json")
    b.copy("physio/golden.json", golden, role="physiology / margin / alarm test vectors: the "
           "C# port must reproduce every case within the stated tolerance (D41)", frame="none",
           units=golden.json().get("units"), contract="golden.schema.json")

    # --- fields: float32 (primary) + the RG-PNG copies
    sub = {k: v for k, v in fidx["fields"].items() if k.startswith(f"{scenario}/")}
    for name, e in sorted(sub.items()):
        png = srcs.need(e["file"])
        short = name.split("/", 1)[1]
        extra = {}
        if "stencil" in e:
            extra["stencil"] = e["stencil"]
        value = f"{short} ({e.get('units')}), scenario {scenario}"
        if short == "pointer":
            value = ("way-home move index k on the 3 m routing grid: next cell = (row + "
                     "stencil[k][0], col + stencil[k][1]); nodata = no move (pad or unreached)")
        b.add(f"fields/{short}.f32", field_png_to_f32(png.data, e["scale"]),
              role=f"field {short} (look up, never recompute)", frame="pad-local",
              units=e.get("units"), contract=None,
              grid=field_grid(fidx, e, grid, frame, value, **extra), source=png,
              transform="RG-PNG counts x scale -> float32 (A = 0 -> nodata)", status="real")
        b.copy(f"planner/{e['file']}", png, role=f"field {short} as the HUD's RG-PNG",
               frame="none", units=e.get("units"), contract=None)
    sub_idx = {k: v for k, v in fidx.items() if k != "fields"}
    sub_idx["fields"] = sub
    sub_bytes = (json.dumps(sub_idx, indent=1, ensure_ascii=False) + "\n").encode("utf-8")
    b.add("planner/fields/index.json", sub_bytes, role="fields index (this scenario's "
          "entries only)", frame="lonlat", units=None, contract="fields_index.schema.json",
          source=fidx_src, transform=f"subset: entries of scenario {scenario}", status="real")

    # --- pad-local derived files
    terr = world.terrain
    zoff = -frame.elev_m
    slope_e = fidx["fields"].get("slope")
    slope_arr = slope_grid = None
    if slope_e:
        slope_png = srcs.need(slope_e["file"])
        slope_grid = field_grid(fidx, slope_e, grid, frame, "slope")
        slope_arr = f32(field_png_to_f32(slope_png.data, slope_e["scale"]),
                        slope_grid["shape"])

    def z_at(x: float, y: float):
        h = terr.height(x + frame.pad_xy[0], y + frame.pad_xy[1])
        return None if h is None else h + zoff

    def slope_at(x: float, y: float):
        if slope_arr is None:
            return None
        ox, oy = slope_grid["origin_m"]
        c = math.floor((x - ox) / slope_grid["cell_m"])
        r = math.floor((oy - y) / slope_grid["cell_m"])
        if 0 <= r < slope_arr.shape[0] and 0 <= c < slope_arr.shape[1]:
            v = float(slope_arr[r, c])
            return None if v == NODATA else round(v, 2)
        return None

    rows, leg_meta = [], []
    for f in legs:
        p = f["properties"]
        lon, lat = np.array(f["geometry"]["coordinates"], dtype=np.float64).T[:2]
        xs, ys = frame.local(lon, lat)
        s, x, y, t = resample_leg(xs, ys, p["times_min"])
        z = [z_at(a, c) for a, c in zip(x, y, strict=True)]
        sl = [slope_at(a, c) for a, c in zip(x, y, strict=True)]
        leg_meta.append({"leg": p["leg"], "from": p["from"], "to": p["to"],
                         "t_start_min": p["t_start_min"], "t_end_min": p["t_end_min"],
                         "length_m": p.get("length_m"), "first_row": len(rows),
                         "n_rows": len(s)})
        rows += route_rows(p["leg"], s, x, y, z, t, sl)
    route_doc = {"schema_version": CONTRACT_VERSION, "frame": "pad-local", "scenario": scenario,
                 "step_m": ROUTE_STEP_M,
                 "columns": ["leg", "s_m", "x_m", "y_m", "z_m", "t_eva_min", "speed_ms",
                             "grade_deg", "slope_deg"],
                 "units": {"leg": "1", "s_m": "m along the leg (horizontal)", "x_m": "m east",
                           "y_m": "m north", "z_m": "m up (pad-local)",
                           "t_eva_min": "min since EVA start", "speed_ms": "m/s (planned)",
                           "grade_deg": "deg (route grade to the next sample)",
                           "slope_deg": "deg (terrain slope, 5 m field)"},
                 "legs": leg_meta, "rows": rows, "source": route_src.path,
                 "notes": ["dwell at a station = the gap between a leg's t_end_min and the next "
                           "leg's t_start_min (see the timeline)",
                           "z from the world pack terrain (bilinear), not from the engine's 3 m "
                           "grid; the engine's leg times and O2 are authoritative"]}
    b.add("route.json", dump_json(route_doc), role="route every 1 m, pad-local",
          frame="pad-local", units=route_doc["units"], contract="bundle/route_local.schema.json",
          source=route_src, transform="lon/lat -> pad-local; resampled every 1 m; z, slope "
          "sampled", status="derived")
    pts = [{"id": "pad", "kind": "pad", "station": None, "name": "pad", "lon": frame.lon,
            "lat": frame.lat, "x_m": 0.0, "y_m": 0.0,
            "z_m": _r(z_at(0.0, 0.0)), "on_route": True}]
    for s in stations:
        x, y = frame.local(s["lon"], s["lat"])
        pts.append({"id": s["id"], "kind": "station", "station": s["id"], "name": s.get("name"),
                    "lon": s["lon"], "lat": s["lat"], "x_m": round(x, 3), "y_m": round(y, 3),
                    "z_m": _r(z_at(x, y)), "on_route": s["id"] in stops})
        acc = (s.get("access") or {}).get(scenario)
        if acc and acc.get("lon") is not None:
            x, y = frame.local(acc["lon"], acc["lat"])
            pts.append({"id": f"{s['id']}.access", "kind": "access", "station": s["id"],
                        "name": s.get("name"), "lon": acc["lon"], "lat": acc["lat"],
                        "x_m": round(x, 3), "y_m": round(y, 3), "z_m": _r(z_at(x, y)),
                        "on_route": s["id"] in stops})
    b.add("points.json", dump_json({"schema_version": CONTRACT_VERSION, "frame": "pad-local",
                                    "points": pts}),
          role="pad, stations and access cells in pad-local metres", frame="pad-local",
          units={"x_m": "m", "y_m": "m", "z_m": "m"}, contract="bundle/points.schema.json",
          source=st_src, transform="lon/lat -> pad-local; z sampled", status="derived")
    for rel, name in ((files["bands"], f"local/{Path(files['bands']).name}"),
                      (files["edges"], "local/edges.geojson"),
                      (files["partner"], "local/partner.geojson"),
                      (f"route_{scenario}.geojson", "local/route.geojson")):
        s = srcs.need(rel)
        b.add(name, dump_json(geojson_to_local(s.json(), frame)),
              role=f"{Path(rel).name} with coordinates in pad-local metres [x, y]",
              frame="pad-local", units="m", contract=None, source=s,
              transform="every position [lon, lat] -> [x_m, y_m]; properties unchanged",
              status="derived")
    b.add("conditions/sun.json", dump_json(sun_doc(clock, clock_src.path)),
          role="sun azimuth/elevation per EVA step and time to dark", frame="none",
          units={"t_eva_min": "min", "lmst_h": "h", "sun_azimuth_deg": "deg", "sun_elevation_deg":
                 "deg", "t_dark_min": "min"}, contract="bundle/sun.schema.json",
          source=clock_src, transform="extract clock.json eva", status="real")
    b.add("conditions/storm.json", dump_json(storm_doc(rad, t_star, rad_src.path)),
          role="2024 storm dose rate re-timed to the EVA clock (D39)", frame="none",
          units={"eva_min": "min", "uGy_day": "uGy/day", "mGy_h": "mGy/h"},
          contract="bundle/storm.schema.json", source=rad_src,
          transform="D39 shift: eva_min = t* + (utc - tripwire_utc)", status="derived")
    snap, yml = config_snapshot(config_dir)
    b.add("config_snapshot.json", dump_json(snap), role="every constant (config/*.yaml)",
          frame="none", units=None, contract="bundle/config_snapshot.schema.json")
    b.add("config_snapshot.yaml", yml, role="the same as YAML", frame="none", units=None,
          contract=None)

    # --- provenance subset
    web_paths = {r["path"].split("/", 1)[1] for r in b.rows if r["path"].startswith("planner/")}
    web_paths |= {"physio/golden.json"}
    src_paths = {s.path for s in b.sources}
    subset = {k: e for k, e in sorted(srcs.manifest.items())
              if e.get("file") in web_paths or e.get("file") in src_paths}
    b.add("manifest_subset.json", dump_json(subset), role="provenance (value, units, file, "
          "script, commit, utc) for every number the bundle's files carry", frame="none",
          units=None, contract="manifest.schema.json")

    # --- identity
    route_prov = newest(srcs.prov(f"route_{scenario}.geojson", route_src))
    if route_prov is None:
        raise ValueError(f"no manifest entry for route_{scenario}.geojson: engine commit unknown")
    prov = [e for s in b.sources for e in srcs.prov(None, s)]
    created = newest([e for e in prov if e.get("utc")])["utc"]
    storm = rad["storm_2024"]
    offset = None
    if t_star is not None:
        offset = (_utc(storm["tripwire_utc"]) - timedelta(minutes=t_star)).strftime(
            "%Y-%m-%dT%H:%M:%SZ")
    sr_cfg = yaml.safe_load((config_dir / "conditions.yaml").read_text(encoding="utf-8"))
    sr = sr_cfg.get("storm_replay", {})
    clock_cfg = sr_cfg.get("clock", {})
    eva = clock["eva"]
    plan_id = f"{frame.pad_id}.{scenario}"
    plan = {
        "schema_version": CONTRACT_VERSION, "kind": "homeline_plan", "plan_id": plan_id,
        "title": f"Official pad · {variant} · {suit:g} kg suit",
        "origin": origin, "origin_label": ORIGIN_LABEL[origin],
        "pad": {"kind": "official", "id": frame.pad_id, "lon": frame.lon, "lat": frame.lat,
                "elev_m": frame.elev_m, "source": f"{pad_src.path} pad (D21 official pad)"},
        "scenario": {"id": scenario, "variant": variant, "suit_kg": suit},
        "stations": stops,
        "eva_start": {"lmst": eva["start_lmst"],
                      "lmst_h": float(clock_cfg.get("eva_start_lmst_h", 9.0)),
                      "utc": eva["start_utc"], "msl_sol": int(eva["msl_sol"]),
                      "decision": "D31 (user 2026-11-14 16:20): 09:00 LMST",
                      "source": f"{clock_src.path} eva; config/conditions.yaml clock"},
        "storm_replay": {"key": "conditions.storm_replay",
                         "decision": "D39 (user 2026-11-14 16:20)",
                         "tripwire_at": sr.get("tripwire_at"),
                         "anchor_event": sr.get("anchor_event"), "tie_break": sr.get("tie_break"),
                         "tripwire_utc": storm.get("tripwire_utc"), "t_star_min": t_star,
                         "storm_utc_at_eva_start": offset,
                         "d_allow_mgy": (rad.get("leash") or {}).get("D_allow_mGy")},
        "engine": {"commit": route_prov["commit"], "config_hash": chash,
                   "contract_version": CONTRACT_VERSION},
        "created_utc": created,
        "world": {"version": world.index["world_version"],
                  "index_sha256": sha256(world.files["index.json"])},
        "dummy": False,
    }
    plan_bytes = dump_json(plan)
    b.add("plan.json", plan_bytes, role="plan identity and inputs", frame="lonlat", units=None,
          contract="bundle/plan.schema.json")
    fg = field_grid(fidx, {"scale": 1.0}, grid, frame, "")
    bounds = [0, 0, 0, 0]
    if fg:
        (ox, oy), (h, w), c = fg["origin_m"], fg["shape"], fg["cell_m"]
        bounds = [ox, oy - h * c, ox + w * c, oy]
    index = index_doc(kind="plan", bundle_id=f"plan-{plan_id}", plan_id=plan_id,
                      world_version=world.index["world_version"],
                      engine_commit=route_prov["commit"], config_hash=chash,
                      created_utc=created, frame=frame, bounds_m=bounds, files=b.rows,
                      notes=["Look up T_home and O2_home in fields/*.f32 by nearest cell; never "
                             "recompute routes (handover rule 1).",
                             "planner/ holds the planner's own files (lon/lat, web contracts); "
                             "the other files are pad-local metres derived from them.",
                             "Card images (panorama/overlay/navcam PNGs) are not included in "
                             "v1."])
    out = dict(b.data)
    out["index.json"] = dump_json(index)
    return out, plan, index


def _r(v):
    return None if v is None else round(v, 3)


# ------------------------------------------------------------------------------ validation ----
@cache
def _schema(name: str) -> dict:
    p = BUNDLE_CONTRACTS / name.split("/", 1)[1] if name.startswith("bundle/") \
        else CONTRACTS / name
    return json.loads(p.read_text(encoding="utf-8"))


def schema_errors(name: str, doc) -> list[str]:
    v = Draft202012Validator(_schema(name))
    return [f"[{name}] at {'/'.join(map(str, e.absolute_path)) or '<root>'}: {e.message}"
            for e in sorted(v.iter_errors(doc), key=lambda e: list(e.absolute_path))]


def verify_entries(files: dict[str, bytes]) -> list[str]:
    errs = []
    if "index.json" not in files:
        return ["index.json missing"]
    index = json.loads(files["index.json"])
    errs += [f"index.json {m}" for m in schema_errors("bundle/bundle.schema.json", index)]
    listed = {}
    for e in index.get("files", []):
        p = e.get("path")
        if p in listed:
            errs.append(f"{p}: listed twice")
        listed[p] = e
    for p in sorted(set(files) - set(listed) - {"index.json"}):
        errs.append(f"{p}: in the zip but not listed in index.json")
    for p, e in sorted(listed.items()):
        data = files.get(p)
        if data is None:
            errs.append(f"{p}: listed in index.json but missing from the zip")
            continue
        if len(data) != e.get("bytes"):
            errs.append(f"{p}: {len(data)} bytes, index says {e.get('bytes')}")
        if sha256(data) != e.get("sha256"):
            errs.append(f"{p}: sha256 mismatch")
        g = e.get("grid")
        if g:
            r, c = g["shape"]
            if len(data) != 4 * r * c:
                errs.append(f"{p}: {len(data)} bytes, grid needs 4 * {r} * {c}")
        con = e.get("contract")
        if con:
            try:
                doc = json.loads(data)
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                errs.append(f"{p}: not JSON: {exc}")
                continue
            errs += [f"{p} {m}" for m in schema_errors(con, doc)]
            if con in vc.SEMANTIC_CHECKS:
                errs += [f"{p}: {m}" for m in vc.SEMANTIC_CHECKS[con](p.split("/", 1)[1], doc)]
        if len(data) > MAX_BYTES:
            errs.append(f"{p}: over 50 MB")
    if index.get("kind") == "plan" and "plan.json" in files:
        plan = json.loads(files["plan.json"])
        for k, want in (("plan_id", plan.get("plan_id")),
                        ("engine_commit", plan.get("engine", {}).get("commit")),
                        ("config_hash", plan.get("engine", {}).get("config_hash")),
                        ("world_version", plan.get("world", {}).get("version"))):
            if index.get(k) != want:
                errs.append(f"index.json {k} {index.get(k)!r} != plan.json {want!r}")
    return errs


def verify_zip_bytes(raw: bytes) -> list[str]:
    try:
        z = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as exc:
        return [f"not a zip: {exc}"]
    names = z.namelist()
    errs = []
    if names[:1] != ["index.json"] or names[1:] != sorted(names[1:]):
        errs.append("entries must be index.json first, then sorted by path")
    if len(set(names)) != len(names):
        errs.append("duplicate zip entries")
    if any(i.date_time != ZIP_DATE for i in z.infolist()):
        errs.append("zip timestamps are not fixed")
    files = {n: z.read(n) for n in names}
    return errs + verify_entries(files)


def stale_sources(fixture: Path = FIXTURE_DIR, interim: Path = INTERIM) -> list[str] | None:
    """Sources recorded in the fixture whose bytes changed (None: inputs not present)."""
    if not (interim / "engine").is_dir():
        return None
    srcs = Sources(interim)
    out = []
    for name in sorted(fixture.glob("*.zip")):
        index = json.loads(zipfile.ZipFile(name).read("index.json"))
        for e in index["files"]:
            s = e.get("source")
            if not s:
                continue
            p = s["path"]
            if p.startswith("make web card merge -> "):
                cur = srcs.web(p.split(" -> ", 1)[1])
                data = cur.data if cur else None
            else:
                f = REPO / p
                data = f.read_bytes() if f.is_file() else None
            if data is None or sha256(data) != s["sha256"]:
                out.append(p)
    return out


# ------------------------------------------------------------------ result trees (backend) ----
class LayeredSources(Sources):
    """A result tree (backend ``results/{hash}/``, D48/D53) over the static sources.

    Files the result tree has win; shared files (conditions, terrain grid, fields index, ...)
    come from the static sources. A result file whose bytes equal the static file keeps the
    static file's provenance, so a result tree holding copies of the published files (the
    pinned official result, or ``web/public/data`` itself) gives the committed fixture's bytes.
    The tree's ``manifest.json`` entries override the static manifest's."""

    def __init__(self, result_dir: Path, base: Sources):
        self.result_dir, self.base = Path(result_dir), base
        self.interim, self.public = base.interim, base.public
        self.web_map = base.web_map
        self.manifest = dict(base.manifest)
        m = self.result_dir / "manifest.json"
        if m.is_file():
            self.manifest.update({k: v for k, v in json.loads(m.read_text(encoding="utf-8"))
                                  .items() if isinstance(v, dict)})

    def _result_path(self, rel: str) -> str:
        try:
            return (self.result_dir / rel).resolve().relative_to(REPO.resolve()).as_posix()
        except ValueError:
            return f"results/{self.result_dir.name}/{rel}"

    def web(self, rel: str) -> Src | None:
        base = self.base.web(rel)
        p = self.result_dir / rel
        if not p.is_file():
            return base
        data = p.read_bytes()
        if base is not None and base.data == data:
            return base
        return Src(data, self._result_path(rel), rel)

    def interim_file(self, rel: str) -> Src | None:
        p = self.result_dir / rel
        if p.is_file():
            data = p.read_bytes()
            base = self.base.interim_file(rel)
            return base if base is not None and base.data == data else \
                Src(data, self._result_path(rel))
        return self.base.interim_file(rel)

    def web_paths(self, prefix: str, suffix: str) -> list[str]:
        names = set(self.base.web_paths(prefix, suffix)) | files_in_dir_of(self.result_dir, prefix)
        return sorted(n for n in names if n.startswith(prefix) and n.endswith(suffix)
                      and "/" not in n[len(prefix):])


def result_origin(result_dir: Path) -> str:
    """D40 origin of a result tree: its run_record.json ``origin`` (WS11 writes one for every
    live result and every pinned precomputed one); a tree without a run record is a static
    pipeline output (``web/public/data``), i.e. ``precomputed``."""
    rr = Path(result_dir) / "run_record.json"
    if rr.is_file():
        origin = json.loads(rr.read_text(encoding="utf-8")).get("origin")
        if origin not in ORIGIN_LABEL:
            raise ValueError(f"{rr}: origin {origin!r} is not one of {sorted(ORIGIN_LABEL)}")
        return origin
    return "precomputed"


def default_scenario(srcs: Sources) -> str:
    sidx = srcs.need("scenarios/index.json").json()
    if sidx.get("default"):
        return sidx["default"]
    ids = [s["id"] for s in sidx.get("scenarios", [])]
    if len(ids) == 1:
        return ids[0]
    raise ValueError(f"scenarios/index.json names no default among {ids}: pass scenario=")


def build_plan_bundle(result_dir: Path, *, scenario: str | None = None,
                      origin: str | None = None, world: World | None = None,
                      interim: Path = INTERIM, public: Path = PUBLIC,
                      config_dir: Path = CONFIG) -> bytes:
    """Plan bundle zip (D41) for one scenario of a result tree (backend F30, D53).

    ``scenario`` defaults to the tree's ``scenarios/index.json`` default; ``origin`` to
    :func:`result_origin`. ``world`` is the shared world pack (``build_world`` is the slow
    part: the server builds it once and passes it in). For the official pad, with
    ``web/public/data`` (or an empty tree) as the result tree, the bytes equal the committed
    fixture's ``plan_bundle.zip``. Raises ValueError when the bundle does not validate."""
    base = Sources(interim, public)
    srcs = LayeredSources(result_dir, base)
    scenario = scenario or default_scenario(srcs)
    origin = origin or result_origin(result_dir)
    frame, pad_src = load_frame(srcs, config_dir)
    chash = config_hash(config_dir)
    world = world or build_world(base, frame, chash)
    files, _, _ = build_plan(srcs, frame, pad_src, world, chash, scenario, config_dir,
                             origin=origin)
    errs = verify_entries(files)
    if errs:
        raise ValueError("plan bundle invalid:\n  " + "\n  ".join(errs[:50]))
    raw = zip_bytes(files)
    errs = verify_zip_bytes(raw)
    if errs:
        raise ValueError("plan bundle failed its round trip:\n  " + "\n  ".join(errs[:50]))
    return raw


# ------------------------------------------------------------------------------------ main ----
def build(out: Path, scenario: str, *, fixture: bool, keep_chunks: int | None,
          interim: Path = INTERIM, public: Path = PUBLIC, config_dir: Path = CONFIG,
          echo=print) -> dict[str, Path]:
    srcs = Sources(interim, public)
    frame, pad_src = load_frame(srcs, config_dir)
    chash = config_hash(config_dir)
    world = build_world(srcs, frame, chash)
    plan_files, plan, _ = build_plan(srcs, frame, pad_src, world, chash, scenario, config_dir)
    errs = verify_entries(world.files) + verify_entries(plan_files)
    if errs:
        raise SystemExit("make_bundle: validation failed:\n  " + "\n  ".join(errs[:50]))
    out.mkdir(parents=True, exist_ok=True)
    written = {}
    if fixture:
        packs = {"plan_bundle.zip": plan_files}
        wf = world.files if keep_chunks is None else build_world(
            srcs, frame, chash, keep_chunks=keep_chunks).files
        e2 = verify_entries(wf)
        if e2:
            raise SystemExit("make_bundle: cropped world pack invalid:\n  " + "\n  ".join(e2))
        packs["world_pack.zip"] = wf
    else:
        packs = {f"plan_{plan['plan_id']}.zip": plan_files,
                 f"{world.index['world_version']}.zip": world.files}
    meta = {"note": "Committed simulator fixture (contracts/bundle/README.md). Rebuild: make "
                    "bundle-fixture. zlib_runtime: repacking is byte-identical only with the "
                    "same zlib build.",
            "zlib_runtime": zlib.ZLIB_RUNTIME_VERSION, "python": sys.version.split()[0],
            "plan_id": plan["plan_id"], "world_version_full": world.index["world_version"],
            "keep_near_chunks": keep_chunks, "zips": {}}
    for name, files in packs.items():
        raw = zip_bytes(files)
        errs = verify_zip_bytes(raw)
        if errs:
            raise SystemExit(f"make_bundle: {name} failed its round trip:\n  "
                             + "\n  ".join(errs[:50]))
        if len(raw) > MAX_BYTES:
            echo(f"WARNING {name}: {len(raw) / 1e6:.1f} MB is over the 50 MB git limit")
        (out / name).write_bytes(raw)
        written[name] = out / name
        meta["zips"][name] = {"bytes": len(raw), "sha256": sha256(raw),
                              "entries": len(files)}
        echo(f"{name}: {len(files)} entries, {len(raw) / 1e6:.2f} MB, sha256 {sha256(raw)[:16]}")
    if fixture:
        (out / "plan.json").write_bytes(plan_files["plan.json"])
        (out / "fixture.json").write_text(json.dumps(meta, indent=1) + "\n", encoding="utf-8")
    return written


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--scenario", default=None, help="scenario id (default: scenarios/index "
                    "default, e.g. nom_104)")
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--fixture", action="store_true",
                    help="write the committed fixture (plan_bundle.zip, world_pack.zip, "
                         "plan.json, fixture.json) to contracts/bundle/fixtures/official_pad_v1")
    ap.add_argument("--keep-near-chunks", type=int, default=None,
                    help="fixture only: crop the world pack to the N near chunks closest to the "
                         "pad")
    ap.add_argument("--check", nargs="+", type=Path, default=None,
                    help="verify zips (unzip, sha256, schemas) and exit")
    args = ap.parse_args(argv)
    if args.check:
        bad = 0
        for p in args.check:
            errs = verify_zip_bytes(p.read_bytes())
            print(f"{p}: {'OK' if not errs else 'FAILED'}")
            for e in errs:
                print(f"  {e}")
            bad += bool(errs)
        return 1 if bad else 0
    scenario = args.scenario
    if scenario is None:
        s = Sources().need("scenarios/index.json").json()
        scenario = s.get("default", "nom_104")
    if args.fixture:
        meta_p = FIXTURE_DIR / "fixture.json"
        keep = args.keep_near_chunks
        if keep is None and meta_p.is_file():
            keep = json.loads(meta_p.read_text())["keep_near_chunks"]
        build(args.out or FIXTURE_DIR, scenario, fixture=True, keep_chunks=keep)
    else:
        build(args.out or DEFAULT_OUT, scenario, fixture=False, keep_chunks=None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
