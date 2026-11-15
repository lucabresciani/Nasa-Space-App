"""Highlight polygons for picking and cards -> ``highlights/{ridges,mineral,blocked}.geojson``
(DESIGN §6.1, §2.2 U7/U14; contract ``contracts/highlights.schema.json`` v1, frozen).

* ``ridges``: connected boxwork ridges. Ridge cells = 1 m ridge index (WS1 ``ridge_index.tif``:
  elevation minus the 15 m median surface) > the ridge threshold; components are 8-connected.
  ``length_m`` = length of the component's skeleton (orthogonal steps 1 cell, unbridged diagonal
  steps sqrt 2 cells); ``relief_m`` = the component's maximum ridge index (height above the local
  15 m median surface, i.e. above the surrounding hollows); ``area_m2``. Components shorter than
  the minimum ridge length are dropped (1 m noise blobs). Extent: the focus area (boxwork unit,
  ``site.yaml aoi_focus``).
* ``mineral``: CRISM hint patches (WS1 ``crism_sindex2_18m.tif`` = sulfate, ``crism_d2300_18m.tif``
  = clay; orbital hint, not an identification): 8-connected 18 m cells whose index, normalised
  p2 -> 0, p98 -> 1 (stations.yaml scoring_assumptions, as overlays.py), is >= the mineral
  threshold. ``strength`` = mean index over the patch (the index's own units), ``strength_max``,
  ``area_m2``. Extent: the CRISM grid (dem window).
* ``blocked``: 8-connected blocked 3 m cells of the nominal cell states (``cellstate_3m.tif``,
  D22/D23) with ``reason``: ``slope_class`` (every cell's plane-fit slope > the nominal no-go),
  ``step_guard`` (every cell blocked only by the 30 deg step guard) or ``mixed``; ``area_m2``.
  Extent: the focus area (budget, see notes); the full-extent cell states are the cell-state layer.

Thresholds (R9): ``config/design.yaml overlays.ridge_index_threshold_m`` / ``mineral_threshold``
are science calls for S. While they are null, the values under ``overlays.preliminary`` are used
and the file says ``preliminary: true`` (the app labels the layer "preliminary").

Polygons come from the raster cells (``rasterio.features.shapes``), simplified at
``overlays.simplify_m`` in the analysis CRS (topology kept), written as lon/lat (7 decimals).
Feature ids are ordered by the main measure (ridges: length, mineral: area, blocked: area;
ties: raster order). Deterministic; skipped when inputs/config/code are unchanged.

Usage: ``python -m pipeline.export.highlights [--force] [--no-record]``.
"""

from __future__ import annotations

import argparse
import math
import sys
from collections.abc import Callable
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from pipeline.export import overlays as O  # noqa: E402
from pipeline.export import terrain_tiles as T  # noqa: E402

OUT = O.EXPORT / "highlights"
KINDS = ("ridges", "mineral", "blocked")
EIGHT = np.ones((3, 3), bool)
SOURCES = {"ridge": O.TERRAIN / "ridge_index.tif",
           "sulfate": O.TERRAIN / O.CRISM["sulfate"][1], "clay": O.TERRAIN / O.CRISM["clay"][1],
           "cellstate": O.TERRAIN / "cellstate_3m.tif", "slope": O.TERRAIN / "slope_3m.tif",
           "stepguard": O.TERRAIN / "stepguard_3m.tif"}
VARIANT = "nominal"  # cellstate_3m.tif (the nominal homeline, DESIGN §3.1)


# ------------------------------------------------------------------------------- thresholds


def threshold_info(kind: str) -> dict:
    """{name, value, units, source, preliminary} of the cut-off used for ``kind`` (R9)."""
    ov = O.design()["overlays"]
    key, units = {"ridges": ("ridge_index_threshold_m", "m"),
                  "mineral": ("mineral_threshold", "1 (normalised p2-p98)")}[kind]
    if ov.get(key) is not None:
        return {"name": f"overlays.{key}", "value": float(ov[key]), "units": units,
                "source": "S, R9", "preliminary": False}
    pre = ov["preliminary"]
    src = {"ridges": "preliminary (R9 open): site.yaml ridge.threshold_m, WS1 ridge rule, assumed",
           "mineral": "preliminary (R9 open): p98 of each index (stations.yaml "
                      "crism_norm_percentiles upper end), assumed"}[kind]
    return {"name": f"overlays.preliminary.{key}", "value": float(pre[key]), "units": units,
            "source": src, "preliminary": True}


