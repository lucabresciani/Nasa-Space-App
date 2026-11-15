"""V1 footing validation (F13): DEM tilt over the rover footprint vs IMU tilt at drive ends.

For every co-registered Curiosity drive end in the focus area (``config/site.yaml`` ``aoi_focus``),
fit a least-squares plane to the DEM cells whose centres lie in a square of side ``footprint_m``
centred on the drive end (``config/validation.yaml`` ``v1.dem_method``), and compare its tilt with
the rover's IMU tilt (MMGIS). Reports bias (mean DEM - IMU), RMSE, Pearson r and a 2x2 confusion
matrix per threshold (``v1.confusion_thresholds_deg``; positive = tilt >= threshold, DEM is the
prediction, IMU the reference). Drive ends whose footprint touches nodata or leaves the DEM are
excluded and counted, never filled. Caveat (SPEC F13): the rover chose gentle ground.

V1 is a validation of the slope model, not a safety margin (SPEC §11 D23, user 2026-11-14
16:16/16:20 CET). The top-level ``rmse_deg`` (config footprint, MMGIS ``tilt``, focus area) is the
primary result; no slope limit is derived from it. v1.json carries ``role`` (that sentence, for the
WS5 scorecard) and ``nogo_context``: the conservative no-go cited from config (17°, D23), marked
``derived_from_v1: false`` and never recorded as a ``v1.*`` manifest key. Sensitivities (other
footprint candidates, IMU tilt from roll/pitch, every drive end on the DEM regardless of the focus
area) sit beside the primary result and never replace it.

``footprint_m`` is 3 m (user decision 2026-11-14 12:37, config/validation.yaml); the real run
refuses to start if it is null. The array API (``dem_tilt_at``, ``compare``) takes it as an
argument.
"""

from __future__ import annotations

import json
import math
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np
import yaml

from pipeline.provenance.manifest import drop, record

REPO = Path(__file__).resolve().parents[2]
CONFIG_DIR = REPO / "config"
DEFAULT_OUT = REPO / "data" / "interim" / "validation" / "v1.json"
DEFAULT_SVG = DEFAULT_OUT.with_suffix(".svg")
# Paths under web/public/data/ (contracts/README.md); `make web` copies the files unchanged.
WEB_JSON = "validation/v1.json"
WEB_SVG = "validation/v1.svg"
CAVEAT = "The rover chose gentle ground."  # SPEC F13
ROLE = "V1 = validation of the slope model, not a safety margin"  # SPEC §11 D23
# Manifest keys from before D23 (V1-derived no-go); run_real removes them from its fragment.
RETIRED_KEYS = ("v1.conservative_nogo.nogo_deg",)


class V1Blocked(RuntimeError):
    """A V1 input or decision is missing (see STATUS.md WS6 Blocked)."""


# --------------------------------------------------------------------------- config


def _v1_config() -> dict[str, Any]:
    return yaml.safe_load((CONFIG_DIR / "validation.yaml").read_text())["v1"]


@lru_cache(maxsize=1)
def _site() -> dict[str, Any]:
    return yaml.safe_load((CONFIG_DIR / "site.yaml").read_text())


@lru_cache(maxsize=1)
def _variants() -> dict[str, Any]:
    return yaml.safe_load((CONFIG_DIR / "variants.yaml").read_text())


NOGO_SOURCES = (
    ("config/variants.yaml variants.conservative.nogo_deg",
     lambda: _variants()["variants"]["conservative"]["nogo_deg"]),
    ("config/site.yaml slope.nogo_deg.conservative",
     lambda: _site()["slope"]["nogo_deg"]["conservative"]),
)


def _as_deg(v: Any) -> float | None:
    """A config no-go as a number; None for the legacy text ("20 - v1_rmse_deg") or anything
    else that is not a plain number. The legacy text is never evaluated (D23)."""
    if isinstance(v, bool):
        return None
    if isinstance(v, int | float):
        return float(v) if math.isfinite(v) else None
    try:
        f = float(str(v).strip())
    except ValueError:
        return None
    return f if math.isfinite(f) else None


