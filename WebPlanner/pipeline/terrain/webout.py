"""Web-facing WS1 documents (F1, F16; contracts v1.0.0 ``coverage``/``coreg``) and grid specs.

Pure functions: ``build.py step_validation`` reads the rasters / internal JSON and calls these.

* ``validation/coverage.json``: per flat disc, the cell states of ``cellstate_3m.tif`` as a
  partition (assessed + blocked + unknown = 100 % of the disc cells, the contract's three
  columns); source-mask shares of the planning extent; the pad check; the coverage map.
* Pad check (SPEC F1 acceptance "the pad's 30-min flat disc is >= 90 % assessed"; WS1 G0): the
  reading of "assessed" is open, so both are reported: data coverage (assessed + blocked) and
  state 0 only. ``pass`` is null until site.yaml ``coverage.pad_check_reading`` names one.
* ``validation/coreg.json``: the contract keys added next to WS1's internal ones.
* ``grid.json``: every WS1 grid (NW corner, resolution, size, lon/lat bounds) for consumers that
  build rasters on the same lattice (WS7 field export).
"""

from __future__ import annotations

import math

import numpy as np

from . import grid as G
from .coverage import HIRISE, HRSC_MOLA, NODATA, NON_HIRISE

ASSESSED, BLOCKED, UNKNOWN = 0, 1, 2

LABELS = {
    "assessed": "assessed (HiRISE 1 m; 3 m plane-fit slope <= nominal 20 deg, no 1 m slope > "
                "30 deg)",
    "blocked": "blocked (3 m plane-fit slope > nominal 20 deg, or a 1 m slope > 30 deg: step "
               "guard; D22)",
    "unknown": "unknown (non-HiRISE or no data)",
    "disc": "flat 30- and 60-min discs",
    "pad": "pad (site.yaml pad_default)",
}
COLOURS = {"assessed": "#3c8c3c", "blocked": "#b03a2e", "unknown": "#9a9a9a",
           "disc": "#ffd400", "pad": "#0aa0ff"}


def _r(v, n=2):
    return None if v is None or not np.isfinite(v) else round(float(v), n)


def disc_state_pct(state: np.ndarray, disc_mask: np.ndarray) -> dict:
    """Assessed / blocked / unknown % of the disc cells (a partition; None for an empty disc)."""
    n = int(disc_mask.sum())
    if n == 0:
        return {"assessed_pct": None, "blocked_pct": None, "unknown_pct": None}
    s = state[disc_mask]
    return {"assessed_pct": _r(100 * np.count_nonzero(s == ASSESSED) / n),
            "blocked_pct": _r(100 * np.count_nonzero(s == BLOCKED) / n),
            "unknown_pct": _r(100 * np.count_nonzero((s != ASSESSED) & (s != BLOCKED)) / n)}


PAD_CHECK_READINGS = {
    "data_coverage": "assessed + blocked cells (state != unknown): blocked terrain is assessed "
                     "data, only unknown cells count against the pad",
    "state0_only": "assessed cells only (state 0: known and within the nominal slope limit); "
                   "blocked cells count against the pad",
}


def pad_check(discs: list[dict], budget_min: float, min_pct: float,
              reading: str | None = None) -> dict:
    """SPEC F1 acceptance "the pad's 30-min flat disc is >= 90 % assessed". Which cells count as
    "assessed" is open (S/C): both readings are always reported; ``pass`` follows ``reading``
    (site.yaml coverage.pad_check_reading) and stays None while it is open."""
    if reading is not None and reading not in PAD_CHECK_READINGS:
        raise ValueError(f"unknown pad-check reading {reading!r}; "
                         f"one of {list(PAD_CHECK_READINGS)}")
    row = next(d for d in discs if d["budget_min"] == budget_min)
    a, b = row["assessed_pct"], row["blocked_pct"]
    known = None if a is None or b is None else round(a + b, 2)
    state0 = None if a is None else round(a, 2)

    def one(pct, key):
        return {"pct": pct, "pass": None if pct is None else bool(pct >= min_pct),
                "definition": PAD_CHECK_READINGS[key]}

    readings = {"data_coverage": one(known, "data_coverage"),
                "state0_only": one(state0, "state0_only")}
    return {"budget_min": budget_min, "min_assessed_pct": min_pct,
            "reading": reading,
            "pass": readings[reading]["pass"] if reading else None,
            "known_pct": known, "assessed_pct": state0,
            "readings": readings,
            "basis": (f"SPEC F1 acceptance: the pad's {budget_min:g}-min flat disc is "
                      f">= {min_pct:g} % assessed. Two readings of 'assessed' are shown; "
                      + (f"the decided reading is '{reading}'." if reading else
                         "which one applies is OPEN (S/C decide; config/site.yaml "
                         "coverage.pad_check_reading), so pass is null."))}