def collection(kind: str, features: list, threshold: dict | None, **extra) -> dict:
    doc = {"type": "FeatureCollection", "kind": kind,
           "preliminary": bool(threshold and threshold["preliminary"]),
           "threshold": (None if threshold is None else
                         {k: threshold[k] for k in ("name", "value", "units", "source")})}
    doc.update(extra)
    doc["features"] = features
    return doc


# ---------------------------------------------------------------------------- raster -> polys


def _transform(x0: float, y0: float, res: float):
    from rasterio.transform import Affine

    return Affine(res, 0.0, x0, 0.0, -res, y0)


def polygons_by_label(lab: np.ndarray, x0: float, y0: float, res: float,
                      simplify_m: float) -> dict:
    """{label: shapely (Multi)Polygon in the analysis CRS} of every non-zero label."""
    from rasterio import features
    from shapely.geometry import MultiPolygon, shape

    parts: dict[int, list] = {}
    for geom, v in features.shapes(lab.astype(np.int32), mask=lab > 0, connectivity=8,
                                   transform=_transform(x0, y0, res)):
        parts.setdefault(int(v), []).append(shape(geom))
    out = {}
    for k, ps in parts.items():
        g = ps[0] if len(ps) == 1 else MultiPolygon(
            [q for p in ps for q in (p.geoms if hasattr(p, "geoms") else [p])])
        out[k] = g.simplify(simplify_m, preserve_topology=True) if simplify_m > 0 else g
    return out


def _label(mask: np.ndarray):
    from scipy import ndimage as ndi

    return ndi.label(mask, structure=EIGHT)


def skeleton_length(mask: np.ndarray, lab: np.ndarray, n: int, res: float) -> np.ndarray:
    """Skeleton length (m) per label 0..n: orthogonal steps 1 cell, unbridged diagonals sqrt 2."""
    from skimage.morphology import skeletonize

    s = skeletonize(mask)
    L = np.zeros(n + 1)

    def add(pair: np.ndarray, labs: np.ndarray, w: float) -> None:
        L[:] += w * np.bincount(labs[pair], minlength=n + 1)[: n + 1]

    add(s[:, :-1] & s[:, 1:], lab[:, :-1], 1.0)
    add(s[:-1, :] & s[1:, :], lab[:-1, :], 1.0)
    d1 = s[:-1, :-1] & s[1:, 1:] & ~(s[:-1, 1:] | s[1:, :-1])
    d2 = s[:-1, 1:] & s[1:, :-1] & ~(s[:-1, :-1] | s[1:, 1:])
    add(d1, lab[:-1, :-1], math.sqrt(2))
    add(d2, lab[:-1, 1:], math.sqrt(2))
    return L * res


def _features(polys: dict, order: list[int], props: Callable[[int, str], dict],
              prefix: str) -> list:
    feats = []
    for i, k in enumerate(order, 1):
        fid = f"{prefix}{i}"
        feats.append({"type": "Feature", "geometry": O.geom_lonlat(polys[k]),
                      "properties": {"id": fid, **props(k, fid)}})
    return feats


def ridge_features(r: np.ndarray, x0: float, y0: float, res: float, *, threshold: float,
                   min_length_m: float, simplify_m: float) -> list:
    from scipy import ndimage as ndi

    r = np.asarray(r, "float32")
    mask = np.isfinite(r) & (r > threshold)
    lab, n = _label(mask)
    if n == 0:
        return []
    length = skeleton_length(mask, lab, n, res)
    idx = np.arange(1, n + 1)
    relief = np.asarray(ndi.maximum(np.where(mask, r, 0), lab, idx))
    cells = np.bincount(lab.ravel(), minlength=n + 1)[1:]
    keep = [k for k in idx if length[k] >= min_length_m]
    if not keep:
        return []
    lab = np.where(np.isin(lab, keep), lab, 0)
    polys = polygons_by_label(lab, x0, y0, res, simplify_m)
    order = sorted(keep, key=lambda k: (-length[k], k))
    return _features(polys, order, lambda k, fid: {
        "label": f"Boxwork ridge {fid}", "relief_m": round(float(relief[k - 1]), 2),
        "length_m": round(float(length[k]), 1),
        "area_m2": round(float(cells[k - 1] * res * res), 1)}, "R")