def nogo_context() -> dict[str, Any]:
    """The conservative no-go cited from config for the scorecard's context (D23: 17°).

    Not a V1 output: V1 validates the slope model and derives no limit. Accepts a number or the
    legacy ``"<deg> - v1_rmse_deg"`` text in either config file without raising; variants.yaml
    (the engine's value) wins, site.yaml is the fallback. Two numbers that disagree, or no
    number at all, give ``conservative_nogo_deg: None`` with a note (unknown stays unknown)."""
    found: list[tuple[str, float]] = []
    legacy: list[str] = []
    for src, get in NOGO_SOURCES:
        try:
            raw = get()
        except (KeyError, TypeError):
            continue
        deg = _as_deg(raw)
        if deg is None:
            legacy.append(f"{src} = {raw!r}")
        else:
            found.append((src, deg))
    base = {"decision": "D23", "derived_from_v1": False}
    if found and all(d == found[0][1] for _, d in found):
        src, deg = found[0]
        return {"conservative_nogo_deg": deg, "source": src, **base,
                "text": f"conservative no-go = {deg:g}° (D23, config)",
                "note": "Config citation for context, not a V1 output."}
    if found:
        text = "conservative no-go: config files disagree (D23)"
        note = "config files disagree: " + ", ".join(f"{s} = {d:g}" for s, d in found)
    else:
        text = "conservative no-go: not a number in config (D23)"
        note = ("no number in config; legacy formula not evaluated (V1 is a validation, not a "
                "margin): " + "; ".join(legacy))
    return {"conservative_nogo_deg": None, "source": None, **base, "text": text, "note": note}


def confusion_thresholds() -> tuple[float, ...]:
    return tuple(float(t) for t in _v1_config()["confusion_thresholds_deg"])


def footprint_m() -> float:
    """The V1 footprint side (m) from config; raises V1Blocked while it is undecided."""
    fp = _v1_config().get("footprint_m")
    if fp is None:
        raise V1Blocked(
            "config/validation.yaml v1.footprint_m is null: the V1 footprint is open "
            "(SPEC F13 '≈3 m' vs site.yaml slope.compare_window_m); S decides"
        )
    return float(fp)


# --------------------------------------------------------------------------- geometry


def tilt_from_roll_pitch(roll_deg, pitch_deg):
    """Tilt of the body z-axis from vertical: cos(tilt) = cos(roll) * cos(pitch)."""
    c = np.cos(np.radians(roll_deg)) * np.cos(np.radians(pitch_deg))
    return np.degrees(np.arccos(np.clip(c, -1.0, 1.0)))


def in_focus(lon, lat, aoi: dict[str, float] | None = None) -> np.ndarray:
    """Boolean mask of points inside the focus area (inclusive bounds)."""
    a = aoi or _site()["aoi_focus"]
    lon, lat = np.asarray(lon, float), np.asarray(lat, float)
    return (lon >= a["west"]) & (lon <= a["east"]) & (lat >= a["south"]) & (lat <= a["north"])


def lonlat_to_xy(lon, lat) -> tuple[np.ndarray, np.ndarray]:
    """Mars 2000 planetocentric lon/lat -> analysis CRS metres (config/site.yaml crs)."""
    from pyproj import Transformer

    crs = _site()["crs"]
    geo = f"+proj=longlat +R={crs['mars_radius_m']} +no_defs"
    tr = Transformer.from_crs(geo, crs["analysis_proj"], always_xy=True)
    x, y = tr.transform(np.asarray(lon, float), np.asarray(lat, float))
    return np.atleast_1d(np.asarray(x)), np.atleast_1d(np.asarray(y))


def dem_tilt_at(dem, transform, x, y, footprint_m: float, nodata: float | None = None):
    """Plane-fit tilt (deg) of ``dem`` over a ``footprint_m`` square centred at each (x, y).

    ``transform`` is a north-up affine (rasterio ``Affine``) mapping (col, row) -> (x, y).
    Returns NaN where the footprint leaves the DEM, touches nodata/NaN, or spans < 3 cells per axis.
    """
    dem = np.asarray(dem, dtype=np.float64)
    x, y = np.atleast_1d(np.asarray(x, float)), np.atleast_1d(np.asarray(y, float))
    if transform.b != 0 or transform.d != 0:
        raise ValueError("dem_tilt_at needs a north-up (unrotated) transform")
    hx = footprint_m / (2 * abs(transform.a))
    hy = footprint_m / (2 * abs(transform.e))
    out = np.full(x.shape, np.nan)
    nrows, ncols = dem.shape
    eps = 1e-9
    for i, (xi, yi) in enumerate(zip(x, y, strict=True)):
        # fractional col/row of the point (cell corners at integers, centres at +0.5)
        cf, rf = (xi - transform.c) / transform.a, (yi - transform.f) / transform.e
        c0, c1 = math.ceil(cf - 0.5 - hx - eps), math.floor(cf - 0.5 + hx + eps)
        r0, r1 = math.ceil(rf - 0.5 - hy - eps), math.floor(rf - 0.5 + hy + eps)
        if c0 < 0 or r0 < 0 or c1 >= ncols or r1 >= nrows or c1 - c0 < 2 or r1 - r0 < 2:
            continue
        win = dem[r0 : r1 + 1, c0 : c1 + 1]
        if not np.all(np.isfinite(win)) or (nodata is not None and np.any(win == nodata)):
            continue
        cc, rr = np.meshgrid(np.arange(c0, c1 + 1) + 0.5, np.arange(r0, r1 + 1) + 0.5)
        gx, gy = transform.c + transform.a * cc, transform.f + transform.e * rr
        a = np.column_stack([gx.ravel() - xi, gy.ravel() - yi, np.ones(gx.size)])
        (dzdx, dzdy, _), *_ = np.linalg.lstsq(a, win.ravel(), rcond=None)
        out[i] = math.degrees(math.atan(math.hypot(dzdx, dzdy)))
    return out


