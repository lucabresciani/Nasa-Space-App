"""Known-answer tests for WS1 co-registration (SPEC F1, §9 "Co-registration").

- A known synthetic shift applied to rover points is recovered within 2 m.
- On the DEM itself (points sampled from it) the shift is ~0.
- A constant vertical offset does not bias the horizontal shift (MAD metric) and is reported
  as the residual median.
"""

from __future__ import annotations

import numpy as np
import pytest
from scipy.ndimage import gaussian_filter

from pipeline.terrain import coreg
from pipeline.terrain.grid import Grid


def _world(seed=3, n=1200):
    rng = np.random.default_rng(seed)
    z = gaussian_filter(rng.normal(0, 1, (n, n)), 12) * 400  # smooth hills, tens of m relief
    z += 0.03 * np.arange(n)[None, :]  # regional tilt
    g = Grid(x0=1000.0, y0=5000.0, res=1.0, width=n, height=n)
    return z.astype(np.float32), g


def _points(g, n_pts=250, seed=4, margin=300):
    rng = np.random.default_rng(seed)
    w, s, e, nn = g.bounds
    x = rng.uniform(w + margin, e - margin, n_pts)
    y = rng.uniform(s + margin, nn - margin, n_pts)
    return x, y


def test_sample_bilinear_exact_on_plane():
    g = Grid(x0=0.0, y0=100.0, res=1.0, width=100, height=100)
    yy, xx = np.mgrid[0:100, 0:100]
    z = (2.0 * (xx + 0.5) + 3.0 * (100 - (yy + 0.5))).astype(np.float32)  # z = 2x + 3y
    x = np.array([10.3, 50.0, 77.77])
    y = np.array([20.1, 60.5, 33.33])
    assert np.allclose(coreg.sample_bilinear(z, g, x, y), 2 * x + 3 * y, atol=1e-3)


@pytest.mark.parametrize("dx,dy", [(0.0, 0.0), (36.0, -18.0), (-121.0, 77.0)])
def test_recovers_synthetic_shift(dx, dy):
    z, g = _world()
    x, y = _points(g)
    # rover elevations measured at the true location; rover positions reported shifted by -d
    elev = coreg.sample_bilinear(z, g, x, y) + 13.0  # plus a vertical datum offset
    res = coreg.grid_search(z, g, x - dx, y - dy, elev, search_m=200, step_m=2)
    assert abs(res["dx"] - dx) <= 2.0 and abs(res["dy"] - dy) <= 2.0
    assert res["median"] == pytest.approx(-13.0, abs=0.5)  # DEM - rover


def test_zero_shift_on_dem_itself():
    z, g = _world(seed=7)
    x, y = _points(g, seed=8)
    elev = coreg.sample_bilinear(z, g, x, y)
    res = coreg.grid_search(z, g, x, y, elev, search_m=200, step_m=2)
    assert res["dx"] == 0.0 and res["dy"] == 0.0
    assert res["mad"] == pytest.approx(0.0, abs=1e-3)


def test_points_off_grid_are_dropped_not_filled():
    z, g = _world()
    x, y = _points(g)
    x = np.append(x, g.bounds[0] - 50)  # outside
    y = np.append(y, g.bounds[1] + 100)
    elev = np.append(coreg.sample_bilinear(z, g, x[:-1], y[:-1]), 0.0)
    v = coreg.sample_bilinear(z, g, x, y)
    assert np.isnan(v[-1])
    res = coreg.grid_search(z, g, x, y, elev, search_m=10, step_m=2)
    assert res["n_used_at_best"] == len(x) - 1


# -------------------------------------------------- CTX far-field band onto dem_1m (WS3 band step)


def _ctx_case(dx=60.0, dy=-40.0, dz=15.0):
    """A 5 m 'fine' reference over the centre of a 20 m 'coarse' item; the item shows the same
    terrain displaced by (dx, dy) and raised by dz (as the canonical CTX vs dem_1m)."""
    from pipeline.terrain import farfield

    n = 1600  # 8 km at 5 m
    rng = np.random.default_rng(11)
    zf = gaussian_filter(rng.normal(0, 1, (n, n)), 40) * 3000
    zf += 0.08 * 5 * np.arange(n)[:, None]  # regional slope rising to the south (rows)
    gf = Grid(x0=0.0, y0=8000.0, res=5.0, width=n, height=n)
    gc = Grid(x0=0.0, y0=8000.0, res=20.0, width=400, height=400)
    rr, cc = np.mgrid[0:gc.height, 0:gc.width]
    x, y = gc.xy_of_rc(rr, cc)
    # item(x, y) = truth(x - dx, y - dy) + dz: content displaced by (+dx, +dy)
    item = (coreg.sample_bilinear(farfield.block_mean(zf, 4), gc, x - dx, y - dy)
            + dz).astype(np.float32)
    ref = zf.copy()
    ref[:, :400] = np.nan  # reference covers only part of the item (overlap ring)
    ref[:, 1200:] = np.nan
    ref[:400, :] = np.nan
    ref[1200:, :] = np.nan
    return item, gc, ref.astype(np.float32), gf, farfield