def mineral_features(v: np.ndarray, x0: float, y0: float, res: float, *, kind: str, lo: float,
                     hi: float, threshold_norm: float, simplify_m: float,
                     prefix: str | None = None) -> list:
    from scipy import ndimage as ndi

    v = np.asarray(v, "float64")
    norm = (v - lo) / (hi - lo)
    mask = np.isfinite(norm) & (norm >= threshold_norm)
    lab, n = _label(mask)
    if n == 0:
        return []
    idx = np.arange(1, n + 1)
    vv = np.where(mask, v, 0.0)
    mean = np.asarray(ndi.mean(vv, lab, idx))
    vmax = np.asarray(ndi.maximum(vv, lab, idx))
    cells = np.bincount(lab.ravel(), minlength=n + 1)[1:]
    polys = polygons_by_label(lab, x0, y0, res, simplify_m)
    order = sorted(idx.tolist(), key=lambda k: (-cells[k - 1], k))
    word = {"sulfate": "Sulfate", "clay": "Clay"}[kind]
    return _features(polys, order, lambda k, fid: {
        "label": f"{word} hint {fid} (orbital hint, not an identification)", "type": kind,
        "strength": round(float(mean[k - 1]), 6), "strength_max": round(float(vmax[k - 1]), 6),
        "area_m2": round(float(cells[k - 1] * res * res), 1)},
        prefix or f"M{kind[0].upper()}")


def blocked_features(state: np.ndarray, slope: np.ndarray, guard: np.ndarray, x0: float,
                     y0: float, res: float, *, nogo: float, simplify_m: float) -> list:
    from scipy import ndimage as ndi

    blocked = np.asarray(state) == 1
    by_slope = blocked & np.isfinite(slope) & (np.asarray(slope) > nogo)
    by_guard_only = blocked & ~by_slope & (np.asarray(guard) == 1)
    lab, n = _label(blocked)
    if n == 0:
        return []
    idx = np.arange(1, n + 1)
    n_slope = np.asarray(ndi.sum(by_slope, lab, idx))
    n_guard = np.asarray(ndi.sum(by_guard_only, lab, idx))
    cells = np.bincount(lab.ravel(), minlength=n + 1)[1:]
    polys = polygons_by_label(lab, x0, y0, res, simplify_m)
    order = sorted(idx.tolist(), key=lambda k: (-cells[k - 1], k))

    def reason(k: int) -> str:
        s, g = n_slope[k - 1] > 0, n_guard[k - 1] > 0
        return "mixed" if s and g else ("slope_class" if s else "step_guard")

    words = {"slope_class": "slope above no-go", "step_guard": "step guard",
             "mixed": "slope and step guard"}
    return _features(polys, order, lambda k, fid: {
        "label": f"Blocked area {fid} ({words[reason(k)]})", "reason": reason(k),
        "area_m2": round(float(cells[k - 1] * res * res), 1)}, "B")


# -------------------------------------------------------------------------------------- build


def load_config() -> dict:
    ov = O.design()["overlays"]
    pre = ov["preliminary"]
    return {"simplify_m": float(ov["simplify_m"]), "focus": O.focus_bounds(),
            "ridge": threshold_info("ridges"), "mineral": threshold_info("mineral"),
            "ridge_min_length_m": float(pre["ridge_min_length_m"]),
            "nogo_deg": float(O.site()["slope"]["nogo_deg"][VARIANT]),
            "norm_percentiles": O.stations_cfg()["scoring_assumptions"]["crism_norm_percentiles"],
            "sources": SOURCES}


