"""WS9 navigation KATs (SPEC §9 "F21 navigation" / "F22 skyline fix", brief WS9 "Tests").

Synthetic inputs only. Every model constant comes from config/nav.yaml (and crew.yaml for the
walking speed); tests override parameters only to isolate one error term. Small Monte Carlo N
with a fixed seed keeps the suite fast; the full N from config is used only in real runs.
"""

from __future__ import annotations

import json
import math

import numpy as np
import pytest

from pipeline.navigation import deadreckon as dr
from pipeline.navigation import montecarlo as mc

NAV = dr.load_config()
SPEED = dr.walking_speed_ms()  # crew.yaml anchor speed (0.98 m/s)
SEED = NAV["monte_carlo"]["seed"]


def zero_params(**kw) -> dr.NavParams:
    p = dr.NavParams.from_config(NAV["default_set"]).replace(
        sigma_s=0.0, sigma_b_deg_h=0.0, psi0_deg=0.0, psi_rw_deg_sqrt_min=0.0, slip=0.0,
        step_noise_frac=0.0)
    return p.replace(**kw)


# --------------------------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------------------------

def test_sets_load_from_config():
    for name, raw in NAV["sets"].items():
        p = dr.NavParams.from_config(name)
        assert p.sigma_s == raw["sigma_s"]
        assert p.sigma_b_deg_h == raw["sigma_b_deg_h"]
        assert p.psi0_deg == raw["psi0_deg"]
        assert p.psi_rw_deg_sqrt_min == raw["psi_rw_deg_sqrt_min"]
        assert p.slip == raw["slip"]
        assert p.step_m == NAV["step_m"]
        assert p.step_noise_frac == NAV["step_noise_frac"]
        assert p.slip_min_slope_deg == NAV["slip_min_slope_deg"]
    assert dr.NavParams.from_config().name == NAV["default_set"]


def test_walking_speed_is_crew_anchor():
    assert SPEED == pytest.approx(0.98)


# --------------------------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------------------------

def test_straight_route_geometry():
    tr = dr.straight_route(600.0, SPEED, heading_deg=90.0)
    assert tr.t_s[0] == 0 and tr.t_s[-1] == pytest.approx(600.0)
    assert np.allclose(np.diff(tr.t_s), NAV["monte_carlo"]["dt_s"])
    assert tr.x[-1] == pytest.approx(600.0 * SPEED)
    assert np.allclose(tr.y, 0.0, atol=1e-9)
    assert tr.distance_m[-1] == pytest.approx(600.0 * SPEED)


def test_piecewise_route_dwells_and_distance():
    pts = [(0.0, 0.0), (0.0, 300.0), (400.0, 300.0)]
    tr = dr.piecewise_route(pts, SPEED, dwell_s={1: 120.0})
    total = 700.0
    assert tr.distance_m[-1] == pytest.approx(total, rel=1e-9)
    assert tr.t_s[-1] == pytest.approx(total / SPEED + 120.0, abs=1.0)
    # stationary during the dwell
    t_arrive = 300.0 / SPEED
    i0 = int(np.ceil(t_arrive)) + 1
    i1 = int(np.floor(t_arrive + 120.0)) - 1
    assert np.allclose(tr.x[i0:i1], 0.0) and np.allclose(tr.y[i0:i1], 300.0)


# --------------------------------------------------------------------------------------------
# F21 KAT 1: zero-error parameters give estimate = truth
# --------------------------------------------------------------------------------------------

def test_zero_error_estimate_equals_truth():
    pts = [(0.0, 0.0), (250.0, 400.0), (-300.0, 900.0), (0.0, 0.0)]
    tr = dr.piecewise_route(pts, SPEED, dwell_s={1: 300.0, 2: 60.0},
                            slope_deg=25.0)  # steep: slip term would fire if non-zero
    res = dr.simulate(tr, zero_params(), runs=20, seed=SEED, record_every_s=1)
    assert np.allclose(res.est_x, tr.x[None, :], atol=1e-9)
    assert np.allclose(res.est_y, tr.y[None, :], atol=1e-9)


# --------------------------------------------------------------------------------------------
# F21 KAT 2: heading bias only, straight route -> analytic lateral error within 1 %
# --------------------------------------------------------------------------------------------

def test_heading_bias_only_matches_analytic_lateral_error():
    sigma_b = NAV["sets"]["high"]["sigma_b_deg_h"]
    p = zero_params(sigma_b_deg_h=sigma_b)
    T = 3600.0
    heading = 90.0  # due east (x); positive heading error turns clockwise = to the right (-y)
    tr = dr.straight_route(T, SPEED, heading_deg=heading)
    res = dr.simulate(tr, p, runs=200, seed=SEED, record_every_s=60)
    b = np.radians(res.gyro_bias_deg_h) / 3600.0  # rad/s, per run
    assert np.std(res.gyro_bias_deg_h) == pytest.approx(sigma_b, rel=0.15)
    ex = res.est_x[:, -1] - tr.x[-1]
    ey = res.est_y[:, -1] - tr.y[-1]
    lateral_right = -ey  # right of an eastward track is -y
    along = ex
    big = np.abs(b) > 1e-9
    analytic_lat = np.where(big, SPEED * (1.0 - np.cos(b * T)) / np.where(big, b, 1.0), 0.0)
    analytic_along = np.where(big, SPEED * np.sin(b * T) / np.where(big, b, 1.0), SPEED * T) \
        - SPEED * T
    sel = np.abs(analytic_lat) > 1.0
    assert sel.sum() > 150
    assert np.allclose(lateral_right[sel], analytic_lat[sel], rtol=0.01)
    assert np.allclose(along, analytic_along, rtol=0.01, atol=0.01)


# --------------------------------------------------------------------------------------------
# F21 KAT 3: the 95 % ellipse covers 93-97 % of runs
# --------------------------------------------------------------------------------------------

@pytest.fixture(scope="module")
def medium_straight():
    tr = dr.straight_route(3600.0, SPEED, heading_deg=60.0)
    p = dr.NavParams.from_config("medium")
    # the full Monte Carlo from config (nav.yaml monte_carlo: runs, seed)
    return tr, p, dr.simulate(tr, p, record_every_s=60)