def test_block_mean_aligned_and_nan_propagates():
    from pipeline.terrain import farfield

    a = np.arange(16, dtype=np.float32).reshape(4, 4)
    assert np.allclose(farfield.block_mean(a, 2), [[2.5, 4.5], [10.5, 12.5]])
    a[0, 0] = np.nan
    b = farfield.block_mean(a, 2)
    assert np.isnan(b[0, 0]) and np.isfinite(b[1, 1])


def test_ctx_coregistration_recovers_shift_and_offset():
    item, gc, ref, gf, farfield = _ctx_case(dx=60.0, dy=-40.0, dz=15.0)
    fit = farfield.coregister_to_reference(item, gc, ref, gf, search_m=200, step_m=20,
                                           n_sample=8000, min_cells=500, seed=0)
    assert fit is not None
    assert fit["dx"] == pytest.approx(60.0, abs=1e-6) and fit["dy"] == pytest.approx(-40.0,
                                                                                    abs=1e-6)
    assert fit["offset_m"] == pytest.approx(15.0, abs=0.5)
    assert fit["after"]["mad_m"] < fit["before"]["mad_m"]
    corr = farfield.apply_fit(item, gc, fit)
    # corrected item agrees with the reference in the overlap (median ~0)
    d = corr - farfield.reference_on(gc, ref, gf)
    assert abs(float(np.nanmedian(d))) < 0.5


def test_ctx_coregistration_zero_on_identical_item():
    item, gc, ref, gf, farfield = _ctx_case(dx=0.0, dy=0.0, dz=0.0)
    fit = farfield.coregister_to_reference(item, gc, ref, gf, search_m=100, step_m=20,
                                           n_sample=8000, min_cells=500, seed=0)
    assert (fit["dx"], fit["dy"]) == (0.0, 0.0)
    assert fit["offset_m"] == pytest.approx(0.0, abs=0.05)
    assert np.allclose(farfield.apply_fit(item, gc, fit), item, equal_nan=True, atol=1e-3)


def test_ctx_coregistration_without_overlap_returns_none():
    item, gc, ref, gf, farfield = _ctx_case()
    fit = farfield.coregister_to_reference(item, gc, np.full_like(ref, np.nan), gf, search_m=100,
                                           step_m=20, n_sample=8000, min_cells=500, seed=0)
    assert fit is None


# -------------------------------------------------- web shape, contracts v1.0.0 (F1, F16)


def test_coreg_web_document_validates():
    import json
    from pathlib import Path

    from jsonschema import Draft202012Validator

    from pipeline.terrain import webout

    internal = {"dx": 0.0, "dy": -2.0, "n_used": 2, "residual_median_m": 0.01,
                "residual_mad_m": 0.04, "method": "grid search",
                "per_drive_end": [
                    {"rmc": "89_276", "sol": 3151, "lon": 137.4, "lat": -4.7, "elev_geoid": -1.0,
                     "dem_at_shift": -1.2, "residual_m": -0.2},
                    {"rmc": "107_2484", "sol": 4200, "lon": 137.41, "lat": -4.79,
                     "elev_geoid": -2.0, "dem_at_shift": None, "residual_m": None}]}
    doc = webout.coreg_web(internal, search_m=200, step_m=2)
    schema = json.loads((Path(__file__).resolve().parents[1] / "contracts"
                         / "coreg.schema.json").read_text())
    errs = list(Draft202012Validator(schema).iter_errors(doc))
    assert not errs, errs
    assert (doc["dx_m"], doc["dy_m"], doc["n"]) == (0.0, -2.0, 2)
    assert doc["residuals"][0] == {"sol": 3151, "site": 89, "drive": 276, "lon": 137.4,
                                   "lat": -4.7, "residual_m": -0.2}
    assert doc["residuals"][1]["residual_m"] is None
    assert doc["method"] == "grid search" and doc["dx"] == 0.0  # internal keys kept