def load_mmgis(path: str | os.PathLike[str]) -> dict[str, np.ndarray]:
    """Drive ends from MMGIS ``MSL_waypoints.json`` (GeoJSON points; fields per
    docs/discovery.md 3.1: RMC, sol, lon, lat, roll, pitch, yaw, tilt in deg). Missing -> NaN."""
    feats = json.loads(Path(path).read_text())["features"]
    props = [f["properties"] for f in feats]

    def num(k: str) -> np.ndarray:
        return np.array([np.nan if p.get(k) is None else float(p[k]) for p in props])

    return {
        "rmc": np.array([str(p.get("RMC")) for p in props], dtype=object),
        "sol": np.array([p.get("sol") for p in props], dtype=object),
        "lon": num("lon"), "lat": num("lat"),
        "tilt": num("tilt"), "roll": num("roll"), "pitch": num("pitch"),
    }


def imu_tilt(de: dict[str, np.ndarray], source: str = "tilt") -> np.ndarray:
    """IMU tilt (deg): MMGIS ``tilt``, or acos(cos roll cos pitch) with ``source="roll_pitch"``.
    A tilt is non-negative by definition, so negative or non-finite values become NaN
    (excluded and counted, never repaired)."""
    if source == "tilt":
        t = np.asarray(de["tilt"], float).copy()
    elif source == "roll_pitch":
        t = np.asarray(tilt_from_roll_pitch(np.asarray(de["roll"], float),
                                            np.asarray(de["pitch"], float)), float)
    else:
        raise ValueError(f"unknown IMU source {source!r}")
    t[~np.isfinite(t) | (t < 0)] = np.nan
    return t


# --------------------------------------------------------------------------- statistics


def compare(dem_tilt, imu_tilt, thresholds_deg) -> dict[str, Any]:
    """Bias (mean DEM - IMU), RMSE, Pearson r and per-threshold confusion matrices.

    Pairs with a NaN on either side are excluded and counted in ``n_excluded``. ``r`` is None
    when undefined (n < 3 or zero variance); bias and RMSE are None when n = 0.
    """
    d_all = np.asarray(dem_tilt, float).ravel()
    i_all = np.asarray(imu_tilt, float).ravel()
    ok = np.isfinite(d_all) & np.isfinite(i_all)
    d, m = d_all[ok], i_all[ok]
    n = int(d.size)
    resid = d - m
    r = None
    if n >= 3 and np.std(d) > 0 and np.std(m) > 0:
        r = float(np.corrcoef(d, m)[0, 1])
    confusion = {}
    for t in thresholds_deg:
        ds, ms = d >= t, m >= t
        confusion[f"{t:g}"] = {
            "tp": int(np.sum(ds & ms)),
            "fp": int(np.sum(ds & ~ms)),
            "fn": int(np.sum(~ds & ms)),
            "tn": int(np.sum(~ds & ~ms)),
        }
    return {
        "n": n,
        "n_excluded": int(d_all.size - n),
        "bias_deg": float(resid.mean()) if n else None,
        "rmse_deg": float(np.sqrt(np.mean(resid**2))) if n else None,
        "r": r,
        "thresholds_deg": [float(t) for t in thresholds_deg],
        "confusion": confusion,
        "points": [[float(a), float(b)] for a, b in zip(d, m, strict=True)],
    }


# --------------------------------------------------------------------------- output