def test_ellipse_95_covers_93_to_97_pct(medium_straight):
    tr, p, res = medium_straight
    conf = NAV["ellipse_conf"]
    for minute in (10, 30, 60):
        k = res.record_index(minute)
        e = res.errors(k)
        ell = mc.error_ellipse(e, conf)
        cov = mc.coverage(e, ell, conf)
        assert 0.93 <= cov <= 0.97, (minute, cov)


def test_ellipse_axes_and_orientation_known_covariance():
    rng = np.random.default_rng(SEED)
    # major axis 10 m along azimuth 30 deg (clockwise from north), minor 3 m
    n = 200_000
    u = rng.normal(0, 10.0, n)
    v = rng.normal(0, 3.0, n)
    az = math.radians(30.0)
    major = np.array([math.sin(az), math.cos(az)])
    minor = np.array([math.cos(az), -math.sin(az)])
    e = u[:, None] * major + v[:, None] * minor
    ell = mc.error_ellipse(e, 0.95)
    k = math.sqrt(-2.0 * math.log(1.0 - 0.95))
    assert ell["a_m"] == pytest.approx(10.0 * k, rel=0.01)
    assert ell["b_m"] == pytest.approx(3.0 * k, rel=0.01)
    assert ell["theta_deg"] == pytest.approx(30.0, abs=0.5)


def test_ellipse_degenerate_zero_error():
    ell = mc.error_ellipse(np.zeros((50, 2)), 0.95)
    assert ell == {"a_m": 0.0, "b_m": 0.0, "theta_deg": 0.0}


# --------------------------------------------------------------------------------------------
# r95(D) and its fit
# --------------------------------------------------------------------------------------------

def test_r95_fit_recovers_known_coefficients():
    D = np.linspace(0, 3000, 61)
    a, b = 0.04, 2.5e-5
    fit = mc.fit_r95(D, a * D + b * D**2)
    assert fit["a"] == pytest.approx(a, rel=1e-6)
    assert fit["b"] == pytest.approx(b, rel=1e-6)


def test_r95_fit_coefficients_non_negative():
    D = np.linspace(10, 1000, 30)
    fit = mc.fit_r95(D, 5.0 + 0.0 * D)  # flat -> no negative growth terms
    assert fit["a"] >= 0 and fit["b"] >= 0


def test_r95_grows_with_distance_and_faster_than_linear_with_bias(medium_straight):
    tr, p, res = medium_straight
    summ = mc.summarise(res, p)
    r95 = np.array([m["r95_m"] for m in summ["per_minute"]])
    D = np.array([m["dist_since_fix_m"] for m in summ["per_minute"]])
    assert np.all(np.diff(r95[5:]) > -0.05 * r95[6:])  # monotone up to MC noise
    assert summ["r95_fit"]["a"] > 0 and summ["r95_fit"]["b"] > 0
    fitted = summ["r95_fit"]["a"] * D + summ["r95_fit"]["b"] * D**2
    late = D > 1000
    assert np.allclose(fitted[late], r95[late], rtol=0.1)


def test_inverse_r95():
    fit = {"a": 0.05, "b": 2e-5}
    r = np.array([0.0, 5.0, 50.0, 200.0])
    D = mc.inverse_r95(fit, r)
    assert np.allclose(fit["a"] * D + fit["b"] * D**2, r)
    assert mc.inverse_r95({"a": 0.05, "b": 0.0}, 5.0) == pytest.approx(100.0)


# --------------------------------------------------------------------------------------------
# F21 KAT 4: error resets at fixes
# --------------------------------------------------------------------------------------------

def test_error_resets_at_fix():
    tr = dr.straight_route(3600.0, SPEED, heading_deg=0.0)
    p = dr.NavParams.from_config("high")
    sigma = NAV["fix_sigma_m"]["station"]
    fixes = [dr.FixEvent(t_eva_min=30.0, type="station", sigma_m=sigma, station="S1")]
    res = dr.simulate(tr, p, runs=2000, seed=SEED, record_every_s=60, fixes=fixes)
    before = res.errors(res.record_index(29))
    at = res.errors(res.record_index(30))
    after = res.errors(res.record_index(31))
    # just before: large; at the fix: N(0, sigma) per axis; then growing again from there
    assert np.std(before, axis=0).max() > 5 * sigma
    assert np.std(at, axis=0) == pytest.approx([sigma, sigma], rel=0.08)
    assert np.mean(at, axis=0) == pytest.approx([0.0, 0.0], abs=0.3)
    assert np.std(after, axis=0).max() < np.std(before, axis=0).max()
    # distance since fix restarts at the fix
    d = res.dist_since_fix_m
    k = res.record_index(30)
    assert d[k] == pytest.approx(0.0, abs=1e-9)
    assert d[res.record_index(31)] == pytest.approx(60 * SPEED, rel=1e-6)
    # errors after the fix are independent of those before (correlation ~ 0)
    r = np.corrcoef(before[:, 0], at[:, 0])[0, 1]
    assert abs(r) < 0.1


def test_fix_at_start_sets_initial_error():
    tr = dr.straight_route(120.0, SPEED)
    sigma = NAV["fix_sigma_m"]["rover"]
    fixes = [dr.FixEvent(t_eva_min=0.0, type="rover", sigma_m=sigma)]
    res = dr.simulate(tr, zero_params(), runs=4000, seed=SEED, record_every_s=60, fixes=fixes)
    e0 = res.errors(0)
    assert np.std(e0, axis=0) == pytest.approx([sigma, sigma], rel=0.05)
    # zero-error dead reckoning keeps the offset constant
    assert np.allclose(res.errors(res.record_index(2)), e0, atol=1e-9)


# --------------------------------------------------------------------------------------------
# Slip: fires only above the slope threshold
# --------------------------------------------------------------------------------------------

def test_slip_only_above_threshold():
    thr = NAV["slip_min_slope_deg"]
    slip = NAV["sets"]["high"]["slip"]
    p = zero_params(slip=slip)
    flat = dr.straight_route(600.0, SPEED, slope_deg=thr - 0.5)
    steep = dr.straight_route(600.0, SPEED, slope_deg=30.0)
    rf = dr.simulate(flat, p, runs=500, seed=SEED, record_every_s=60)
    rs = dr.simulate(steep, p, runs=500, seed=SEED, record_every_s=60)
    assert np.allclose(rf.errors(-1), 0.0, atol=1e-9)
    e = rs.errors(-1)
    # along-track (east) only; per-step N(0, slip sin(theta) L) summed over d / L steps
    L = NAV["step_m"]
    d = 600.0 * SPEED
    expected = slip * math.sin(math.radians(30.0)) * math.sqrt(L * d)
    assert np.std(e[:, 0]) == pytest.approx(expected, rel=0.1)
    assert np.allclose(e[:, 1], 0.0, atol=1e-9)