def source_fractions_pct(mask: np.ndarray, region: np.ndarray) -> dict:
    """Share of ``region`` per source-mask code (contract names)."""
    m = mask[region]
    n = m.size
    cnt = np.bincount(m.ravel(), minlength=4) if n else np.zeros(4)

    def p(code):
        return None if n == 0 else 100.0 * float(cnt[code]) / n

    return {"hirise": p(HIRISE), "ctx": p(NON_HIRISE), "hrsc_mola": p(HRSC_MOLA),
            "nodata": p(NODATA)}


def lonlat_bounds(g: G.Grid, nd: int = 6) -> list[float]:
    """[w, s, e, n] lon/lat of the grid's pixel edges (the analysis CRS is equirectangular, so a
    north-up analysis grid is a lon/lat rectangle)."""
    w, s, e, n = g.bounds
    lw, ln = G.lonlat_of_xy(w, n)
    le, ls = G.lonlat_of_xy(e, s)
    return [round(float(v), nd) for v in (lw, ls, le, ln)]


def coverage_map_rgba(state: np.ndarray, g: G.Grid, pad_xy, radii_m) -> tuple[np.ndarray, dict]:
    """North-up RGBA map of the cell states on grid ``g`` with the disc outlines and the pad.

    Every pixel has exactly one legend colour (no shading), alpha 255. Returns (rgba, legend)
    with legend = {css colour: label} (contract ``map.legend``)."""
    def rgb(h):
        return [int(h[i:i + 2], 16) for i in (1, 3, 5)]

    out = np.zeros(state.shape + (4,), np.uint8)
    out[..., 3] = 255
    out[..., :3] = rgb(COLOURS["unknown"])
    out[state == ASSESSED, :3] = rgb(COLOURS["assessed"])
    out[state == BLOCKED, :3] = rgb(COLOURS["blocked"])
    x, y = g.xy_of_rc(np.arange(g.height)[:, None], np.arange(g.width)[None, :])
    d = np.hypot(x - pad_xy[0], y - pad_xy[1])
    lw = max(1.5 * g.res, 6.0)  # outline half-width, m
    ring = np.zeros(state.shape, bool)
    for r in radii_m:
        ring |= np.abs(d - r) <= lw
    out[ring, :3] = rgb(COLOURS["disc"])
    out[d <= max(4 * g.res, 25.0), :3] = rgb(COLOURS["pad"])
    legend = {COLOURS[k]: LABELS[k] for k in ("assessed", "blocked", "unknown", "disc", "pad")}
    return out, legend


def coverage_web(internal: dict, *, discs: list[dict], source_pct: dict, pad_chk: dict,
                 speed_ms: float, origin: str | None, map_meta: dict | None) -> dict:
    """Contract document = WS1 internal coverage dict (D3 evidence etc.) + proposed keys
    (coverage schema is loose in contracts v1.0.0).
    The internal ``discs`` dict (keyed by budget) is kept as ``discs_by_budget``."""
    doc = {k: v for k, v in internal.items() if k not in ("discs", "pad_check")}
    if isinstance(internal.get("discs"), dict):
        doc["discs_by_budget"] = internal["discs"]
    elif "discs_by_budget" in internal:
        doc["discs_by_budget"] = internal["discs_by_budget"]
    pad = dict(internal.get("pad") or {})
    doc.update({
        "pad": pad,
        "disc_speed_ms": speed_ms,
        "discs": discs,
        "source_fractions_pct": {k: _r(v) for k, v in source_pct.items()},
        "source_mask_origin": origin,
        "pad_check": pad_chk,
        "map": map_meta,
    })
    return doc