def write_result(
    result: dict[str, Any],
    out_path: str | os.PathLike[str] = DEFAULT_OUT,
    svg_path: str | os.PathLike[str] | None = DEFAULT_SVG,
    *,
    footprint_m: float,
    dem_file: str,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Write ``v1.json`` (+ the scatter SVG) and record every displayed number in the manifest.

    Keys: ``v1.{bias_deg,rmse_deg,r,n,n_excluded,footprint_m}``, ``v1.confusion.<thr>.<cell>``,
    ``v1.n_drive_ends`` / ``v1.n_in_focus`` when present; ``file`` = the web data path.
    """
    from pipeline.validation.figures import v1_scatter_svg

    out_path = Path(out_path)
    doc = {
        **result,
        "footprint_m": float(footprint_m),
        "dem_method": _v1_config()["dem_method"],
        "dem_file": dem_file,
        "bias_definition": "mean(DEM tilt - IMU tilt)",
        "positive_class": "tilt >= threshold (DEM = prediction, IMU = reference)",
        "caveat": CAVEAT,
        "role": ROLE,
        **(extra or {}),
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(doc, indent=2, allow_nan=False) + "\n")

    def rec(key: str, value: Any, units: str | None) -> None:
        record(key, value, units, WEB_JSON, __file__)

    for key, units in (("bias_deg", "deg"), ("rmse_deg", "deg"), ("r", "1"), ("n", "count"),
                       ("n_excluded", "count"), ("footprint_m", "m"),
                       ("n_drive_ends", "count"), ("n_in_focus", "count")):
        if key in doc:
            rec(f"v1.{key}", doc[key], units)
    for thr, cm in doc["confusion"].items():
        for cell, v in cm.items():
            rec(f"v1.confusion.{thr}.{cell}", v, "count")
    if svg_path is not None:
        v1_scatter_svg(doc, svg_path)
    return doc


def _read_dem(dem_path: str | os.PathLike[str]):
    """(dem float64, transform, nodata) from a GeoTIFF; refuses any CRS but the analysis CRS."""
    import rasterio

    with rasterio.open(dem_path) as src:
        want = _site()["crs"]["analysis_proj"]
        if src.crs is None or _norm_proj(src.crs.to_proj4()) != _norm_proj(want):
            raise ValueError(f"DEM CRS {src.crs} is not the analysis CRS {want!r}")
        return src.read(1, masked=False).astype(np.float64), src.transform, src.nodata


def _focus_xy(lon, lat, shift_xy_m):
    lon, lat = np.atleast_1d(np.asarray(lon, float)), np.atleast_1d(np.asarray(lat, float))
    keep = in_focus(lon, lat)
    x, y = lonlat_to_xy(lon[keep], lat[keep])
    shift = [0.0, 0.0] if shift_xy_m is None else [float(v) for v in shift_xy_m]
    return keep, x + shift[0], y + shift[1], shift


def run(
    dem_path: str | os.PathLike[str],
    lon,
    lat,
    imu_tilt_deg,
    out_path: str | os.PathLike[str] = DEFAULT_OUT,
    svg_path: str | os.PathLike[str] | None = DEFAULT_SVG,
    *,
    footprint_m: float,
    shift_xy_m: tuple[float, float] | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """V1 on arrays: DEM GeoTIFF in the analysis CRS + drive ends (lon/lat) + IMU tilt (deg).

    ``shift_xy_m`` (dx, dy) is added to the drive ends' analysis-CRS x/y to put them in the DEM
    frame (WS1 co-registration; WS1's coreg.json ``sign`` states the same convention). Drive ends
    outside the focus area are dropped before counting."""
    from pipeline.provenance.manifest import _rel

    imu = np.atleast_1d(np.asarray(imu_tilt_deg, float))
    keep, x, y, shift = _focus_xy(lon, lat, shift_xy_m)
    dem, transform, nodata = _read_dem(dem_path)
    tilt = dem_tilt_at(dem, transform, x, y, footprint_m, nodata=nodata)
    res = compare(tilt, imu[keep], confusion_thresholds())
    extra = {"n_drive_ends": int(keep.size), "n_in_focus": int(keep.sum()),
             "aoi_focus": dict(_site()["aoi_focus"]), "shift_xy_m": shift, **(extra or {})}
    return write_result(res, out_path, svg_path, footprint_m=footprint_m,
                        dem_file=_rel(dem_path), extra=extra)


def load_coreg_shift(path: str | os.PathLike[str]) -> tuple[float, float]:
    """(dx_m, dy_m) from WS1's ``coreg.json`` (contracts/coreg.schema.json)."""
    doc = json.loads(Path(path).read_text())
    if doc.get("dx_m") is None or doc.get("dy_m") is None:
        raise V1Blocked(f"{path}: co-registration shift is null; V1 waits for WS1")
    return float(doc["dx_m"]), float(doc["dy_m"])


def run_real(
    mmgis_path: str | os.PathLike[str],
    coreg_path: str | os.PathLike[str],
    dem_path: str | os.PathLike[str],
    out_path: str | os.PathLike[str] = DEFAULT_OUT,
    svg_path: str | os.PathLike[str] | None = DEFAULT_SVG,
) -> dict[str, Any]:
    """V1 on MMGIS drive ends + WS1 coreg shift + WS1 DEM, with the config footprint (V1Blocked
    while undecided). Sensitivities: every candidate footprint, and IMU tilt from roll/pitch.
    Each is reported next to the primary result; none replaces it."""
    from pipeline.provenance.manifest import _rel

    fp = footprint_m()
    de = load_mmgis(mmgis_path)
    shift = load_coreg_shift(coreg_path)
    keep, x, y, _ = _focus_xy(de["lon"], de["lat"], shift)
    dem, transform, nodata = _read_dem(dem_path)
    thr = confusion_thresholds()
    sensitivity: dict[str, Any] = {}
    cands = [float(c) for c in _v1_config().get("footprint_candidates_m", [])]
    for name, f, source in [*((f"footprint_{c:g}m", c, "tilt") for c in cands if c != fp),
                            ("imu_roll_pitch", fp, "roll_pitch")]:
        t = dem_tilt_at(dem, transform, x, y, f, nodata=nodata)
        r = compare(t, imu_tilt(de, source)[keep], thr)
        sensitivity[name] = {k: r[k] for k in ("n", "n_excluded", "bias_deg", "rmse_deg", "r",
                                               "confusion")} | {"footprint_m": f,
                                                                "imu_source": source}
    # every drive end whose footprint lies on the DEM, focus area or not
    xa, ya = lonlat_to_xy(de["lon"], de["lat"])
    t_all = dem_tilt_at(dem, transform, xa + shift[0], ya + shift[1], fp, nodata=nodata)
    r_all = compare(t_all, imu_tilt(de, "tilt"), thr)
    sensitivity["all_in_dem"] = {k: r_all[k] for k in ("n", "n_excluded", "bias_deg", "rmse_deg",
                                                       "r", "confusion")} | {
        "footprint_m": fp, "imu_source": "tilt", "n_drive_ends": int(de["lon"].size),
        "n_on_dem": int(np.sum(np.isfinite(t_all))), "set": "all drive ends, no focus filter"}
    imu = imu_tilt(de, "tilt")
    dem_t = dem_tilt_at(dem, transform, x, y, fp, nodata=nodata)
    ok = np.isfinite(dem_t) & np.isfinite(imu[keep])
    extra = {
        "imu_source": "tilt",
        "excluded": {"dem_nodata_or_outside": int(np.sum(~np.isfinite(dem_t))),
                     "imu_invalid": int(np.sum(np.isfinite(dem_t) & ~np.isfinite(imu[keep])))},
        "point_ids": [str(v) for v in de["rmc"][keep][ok]],
        "mmgis_file": _rel(mmgis_path),
        "coreg_file": _rel(coreg_path),
        "sensitivity": sensitivity,
    }
    extra["nogo_context"] = nogo_context()  # config citation (D23), not a V1 output
    doc = run(dem_path, de["lon"], de["lat"], imu, out_path, svg_path, footprint_m=fp,
              shift_xy_m=shift, extra=extra)
    for name, sres in sensitivity.items():
        for key, units in (("bias_deg", "deg"), ("rmse_deg", "deg"), ("r", "1"), ("n", "count"),
                           ("n_excluded", "count")):
            record(f"v1.sensitivity.{name}.{key}", sres[key], units, WEB_JSON, __file__)
        for thr_k, cm in sres["confusion"].items():
            for cell, v in cm.items():
                record(f"v1.sensitivity.{name}.confusion.{thr_k}.{cell}", v, "count", WEB_JSON,
                       __file__)
    drop(RETIRED_KEYS, __file__)
    return doc


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--mmgis", required=True, help="cached MSL_waypoints.json")
    ap.add_argument("--coreg", default=str(REPO / "data/interim/terrain/coreg.json"))
    ap.add_argument("--dem", default=str(REPO / "data/interim/terrain/dem_1m.tif"))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--svg", default=str(DEFAULT_SVG))
    a = ap.parse_args(argv)
    try:
        doc = run_real(a.mmgis, a.coreg, a.dem, a.out, a.svg)
    except V1Blocked as e:
        print(f"V1 BLOCKED: {e}")
        return 2
    print(json.dumps({k: doc[k] for k in ("n", "n_excluded", "bias_deg", "rmse_deg", "r",
                                          "confusion", "footprint_m")}, indent=1))
    return 0


def _norm_proj(p: str) -> str:
    return " ".join(sorted(t for t in p.split() if t not in ("+no_defs", "+no_defs=True")))


if __name__ == "__main__":
    raise SystemExit(main())
