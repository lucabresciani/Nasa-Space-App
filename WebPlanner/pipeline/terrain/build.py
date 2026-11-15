"""WS1 terrain build steps (F1, F2, F7). Inputs are cached raw downloads (``fetch.py``).

    python -m pipeline.terrain.build dem       # dem_1m.tif (merged DEM -> analysis CRS, 1 m)
    python -m pipeline.terrain.build mask      # source_mask.tif, coverage.json, coverage.png
    python -m pipeline.terrain.build coreg     # coreg.json, drive_ends_coreg.json
    python -m pipeline.terrain.build slope     # slope_1m, slope5_1m, roughness_5m, ridge_index,
                                               # elev_3m, maxslope_3m, dataedge_3m, ridge_3m,
                                               # then `cells`
    python -m pipeline.terrain.build cells     # D22/D23: slope_3m, stepguard_3m, cellstate_3m
                                               # (nominal), _optimistic, _conservative, summary
                                               # cellstate_3m_variants.json (atomic swap)
    python -m pipeline.terrain.build xcheck    # hirise_xcheck.json (+ HiRISE-vs-merged shift)
    python -m pipeline.terrain.build validation  # coverage.json/.png, coreg.json (contracts),
                                                 # coverage.json terrain_checks = xcheck, slope
                                                 # compare, conservative summary (web-path keys)
    python -m pipeline.terrain.build grid      # grid.json (grids, lon/lat bounds, height datum)
    python -m pipeline.terrain.build all
    python -m pipeline.terrain.build farfield_v2  # ctx_20m_v2.tif + farfield_v2.json
    python -m pipeline.terrain.build manifest     # rebuild the WS1 manifest fragment from outputs
    python -m pipeline.terrain.build validation_staged  # validation files to terrain/staged/

Every displayed number goes to the provenance manifest (``record``).
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

import numpy as np
import yaml

from . import coreg, coverage, rio, routing, webout
from . import grid as G
from . import slope as S
from .prov import record

OUT = G.OUT
DISC = G.REPO / "data" / "raw" / "discovery"
SCRIPT = __file__


def _crew() -> dict:
    return yaml.safe_load((G.CONFIG / "crew.yaml").read_text())


def _w(path: Path, obj) -> Path:
    """Atomic JSON write (other workstreams read these files while WS1 rebuilds)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1, allow_nan=False) + "\n")
    tmp.replace(path)
    return path


def _r(v, n=3):
    return None if v is None or not np.isfinite(v) else round(float(v), n)


# --------------------------------------------------------------------------- dem


def step_dem() -> Path:
    vrt = G.RAW / "merged_dem_rows.vrt"
    if not vrt.exists():
        raise FileNotFoundError(f"{vrt}: run `python -m pipeline.terrain.fetch dem` first")
    return rio.warp_to_grid(vrt, OUT / "dem_1m.tif", G.dem_grid(), "bilinear",
                            src_nodata=G.site()["d0_sources"]["merged_dem_nodata"])


# --------------------------------------------------------------------------- footprints


_ID = re.compile(r"DTEEC_(\d{6})_\d{4}_(\d{6})_\d{4}_")


def stac_footprints() -> list[dict]:
    """STAC HiRISE DTM items over the planning bbox (D0 2.3), with analysis-CRS polygons."""
    import shapely
    from shapely.geometry import shape

    d = json.loads((DISC / "stac_hirise_dtms_planning_bbox.json").read_text())
    pairs = {tuple(sorted(p)) for p in G.site()["merged_dem_hirise_pairs"]}
    out = []
    for f in d["features"]:
        m = _ID.match(f["id"])
        orbits = tuple(sorted((int(m.group(1)), int(m.group(2))))) if m else None
        geom = shapely.transform(shape(f["geometry"]),
                                 lambda c: np.column_stack(G.xy_of_lonlat(c[:, 0], c[:, 1])))
        out.append({"id": f["id"], "orbits": orbits, "in_mosaic_list": orbits in pairs,
                    "poly": geom})
    return out


def texture_rms(z: np.ndarray, res: float) -> np.ndarray:
    """RMS of the high-pass DEM (z - mean over hp window) over the rms window, metres.

    Evidence only (D3): a 20 m CTX or HRSC DEM upsampled to 1 m has almost no high-pass
    energy; a HiRISE stereo DEM has decimetres of it. Not used to build the mask.
    """
    from scipy.ndimage import uniform_filter

    t = G.site()["texture_check"]
    hp = S.window_px(t["highpass_window_m"], res)
    rw = S.window_px(t["rms_window_m"], res)

    def f(s):
        s = s.astype(np.float64)
        nan = ~np.isfinite(s)
        s0 = np.where(nan, np.nanmean(s), s)
        h = s0 - uniform_filter(s0, hp, mode="nearest")
        out = np.sqrt(uniform_filter(h * h, rw, mode="nearest")).astype(np.float32)
        out[nan] = np.nan
        return out

    return S.strips(f, z, halo=hp + rw, rows=1024)


# --------------------------------------------------------------------------- mask + coverage


def _d3_state() -> dict:
    """D3 (SPEC 11) state from site.yaml d3 (decided A by the user at 11:24 CET, session 2)."""
    d = G.site()["d3"]
    return {"status": d["status"], "applied": d["applied"], "note": d["note"],
            "decided": bool(d.get("decided", False))}


def disc_radii_m() -> dict[int, float]:
    c = _crew()
    v = float(c["anchor"]["speed_ms"])
    return {int(b): v * 60.0 * b for b in c["walkback_budgets_min"]}


def _state3_from_mask(mask1: np.ndarray, g1: G.Grid) -> tuple[np.ndarray, G.Grid]:
    """3 m 'known' state from the 1 m mask alone (slope-independent): 0 known, 2 unknown."""
    g3 = G.route_grid()
    off = int(round((g1.y0 - g3.y0) / g1.res)), int(round((g3.x0 - g1.x0) / g1.res))
    k = int(round(g3.res / g1.res))
    sub = mask1[off[0]:off[0] + g3.height * k, off[1]:off[1] + g3.width * k]
    blocks = routing._blocks(sub, k)
    known = (blocks == coverage.HIRISE).all(axis=2)
    return np.where(known, routing.ASSESSED, routing.UNKNOWN).astype(np.uint8), g3


def _cov_for(mask1, g1, pad_xy) -> dict:
    st3, g3 = _state3_from_mask(mask1, g1)
    res = {}
    for b, r in disc_radii_m().items():
        d = coverage.disc(g3, pad_xy, r)
        c = coverage.disc_coverage(st3, d)
        res[str(b)] = {"radius_m": round(r, 1), **{k: _r(v, 4) if isinstance(v, float) else v
                                                  for k, v in c.items()}}
    return res