def _site_drive(rmc: str | None) -> tuple[int | None, int | None]:
    try:
        s, d = str(rmc).split("_")
        return int(s), int(d)
    except (ValueError, AttributeError):
        return None, None


def coreg_web(internal: dict, *, search_m: float, step_m: float) -> dict:
    """Contract document = WS1's internal coreg dict + ``dx_m, dy_m, n, residuals`` etc."""
    res = []
    for p in internal.get("per_drive_end", []):
        site, drive = _site_drive(p.get("rmc"))
        res.append({"sol": p.get("sol"), "site": site, "drive": drive, "lon": p["lon"],
                    "lat": p["lat"], "residual_m": p.get("residual_m")})
    return {**internal, "dx_m": internal["dx"], "dy_m": internal["dy"],
            "residual_median_m": internal["residual_median_m"],
            "residual_mad_m": internal["residual_mad_m"], "n": int(internal["n_used"]),
            "search_m": search_m, "step_m": step_m,
            "residuals_position": "MMGIS drive-end lon/lat as published (before the shift)",
            "residuals": res}


def grid_spec(g: G.Grid) -> dict:
    """One WS1 grid: NW pixel corner (analysis CRS), resolution, size, bounds, GDAL transform."""
    w, s, e, n = g.bounds
    return {"res_m": g.res, "width": g.width, "height": g.height,
            "nw_xy": [g.x0, g.y0], "bounds_xy": [w, s, e, n],
            "bounds_lonlat": lonlat_bounds(g),
            "transform_gdal": [g.x0, g.res, 0.0, g.y0, 0.0, -g.res]}


def grids_doc() -> dict:
    s = G.site()
    px, py = G.pad_xy()
    plon, plat = s["pad_default"]["lon"], s["pad_default"]["lat"]
    r, r3 = s["planning_radius_m"], s["grids_m"]["route"]
    half3 = math.ceil(r / r3 - 1e-9) * r3
    return {
        "crs": G.analysis_crs(),
        "geographic": s["crs"]["geographic"],
        "pad": {"lon": plon, "lat": plat, "xy": [px, py],
                "source": "config/site.yaml pad_default (kept unchanged by the user, 2026-11-14 "
                          "11:24 CET; if it ever changes, every grid moves with it)"},
        "lattice": "pixel edges at pad_xy + k * res_m (k integer) for every grid; the pad is a "
                   "pixel corner; rows run north to south, columns west to east",
        "pixel_is": "area (GDAL transform = NW corner of pixel (0, 0))",
        "grids": {
            "dem_1m": {**grid_spec(G.dem_grid()), "files": [
                "dem_1m.tif", "source_mask.tif", "slope_1m.tif", "slope_5m.tif",
                "roughness_5m.tif", "ridge_index.tif", "ortho_lrgb_1m.tif", "ortho_grey_1m.tif",
                "ortho_grey_source_1m.tif"]},
            "route_3m": {**grid_spec(G.route_grid()), "files": [
                "elev_3m.tif", "slope_3m.tif", "stepguard_3m.tif", "cellstate_3m.tif",
                "cellstate_3m_optimistic.tif", "cellstate_3m_conservative.tif",
                "maxslope_3m.tif", "dataedge_3m.tif", "ridge_3m.tif"],
                "cell_states": "D22/D23: slope_3m = plane-fit slope of the nine 1 m elevations; "
                               "stepguard_3m = 1 if any 1 m slope > 30 deg (255 unknown); "
                               "cellstate_3m (nominal 20 deg), _optimistic (25), _conservative "
                               "(17): blocked iff slope_3m > nogo or step guard; maxslope_3m = "
                               "rough-footing overlay only",
                "note": "WS2 engine rasters (t_home, o2_home, pointer) are on this grid"},
            "fields_5m": {**grid_spec(G.fields_grid()),
                          "note": "the web field-PNG grid (contracts/README.md 'Field PNGs', "
                                  "site.yaml grids_m.fields): pad +/- planning_radius_m; WS1 "
                                  "writes no raster on it"},
        },
        "radius_note": f"planning_radius_m = {r} m; half-widths are rounded up to whole cells "
                       f"(3 m grid: +/- {half3:g} m)",
    }


# --------------------------------------------------------------------------- terrain checks