def test_scale_factor_only_gives_proportional_along_track_error():
    p = zero_params(sigma_s=NAV["sets"]["medium"]["sigma_s"])
    tr = dr.straight_route(1200.0, SPEED, heading_deg=90.0)
    res = dr.simulate(tr, p, runs=300, seed=SEED, record_every_s=60)
    e = res.errors(-1)
    assert np.allclose(e[:, 0], (res.scale_factor - 1.0) * tr.distance_m[-1], atol=1e-6)
    assert np.std(res.scale_factor) == pytest.approx(p.sigma_s, rel=0.15)


def test_seed_reproducible():
    tr = dr.straight_route(300.0, SPEED)
    p = dr.NavParams.from_config("medium")
    a = dr.simulate(tr, p, runs=10, seed=SEED, record_every_s=60)
    b = dr.simulate(tr, p, runs=10, seed=SEED, record_every_s=60)
    assert np.array_equal(a.est_x, b.est_x) and np.array_equal(a.est_y, b.est_y)


# --------------------------------------------------------------------------------------------
# Contracts: montecarlo, tracks, fixes (written to tmp only)
# --------------------------------------------------------------------------------------------

CONTRACTS = dr.REPO / "contracts"


def _validate(obj, schema):
    """Validate against contracts/<schema> (draft 2020-12), raising on the first error."""
    from jsonschema import Draft202012Validator

    s = json.loads((CONTRACTS / schema).read_text())
    Draft202012Validator(s).validate(obj)


def test_montecarlo_json_validates(tmp_path, medium_straight):
    tr, p, res = medium_straight
    summ = mc.summarise(res, p)
    _validate(summ, "montecarlo.schema.json")
    assert summ["set"] == "medium" and summ["runs"] == NAV["monte_carlo"]["runs"]
    assert summ["per_minute"][0]["t_eva_min"] == 0
    out = mc.write_json(summ, tmp_path / "nav" / "montecarlo_medium.json")
    _validate(json.loads(out.read_text()), "montecarlo.schema.json")