def step_mask() -> dict:
    dem, g1 = rio.read(OUT / "dem_1m.tif")
    fps = stac_footprints()
    sel = [f for f in fps if f["in_mosaic_list"]]
    hirise = coverage.rasterize_footprints([f["poly"] for f in sel], g1)
    mask = coverage.source_mask(dem, hirise)
    rio.write_cog(OUT / "source_mask.tif", mask, g1, nodata=255,
                  tags={"codes": "1 HiRISE (STAC footprint quads of the mosaic's listed pairs, "
                        "D3 recommended default, awaiting confirmation), 2 non-HiRISE (CTX or "
                        "HRSC; not separable), 0 nodata"})
    pad = G.pad_xy()
    fr = coverage.source_fractions(mask)
    focus = G.site()["aoi_focus"]
    fx0, fy1 = G.xy_of_lonlat(focus["west"], focus["north"])
    fx1, fy0 = G.xy_of_lonlat(focus["east"], focus["south"])
    r0, c0 = g1.rc_of_xy(fx0, fy1)
    r1, c1 = g1.rc_of_xy(fx1, fy0)
    fwin = (slice(int(r0), int(r1) + 1), slice(int(c0), int(c1) + 1))
    fr_focus = coverage.source_fractions(mask, fwin)

    # ---- D3 options (evidence for C/S)
    tex = texture_rms(dem, g1.res)
    tex_inside = tex[hirise & np.isfinite(tex)]
    tex_outside = tex[~hirise & np.isfinite(tex)]
    all5 = coverage.rasterize_footprints([f["poly"] for f in fps], g1)
    opts = {
        "A_listed_pairs_quads (recommended default, applied)": _cov_for(mask, g1, pad),
        "B_all_stac_quads": _cov_for(coverage.source_mask(dem, all5), g1, pad),
    }
    # C: listed quads restricted to HiRISE-like texture. Reference: the D0-cached CTX 20 m window
    # at the pad (geoid-adjusted), upsampled bilinearly to 1 m: its texture p95 is the threshold.
    ctx_ref = ctx_texture_reference()
    thr = ctx_ref["p95"] if ctx_ref else None
    if thr is not None:
        hirise_c = hirise & (tex > thr)
        opts["C_listed_quads_and_texture_above_ctx_p95"] = _cov_for(
            coverage.source_mask(dem, hirise_c), g1, pad)
    d30 = coverage.disc(g1, pad, disc_radii_m()[min(disc_radii_m())])
    t30 = tex[d30 & np.isfinite(tex)]
    cov = {
        "pad": {"lon": G.site()["pad_default"]["lon"], "lat": G.site()["pad_default"]["lat"],
                "xy": [round(pad[0], 2), round(pad[1], 2)]},
        "grid": {"res_m": G.route_grid().res, "rule": "3 m cell assessed if all nine 1 m cells "
                 "are HiRISE (source mask 1) and valid; blocked counts as assessed"},
        "discs": opts["A_listed_pairs_quads (recommended default, applied)"],
        "disc_speed_ms": _crew()["anchor"]["speed_ms"],
        "pad_disc_assessed_min_pct": G.site()["coverage"]["pad_disc_assessed_min_pct"],
        "source_fractions_dem_window": {str(k): _r(v, 4) for k, v in fr.items()},
        "source_fractions_focus": {str(k): _r(v, 4) for k, v in fr_focus.items()},
        "codes": {"0": "nodata", "1": "HiRISE", "2": "non-HiRISE (CTX or HRSC, not separable "
                  "without mosaic footprints)", "3": "HRSC/MOLA (not used: not separable)"},
        "d3": {
            **_d3_state(),
            "stac_items": [{"id": f["id"], "in_mosaic_list": f["in_mosaic_list"]} for f in fps],
            "options": opts,
            "texture_rms_m": {
                "inside_listed_quads": {"p5": _r(np.percentile(tex_inside, 5)),
                                        "median": _r(np.median(tex_inside)),
                                        "p95": _r(np.percentile(tex_inside, 95))}
                if tex_inside.size else None,
                "outside_listed_quads": {"p5": _r(np.percentile(tex_outside, 5)),
                                         "median": _r(np.median(tex_outside)),
                                         "p95": _r(np.percentile(tex_outside, 95))}
                if tex_outside.size else None,
                "ctx_20m_upsampled_reference": ctx_ref,
                "frac_30min_disc_below_ctx_p95": _r(float((t30 <= thr).mean()), 4)
                if thr is not None else None,
                "params": G.site()["texture_check"],
            },
        },
        "source_mask": "data/interim/terrain/source_mask.tif",
    }
    a30 = cov["discs"]["30"]["assessed_frac"]
    cov["pad_check"] = {
        "assessed_pct_30min": _r(100 * a30, 2) if a30 is not None else None,
        "pass": bool(a30 is not None and 100 * a30 >= cov["pad_disc_assessed_min_pct"]),
    }
    _w(OUT / "coverage.json", cov)
    k = int(G.site()["grids_m"]["fields"] / g1.res)  # evidence raster at 5 m (block mean)
    t5 = np.nanmean(routing._blocks(tex, k), axis=2).astype(np.float32)
    rio.write_cog(OUT / "xcheck" / "texture_rms_5m.tif", t5,
                  G.Grid(g1.x0, g1.y0, g1.res * k, g1.width // k, g1.height // k))
    # G0 evidence map (hillshade + D3 hatch); the web map coverage.png and the contract shape of
    # coverage.json (+ manifest keys) come from step_validation once cellstate_3m.tif exists.
    coverage_png(dem, mask, g1, pad, OUT / "xcheck" / "coverage_hillshade.png")
    return cov


def ctx_texture_reference() -> dict | None:
    """Texture of a CTX 20 m DEM upsampled to 1 m (D0's cached 128 px window at the pad)."""
    src = DISC / "ctx_T01_000815_geoidadj_win2560m_pad.tif"
    if not src.exists():
        return None
    g = G.pad_grid(1000.0, 1.0)
    tmp = OUT / "xcheck" / "ctx_reference_1m.tif"
    rio.warp_to_grid(src, tmp, g, "bilinear", src_nodata=-32767)
    c, _ = rio.read(tmp)
    v = texture_rms(c, 1.0)
    v = v[np.isfinite(v)]
    return {"file": str(src.relative_to(G.REPO)), "p50": _r(np.percentile(v, 50), 4),
            "p95": _r(np.percentile(v, 95), 4), "p99": _r(np.percentile(v, 99), 4)}


def hillshade(z: np.ndarray, res: float, az=315.0, alt=45.0) -> np.ndarray:
    gy, gx = np.gradient(np.where(np.isfinite(z), z, np.nanmean(z)), res)
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    a, e = math.radians(az), math.radians(alt)
    hs = np.sin(e) * np.cos(slope) + np.cos(e) * np.sin(slope) * np.cos(a - aspect)
    return np.clip(hs, 0, 1)


def coverage_png(dem, mask, g1: G.Grid, pad, path: Path, step: int = 10) -> Path:
    """Coverage map: hillshade, unknown hatched red, discs and pad. 10 m pixels."""
    from PIL import Image, ImageDraw

    z = dem[::step, ::step]
    m = mask[::step, ::step]
    hs = hillshade(z, g1.res * step)
    rgb = np.dstack([hs * 200 + 40] * 3).astype(np.float32)
    unk = m != coverage.HIRISE
    hatch = ((np.add.outer(np.arange(z.shape[0]), np.arange(z.shape[1])) // 4) % 2) == 0
    rgb[unk] = rgb[unk] * 0.55 + np.array([200, 30, 30]) * 0.45
    rgb[unk & hatch] *= 0.7
    img = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8))
    d = ImageDraw.Draw(img)
    cx = (pad[0] - g1.x0) / (g1.res * step)
    cy = (g1.y0 - pad[1]) / (g1.res * step)
    for r in disc_radii_m().values():
        rp = r / (g1.res * step)
        d.ellipse([cx - rp, cy - rp, cx + rp, cy + rp], outline=(255, 220, 0), width=2)
    d.ellipse([cx - 4, cy - 4, cx + 4, cy + 4], fill=(0, 160, 255))
    d.text((8, 8), "Coverage: red hatched = unknown (non-HiRISE); circles = flat 30/60-min "
           "discs; blue = pad_default", fill=(255, 255, 255))
    img.save(path)
    return path


# --------------------------------------------------------------------------- coreg


def drive_ends() -> list[dict]:
    """MMGIS drive ends (cached by D0, docs/discovery.md 3.1)."""
    p = G.REPO / G.site()["d0_sources"]["mmgis_waypoints_cached"]
    feats = json.loads(p.read_text())["features"]
    keep = ("RMC", "site", "drive", "sol", "lon", "lat", "elev_geoid", "roll", "pitch", "yaw",
            "tilt")
    return [{k: f["properties"][k] for k in keep} for f in feats]


def step_coreg() -> dict:
    dem, g1 = rio.read(OUT / "dem_1m.tif")
    c = G.site()["coreg"]
    if c["metric"] != "MAD":
        raise ValueError(f"coreg metric {c['metric']!r} not implemented")
    pts = drive_ends()
    lon = np.array([p["lon"] for p in pts])
    lat = np.array([p["lat"] for p in pts])
    elev = np.array([p["elev_geoid"] for p in pts])
    x, y = G.xy_of_lonlat(lon, lat)
    w, so, e, n = g1.bounds
    inside = (x > w) & (x < e) & (y > so) & (y < n)
    res = coreg.grid_search(dem, g1, x[inside], y[inside], elev[inside],
                            search_m=c["search_m"], step_m=c["step_m"])
    r_best = coreg.residuals(dem, g1, x, y, elev, res["dx"], res["dy"])
    r_zero = coreg.residuals(dem, g1, x, y, elev, 0.0, 0.0)
    surf = res.pop("mad_surface")
    shifts = res.pop("shifts_m")
    # curvature of the MAD surface around the best shift: how well constrained is it?
    i0 = int(np.where(shifts == res["dy"])[0][0])
    j0 = int(np.where(shifts == res["dx"])[0][0])
    prof = {"dx_at_best_dy": {f"{shifts[j]:+.0f}": _r(surf[i0, j])
                              for j in range(max(0, j0 - 5), min(shifts.size, j0 + 6))},
            "dy_at_best_dx": {f"{shifts[i]:+.0f}": _r(surf[i, j0])
                              for i in range(max(0, i0 - 5), min(shifts.size, i0 + 6))}}
    ok = inside & np.isfinite(r_best)
    rb = r_best[ok]
    med = float(np.median(rb))
    mad = float(np.median(np.abs(rb - med)))
    rz = r_zero[inside & np.isfinite(r_zero)]
    out = {
        "method": f"grid search +/-{c['search_m']} m step {c['step_m']} m minimising the MAD of "
                  "DEM(x+dx, y+dy) - elev_geoid over MMGIS drive ends inside dem_1m",
        "sign": "(dx, dy) is added to the MMGIS rover position (analysis CRS, m east/north) to "
                "land on the DEM; residual = DEM - rover elevation (m)",
        "dem": "data/interim/terrain/dem_1m.tif",
        "rover": G.site()["d0_sources"]["mmgis_waypoints_cached"],
        "dx": res["dx"], "dy": res["dy"],
        "n_points": int(inside.sum()), "n_used": int(ok.sum()),
        "residual_median_m": _r(med), "residual_mad_m": _r(mad),
        "residual_p5_p95_m": [_r(np.percentile(rb, 5)), _r(np.percentile(rb, 95))],
        "at_zero_shift": {"residual_median_m": _r(np.median(rz)),
                          "residual_mad_m": _r(np.median(np.abs(rz - np.median(rz))))},
        "mad_profile_m": prof,
        "per_drive_end": [
            {"rmc": pts[i]["RMC"], "sol": pts[i]["sol"], "lon": round(lon[i], 6),
             "lat": round(lat[i], 6), "elev_geoid": pts[i]["elev_geoid"],
             "dem_at_shift": _r(r_best[i] + elev[i]), "residual_m": _r(r_best[i])}
            for i in np.where(inside)[0]],
    }
    out = webout.coreg_web(out, search_m=c["search_m"], step_m=c["step_m"])  # contract v1.1
    _w(OUT / "coreg.json", out)
    # co-registered drive ends for WS6 (V1) and WS3: shifted lon/lat + IMU attitude
    sx, sy = x + res["dx"], y + res["dy"]
    slon, slat = G.lonlat_of_xy(sx, sy)
    ends = [{**pts[i], "lon_coreg": round(float(slon[i]), 7), "lat_coreg": round(float(slat[i]), 7),
             "x_coreg": round(float(sx[i]), 2), "y_coreg": round(float(sy[i]), 2),
             "dem_m": _r(r_best[i] + elev[i])} for i in np.where(inside)[0]]
    _w(OUT / "drive_ends_coreg.json", {"crs_xy": G.analysis_crs(), "shift_m": [res["dx"],
                                       res["dy"]], "source": out["rover"], "drive_ends": ends})
    # contract keys + canonical manifest keys (coreg.*): step_validation
    return out


# --------------------------------------------------------------------------- HiRISE cross-check


def step_xcheck() -> dict:
    """Merged DEM minus each HiRISE DTM (never used for routing): median, P90; plus the
    horizontal shift between them (same MAD grid search, on a random subsample)."""
    from . import fetch

    dem, g1 = rio.read(OUT / "dem_1m.tif")
    c = G.site()["coreg"]
    rng = np.random.default_rng(0)
    out = {"definition": "diff = merged DEM - HiRISE DTM on the dem_1m grid (bilinear); "
                         "P90 is of |diff|", "items": {}}
    for pid in G.site()["d0_sources"]["hirise_dtm_href"]:
        src = fetch.cached(f"hirise_dtm_{pid}_win")
        if src is None:
            raise FileNotFoundError(f"{pid}: run `python -m pipeline.terrain.fetch hirise`")
        dst = OUT / "xcheck" / f"hirise_{pid}_1m.tif"
        rio.warp_to_grid(src, dst, g1, "bilinear", src_nodata="-3.4028227e+38")
        h, _ = rio.read(dst)
        h[h < -1e30] = np.nan
        d = dem - h
        v = d[np.isfinite(d)]
        item = {"file": str(dst.relative_to(G.REPO)), "valid_frac_of_dem_window":
                _r(np.isfinite(h).mean(), 4),
                "median_m": _r(np.median(v)), "p10_m": _r(np.percentile(v, 10)),
                "p90_m": _r(np.percentile(v, 90)), "p90_abs_m": _r(np.percentile(np.abs(v), 90))}
        # horizontal shift of HiRISE relative to the merged DEM
        rr, cc = np.where(np.isfinite(h))
        sel = rng.choice(rr.size, size=min(4000, rr.size), replace=False)
        px, py = g1.xy_of_rc(rr[sel], cc[sel])
        s = coreg.grid_search(dem, g1, px, py, h[rr[sel], cc[sel]], search_m=c["search_m"],
                              step_m=c["step_m"])
        item["shift_to_merged"] = {"dx": s["dx"], "dy": s["dy"], "mad_m": _r(s["mad"]),
                                   "median_m": _r(s["median"]), "n": s["n_used_at_best"],
                                   "note": "(dx, dy) added to HiRISE positions to land on the "
                                           "merged DEM; median = merged - HiRISE after shift"}
        out["items"][pid] = item
    _w(OUT / "hirise_xcheck.json", out)
    return out  # manifest keys: _record_validation (validation/coverage.json terrain_checks)


# --------------------------------------------------------------------------- slope, ridge, routing


def ridge_index(z: np.ndarray, res: float) -> np.ndarray:
    """Elevation minus the median-filtered surface (site.yaml ridge.median_window_m).
    NaN wherever the median window touches nodata (never filled)."""
    from scipy.ndimage import median_filter, uniform_filter

    w = S.window_px(G.site()["ridge"]["median_window_m"], res)

    def f(s):
        nan = ~np.isfinite(s)
        s0 = np.where(nan, 0.0, s).astype(np.float32)
        med = median_filter(s0, size=w, mode="nearest")
        out = (s0 - med).astype(np.float32)
        bad = uniform_filter(nan.astype(np.float32), w, mode="constant") > 1e-6
        h = w // 2
        bad[:h] = bad[-h:] = True
        bad[:, :h] = bad[:, -h:] = True
        out[bad] = np.nan
        return out

    return S.strips(f, z, halo=w // 2, rows=1024)


def step_slope() -> dict:
    site = G.site()
    dem, g1 = rio.read(OUT / "dem_1m.tif")
    mask, _ = rio.read(OUT / "source_mask.tif")
    s1 = S.horn(dem, g1.res)
    rio.write_cog(OUT / "slope_1m.tif", s1, g1)
    wpx = S.window_px(site["slope"]["compare_window_m"], g1.res)
    s5, rough = S.plane_fit(dem, g1.res, wpx)
    rio.write_cog(OUT / "slope_5m.tif", s5, g1,
                  tags={"method": f"least-squares plane over {wpx}x{wpx} 1 m cells"})
    rw = S.window_px(site["roughness_window_m"], g1.res)
    if rw != wpx:
        _, rough = S.plane_fit(dem, g1.res, rw)
    rio.write_cog(OUT / "roughness_5m.tif", rough, g1,
                  tags={"method": f"RMS residual of a plane over {rw}x{rw} 1 m cells (m)"})
    known1 = (mask == coverage.HIRISE) & np.isfinite(s1) & np.isfinite(s5)
    d = (s5 - s1)[known1]
    nogo = float(site["slope"]["nogo_deg"]["nominal"])
    cmp_ = {"window_px": wpx, "median_diff_deg": _r(np.median(d)),
            "p5_p95_diff_deg": [_r(np.percentile(d, 5)), _r(np.percentile(d, 95))],
            "median_abs_diff_deg": _r(np.median(np.abs(d))),
            "frac_cells_over_nogo_horn": _r(float((s1[known1] > nogo).mean()), 5),
            "frac_cells_over_nogo_5m": _r(float((s5[known1] > nogo).mean()), 5),
            "definition": "slope_5m - slope_1m (Horn) over HiRISE cells, deg"}
    del s5, d
    ridge = ridge_index(dem, g1.res)
    thr = float(site["ridge"]["threshold_m"])
    rio.write_cog(OUT / "ridge_index.tif", ridge, g1,
                  tags={"method": "elevation - median over "
                        f"{site['ridge']['median_window_m']} m; ridge where > {thr} m"})

    # 3 m routing grids on the route lattice (nested in the 1 m grid)
    g3 = G.route_grid()
    k = int(round(g3.res / g1.res))
    r0 = int(round((g1.y0 - g3.y0) / g1.res))
    c0 = int(round((g3.x0 - g1.x0) / g1.res))
    win = (slice(r0, r0 + g3.height * k), slice(c0, c0 + g3.width * k))
    cg = routing.cell_grids(dem[win], s1[win], mask[win], res_m=g1.res,
                            step_guard_deg=float(site["slope"]["step_guard_deg"]), k=k)
    st_known = np.where(cg.known, routing.ASSESSED, routing.UNKNOWN).astype(np.uint8)
    edge3 = coverage.data_edge(st_known, g3.res, float(site["coverage"]["source_edge_buffer_m"]))
    rio.write_cog(OUT / "elev_3m.tif", cg.elev, g3, tags={"method": "mean of 3x3 1 m cells"})
    rio.write_cog(OUT / "maxslope_3m.tif", cg.maxslope, g3,
                  tags={"method": "max Horn 1 m slope inside the 3 m cell (deg)"})
    rio.write_cog(OUT / "dataedge_3m.tif", edge3.astype(np.uint8), g3, nodata=255,
                  tags={"codes": "1 = known cell within source_edge_buffer_m of unknown"})
    del cg
    ridge3 = routing._blocks(ridge[win], k)
    with np.errstate(invalid="ignore"):
        ridge3max = np.where(np.isfinite(ridge3).all(axis=2), ridge3.max(axis=2), np.nan)
    rio.write_cog(OUT / "ridge_3m.tif", (ridge3max > thr).astype(np.uint8), g3, nodata=255,
                  tags={"codes": f"1 = any 1 m cell has ridge_index > {thr} m (haul mask)"})

    out = {"slope_compare": cmp_, "ridge_threshold_m": thr,
           "ridge_frac_1m": _r(float(np.nanmean(ridge > thr)), 4)}
    _w(OUT / "slope_summary.json", out)
    del dem, s1, mask, ridge
    step_cells()  # D22/D23 cell slope, step guard, cell states; adds slope_summary "discs"
    return out  # manifest keys: _record_validation (validation/coverage.json terrain_checks)


VARIANT_FILES = {"nominal": "cellstate_3m.tif",  # canonical (make web -> terrain/cellstate)
                 "optimistic": "cellstate_3m_optimistic.tif",
                 "conservative": "cellstate_3m_conservative.tif"}  # -> cellstate_conservative
CELLS_JSON = "cellstate_3m_variants.json"


def step_cells() -> dict:
    """D22/D23 (SPEC 11): 3 m plane-fit slope, step guard and the cell states at the three no-go
    limits, from dem_1m.tif, slope_1m.tif and source_mask.tif (nothing else is rewritten;
    maxslope_3m.tif stays the rough-footing overlay). Every raster is written to a tmp_ name
    first and swapped in only when all are complete (others read data/interim/terrain/)."""
    site = G.site()
    sl = site["slope"]
    nogo = {v: float(sl["nogo_deg"][v]) for v in VARIANT_FILES}
    sgd = float(sl["step_guard_deg"])
    dem, g1 = rio.read(OUT / "dem_1m.tif")
    s1, _ = rio.read(OUT / "slope_1m.tif")
    mask, _ = rio.read(OUT / "source_mask.tif")
    g3 = G.route_grid()
    k = int(round(g3.res / g1.res))
    r0 = int(round((g1.y0 - g3.y0) / g1.res))
    c0 = int(round((g3.x0 - g1.x0) / g1.res))
    win = (slice(r0, r0 + g3.height * k), slice(c0, c0 + g3.width * k))
    cg = routing.cell_grids(dem[win], s1[win], mask[win], res_m=g1.res, step_guard_deg=sgd, k=k)
    del dem, s1, mask
    mx, _ = rio.read(OUT / "maxslope_3m.tif")  # the published rough-footing grid, unchanged
    if mx.shape != cg.maxslope.shape or not np.array_equal(np.isnan(mx), np.isnan(cg.maxslope)) \
            or np.nanmax(np.abs(mx - cg.maxslope)) > 0:
        raise ValueError("maxslope_3m.tif differs from the max 1 m slope of slope_1m.tif: "
                         "run `build slope`")
    states = {v: cg.state(d) for v, d in nogo.items()}
    pending = [("slope_3m.tif", cg.slope, None,
                {"method": "D22: slope (deg) of the least-squares plane through the cell's nine "
                           "1 m elevations (dem_1m.tif); NaN = unknown cell"}),
               ("stepguard_3m.tif", cg.stepguard_u8(), 255,
                {"codes": f"D22 step guard: 1 = some 1 m Horn slope inside the cell > {sgd:g} "
                          "deg (blocked at every no-go), 0 = no, 255 = unknown cell"})]
    for v, f in VARIANT_FILES.items():
        pending.append((f, states[v], 255,
                        {"codes": f"0 assessed, 1 blocked (3 m plane-fit slope > {nogo[v]:g} deg "
                                  f"{v}, or step guard > {sgd:g} deg; D22/D23), 2 unknown",
                         "variant": v, "nogo_deg": f"{nogo[v]:g}"}))
    for name, arr, nd, tags in pending:
        rio.write_cog(OUT / ("tmp_" + name), arr, g3, nodata=nd, tags=tags)
    for name, *_ in pending:
        (OUT / ("tmp_" + name)).replace(OUT / name)
    pad = G.pad_xy()
    radii = disc_radii_m()
    doc = webout.cell_state_summary(
        states, cg.slope, cg.stepguard, cg.known, cg.maxslope, g3, pad, radii, nogo_deg=nogo,
        step_guard_deg=sgd, rasters={v: f"data/interim/terrain/{f}"
                                     for v, f in VARIANT_FILES.items()})
    _w(OUT / CELLS_JSON, doc)
    old = OUT / "cellstate_3m_conservative.json"  # pre-D23 summary (20 - V1 RMSE): retired
    if old.exists():
        old.unlink()
    # slope_summary.json "discs": blocked share of known cells (nominal) and 17-20 deg share
    summ_p = OUT / "slope_summary.json"
    summ = json.loads(summ_p.read_text()) if summ_p.exists() else {}
    nom = states["nominal"]
    bt = float(sl["flag_beyond_tested_deg"])
    summ.update(nogo_deg=nogo["nominal"], step_guard_deg=sgd, discs={})
    for b, rad in radii.items():
        dsk = coverage.disc(g3, pad, rad)
        known = dsk & cg.known
        with np.errstate(invalid="ignore"):
            beyond = (cg.slope[known] > bt) & (cg.slope[known] <= nogo["nominal"]) \
                & ~cg.stepguard[known]
        summ["discs"][str(b)] = {
            "blocked_pct_of_known": _r(100 * float((nom[known] == routing.BLOCKED).mean()), 3),
            "beyond_tested_pct_of_known": _r(100 * float(beyond.mean()), 3),
            "beyond_tested_definition": f"plane-fit slope in ({bt:g}, {nogo['nominal']:g}] deg "
                                        "and no step guard",
            "data_edge_cells": None}
    edge, _ = rio.read(OUT / "dataedge_3m.tif")
    for b, rad in radii.items():
        summ["discs"][str(b)]["data_edge_cells"] = int(((edge == 1)
                                                        & coverage.disc(g3, pad, rad)).sum())
    _w(summ_p, summ)
    return doc


# --------------------------------------------------------------------------- far field (WS3)


def step_farfield() -> dict:
    """ctx_20m.tif (CTX geoid-adjusted DTM windows, greedy picks, first pick wins) and
    mola_hrsc_200m.tif (D0's cached +/-80 km window), both north-up in the analysis CRS."""
    import yaml as _y

    from . import fetch

    hz = _y.safe_load((G.CONFIG / "horizon.yaml").read_text())
    band = {b["source"]: b for b in hz["sampling"]}
    pr = G.site()["planning_radius_m"]
    # MOLA-HRSC
    mola_src = fetch.fetch_mola()
    gm = G.pad_grid(band["mola_hrsc_200m"]["to_m"] + pr, band["mola_hrsc_200m"]["step_m"])
    rio.warp_to_grid(mola_src, OUT / "mola_hrsc_200m.tif", gm, "bilinear", src_nodata=-32768,
                     out_type="Float32")
    mola, _ = rio.read(OUT / "mola_hrsc_200m.tif")
    # CTX: greedy picks; each item QA'd against MOLA-HRSC; failures excluded and re-picked
    qa_cfg = G.site()["ctx_qa"]
    gc = G.pad_grid(fetch.ctx_radius_m(), band["ctx_20m"]["step_m"])
    rng = np.random.default_rng(0)
    exclude: set[str] = set()
    qa: dict[str, dict] = {}
    for _ in range(4):
        picks = fetch.fetch_ctx(fetch.ctx_radius_m(), exclude=frozenset(exclude))
        bad = False
        for c, p in picks:
            if c["id"] in qa:
                continue
            one = OUT / "xcheck" / f"ctx_item_{c['id']}.tif"
            rio.warp_to_grid(p, one, gc, "bilinear", src_nodata=-32767)
            z, _ = rio.read(one)
            rr, cc = np.where(np.isfinite(z))
            sel = rng.choice(rr.size, size=min(20000, rr.size), replace=False)
            x, y = gc.xy_of_rc(rr[sel], cc[sel])
            d = z[rr[sel], cc[sel]] - coreg.sample_bilinear(mola, gm, x, y)
            d = d[np.isfinite(d)]
            med = float(np.median(d))
            ok = abs(med) <= qa_cfg["max_abs_median_vs_mola_m"]
            qa[c["id"]] = {"minus_mola_median_m": _r(med),
                           "minus_mola_p5_p95_m": [_r(np.percentile(d, 5)),
                                                   _r(np.percentile(d, 95))],
                           "accepted": ok, "file": one, "gain": c["gain"]}
            if not ok:
                exclude.add(c["id"])
                bad = True
        if not bad:
            break
    used = [c for c, _ in picks if qa[c["id"]]["accepted"]]
    ctx = np.full(gc.shape, np.nan, np.float32)
    for c in reversed(used):  # first pick wins: paint in reverse priority
        z, _ = rio.read(qa[c["id"]]["file"])
        if qa_cfg["level_to_mola"]:
            z = z - np.float32(qa[c["id"]]["minus_mola_median_m"])
        ctx = np.where(np.isfinite(z), z, ctx)
    rio.write_cog(OUT / "ctx_20m.tif", ctx, gc, tags={
        "source": "USGS controlled CTX DTMs, geoid_adjusted_dem; "
                  + ("levelled to MOLA-HRSC per item" if qa_cfg["level_to_mola"] else "")})
    srcs = [(c, None) for c in used]
    ctx, _ = rio.read(OUT / "ctx_20m.tif")
    # datum sanity: CTX minus MOLA-HRSC sampled at CTX cell centres
    rr, cc = np.where(np.isfinite(ctx))
    sel = np.random.default_rng(0).choice(rr.size, size=min(20000, rr.size), replace=False)
    x, y = gc.xy_of_rc(rr[sel], cc[sel])
    dm = ctx[rr[sel], cc[sel]] - coreg.sample_bilinear(mola, gm, x, y)
    dm = dm[np.isfinite(dm)]
    dsk = coverage.disc(gc, G.pad_xy(), fetch.ctx_radius_m())
    out = {"ctx_20m": {"file": "data/interim/terrain/ctx_20m.tif", "res_m": gc.res,
                       "half_width_m": fetch.ctx_radius_m(),
                       "items": [{k: v for k, v in c.items() if k != "poly"} for c, _ in srcs],
                       "qa": {k: {kk: vv for kk, vv in v.items() if kk != "file"}
                              for k, v in qa.items()},
                       "qa_rule": qa_cfg,
                       "valid_frac_disc": _r(float(np.isfinite(ctx[dsk]).mean()), 4),
                       "minus_mola_median_m": _r(np.median(dm)),
                       "minus_mola_p5_p95_m": [_r(np.percentile(dm, 5)),
                                               _r(np.percentile(dm, 95))],
                       "asset": G.site()["d0_sources"]["ctx_asset"]},
           "mola_hrsc_200m": {"file": "data/interim/terrain/mola_hrsc_200m.tif",
                              "res_m": gm.res, "half_width_m": gm.width * gm.res / 2,
                              "source": str(mola_src.relative_to(G.REPO)),
                              "valid_frac": _r(float(np.isfinite(mola).mean()), 4)}}
    _w(OUT / "farfield.json", out)
    return out


def step_farfield_v2() -> dict:
    """ctx_20m_v2.tif: the same accepted CTX items as ctx_20m.tif, each co-registered to dem_1m
    in their overlap (horizontal MAD grid search + median offset, site.yaml ctx_v2) instead of
    levelled to MOLA-HRSC by one whole-disc median. Writes a new file; ctx_20m.tif is untouched
    (C decides the switch). Report: farfield_v2.json (before/after vs dem_1m and vs MOLA-HRSC
    by distance ring, the 2 km handover step and its elevation-angle equivalent)."""
    from . import farfield as FF

    cfg = G.site()["ctx_v2"]
    ff = json.loads((OUT / "farfield.json").read_text())["ctx_20m"]
    dem, g1 = rio.read(OUT / "dem_1m.tif")
    mola, gm = rio.read(OUT / "mola_hrsc_200m.tif")
    v1, gc = rio.read(OUT / "ctx_20m.tif")
    pad = G.pad_xy()
    dem20 = FF.reference_on(gc, dem, g1)
    del dem
    items, fits = [c["id"] for c in ff["items"]], {}
    v2 = np.full(gc.shape, np.nan, np.float32)
    for iid in reversed(items):  # first pick wins: paint in reverse priority (as ctx_20m.tif)
        z, gz = rio.read(OUT / "xcheck" / f"ctx_item_{iid}.tif")
        assert gz == gc, f"{iid}: item grid differs from ctx_20m.tif"
        fit = FF.coregister_to_reference(z, gc, dem20, gc, search_m=cfg["shift_search_m"],
                                         step_m=cfg["shift_step_m"], n_sample=cfg["sample_cells"],
                                         min_cells=cfg["min_overlap_cells"], seed=0)
        lvl = None
        ok = np.isfinite(z) & np.isfinite(dem20)
        if ok.sum():
            off = float(np.median((z - dem20)[ok]))
            lvl = {"offset_m": _r(off), "after_mad_m": _r(float(np.median(np.abs(
                (z - dem20)[ok] - off))))}
        if fit is None:
            fit = {"dx": 0.0, "dy": 0.0, "offset_m": float(ff["qa"][iid]["minus_mola_median_m"]),
                   "method": "fallback: levelled to MOLA-HRSC (no dem_1m overlap)"}
        else:
            fit["method"] = "co-registered to dem_1m (20 m block mean) in the overlap"
        fit["level_only_alternative"] = lvl
        fit["v1_mola_offset_m"] = ff["qa"][iid]["minus_mola_median_m"]
        fits[iid] = fit
        zc = FF.apply_fit(z, gc, fit)
        v2 = np.where(np.isfinite(zc), zc, v2)
    rio.write_cog(OUT / "ctx_20m_v2.tif", v2, gc, tags={
        "source": "USGS controlled CTX DTMs, geoid_adjusted_dem; each item shifted and levelled "
                  "onto dem_1m in the overlap (farfield_v2.json)"})

    def mola_at(x, y):
        return coreg.sample_bilinear(mola, gm, x, y)

    def dem_at(x, y):
        return coreg.sample_bilinear(dem20, gc, x, y)

    near = [(0, 1000), (1000, 2000), (2000, 3000), (3000, 3900), (1500, 3900)]
    far = [(0, 4000), (4000, 8000), (8000, 16000), (16000, 24000), (24000, 30000),
           (30000, 34000)]
    hand = float(yaml.safe_load((G.CONFIG / "horizon.yaml").read_text())["sampling"][0]["to_m"])
    rep = {}
    for name, z in (("v1", v1), ("v2", v2)):
        dn = FF.ring_stats(z, gc, dem_at, pad, near)
        rep[name] = {"minus_dem_1m_by_ring_m": dn,
                     "minus_mola_by_ring_m": FF.ring_stats(z, gc, mola_at, pad, far),
                     "handover_step_m": dn["1500-3900"]["median_m"],
                     "handover_step_deg_at_handover": None if dn["1500-3900"]["median_m"] is None
                     else _r(math.degrees(math.atan2(dn["1500-3900"]["median_m"], hand)), 3),
                     "valid_frac": _r(float(np.isfinite(z).mean()), 4)}
    rr, cc = np.where(np.isfinite(dem20))
    mz = np.full(gc.shape, np.nan, np.float32)
    mz[rr, cc] = mola_at(*gc.xy_of_rc(rr, cc))
    out = {"file": "data/interim/terrain/ctx_20m_v2.tif", "replaces": "ctx_20m.tif (if C "
           "switches)", "config": cfg, "handover_m": hand,
           "reference": "dem_1m block-averaged to the 20 m CTX lattice (same pad-centred lattice)",
           "sign": "corrected(x, y) = item(x + dx, y + dy) - offset_m; (dx, dy) = where the item's "
                   "content sits relative to dem_1m (east, north, m)",
           "items": fits, "compare": rep,
           "mola_minus_dem_1m_by_ring_m": FF.ring_stats(mz, gc, dem_at, pad, near)}
    _w(OUT / "farfield_v2.json", out)
    return out


# --------------------------------------------------------------------------- CRISM (F7)


def step_crism() -> dict:
    """CRISM MTRDR D2300 and SINDEX2 (D0 2.7) -> analysis CRS, 18 m, mean of observations."""
    import rasterio
    from rasterio.transform import Affine

    from . import fetch

    s = G.site()["d0_sources"]
    ign = float(s["crism_ignore_value"])
    g18 = G.pad_grid(G.site()["planning_radius_m"] + G.site()["dem_window_buffer_m"], 18.0)
    out = {}
    for idx_name, band in s["crism_band_1based"].items():
        layers = []
        for pid in s["crism_su_img"]:
            raw = fetch.cached(f"crism_{pid}_{idx_name}_b{band}")
            if raw is None:
                raise FileNotFoundError(f"{pid}: run `python -m pipeline.terrain.fetch crism`")
            h = fetch._envi_hdr(DISC / f"crism_{pid}_su.hdr")
            a = np.fromfile(raw, "<f4").reshape(h["lines"], h["samples"]).copy()
            a[(a == ign) | ~np.isfinite(a)] = np.nan
            mi = h["map info"]  # [proj, ref_x, ref_y, easting, northing, dx, dy, ...]
            rx, ry, e0, n0, dx, dy = (float(v) for v in mi[1:7])
            t = Affine(dx, 0, e0 - (rx - 1) * dx, 0, -dy, n0 + (ry - 1) * dy)
            src = OUT / "xcheck" / f"crism_{pid}_{idx_name}_native.tif"
            src.parent.mkdir(parents=True, exist_ok=True)
            with rasterio.open(src, "w", driver="GTiff", width=a.shape[1], height=a.shape[0],
                               count=1, dtype="float32", crs=G.source_crs(), transform=t,
                               nodata=np.nan) as ds:
                ds.write(a, 1)
            dst = OUT / "xcheck" / f"crism_{pid}_{idx_name}_18m.tif"
            rio.warp_to_grid(src, dst, g18, "bilinear")
            layers.append(rio.read(dst)[0])
        with np.errstate(invalid="ignore"), __import__("warnings").catch_warnings():
            __import__("warnings").simplefilter("ignore", RuntimeWarning)
            m = np.nanmean(np.stack(layers), axis=0).astype(np.float32)
        name = f"crism_{idx_name.lower()}_18m.tif"
        rio.write_cog(OUT / name, m, g18, tags={"source": ", ".join(s["crism_su_img"]),
                                                 "combine": "mean of valid observations"})
        v = m[np.isfinite(m)]
        out[idx_name] = {"file": f"data/interim/terrain/{name}",
                         "valid_frac": _r(float(np.isfinite(m).mean()), 4),
                         "p2_p50_p98": [_r(np.percentile(v, q), 5) for q in (2, 50, 98)]}
    _w(OUT / "crism.json", out)
    return out


# --------------------------------------------------------------------------- stations (F7)


def _norm(a: np.ndarray, lo_hi) -> tuple[np.ndarray, list[float]]:
    v = a[np.isfinite(a)]
    lo, hi = (float(np.percentile(v, q)) for q in lo_hi)
    return np.clip((a - lo) / (hi - lo), 0, 1), [lo, hi]


def step_stations() -> dict:
    """Station science points and values per stations.yaml (values part of stations.json).

    value = w_crism * CRISM (normalised) + w_ridge * ridge density (normalised)
            + w_manual * manual_priority   (SPEC F7; normalisations in scoring_assumptions)

    D26/D32 (user 2026-11-14 16:20 CET), on the D22 nominal cell states (cellstate_3m.tif):
    order S4, S1, S2, then up to ``extras.max`` F7-scored stations (S6...); every science point is
    walkable (assessed 3 m cell), in the focus area and >= ``min_spacing_m`` from every station
    placed before it. S3/S5 (``status: dropped``) are listed under ``dropped``, not placed.
    WS2 computes the access cells and reachability from these science points.
    """
    from scipy.ndimage import convolve

    from . import stations as ST

    st = G.stations_cfg()
    asm = st["scoring_assumptions"]
    w = st["scoring_weights"]
    ex = st["extras"]
    min_sp = float(st["min_spacing_m"])
    ridge, g1 = rio.read(OUT / "ridge_index.tif")
    thr = float(G.site()["ridge"]["threshold_m"])
    # ridge density on a 5 m lattice: fraction of 1 m ridge cells per 5 m block, then the mean
    # over a disc of ridge_density_radius_m (in 5 m cells)
    k5 = int(G.site()["grids_m"]["fields"] / g1.res)
    rb = routing._blocks(ridge, k5)
    valid5 = np.isfinite(rb).all(axis=2)
    frac5 = np.where(valid5, (rb > thr).mean(axis=2), np.nan)
    g5 = G.Grid(g1.x0, g1.y0, g1.res * k5, g1.width // k5, g1.height // k5)
    rr = int(round(st["ridge_density_radius_m"] / g5.res))
    yy, xx = np.mgrid[-rr:rr + 1, -rr:rr + 1]
    ker = ((xx * xx + yy * yy) <= rr * rr).astype(np.float64)
    num = convolve(np.where(valid5, frac5, 0.0), ker, mode="constant")
    den = convolve(valid5.astype(np.float64), ker, mode="constant")
    with np.errstate(invalid="ignore", divide="ignore"):
        dens = np.where(den >= ker.sum() - 1e-9, num / den, np.nan)
    p98 = float(np.nanpercentile(dens, asm["crism_norm_percentiles"][1]))
    dens_n = np.clip(dens / p98, 0, 1)
    # CRISM on the same 5 m lattice (sampled at 5 m cell centres)
    r5, c5 = np.mgrid[0:g5.height, 0:g5.width]
    x5, y5 = g5.xy_of_rc(r5, c5)
    crism_n, crism_rng = {}, {}
    for idx in st["crism_indices"].values():
        a, g18 = rio.read(OUT / f"crism_{idx.lower()}_18m.tif")
        n18, crism_rng[idx] = _norm(a, asm["crism_norm_percentiles"])
        crism_n[idx] = coreg.sample_bilinear(n18, g18, x5.ravel(), y5.ravel()).reshape(x5.shape)
    idx_names = list(crism_n)
    crism_n["max"] = np.fmax(*[crism_n[i] for i in idx_names])

    def crism_for(sid):
        return crism_n[asm["station_crism_index"].get(sid, ex["crism_index"])]

    # D22 nominal cell states: the walkable filter (D26)
    state3, g3 = rio.read(OUT / "cellstate_3m.tif")
    var_states = {v: rio.read(OUT / f)[0] for v, f in VARIANT_FILES.items()}
    slope3, _ = rio.read(OUT / "slope_3m.tif")
    sg3, _ = rio.read(OUT / "stepguard_3m.tif")

    # pick lattice: 25 m cells; S1/S2 domain = focus area and flat 30-min disc around pad_default
    f = G.site()["aoi_focus"]
    lon5, lat5 = G.lonlat_of_xy(x5, y5)
    pad = G.pad_xy()
    r30 = disc_radii_m()[min(disc_radii_m())]
    focus5 = ST.in_focus(lon5, lat5, f)
    dom = focus5 & (np.hypot(x5 - pad[0], y5 - pad[1]) <= r30)
    kc = int(asm["pick_cell_m"] / g5.res)
    hh, ww = (g5.height // kc) * kc, (g5.width // kc) * kc

    def cells(a):
        b = routing._blocks(a[:hh, :ww], kc)
        with np.errstate(invalid="ignore"), __import__("warnings").catch_warnings():
            __import__("warnings").simplefilter("ignore", RuntimeWarning)
            return np.nanmean(b, axis=2)

    dom_c = routing._blocks(dom[:hh, :ww], kc).all(axis=2)
    focus_c = routing._blocks(focus5[:hh, :ww], kc).all(axis=2)
    gc = G.Grid(g5.x0, g5.y0, g5.res * kc, ww // kc, hh // kc)
    xc, yc = gc.xy_of_rc(*np.mgrid[0:gc.height, 0:gc.width])
    walk_c = ST.walkable_at(state3, g3, xc.ravel(), yc.ravel()).reshape(xc.shape)
    dens_c = cells(dens_n)

    def value(crism_v, dens_v, manual):
        if crism_v is None or dens_v is None or not np.isfinite(crism_v) \
                or not np.isfinite(dens_v):
            return None
        return w["crism"] * crism_v + w["ridge_density"] * dens_v + w["manual"] * manual

    def best(score):
        if not np.isfinite(score).any():
            return None
        i = np.unravel_index(np.nanargmax(score), score.shape)
        return (float(xc[i]), float(yc[i]))

    placed: list[tuple[float, float]] = []
    pos: dict[str, tuple] = {}
    # S4: drive end nearest sol 4200 that is walkable and in the focus area (D26)
    ends = sorted(drive_ends(), key=lambda e: (abs(e["sol"] - 4200), e["sol"]))
    e0 = ends[0]
    e4 = next((e for e in ends
               if ST.walkable_at(state3, g3, *G.xy_of_lonlat(e["lon"], e["lat"]))[0]
               and ST.in_focus(e["lon"], e["lat"], f)), None)
    s4_xy = None if e4 is None else tuple(float(v) for v in G.xy_of_lonlat(e4["lon"], e4["lat"]))
    moved = None
    if e4 is not None and e4 is not e0:
        x0_, y0_ = G.xy_of_lonlat(e0["lon"], e0["lat"])
        moved = {"rmc": e0["RMC"], "sol": e0["sol"], "lon": e0["lon"], "lat": e0["lat"],
                 "dist_m": _r(float(np.hypot(s4_xy[0] - x0_, s4_xy[1] - y0_)), 1),
                 "cellstate_nominal": int(state3[tuple(int(v) for v in g3.rc_of_xy(x0_, y0_))])}
    if s4_xy:
        placed.append(s4_xy)
    pos["S4"] = (s4_xy, None if e4 is None else
                 f"MMGIS drive end {e4['RMC']} (sol {e4['sol']}): nearest sol 4200 that is "
                 "walkable (D22 nominal) and in the focus area", moved)
    # S1: max(ridge density + clay index) in focus area and 30-min disc, walkable, spaced
    sp = ST.spacing_ok(xc, yc, placed, min_sp)
    s1_xy = best(np.where(dom_c & walk_c & sp, dens_c + cells(crism_for("S1")), -np.inf))
    if s1_xy:
        placed.append(s1_xy)
    pos["S1"] = (s1_xy, "rule: max(ridge density + clay index) 25 m cell in focus area and "
                        f"30-min disc; walkable (D22 nominal); >= {min_sp:g} m from S4", None)
    sp = ST.spacing_ok(xc, yc, placed, min_sp)
    s2_xy = best(np.where(dom_c & walk_c & sp, dens_c, -np.inf))
    if s2_xy:
        placed.append(s2_xy)
    pos["S2"] = (s2_xy, f"rule: max ridge density 25 m cell (same domain as S1, assumed); "
                        f"walkable; >= {min_sp:g} m from S4 and S1", None)
    # extras (D26): F7 value on 25 m cells, focus area, walkable, spaced from every station
    val_c = (w["crism"] * cells(crism_n[ex["crism_index"]]) + w["ridge_density"] * dens_c
             + w["manual"] * float(ex["manual_priority"]))
    elig = focus_c & walk_c
    picks = ST.place_extras(xc.ravel(), yc.ravel(), val_c.ravel(), elig.ravel(), placed,
                            int(ex["max"]), min_sp)
    for n, i in enumerate(picks):
        sid = ex["ids"][n]
        pos[sid] = ((float(xc.ravel()[i]), float(yc.ravel()[i])),
                    f"D26 extra #{n + 1}: highest F7 value 25 m cell (crism = {ex['crism_index']} "
                    f"index, manual 0) in the focus area, walkable, >= {min_sp:g} m from every "
                    f"station placed before it (25 m cell value {val_c.ravel()[i]:.4f})", None)

    s_cfg = {s["id"]: s for s in st["stations"]}
    out, dropped = [], []
    for s in st["stations"]:
        if s.get("status") == "dropped":
            dropped.append({"id": s["id"], "name": s["name"], "status": "dropped",
                            "reason": "D26/D44 (user 17:28 CET): dropped, final; the imagery "
                                      "behind the claim is unchecked"})
    order = ["S1", "S2", "S4"] + [ex["ids"][n] for n in range(len(picks))]
    for sid in order:
        xy, how, moved_from = pos[sid]
        extra = sid not in s_cfg
        manual = float(ex["manual_priority"]) if extra else float(s_cfg[sid]["manual_priority"])
        rec = {"id": sid, "name": None if extra else s_cfg[sid]["name"], "lon": None,
               "lat": None, "value": None, "components": None, "position_rule": how,
               "placement": "F7 extra (D26)" if extra else "rule (D26 re-placed after D22)",
               "dwell_min": st["dwell_min"], "manual_priority": manual}
        if xy is None:
            rec["name"] = rec["name"] or sid
            rec["position_rule"] = "no cell passes the D26 filters"
            out.append(rec)
            continue
        lon, lat = G.lonlat_of_xy(*xy)
        r, c = g5.rc_of_xy(*xy)
        cv = float(crism_for(sid)[r, c])
        dv = float(dens_n[r, c])
        both = {i: float(crism_n[i][r, c]) for i in idx_names}
        name, finding = ST.finding_name(both, dv, min_norm=float(ex["name_min_norm"]),
                                        index_words=ex["index_words"])
        r3, c3 = g3.rc_of_xy(*xy)
        rec.update(lon=round(float(lon), 6), lat=round(float(lat), 6),
                   x=round(xy[0], 2), y=round(xy[1], 2),
                   components={"crism_index": asm["station_crism_index"].get(sid,
                                                                             ex["crism_index"]),
                               "crism_norm": _r(cv, 4), "ridge_density_norm": _r(dv, 4),
                               "ridge_density_raw": _r(float(dens[r, c]), 4),
                               "crism_norm_by_index": {i: _r(v, 4) for i, v in both.items()}},
                   finding=name,
                   finding_detail=finding,
                   cell={"slope_3m_deg": _r(float(slope3[r3, c3]), 2),
                         "stepguard": int(sg3[r3, c3]),
                         "state": {v: int(a[r3, c3]) for v, a in var_states.items()}})
        if extra:
            rec["name"] = name
        if moved_from:
            rec["moved_from"] = moved_from
        v = value(cv, dv, manual)
        rec["value"] = _r(v, 4) if v is not None else None
        out.append(rec)
    # D44: same-name stations get the compass point of the bearing from the official pad
    pad_lon, pad_lat, pad_src = ST.official_pad(G.REPO / "data/interim/engine/public/pad.json",
                                                G.site()["pad_default"])
    pad_off = tuple(float(v) for v in G.xy_of_lonlat(pad_lon, pad_lat))
    out = ST.add_compass_suffixes(out, pad_off)
    naming = {"rule": "D44 (user 17:28 CET): " + ex["same_name_suffix"]["compass"],
              "tie": ex["same_name_suffix"]["tie"],
              "pad": {"lon": pad_lon, "lat": pad_lat, "source": pad_src},
              "assumed": bool(ex["same_name_suffix"]["assumed"])}
    # spacing check over the final list (D32)
    pts = [(r_["x"], r_["y"]) for r_ in out if r_.get("x") is not None]
    dmin = min((float(np.hypot(a[0] - b[0], a[1] - b[1])) for i, a in enumerate(pts)
                for b in pts[i + 1:]), default=None)
    if dmin is not None and dmin < min_sp:
        raise ValueError(f"stations closer than {min_sp} m: {dmin:.1f} m")
    doc = {"note": "values part of stations.json (F7); objective/tasks/t_home/cards are filled "
                   "downstream. Internal file, not the web contract. Science points only: WS2 "
                   "computes the access cells and reachability (a station nobody can reach "
                   f"stays on the map, labelled '{st['placement']['unreachable_label']}', D26).",
           "weights": w, "weights_assumed": bool(st.get("scoring_weights_assumed")),
           "min_spacing_m": min_sp, "min_pairwise_m": _r(dmin, 1),
           "placement": st["placement"], "extras_rule": ex,
           "cellstate_source": "data/interim/terrain/cellstate_3m.tif (D22 nominal)",
           "normalisation": {"crism_p2_p98": crism_rng, "ridge_density_p98": _r(p98, 5)},
           "assumptions": asm, "same_name_suffix": naming, "stations": out, "dropped": dropped}
    _w(OUT / "stations.json", doc)
    _record_stations(doc)
    rio.write_cog(OUT / "ridge_density_5m.tif", dens.astype(np.float32), g5,
                  tags={"method": f"fraction of 1 m ridge cells within "
                                  f"{st['ridge_density_radius_m']} m"})
    return doc


def _record_stations(doc: dict) -> None:
    for rec in doc["stations"]:
        if rec.get("value") is not None:
            # web path: WS2 merges these values into engine/public/stations.json, which
            # `make web` publishes as stations.json (contracts/README.md sources table)
            record(f"stations.{rec['id']}.value", rec["value"], "1", "stations.json", SCRIPT)


# --------------------------------------------------------------------------- ortho + basemap


def _zoom_for(res_m: float) -> int:
    """XYZ zoom whose pixel (Mars lon/lat passed to MapLibre as-is, D4) is <= res_m... nearest.

    m/px at zoom z = (2 pi R / 360) * 360 / (256 * 2^z) = 2 pi R / (256 * 2^z).
    """
    r = G.site()["crs"]["mars_radius_m"]
    return int(round(math.log2(2 * math.pi * r / (256 * res_m))))


def step_ortho() -> dict:
    """ortho_lrgb_1m.tif on the dem grid (RGBA) for WS8, and XYZ PNG basemap tiles in
    data/interim/terrain/tiles/basemap/ (copied to web/public/data/tiles/basemap/ by make web).

    Source: Gale HiRISE LRGB colour COG (D0 2.6; covers 100% of the focus area, the RED ortho
    019698 only 80%). Low zooms from the 1 m overview over the dem window, high zooms from the
    0.25 m full resolution over the focus area. Zoom range from site.yaml basemap_res_m.
    """
    import shutil
    import subprocess

    from . import fetch

    src1 = fetch.cached("lrgb_1m_demwin")
    src025 = fetch.cached("lrgb_025m_focus")
    if src1 is None or src025 is None:
        raise FileNotFoundError("run `python -m pipeline.terrain.fetch lrgb` first")
    g1 = G.dem_grid()
    ortho = rio.warp_to_grid(src1, OUT / "ortho_lrgb_1m.tif", g1, "bilinear", dst_nodata=None,
                             out_type="Byte", extra=["-dstalpha"])
    lo_res, hi_res = G.site()["basemap_res_m"]
    z_hi = _zoom_for(lo_res)  # finest zoom (0.25 m -> z18)
    z_lo = _zoom_for(hi_res)  # coarsest zoom (10 m -> z13)
    z_split = _zoom_for(1.0)  # the 1 m overview serves zooms <= z_split
    tiles = OUT / "tiles" / "basemap"
    if tiles.exists():
        shutil.rmtree(tiles)
    tmp = OUT / "tiles" / "_vrt"
    tmp.mkdir(parents=True, exist_ok=True)
    runs = [(src1, z_lo, z_split), (src025, z_split + 1, z_hi)]
    for i, (src, za, zb) in enumerate(runs):
        ll = tmp / f"ll_{i}.vrt"
        earth = tmp / f"earth_{i}.vrt"
        subprocess.run(["gdalwarp", "-q", "-overwrite", "-of", "VRT", "-t_srs", G.geo_crs(),
                        "-r", "bilinear", "-dstalpha", str(src), str(ll)], check=True)
        # D4: Mars lon/lat are passed to MapLibre as if they were Earth lon/lat
        subprocess.run(["gdal_translate", "-q", "-of", "VRT", "-a_srs", "EPSG:4326", str(ll),
                        str(earth)], check=True)
        subprocess.run(["gdal", "raster", "tile", "-q", "--min-zoom", str(za), "--max-zoom",
                        str(zb), "--convention", "xyz", "--tiling-scheme", "WebMercatorQuad",
                        "-r", "bilinear", "--webviewer", "none", "-i", str(earth),
                        "-o", str(tiles)], check=True)
    shutil.rmtree(tmp)
    n = sum(1 for _ in tiles.rglob("*.png"))
    mb = sum(p.stat().st_size for p in tiles.rglob("*.png")) / 1e6
    per_zoom = {z.name: sum(1 for _ in z.rglob("*.png")) for z in sorted(tiles.iterdir())
                if z.is_dir()}
    out = {"ortho_1m": str(ortho.relative_to(G.REPO)), "tiles": str(tiles.relative_to(G.REPO)),
           "zooms": [z_lo, z_hi], "split_zoom": z_split, "n_tiles": n, "size_mb": round(mb, 1),
           "per_zoom": per_zoom,
           "source": G.site()["d0_sources"]["lrgb_cog_href"],
           "note": "XYZ, WebMercatorQuad on Mars lon/lat passed through as Earth lon/lat (D4)"}
    out["ortho_vs_dem_shift_px"] = ortho_alignment()
    _w(OUT / "basemap.json", out)
    return out


def ortho_alignment(boxes=((0.5, 0.5), (0.32, 0.58), (0.64, 0.38)), size=1024) -> list[dict]:
    """Phase correlation of ortho luminance vs DEM hillshade (sun azimuth scanned in 30 deg
    steps, best kept) in a few 1 km boxes: a registration check, 1 m pixels (row, col)."""
    import rasterio
    from scipy.ndimage import gaussian_filter
    from skimage.registration import phase_cross_correlation

    with rasterio.open(OUT / "ortho_lrgb_1m.tif") as ds:
        lum = ds.read([1, 2, 3]).astype(np.float32).mean(axis=0)
    z, _ = rio.read(OUT / "dem_1m.tif")

    def hp(x):
        x = x - gaussian_filter(x, 15)
        return x / x.std()

    res = []
    for fr, fc in boxes:
        r0, c0 = int(fr * z.shape[0]) - size // 2, int(fc * z.shape[1]) - size // 2
        lw = hp(lum[r0:r0 + size, c0:c0 + size])
        zz = z[r0:r0 + size, c0:c0 + size]
        best = None
        for az in range(0, 360, 30):
            hs = hp(hillshade(zz, 1.0, az=az, alt=40).astype(np.float32))
            sh, _, _ = phase_cross_correlation(lw, hs, upsample_factor=4, normalization=None)
            rolled = np.roll(hs, (int(round(sh[0])), int(round(sh[1]))), (0, 1))
            cc = float((lw * rolled)[50:-50, 50:-50].mean())
            if best is None or cc > best["corr"]:
                best = {"box_rc": [r0, c0], "corr": round(cc, 3), "sun_az": az,
                        "shift_rc": [float(sh[0]), float(sh[1])]}
        res.append(best)
    return res


# --------------------------------------------------------------------------- web documents


def _record_file(web_rel: str, path: Path) -> None:
    """File-level provenance key ``file.<web path>`` (contracts/README.md "Manifest keys")."""
    import hashlib

    record(f"file.{web_rel}", hashlib.sha256(path.read_bytes()).hexdigest(), "sha256", web_rel,
           SCRIPT)


def step_validation(out_dir: Path | None = None) -> dict:
    """validation/coverage.json + coverage.png and validation/coreg.json in the contract v1.1
    shape (copied by `make web` from data/interim/terrain/), with the canonical manifest keys.
    Needs cellstate_3m.tif (step slope), source_mask.tif (mask) and coreg.json (coreg).
    With ``out_dir`` the three files are written there instead and nothing is recorded (staging:
    other workstreams read data/interim/terrain/ while WS1 rebuilds; compare, then swap)."""
    dst = OUT if out_dir is None else Path(out_dir)
    from PIL import Image

    site = G.site()
    st, g3 = rio.read(OUT / "cellstate_3m.tif")
    mask, g1 = rio.read(OUT / "source_mask.tif")
    pad = G.pad_xy()
    radii = disc_radii_m()
    discs = [{"budget_min": b, "radius_m": round(r, 1),
              **webout.disc_state_pct(st, coverage.disc(g3, pad, r))} for b, r in radii.items()]
    src = webout.source_fractions_pct(mask, coverage.disc(g1, pad, site["planning_radius_m"]))
    del mask
    min_pct = site["coverage"]["pad_disc_assessed_min_pct"]
    pchk = webout.pad_check(discs, min(radii), min_pct,
                            reading=site["coverage"].get("pad_check_reading"))
    rgba, legend = webout.coverage_map_rgba(st, g3, pad, list(radii.values()))
    dst.mkdir(parents=True, exist_ok=True)
    png = dst / "coverage.png"
    tmp = png.with_name("coverage.tmp.png")
    Image.fromarray(rgba, "RGBA").save(tmp, format="PNG", optimize=True)
    tmp.replace(png)
    internal = json.loads((OUT / "coverage.json").read_text())
    d3 = site["d3"]
    if isinstance(internal.get("d3"), dict):
        internal["d3"] = {**internal["d3"], **_d3_state()}
    doc = webout.coverage_web(
        internal, discs=discs, source_pct=src, pad_chk=pchk,
        speed_ms=_crew()["anchor"]["speed_ms"],
        origin=f"D3 {d3['status']}: {d3['applied']}, intersected with valid DEM cells; the "
               "mosaic publishes no footprints (docs/discovery.md 2.2)",
        map_meta={"png": "validation/coverage.png", "bounds": webout.lonlat_bounds(g3),
                  "legend": legend, "res_m": g3.res,
                  "source": "data/interim/terrain/cellstate_3m.tif (3 m cell states)"})
    doc["source_fractions_note"] = ("share of the planning extent (disc of planning_radius_m "
                                    "around the pad) on the 1 m source mask; 'ctx' = code 2 = "
                                    "any non-HiRISE source (CTX or HRSC, not separable without "
                                    "mosaic footprints), 'hrsc_mola' (code 3) is never assigned")
    doc["discs_note"] = ("cell states of cellstate_3m.tif inside each flat disc (radius = "
                         "crew.yaml anchor.speed_ms x budget); assessed + blocked + unknown = 100")
    doc["terrain_checks"] = _terrain_checks()
    _w(dst / "coverage.json", doc)
    c = site["coreg"]
    cg = webout.coreg_web(json.loads((OUT / "coreg.json").read_text()), search_m=c["search_m"],
                          step_m=c["step_m"])
    _w(dst / "coreg.json", cg)

    if out_dir is None:
        _record_validation(doc, cg)
    return {"discs": discs, "pad_check": pchk, "source_fractions_pct": src}


def _record_validation(doc: dict, cg: dict) -> None:
    """Manifest keys of validation/coverage.json (+ .png) and validation/coreg.json."""
    F = "validation/coverage.json"
    for i, row in enumerate(doc["discs"]):
        b = row["budget_min"]
        for k in ("assessed_pct", "blocked_pct", "unknown_pct"):
            record(f"coverage.disc_{b}.{k}", row[k], "%", F, SCRIPT)
        record(f"validation.coverage.discs.{i}.budget_min", b, "min", F, SCRIPT)
        record(f"validation.coverage.discs.{i}.radius_m", row["radius_m"], "m", F, SCRIPT)
    for k, v in doc["source_fractions_pct"].items():
        record(f"coverage.source_fractions_pct.{k}", v, "%", F, SCRIPT)
    pchk = doc["pad_check"]
    for k, u in (("budget_min", "min"), ("min_assessed_pct", "%"), ("pass", None),
                 ("reading", None), ("known_pct", "%")):
        if k in pchk:  # "reading" is absent from a coverage.json written before session 2
            record(f"validation.coverage.pad_check.{k}", pchk[k], u, F, SCRIPT)
    for name, rd in pchk.get("readings", {}).items():
        record(f"validation.coverage.pad_check.readings.{name}.pct", rd["pct"], "%", F, SCRIPT)
        record(f"validation.coverage.pad_check.readings.{name}.pass", rd["pass"], None, F,
               SCRIPT)
    for k, u in (("dx_m", "m"), ("dy_m", "m"), ("residual_median_m", "m"),
                 ("residual_mad_m", "m"), ("n", "1")):
        record(f"coreg.{k}", cg[k], u, "validation/coreg.json", SCRIPT)
    _record_terrain_checks(doc.get("terrain_checks") or {}, F)
    _record_file("validation/coverage.json", OUT / "coverage.json")
    _record_file("validation/coverage.png", OUT / "coverage.png")
    _record_file("validation/coreg.json", OUT / "coreg.json")


def step_manifest() -> dict:
    """Rebuild WS1's manifest fragment from the outputs on disk (no raster is read or written):
    the fragment is cleared first, so keys WS1 no longer produces are dropped; then stations.json,
    coverage.json (incl. terrain_checks) and coreg.json are recorded again."""
    from pipeline.provenance import manifest as M

    def j(name):
        return json.loads((OUT / name).read_text())

    frag = M._fragment_dir(None) / M._fragment_name(M._rel(SCRIPT))
    before = set(json.loads(frag.read_text())) if frag.exists() else set()
    if frag.exists():
        frag.unlink()
    _record_stations(j("stations.json"))
    _record_validation(j("coverage.json"), j("coreg.json"))
    after = set(json.loads(frag.read_text()))
    return {"dropped": sorted(before - after), "added": sorted(after - before),
            "n": len(after)}


def step_grid() -> dict:
    """grid.json: every WS1 grid (NW corner, res, size, lon/lat bounds) + the height datum."""
    doc = webout.grids_doc()
    doc["height_datum"] = HEIGHT_DATUM
    _w(OUT / "grid.json", doc)
    return doc


HEIGHT_DATUM = (
    "metres above the Mars areoid, as published in the MSL Gale merged DEM v3 (docs/discovery.md "
    "2.1, 'areoid heights'); same datum as MMGIS elev_geoid (see coreg.json residual median), the "
    "HiRISE/CTX geoid-adjusted DTMs and the MOLA-HRSC blend. Not radius, not height above the "
    "R = 3,396,190 m sphere. Horizontal: analysis CRS (config/site.yaml crs.analysis_proj).")


# --------------------------------------------------------------------------- terrain checks


def _terrain_checks() -> dict:
    """validation/coverage.json ``terrain_checks`` from WS1's interim summaries (absent -> null)."""
    def j(name):
        p = OUT / name
        return json.loads(p.read_text()) if p.exists() else None

    return webout.terrain_checks(j("hirise_xcheck.json"), j("slope_summary.json"), j(CELLS_JSON))


def _record_terrain_checks(tc: dict, F: str) -> None:
    """Manifest keys of ``terrain_checks`` (all cite the web file ``F``)."""
    for pid, it in ((tc.get("hirise_xcheck") or {}).get("items") or {}).items():
        record(f"terrain.xcheck.{pid}.median", it["median_m"], "m", F, SCRIPT)
        record(f"terrain.xcheck.{pid}.p90_abs", it["p90_abs_m"], "m", F, SCRIPT)
    if tc.get("slope_compare"):
        record("terrain.slope_compare.median_abs_diff",
               tc["slope_compare"]["median_abs_diff_deg"], "deg", F, SCRIPT)
    for b, v in (tc.get("blocked_pct_of_known") or {}).items():
        record(f"terrain.blocked_pct.{b}min", v, "%", F, SCRIPT)
    cs = tc.get("cell_states")
    if cs:  # D22/D23 (replaces the pre-D23 terrain.conservative.* / nogo_conservative_deg keys)
        record("terrain.step_guard_deg", cs["step_guard_deg"], "deg", F, SCRIPT)
        for row in cs.get("discs_stepguard") or []:
            record(f"terrain.stepguard.disc_{row['budget_min']}.pct", row["stepguard_pct"], "%",
                   F, SCRIPT)
        for v, vd in cs["variants"].items():
            record(f"terrain.nogo_deg.{v}", vd["nogo_deg"], "deg", F, SCRIPT)
            for row in vd["discs"]:
                for k in ("assessed_pct", "blocked_pct", "unknown_pct", "blocked_slope_pct",
                          "blocked_stepguard_only_pct", "maxslope_rule_blocked_pct"):
                    if k in row:
                        record(f"terrain.cellstates.{v}.disc_{row['budget_min']}.{k}", row[k],
                               "%", F, SCRIPT)


# --------------------------------------------------------------------------- CLI


STEPS = {"dem": step_dem, "mask": step_mask, "coreg": step_coreg, "xcheck": step_xcheck,
         "slope": step_slope, "farfield": step_farfield, "crism": step_crism,
         "stations": step_stations, "validation": step_validation, "grid": step_grid,
         "ortho": step_ortho}
OPTIONAL = {"cells": step_cells,  # D22/D23 cell states alone (also run at the end of "slope")
            "farfield_v2": step_farfield_v2,  # ctx_20m_v2.tif (C decides the switch)
            "manifest": step_manifest,  # re-record every WS1 key from the outputs on disk
            "validation_staged": lambda: step_validation(OUT / "staged")}  # compare, then swap


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("steps", nargs="+", choices=[*STEPS, *OPTIONAL, "all"])
    a = ap.parse_args(argv)
    todo = list(STEPS) if "all" in a.steps else a.steps
    for s in todo:
        r = {**STEPS, **OPTIONAL}[s]()
        print(s, "->", r if isinstance(r, Path) or s == "manifest" else "ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