def _state_pct(s: np.ndarray) -> dict:
    n = s.size
    return {"assessed": _r(100 * np.count_nonzero(s == ASSESSED) / n),
            "blocked": _r(100 * np.count_nonzero(s == BLOCKED) / n),
            "unknown": _r(100 * np.count_nonzero((s != ASSESSED) & (s != BLOCKED)) / n)}


def cell_state_summary(states: dict, slope3: np.ndarray, stepguard: np.ndarray,
                       known: np.ndarray, maxslope: np.ndarray, g: G.Grid, pad_xy, radii: dict,
                       *, nogo_deg: dict, step_guard_deg: float, rasters: dict) -> dict:
    """D22/D23 cell states per variant in each flat disc: the partition (assessed / blocked /
    unknown, % of all disc cells, like ``discs``), the blocked share split into "by the 3 m
    plane-fit slope" and "by the step guard only", and the OLD max-slope rule at the same no-go
    (``maxslope_rule_blocked_pct``, comparison only). Plus the step-guard share per disc."""
    from .coverage import disc

    known = np.asarray(known, bool)
    sg = np.asarray(stepguard, bool) & known
    disc_masks = {int(b): (float(r), disc(g, pad_xy, r)) for b, r in radii.items()}

    def pct(m, d, n):
        return _r(100 * np.count_nonzero(m & d) / n) if n else None

    variants = {}
    for v, st in states.items():
        nogo = float(nogo_deg[v])
        with np.errstate(invalid="ignore"):
            by_slope = known & (slope3 > nogo)
            old = known & (maxslope > nogo)
        rows = []
        for b, (r, d) in disc_masks.items():
            n = int(d.sum())
            rows.append({"budget_min": b, "radius_m": round(r, 1), **disc_state_pct(st, d),
                         "blocked_slope_pct": pct(by_slope, d, n),
                         "blocked_stepguard_only_pct": pct(sg & ~by_slope, d, n),
                         "maxslope_rule_blocked_pct": pct(old, d, n)})
        variants[v] = {"nogo_deg": nogo, "raster": rasters.get(v), "discs": rows,
                       "grid_pct": _state_pct(st)}
    dsg = []
    for b, (r, d) in disc_masks.items():
        n = int(d.sum())
        dsg.append({"budget_min": b, "radius_m": round(r, 1), "stepguard_pct": pct(sg, d, n)})
    return {"rule": "D22/D23 (SPEC 11): a known 3 m cell is blocked iff its plane-fit slope "
                    "(least-squares plane through its nine 1 m elevations) > nogo_deg, or any "
                    f"1 m Horn slope inside it > {step_guard_deg:g} deg (step guard, assumed); "
                    "unknown cells stay unknown. Percentages are of all disc cells "
                    "(assessed + blocked + unknown = 100); blocked = blocked_slope + "
                    "blocked_stepguard_only (rounding aside). maxslope_rule_blocked_pct = the old "
                    "rule (max 1 m slope > nogo), comparison only (rough footing)",
            "step_guard_deg": float(step_guard_deg), "variants": variants,
            "discs_stepguard": dsg}


def terrain_checks(xcheck: dict | None, slope_summary: dict | None,
                   cell_states: dict | None) -> dict:
    """``terrain_checks`` block of validation/coverage.json: the WS1 numbers that have no web file
    of their own (HiRISE cross-check, 1 m vs 5 m slope, blocked share of known cells, the D22/D23
    cell states per variant), so their manifest keys cite a published path."""
    xc = None
    if xcheck:
        xc = {"definition": xcheck.get("definition"),
              "items": {pid: {"median_m": it["median_m"], "p90_abs_m": it["p90_abs_m"]}
                        for pid, it in xcheck["items"].items()}}
    sc = bp = None
    if slope_summary:
        cmp_ = slope_summary["slope_compare"]
        sc = {"median_abs_diff_deg": cmp_["median_abs_diff_deg"],
              "definition": cmp_.get("definition")}
        bp = {str(b): row["blocked_pct_of_known"] for b, row in slope_summary["discs"].items()}
    return {"note": "WS1 terrain checks without a web file of their own (manifest keys cite "
                    "validation/coverage.json); the HiRISE DTMs are never used for routing",
            "hirise_xcheck": xc, "slope_compare": sc, "blocked_pct_of_known": bp,
            "cell_states": cell_states}