def build(cfg: dict, out_dir: Path, log: Callable[[str], None] = print) -> dict[str, dict]:
    out_dir.mkdir(parents=True, exist_ok=True)
    src, simp, docs = cfg["sources"], cfg["simplify_m"], {}

    r, x0, y0, res = O.read_raster(src["ridge"], cfg["focus"])
    feats = ridge_features(r, x0, y0, res, threshold=cfg["ridge"]["value"],
                           min_length_m=cfg["ridge_min_length_m"], simplify_m=simp)
    del r
    docs["ridges"] = collection(
        "ridges", feats, cfg["ridge"], extent="focus area (site.yaml aoi_focus)",
        min_length_m=cfg["ridge_min_length_m"], simplify_m=simp,
        source=[O.rel(src["ridge"])], source_hash=O.sha256([src["ridge"]]))

    feats = []
    for kind in ("sulfate", "clay"):
        v, x0, y0, res = O.read_raster(src[kind])
        v = v.astype("float32")
        lo, hi = O.norm_range(v)
        feats += mineral_features(v, x0, y0, res, kind=kind, lo=lo, hi=hi,
                                  threshold_norm=cfg["mineral"]["value"], simplify_m=simp)
    docs["mineral"] = collection(
        "mineral", feats, cfg["mineral"], extent="CRISM 18 m grid (dem window)",
        caption="Orbital hint, not an identification", simplify_m=simp,
        source=[O.rel(src["sulfate"]), O.rel(src["clay"])],
        source_hash=O.sha256([src["sulfate"], src["clay"]]))

    st, x0, y0, res = O.read_raster(src["cellstate"], cfg["focus"])
    sl, *_ = O.read_raster(src["slope"], cfg["focus"])
    sg, *_ = O.read_raster(src["stepguard"], cfg["focus"])
    feats = blocked_features(st, sl, sg, x0, y0, res, nogo=cfg["nogo_deg"], simplify_m=simp)
    docs["blocked"] = collection(
        "blocked", feats, None, variant=VARIANT, nogo_deg=cfg["nogo_deg"],
        extent="focus area (site.yaml aoi_focus)", simplify_m=simp,
        source=[O.rel(src[k]) for k in ("cellstate", "slope", "stepguard")],
        source_hash=O.sha256([src[k] for k in ("cellstate", "slope", "stepguard")]))

    total = 0
    for kind, doc in docs.items():
        text = O.dumps(doc)
        (out_dir / f"{kind}.geojson").write_text(text)
        total += len(text.encode())
        log(f"highlights/{kind}: {len(doc['features'])} features, "
            f"{len(text.encode()) / O.MIB:.2f} MiB, preliminary={doc['preliminary']}")
    if total > O.budget_bytes():
        raise O.BudgetError(f"highlights: {total} B alone exceed the overlays budget")
    return docs


def record_manifest(docs: dict) -> None:
    from pipeline.provenance.manifest import record

    s = __file__
    r, m = docs["ridges"], docs["mineral"]
    record("highlights.ridges.threshold_m", r["threshold"]["value"], "m",
           "highlights/ridges.geojson", s)
    record("highlights.ridges.min_length_m", r["min_length_m"], "m", "highlights/ridges.geojson", s)
    record("highlights.mineral.threshold_norm", m["threshold"]["value"], "1",
           "highlights/mineral.geojson", s)
    for kind in KINDS:
        record(f"highlights.{kind}.count", len(docs[kind]["features"]), "1",
               f"highlights/{kind}.geojson", s)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--no-record", action="store_true")
    a = ap.parse_args(argv)
    cfg = load_config()
    srcs = list(cfg["sources"].values())
    missing = [str(p) for p in srcs if not Path(p).exists()]
    if missing:
        raise FileNotFoundError(f"highlights: missing sources {missing}")
    key = O.build_key(cfg, srcs, [Path(__file__), Path(O.__file__), Path(T.__file__)])
    if not a.force and O.up_to_date(a.out / "blocked.geojson", a.out / O.BUILD_KEY, key):
        print(f"highlights: up to date ({a.out})")
        return 0
    docs = build(cfg, a.out)
    (a.out / O.BUILD_KEY).write_text(key + "\n")
    if not a.no_record:
        record_manifest(docs)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