def test_tracks_geojson_validates(tmp_path):
    pts = [(0.0, 0.0), (0.0, 600.0), (500.0, 600.0)]
    tr = dr.piecewise_route(pts, SPEED, dwell_s={1: 300.0})
    p = dr.NavParams.from_config("medium")
    res = dr.simulate(tr, p, runs=100, seed=SEED, record_every_s=60)
    gj = mc.tracks_geojson(res, p)
    _validate(gj, "tracks.schema.json")
    kinds = [f["properties"]["kind"] for f in gj["features"]]
    assert kinds.count("true") == 1 and kinds.count("estimated") == 1
    assert gj["features"][0]["properties"]["t_eva_min"] == pytest.approx(tr.t_s[-1] / 60.0)
    n_ell = kinds.count("ellipse95")
    every = NAV["tracks"]["ellipse_every_min"]
    assert n_ell == int(tr.t_s[-1] / 60 // every) + 1
    ring = next(f for f in gj["features"] if f["properties"]["kind"] == "ellipse95")
    coords = ring["geometry"]["coordinates"][0]
    assert coords[0] == coords[-1]
    assert len(coords) == NAV["tracks"]["ellipse_vertices"] + 1
    # coordinates are lon/lat near the pad, 6 decimals
    lon, lat = gj["features"][0]["geometry"]["coordinates"][0]
    assert abs(lon - dr.pad_lonlat()[0]) < 0.01 and abs(lat - dr.pad_lonlat()[1]) < 0.01
    assert round(lon, 6) == lon


def test_fixes_json_validates():
    fixes = [
        dr.FixEvent(0.0, "rover", NAV["fix_sigma_m"]["rover"]),
        dr.FixEvent(42.5, "station", NAV["fix_sigma_m"]["station"], station="S1"),
        dr.FixEvent(90.0, "skyline", 37.2, station="S2", error_m=37.2, image_id="NLB_test"),
    ]
    out = mc.fixes_json(fixes)
    _validate(out, "fixes.schema.json")
    assert out[0]["error_m"] is None and out[2]["image_id"] == "NLB_test"
    with pytest.raises(ValueError):
        dr.FixEvent(1.0, "skyline", 5.0)  # skyline fix without error_m / image_id


def test_projection_round_trip():
    lon0, lat0 = dr.pad_lonlat()
    x, y = dr.lonlat_to_xy(lon0, lat0)
    lon, lat = dr.xy_to_lonlat(x + 1000.0, y)
    x2, y2 = dr.lonlat_to_xy(lon, lat)
    assert x2 - x == pytest.approx(1000.0, abs=1e-6) and y2 == pytest.approx(y, abs=1e-6)


def test_manifest_records_to_tmp_fragment(tmp_path, medium_straight):
    tr, p, res = medium_straight
    summ = mc.summarise(res, p)
    keys = mc.record_manifest(summ, "data/interim/nav/montecarlo_medium.json",
                              fragment_dir=tmp_path)
    frag = json.loads(next(tmp_path.rglob("*.json")).read_text())
    assert set(keys) <= set(frag)
    assert frag["nav.r95_fit.medium.a"]["value"] == pytest.approx(summ["r95_fit"]["a"])
    assert frag["nav.r95_fit.medium.a"]["units"] == "1"




# --------------------------------------------------------------------------------------------
# F21 fix-interval map (fixinterval.py)
# --------------------------------------------------------------------------------------------

from pipeline.navigation import fixinterval as fi  # noqa: E402

FIT_MEDIUM = {"a": 0.09, "b": 1.2e-5}  # synthetic coefficients (shape of the medium set)


def cone_field(res_m=10.0, half_m=2500.0):
    """T_home = flat-ground walking time from the pad (min): a cone, edge of the homeline at
    limit * 60 * v metres."""
    n = int(round(2 * half_m / res_m)) + 1
    c = (np.arange(n) - (n - 1) / 2) * res_m
    X, Y = np.meshgrid(c, -c)
    R = np.hypot(X, Y)
    return R / SPEED / 60.0, R, res_m


def test_homeline_limit_from_config():
    crew = dr.crew_config()
    assert fi.homeline_limit_min() == pytest.approx(
        crew["walkback_budgets_min"][0] - NAV["fix_interval_ws9"]["reserve_min"])


def test_margin_radius_edt_on_cone():
    T, R, res = cone_field()
    lim = fi.homeline_limit_min()
    edge = lim * 60.0 * SPEED
    r_m = fi.margin_radius_edt(T, res, lim)
    inside = R < edge - 2 * res
    # exact distance to the edge, to one grid cell
    assert np.allclose(r_m[inside], edge - R[inside], atol=res * 1.01)
    assert np.all(r_m[R > edge + res] == 0.0)


def test_margin_radius_edt_matches_worst_field_interpolation():
    from scipy.ndimage import maximum_filter
    T, R, res = cone_field(res_m=5.0, half_m=2000.0)
    lim = fi.homeline_limit_min()
    radii = dr._yaml("hud")["worst_case_radii_m"]
    worst = {}
    for rad in radii:
        k = int(rad // res)
        yy, xx = np.mgrid[-k:k + 1, -k:k + 1]
        worst[rad] = maximum_filter(T, footprint=(np.hypot(xx, yy) * res <= rad))
    r_w, censored = fi.margin_radius_from_worst(T, worst, lim)
    r_e = fi.margin_radius_edt(T, res, lim)
    sel = (~censored) & (r_w > 0)
    assert sel.sum() > 100
    assert np.allclose(r_w[sel], r_e[sel], atol=1.5 * res)
    assert np.all(r_w[censored] == max(radii))


def test_dmax_zero_outside_and_smaller_near_edge():
    T, R, res = cone_field()
    lim = fi.homeline_limit_min()
    edge = lim * 60.0 * SPEED
    d = fi.fix_interval(T, res, FIT_MEDIUM, limit_min=lim)
    assert np.all(d[R > edge + res] == 0.0)
    assert np.all(d[R < edge - 2 * res] > 0.0)
    # monotone: smaller towards the edge along a ray from the pad
    row = T.shape[0] // 2
    prof = d[row, T.shape[1] // 2:]
    rr = R[row, T.shape[1] // 2:]
    inside = rr < edge
    assert np.all(np.diff(prof[inside]) <= 1e-9)
    # equals the inverse of the r95 fit at the margin radius
    r_m = fi.margin_radius_edt(T, res, lim)
    assert np.allclose(d, mc.inverse_r95(FIT_MEDIUM, r_m))


def test_dmax_unknown_cells_stay_unknown_and_shrink_neighbours():
    T, R, res = cone_field()
    lim = fi.homeline_limit_min()
    T2 = T.copy()
    hole = (np.abs(R - 600.0) < 30.0)  # unknown ring segment
    hole &= np.indices(T.shape)[1] > T.shape[1] // 2
    T2[hole] = np.nan
    d1 = fi.fix_interval(T, res, FIT_MEDIUM, limit_min=lim)
    d2 = fi.fix_interval(T2, res, FIT_MEDIUM, limit_min=lim)
    assert np.all(np.isnan(d2[hole]))
    assert np.all(d2[~hole] <= d1[~hole] + 1e-9)
    assert np.any(d2[~hole] < d1[~hole] - 1.0)


def test_fix_interval_summary_contract_and_classes(tmp_path):
    T, R, res = cone_field()
    lim = fi.homeline_limit_min()
    d = fi.fix_interval(T, res, FIT_MEDIUM, limit_min=lim)
    s = fi.summarise(d, T, "medium", limit_min=lim)
    _validate(s, "fix_interval_summary.schema.json")
    assert list(s["class_area_pct"]) == ["<100", "100-300", "300-1000", ">1000"]
    assert sum(s["class_area_pct"].values()) == pytest.approx(100.0, abs=0.01)
    inside = T <= lim
    assert s["median_m"] == pytest.approx(float(np.median(d[inside])), abs=0.05)
    p = NAV["fix_interval_ws9"]["edge_percentile"]
    assert s["edge_p10_m"] == pytest.approx(float(np.percentile(d[inside], p)), abs=0.05)
    assert s["edge_p10_m"] < s["median_m"]


def test_fix_interval_png_round_trip(tmp_path):
    T, R, res = cone_field()
    d = fi.fix_interval(T, res, FIT_MEDIUM)
    d[0, 0] = np.nan
    path = fi.write_png(d, tmp_path / "fields" / "fix_interval_medium.png")
    back = fi.read_png(path)
    per = dr._yaml("hud")["field_scales"]["fix_interval"]["per_count"]
    ok = np.isfinite(d)
    assert np.isnan(back[0, 0])
    assert np.all(np.abs(back[ok] - np.minimum(d[ok], 65535 * per)) <= per / 2 + 1e-9)


def test_fix_interval_manifest_to_tmp(tmp_path):
    T, R, res = cone_field()
    d = fi.fix_interval(T, res, FIT_MEDIUM)
    s = fi.summarise(d, T, "medium")
    keys = fi.record_manifest(s, "data/interim/nav/fix_interval_medium.png", fragment_dir=tmp_path)
    frag = json.loads(next(tmp_path.rglob("*.json")).read_text())
    assert set(keys) <= set(frag)
    assert frag["nav.fix_interval.medium.median_m"]["units"] == "m"


# --------------------------------------------------------------------------------------------
# F22 skyline-matching fix (skylinefix.py) on a synthetic DEM with a known observer
# --------------------------------------------------------------------------------------------

import importlib.util  # noqa: E402

from pipeline.navigation import skylinefix as sf  # noqa: E402

# WS3's horizon engine (branch ws3-horizon) is not on main yet: the engine KATs run once merged.
HAS_WS3 = importlib.util.find_spec("pipeline.horizon.rays") is not None

SKY = NAV["skyline_fix"]
TRUE_XY = (37.0, -23.0)  # deliberately off every candidate grid


def _terrain(X, Y):
    """Smooth synthetic terrain: gentle tilt plus Gaussian hills 1.2-3.5 km from the observer,
    so the near field (< far_field_min_m) is plain and the skyline is far-field."""
    rng = np.random.default_rng(SEED)
    z = 0.004 * X - 0.002 * Y
    for _ in range(14):
        r = rng.uniform(1200.0, 3500.0)
        a = rng.uniform(0.0, 2 * math.pi)
        cx, cy = TRUE_XY[0] + r * math.sin(a), TRUE_XY[1] + r * math.cos(a)
        h = rng.uniform(40.0, 160.0)
        s = rng.uniform(150.0, 400.0)
        z = z + h * np.exp(-((X - cx) ** 2 + (Y - cy) ** 2) / (2 * s * s))
    return z


def _band(source, res, half):
    from pipeline.horizon.rays import DemBand
    n = int(round(2 * half / res)) + 1
    c = (np.arange(n) - (n - 1) / 2) * res
    X, Y = np.meshgrid(c, -c)
    return DemBand.from_transform(source, _terrain(X, Y).astype(np.float32),
                                  (-half - res / 2, res, 0.0, half + res / 2, 0.0, -res))


@pytest.fixture(scope="module")
def sky_world():
    if not HAS_WS3:
        pytest.skip("WS3 horizon engine (pipeline.horizon.rays) not merged yet")
    from pipeline.horizon import config as hcfg
    from pipeline.horizon.rays import HorizonEngine
    engine = HorizonEngine([_band("dem_1m", 10.0, 4500.0), _band("ctx_20m", 20.0, 4500.0)])
    h = hcfg.load()["navcam_height_m"]
    # the "detected" skyline: the true horizon sampled at column azimuths off the ray grid
    el, _, _ = engine.horizons([TRUE_XY[0]], [TRUE_XY[1]], eye_height_m=h, az_step_deg=0.125)
    az_grid = np.arange(el.shape[1]) * 0.125
    obs_az = (0.13 + 0.5 * np.arange(720)) % 360.0
    obs_el = np.interp(obs_az, np.append(az_grid, 360.0), np.append(el[0], el[0, 0]))
    return engine, obs_az, obs_el


def test_candidate_grid_from_config():
    xs, ys = sf.grid_around((100.0, 200.0), SKY["search_extent_m"], SKY["coarse_grid_m"])
    n = int(SKY["search_extent_m"] / SKY["coarse_grid_m"]) + 1
    assert xs.size == n * n
    assert xs.min() == pytest.approx(100.0 - SKY["search_extent_m"] / 2)
    assert ys.max() == pytest.approx(200.0 + SKY["search_extent_m"] / 2)


def test_standalone_prior_offset():
    rng = np.random.default_rng(SEED)
    px, py = sf.standalone_prior(TRUE_XY, rng)
    assert math.hypot(px - TRUE_XY[0], py - TRUE_XY[1]) == pytest.approx(
        SKY["standalone_prior_offset_m"])


def test_score_is_zero_at_truth_and_positive_elsewhere(sky_world):
    from pipeline.horizon import config as hcfg
    engine, az, el = sky_world
    h = hcfg.load()["navcam_height_m"]
    rms = sf.score(engine, [TRUE_XY[0], TRUE_XY[0] + 200.0], [TRUE_XY[1], TRUE_XY[1]], az, el,
                   az_step_deg=hcfg.load()["az_step_deg"], min_dist_m=0.0, eye_height_m=h)
    assert rms[0] < 0.01
    assert rms[1] > 10 * rms[0] + 0.05


def test_skyline_fix_recovers_known_observer_within_one_grid_step(sky_world):
    engine, az, el = sky_world
    rng = np.random.default_rng(SEED)
    prior = sf.standalone_prior(TRUE_XY, rng)
    res = sf.locate(engine, az, el, prior)
    err = math.hypot(res.x - TRUE_XY[0], res.y - TRUE_XY[1])
    assert err <= SKY["refine_grid_m"], err
    n_coarse = (int(SKY["search_extent_m"] / SKY["coarse_grid_m"]) + 1) ** 2
    assert res.candidates_evaluated > n_coarse
    assert res.sigma_m > 0
    rec = sf.localisation_record(res, TRUE_XY)
    _validate(rec, "localisation.schema.json")
    assert rec["error_m"] == pytest.approx(err, abs=0.01)
    assert rec["candidates_evaluated"] == res.candidates_evaluated
    fix = sf.fix_event(rec, t_eva_min=95.0, station="S2", image_id="SYNTH_0001")
    assert fix.type == "skyline" and fix.sigma_m == rec["error_m"]
    _validate(mc.fixes_json([fix]), "fixes.schema.json")


def test_every_frame_tried_is_reported(sky_world):
    engine, az, el = sky_world
    frames = [
        {"image_id": "SYNTH_ok", "true_xy": TRUE_XY, "obs_az": az, "obs_el": el},
        {"image_id": "SYNTH_nosky", "true_xy": TRUE_XY, "obs_az": az,
         "obs_el": np.full_like(el, np.nan)},
    ]
    out = sf.try_frames(engine, frames, rng=np.random.default_rng(SEED))
    assert [r["image_id"] for r in out] == ["SYNTH_ok", "SYNTH_nosky"]
    assert out[0]["status"] == "ok" and out[0]["error_m"] <= SKY["refine_grid_m"]
    assert out[1]["status"] == "failed" and out[1]["reason"]


def test_localisation_manifest_to_tmp(tmp_path, sky_world):
    engine, az, el = sky_world
    res = sf.locate(engine, az, el, (TRUE_XY[0] + 120.0, TRUE_XY[1] - 90.0))
    rec = sf.localisation_record(res, TRUE_XY)
    keys = sf.record_manifest(rec, "SYNTH_0001", "data/interim/localisation/SYNTH_0001.json",
                              fragment_dir=tmp_path)
    frag = json.loads(next(tmp_path.rglob("*.json")).read_text())
    assert set(keys) <= set(frag)
    assert frag["nav.skyline.SYNTH_0001.error_m"]["units"] == "m"


# --------------------------------------------------------------------------------------------
# Synthetic end-to-end export (run.py) -> tmp only
# --------------------------------------------------------------------------------------------

def test_synthetic_export_writes_contract_valid_nav_files(tmp_path):
    from pipeline.navigation import run as nav_run
    written = nav_run.synthetic(tmp_path, runs=50, sets=["low", "medium"])
    names = sorted(p.relative_to(tmp_path).as_posix() for p in written)
    assert names == ["nav/fixes.json", "nav/montecarlo_low.json", "nav/montecarlo_medium.json",
                     "nav/tracks_low.geojson", "nav/tracks_medium.geojson"]
    schema = {"montecarlo": "montecarlo.schema.json", "tracks": "tracks.schema.json",
              "fixes": "fixes.schema.json"}
    for p in written:
        _validate(json.loads(p.read_text()), schema[p.stem.split("_")[0]])
    fixes = json.loads((tmp_path / "nav" / "fixes.json").read_text())
    assert fixes[0]["type"] == "rover" and fixes[0]["t_eva_min"] == 0
    assert {f["station"] for f in fixes if f["type"] == "station"} == {"SYN1", "SYN2", "SYN3"}
    m = json.loads((tmp_path / "nav" / "montecarlo_medium.json").read_text())
    assert m["route"].startswith("synthetic")
    # error resets at each station fix: dist_since_fix returns to 0 there
    zeros = [r["t_eva_min"] for r in m["per_minute"] if r["dist_since_fix_m"] == 0]
    assert len(zeros) > 4


def test_run_refuses_public_data_dir():
    from pipeline.navigation import run as nav_run
    with pytest.raises(ValueError):
        nav_run.synthetic(dr.REPO / "web" / "public" / "data", runs=2, sets=["low"])


# --------------------------------------------------------------------------------------------
# Real-route run (real.py) on a synthetic data/interim tree in tmp (inputs shaped like WS2/WS1)
# --------------------------------------------------------------------------------------------

from pathlib import Path  # noqa: E402

from pipeline.navigation import real as nav_real  # noqa: E402

LEG_M = 600.0  # pad -> station distance of the tmp route (docs/dummy.md S1 geometry)


def _route_fc(timed: bool = True) -> tuple[dict, list]:
    """Pad -> S1 600 m north at SPEED, 30 min dwell (stations.yaml), back; WS2 leg format."""
    px, py = dr.pad_xy()
    n = 13
    ys = np.linspace(0.0, LEG_M, n)
    t1 = LEG_M / SPEED / 60.0
    dwell = float(dr._yaml("stations")["dwell_min"])
    t2 = t1 + dwell
    t3 = t2 + t1
    out_ll = [list(map(float, dr.xy_to_lonlat(px, py + v))) for v in ys]
    back_ll = out_ll[::-1]
    tm = np.linspace(0.0, t1, n)
    legs = [
        {"leg": 1, "from": "pad", "to": "S1", "t_start_min": 0.0, "t_end_min": t1,
         "times_min": tm.tolist()},
        {"leg": 2, "from": "S1", "to": "pad", "t_start_min": t2, "t_end_min": t3,
         "times_min": (t2 + tm).tolist()},
    ]
    if not timed:
        for leg in legs:
            leg.pop("times_min")
    fc = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": {"type": "LineString", "coordinates": c}, "properties": p}
        for c, p in zip([out_ll, back_ll], legs, strict=True)]}
    timeline = [
        {"t_min": 0.0, "event": "depart", "station": None, "o2_left_L": None, "t_home_min": 0.0,
         "margin_min": None},
        {"t_min": t1, "event": "arrive", "station": "S1", "o2_left_L": None, "t_home_min": t1,
         "margin_min": None},
        {"t_min": t2, "event": "leave", "station": "S1", "o2_left_L": None, "t_home_min": t1,
         "margin_min": None},
        {"t_min": t3, "event": "return", "station": None, "o2_left_L": None, "t_home_min": 0.0,
         "margin_min": None},
    ]
    return fc, timeline


def _write_tif(path, arr, x0, y0, res):
    import rasterio
    from rasterio.transform import from_origin
    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(path, "w", driver="GTiff", height=arr.shape[0], width=arr.shape[1],
                       count=1, dtype="float32", crs=dr.site_config()["crs"]["analysis_proj"],
                       transform=from_origin(x0, y0, res, res), nodata=float("nan")) as ds:
        ds.write(arr.astype(np.float32), 1)


@pytest.fixture
def real_tree(tmp_path):
    """tmp data/interim with WS2 route/timeline/T_home and WS1 slope for scenario nom_104."""
    interim = tmp_path / "data" / "interim"
    fc, tl = _route_fc()
    pub = interim / "engine" / "public"
    pub.mkdir(parents=True)
    (pub / "route_nom_104.geojson").write_text(json.dumps(fc))
    (pub / "timeline_nom_104.json").write_text(json.dumps(tl))
    px, py = dr.pad_xy()
    res, half = 6.0, 2400.0
    n = int(2 * half / res)
    xc = px - half + res * (np.arange(n) + 0.5)
    yc = py + half - res * (np.arange(n) + 0.5)
    gx, gy = np.meshgrid(xc, yc)
    t_home = np.hypot(gx - px, gy - py) / SPEED / 60.0  # flat world: distance / speed
    t_home[:5, :5] = np.nan  # an unknown corner
    _write_tif(interim / "engine" / "nom_104" / "t_home.tif", t_home, px - half, py + half, res)
    slope = np.where(gy > py + LEG_M / 2, 15.0, 2.0)  # steep (slip) on the northern half
    _write_tif(interim / "terrain" / "slope_1m.tif", slope, px - half, py + half, res)
    return interim


def test_route_knots_follow_per_vertex_times_and_dwell():
    fc, tl = _route_fc()
    traj, _ = nav_real.route_trajectory(fc)
    t1 = tl[1]["t_min"] * 60.0
    t2 = tl[2]["t_min"] * 60.0
    d = np.hypot(traj.x, traj.y)
    i1, i2 = np.searchsorted(traj.t_s, [t1 + 1, t2 - 1])
    assert np.allclose(d[i1:i2], LEG_M, atol=1e-6)  # dwelling at S1
    assert traj.t_s[-1] == pytest.approx(tl[3]["t_min"] * 60.0, abs=1.0)
    assert d[-1] == pytest.approx(0.0, abs=1e-6) and d[0] == 0.0
    assert traj.distance_m[-1] == pytest.approx(2 * LEG_M, rel=1e-6)
    # speed on the legs = the leg times (WS2 times_min)
    walk = traj.step_dist_m[: int(t1) - 1]
    assert np.allclose(walk, SPEED, rtol=1e-6)


def test_route_knots_uniform_speed_without_vertex_times():
    fc, _ = _route_fc(timed=False)
    k = nav_real.route_knots(fc)
    assert k["timed_legs"] == 0 and k["n_legs"] == 2
    a, _ = nav_real.route_trajectory(_route_fc()[0])
    b, _ = nav_real.route_trajectory(fc)
    assert np.allclose(a.x, b.x, atol=1e-6) and np.allclose(a.y, b.y, atol=1e-6)


def test_route_knots_refuse_mismatched_times():
    fc, _ = _route_fc()
    fc["features"][0]["properties"]["times_min"] = [0.0, 1.0]
    with pytest.raises(ValueError, match="times_min"):
        nav_real.route_knots(fc)


def test_fixes_from_timeline_and_skyline_replacement(monkeypatch):
    _, tl = _route_fc()
    fx = nav_real.fixes_from_timeline(tl)
    assert [(f.type, f.station) for f in fx] == [("rover", None), ("station", "S1"),
                                                 ("rover", None)]
    assert fx[0].sigma_m == NAV["fix_sigma_m"]["rover"]
    assert fx[1].sigma_m == NAV["fix_sigma_m"]["station"]
    sky = {"S1": {"image_id": "NLB_X", "error_m": 42.0}}
    fx = nav_real.fixes_from_timeline(tl, skyline=sky)
    assert [(f.type, f.station, f.sigma_m) for f in fx][1] == ("skyline", "S1", 42.0)
    assert len(fx) == 3  # replace (nav.yaml default)
    monkeypatch.setitem(NAV["real_run_ws9"], "skyline_station_fix", "add")
    fx = nav_real.fixes_from_timeline(tl, skyline=sky)
    assert [f.type for f in fx] == ["rover", "station", "skyline", "rover"]


def test_pick_station_fix_uses_rms_never_the_error():
    rows = [{"status": "ok", "station": "S1", "image_id": "a", "rms_deg": 0.9, "error_m": 5.0},
            {"status": "ok", "station": "S1", "image_id": "b", "rms_deg": 0.3, "error_m": 80.0},
            {"status": "failed", "station": "S1", "image_id": "c", "error_m": None}]
    assert nav_real.pick_station_fixes(rows)["S1"]["image_id"] == "b"


def test_dry_run_lists_missing_inputs_with_owners(tmp_path):
    rep = nav_real.dry_run("nom_104", interim=tmp_path / "data" / "interim", log=lambda *a: None)
    owners = {i["name"]: (i["owner"], i["exists"]) for i in rep["inputs"]}
    assert owners["route"] == ("WS2", False) and owners["t_home"] == ("WS2", False)
    assert owners["slope"] == ("WS1", False) and owners["navcam_frames"] == ("WS3", False)
    assert len(rep["problems"]) == 8  # route, timeline, t_home, slope, frames, 3 DEM bands
    rep = nav_real.dry_run("nom_104", interim=tmp_path / "data" / "interim", skyline=False,
                           log=lambda *a: None)
    assert len(rep["problems"]) == 4


def test_real_run_refuses_missing_inputs_and_public_out(tmp_path):
    with pytest.raises(SystemExit):
        nav_real.run("nom_104", out=tmp_path / "o", interim=tmp_path / "x", skyline=False,
                     log=lambda *a: None)
    with pytest.raises(ValueError):
        nav_real.run("nom_104", out=dr.REPO / "web" / "public" / "data", skyline=False,
                     log=lambda *a: None)


def test_real_run_end_to_end_contracts_and_manifest(real_tree, tmp_path):
    from pipeline.navigation import fixinterval as fi
    out = real_tree / "navigation"
    frag = tmp_path / "frag"
    (out / "nav").mkdir(parents=True)
    (out / "nav" / "stale.json").write_text("{}")  # cleared before the run
    rep = nav_real.run("nom_104", out=out, interim=real_tree, sets=["low", "medium"], runs=60,
                       skyline=False, record=True, fragment_dir=frag, log=lambda *a: None)
    assert not (out / "nav" / "stale.json").exists()
    names = sorted(rep["written"])
    assert names == ["fields/fix_interval_low.png", "fields/fix_interval_medium.png",
                     "nav/fix_interval_summary.json", "nav/fixes.json",
                     "nav/montecarlo_low.json", "nav/montecarlo_medium.json",
                     "nav/tracks_low.geojson", "nav/tracks_medium.geojson"]
    schema = {"montecarlo": "montecarlo.schema.json", "tracks": "tracks.schema.json",
              "fixes": "fixes.schema.json", "fix": "fix_interval_summary.schema.json"}
    for n in names:
        if n.startswith("nav/"):
            _validate(json.loads((out / n).read_text()), schema[Path(n).stem.split("_")[0]])
    m = json.loads((out / "nav" / "montecarlo_medium.json").read_text())
    assert m["route"] == "route_nom_104" and m["runs"] == 60 and m["scenario"] == "nom_104"
    # fix at the station: the error resets there (dist_since_fix = 0 during the dwell)
    t1 = LEG_M / SPEED / 60.0
    dwell = [r for r in m["per_minute"] if t1 + 1 <= r["t_eva_min"] <= t1 + 29]
    assert dwell and all(r["dist_since_fix_m"] == 0 for r in dwell)
    # one summary file (contracts v1.0.0), for the default set; every set in the report
    s = json.loads((out / fi.SUMMARY_PATH).read_text())
    assert s["set"] == NAV["default_set"] and s["median_m"] > 0
    assert set(rep["fix_interval"]) == {"low", "medium"}
    assert rep["fix_interval"]["low"]["median_m"] > s["median_m"]  # less drift: fix less often
    # D_max on the HUD field grid (pad +/- planning radius at field_png.res_m)
    idx = json.loads((out / "fields_index_nav.json").read_text())
    g = nav_real.field_grid()
    d = fi.read_png(out / "fields" / "fix_interval_medium.png")
    assert d.shape == (idx["height"], idx["width"]) == (g["height"], g["width"])
    assert idx["res_m"] == dr._yaml("hud")["field_png"]["res_m"]
    e = idx["fields"]["fix_interval_medium"]
    _validate({"dummy": False, **{k: idx[k] for k in ("bounds", "width", "height", "res_m")},
               "fields": {"fix_interval_medium": e}}, "fields_index.schema.json")
    assert e["file"] == "fields/fix_interval_medium.png" and e["scenario"] == "nom_104"
    c = g["height"] // 2
    assert d[c, c] > 0 and np.isnan(d[0, 0])  # the T_home raster is smaller than the grid
    # manifest: nav.* keys with the file values
    entries = {}
    for f in frag.glob("*.json"):
        entries.update(json.loads(f.read_text()))
    assert entries["nav.montecarlo.medium.runs"]["value"] == 60
    assert entries["nav.r95_fit.medium.a"]["value"] == m["r95_fit"]["a"]
    assert entries["nav.fix_interval.medium.median_m"]["value"] == s["median_m"]
    assert entries["nav.fix_interval.medium.median_m"]["file"] == fi.SUMMARY_PATH
    assert "nav.fix_interval.low.median_m" not in entries  # not shown: not in a web file
    assert entries["nav.fixes.1.sigma_m"]["value"] == NAV["fix_sigma_m"]["station"]


def test_real_run_uses_skyline_report_for_paired_stations(real_tree, tmp_path):
    """F22 results feed F21: a recovered frame paired with a route station becomes a skyline fix
    (sigma = measured error) at that station; unpaired and failed frames stay in the report."""
    out = real_tree / "navigation"
    out.mkdir(parents=True)
    rows = [
        {"image_id": "NLB_A", "station": "S1", "status": "ok", "error_m": 8.0, "rms_deg": 0.4},
        {"image_id": "NLB_B", "station": "S1", "status": "ok", "error_m": 3.0, "rms_deg": 0.9},
        {"image_id": "NLB_C", "station": None, "status": "ok", "error_m": 30.0, "rms_deg": 0.2},
        {"image_id": "NLB_D", "station": "S1", "status": "failed", "error_m": None,
         "reason": "no sky"},
    ]
    (out / nav_real.SKYLINE_REPORT).write_text(json.dumps(
        {"n_frames": 4, "n_ok": 3, "rows": rows}))
    rep = nav_real.run("nom_104", out=out, interim=real_tree, sets=["medium"], runs=20,
                       skyline=True, record=False, log=lambda *a: None, engine=object())
    fx = json.loads((out / "nav" / "fixes.json").read_text())
    _validate(fx, "fixes.schema.json")
    sky = [f for f in fx if f["type"] == "skyline"]
    assert len(sky) == 1 and sky[0]["image_id"] == "NLB_A"  # lowest RMS, never lowest error
    assert sky[0]["sigma_m"] == 8.0 and sky[0]["station"] == "S1"  # passes the F22 gate
    assert rep["skyline"]["used"] == {"S1": "NLB_A"} and rep["skyline"]["n_frames"] == 4


# --------------------------------------------------------------------------------------------
# Session 2: F22 gate (C decision 2026-11-14 11:58), canonical bands, nav.yaml vo block
# --------------------------------------------------------------------------------------------

def test_skyline_gate_tolerance_is_the_f22_kat_tolerance():
    # the KAT above: "recovered within one grid step" = skyline_fix.refine_grid_m
    assert nav_real.skyline_gate_tolerance_m() == NAV["skyline_fix"]["refine_grid_m"]


def test_skyline_gate_passes_only_within_kat_tolerance():
    tol = NAV["skyline_fix"]["refine_grid_m"]
    best = {"S1": {"image_id": "a", "station": "S1", "status": "ok", "error_m": tol,
                   "rms_deg": 0.2},
            "S2": {"image_id": "b", "station": "S2", "status": "ok", "error_m": tol + 0.01,
                   "rms_deg": 0.1},
            "S4": {"image_id": "c", "station": "S4", "status": "ok", "error_m": 617.0,
                   "rms_deg": 0.05}}
    passed, rejected = nav_real.gate_skyline_fixes(best)
    assert set(passed) == {"S1"}
    assert set(rejected) == {"S2", "S4"}
    assert "station fix kept" in rejected["S4"]["reason"]
    assert rejected["S4"]["image_id"] == "c" and rejected["S4"]["error_m"] == 617.0


def test_real_run_rejected_skyline_frame_keeps_station_fix(real_tree):
    """A paired frame that misses the KAT tolerance does not become a fix: the surveyed station
    fix stays (C 11:58), and the run report says why."""
    out = real_tree / "navigation"
    out.mkdir(parents=True)
    rows = [{"image_id": "NLB_FAR", "station": "S1", "status": "ok", "error_m": 523.0,
             "rms_deg": 0.1}]
    (out / nav_real.SKYLINE_REPORT).write_text(json.dumps(
        {"n_frames": 1, "n_ok": 1, "rows": rows}))
    rep = nav_real.run("nom_104", out=out, interim=real_tree, sets=["medium"], runs=20,
                       skyline=True, record=False, log=lambda *a: None, engine=object())
    fx = json.loads((out / "nav" / "fixes.json").read_text())
    assert [f["type"] for f in fx] == ["rover", "station", "rover"]
    assert fx[1]["sigma_m"] == NAV["fix_sigma_m"]["station"]
    assert rep["skyline"]["used"] == {}
    assert rep["skyline"]["rejected"]["S1"]["image_id"] == "NLB_FAR"


def test_skyline_bands_are_the_canonical_horizon_bands():
    """nav.yaml defers to horizon.yaml bands.{source}.path (WS1 canonical, C 11:15)."""
    hb = dr._yaml("horizon")["bands"]
    paths = nav_real.skyline_band_paths(dr.REPO)
    assert set(paths) == {"dem_1m", "ctx_20m", "mola_hrsc_200m"}
    for src, p in paths.items():
        assert p == dr.REPO / hb[src]["path"]
    ins = {i.name: i for i in nav_real.inputs("nom_104")}
    assert ins["ctx_20m"].path == dr.REPO / hb["ctx_20m"]["path"]


def test_nav_yaml_vo_block_matches_ws10_keys():
    """WS10 reads nav.yaml vo (vo.load_vo_config): every key of its pending block, same values,
    flagged assumed."""
    from pipeline.navigation import vo
    cfg, src = vo.load_vo_config()
    assert src == "config/nav.yaml vo"
    assert cfg["assumed"] is True
    for k, v in vo.PENDING_VO_CONFIG.items():
        assert cfg[k] == v, k


def test_curiosity_set_is_optional_labelled_and_not_default():
    opt = NAV["optional_sets"]["curiosity_vo_256"]
    assert "curiosity_vo_256" not in NAV["sets"] and NAV["default_set"] != "curiosity_vo_256"
    assert opt["label"] == "rover analogue: a rover is not an astronaut"
    assert opt["status"].startswith("pending N")
    assert opt["sigma_s"] > 0 and opt["sigma_b_deg_h"] > 0
    assert opt["psi0_deg"] is None and opt["slip"] is None  # not measured by VO
