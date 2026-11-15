"""WS3 horizon KATs (SPEC §9 "Horizon and camera", brief WS3 "Tests"), synthetic data only.

Every constant comes from config/ (horizon.yaml, site.yaml). Synthetic DEMs are built in memory.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from pipeline.horizon import config as hcfg
from pipeline.horizon.rays import DemBand, HorizonEngine, HorizonProfile, curvature_drop

CFG = hcfg.load()
R = hcfg.mars_radius_m()
EYE = CFG["eye_height_m"]
I_EAST = int(round(90.0 / CFG["az_step_deg"]))
I_WEST = int(round(270.0 / CFG["az_step_deg"]))


def band_from_centers(source, z, x_first, y_first, res):
    """North-up band whose pixel (0, 0) centre is at (x_first, y_first)."""
    return DemBand.from_transform(
        source, np.asarray(z, dtype=np.float32),
        (x_first - res / 2.0, res, 0.0, y_first + res / 2.0, 0.0, -res),
    )


def plane_band(source, half_extent_m, res, z=0.0):
    n = int(round(2 * half_extent_m / res)) + 1
    return band_from_centers(source, np.full((n, n), z), -half_extent_m, half_extent_m, res)


# --------------------------------------------------------------------------------------------
# Curvature
# --------------------------------------------------------------------------------------------

def test_mars_radius_from_site_config():
    assert R == pytest.approx(3_396_190.0)


def test_curvature_drop_at_20km_is_58_9_m():
    """Brief WS3 / SPEC §9: curvature drop at 20 km = 58.9 m (R = 3,396.19 km)."""
    assert round(curvature_drop(20_000.0, R), 1) == 58.9
    assert curvature_drop(20_000.0) == pytest.approx(20_000.0**2 / (2 * R))


# --------------------------------------------------------------------------------------------
# Ray engine
# --------------------------------------------------------------------------------------------

@pytest.fixture(scope="module")
def flat_engine():
    bands = [
        plane_band("dem_1m", 600.0, 1.0),
        plane_band("ctx_20m", 6_000.0, 20.0),
        plane_band("mola_hrsc_200m", 82_000.0, 200.0),
    ]
    return HorizonEngine(bands)


def test_ray_count_and_step_from_config(flat_engine):
    prof = flat_engine.horizon(0.0, 0.0)
    assert len(prof.az_deg) == int(round(360.0 / CFG["az_step_deg"])) == 1440
    assert prof.az_deg[0] == 0.0
    assert prof.az_deg[1] == pytest.approx(CFG["az_step_deg"])
    assert prof.eye_height_m == EYE


def test_flat_infinite_plane_equals_minus_curvature_dip(flat_engine):
    """Brief WS3: horizon on a flat infinite plane = -(curvature dip) within 0.01 deg."""
    prof = flat_engine.horizon(0.0, 0.0)
    dip_deg = math.degrees(math.acos(R / (R + EYE)))  # geometric dip of the horizon
    assert np.all(np.abs(prof.elevation_deg + dip_deg) < 0.01)
    # horizon distance sqrt(2 R h) ~ 3.4 km, within one 20 m sample step
    assert np.all(np.abs(prof.distance_m - math.sqrt(2 * R * EYE)) <= 20.0 + 1e-6)
    assert set(prof.source) == {"ctx_20m"}


def test_wall_100m_at_1km_from_1p7m_is_5p61_deg():
    """Brief WS3 / SPEC §9: a 100 m wall at 1 km seen from 1.7 m eye height = 5.61 deg."""
    assert EYE == 1.7
    nx, ny = 1101, 41
    z = np.zeros((ny, nx), dtype=np.float32)
    z[:, 1000:1021] = 100.0  # columns 1000..1020 -> x = 1000..1020 m
    eng = HorizonEngine([band_from_centers("dem_1m", z, 0.0, 20.0, 1.0)])
    prof = eng.horizon(0.0, 0.0)
    el = prof.elevation_deg[I_EAST]
    expected = math.degrees(math.atan((100.0 - EYE - curvature_drop(1000.0)) / 1000.0))
    assert el == pytest.approx(expected, abs=1e-6)
    assert round(el, 2) == 5.61
    assert prof.distance_m[I_EAST] == pytest.approx(1000.0)
    assert prof.source[I_EAST] == "dem_1m"


def test_curvature_inside_engine_wall_at_20km_reads_zero():
    """A wall eye height + curvature drop tall at 20 km sits at 0 deg; no data stays unknown."""
    res = 20.0
    xs = np.arange(0.0, 26_000.0 + res, res)
    z = np.zeros((3, xs.size), dtype=np.float32)
    z[:, xs >= 20_000.0] = EYE + curvature_drop(20_000.0)
    eng = HorizonEngine([band_from_centers("ctx_20m", z, 0.0, 20.0, res)])
    prof = eng.horizon(0.0, 0.0)
    assert prof.elevation_deg[I_EAST] == pytest.approx(0.0, abs=1e-4)
    assert prof.distance_m[I_EAST] == pytest.approx(20_000.0)
    assert math.isnan(prof.elevation_deg[I_WEST])  # west: no data -> NaN, not 0
    assert prof.source[I_WEST] is None


def test_sampling_steps_follow_config():
    """Samples every 1 m to 2 km, 20 m to 30 km, 200 m beyond (horizon.yaml sampling)."""
    eng = HorizonEngine([plane_band("mola_hrsc_200m", 1000.0, 200.0)])
    d0, d1, step, *_ = eng._seg
    want = CFG["sampling"]
    assert [float(s["step_m"]) for s in want] == list(step)
    assert [float(s["to_m"]) for s in want] == list(d1)
    assert d0[0] == want[0]["step_m"]
    assert d0[1] == want[0]["to_m"] + want[1]["step_m"]


def test_nodata_in_fine_band_falls_back_to_coarser():
    fine = plane_band("dem_1m", 300.0, 1.0)
    fine.z[:, :] = np.nan
    coarse = plane_band("ctx_20m", 3_000.0, 20.0)
    eng = HorizonEngine([fine, coarse])
    prof = eng.horizon(0.0, 0.0, z_obs=EYE)
    assert set(prof.source) == {"ctx_20m"}
    assert CFG["band_fallback"]["value"] == "coarser"


def test_coarse_band_never_used_inside_finer_range_when_finer_has_data():
    """Inside 2 km the 1 m DEM wins over a coarser band that disagrees."""
    fine = plane_band("dem_1m", 2_100.0, 1.0, z=0.0)
    coarse = plane_band("ctx_20m", 5_000.0, 20.0, z=50.0)
    eng = HorizonEngine([fine, coarse])
    el, dist, src = eng.horizons([0.0], [0.0], z_obs=EYE, az_step_deg=90.0)
    # the coarse band (50 m higher) only enters beyond 2 km
    assert np.all(dist[0] > CFG["sampling"][0]["to_m"])
    assert np.all(src[0] == 1)


# --- C decision 2026-11-14 12:35 (F20 at S2): dem_1m out to the edge of its coverage ----------

def _strip_engine(fine_wall=None, coarse_wall=None, fine_len=4000.0):
    """dem_1m strip x 0..fine_len (y -20..20, flat 0) + ctx_20m flat 0 over +/- 8 km.
    ``*_wall`` = (x_from, x_to, z) raised in that band only."""
    nx = int(fine_len) + 1
    fz = np.zeros((41, nx), dtype=np.float32)
    if fine_wall:
        fz[:, int(fine_wall[0]):int(fine_wall[1]) + 1] = fine_wall[2]
    fine = band_from_centers("dem_1m", fz, 0.0, 20.0, 1.0)
    coarse = plane_band("ctx_20m", 8_000.0, 20.0)
    if coarse_wall:
        xs = -8_000.0 + 20.0 * np.arange(coarse.z.shape[1])
        coarse.z[:, (xs >= coarse_wall[0]) & (xs <= coarse_wall[1])] = coarse_wall[2]
    return HorizonEngine([fine, coarse])


def test_sampling_dem_1m_hands_over_at_its_band_edge():
    """horizon.yaml: the dem_1m segment extends to the band edge (C decision 12:35)."""
    seg = CFG["sampling"][0]
    assert seg["source"] == "dem_1m" and seg["handover"] == "band_edge"
    assert [s.get("handover") for s in CFG["sampling"][1:]] == [None, None]


def test_dem_1m_used_beyond_2km_up_to_its_edge():
    """A 100 m wall in dem_1m at 3.5 km (inside its coverage) is seen from dem_1m; CTX there is
    flat and is not consulted (with the old 2 km handover the wall was lost)."""
    eng = _strip_engine(fine_wall=(3500, 3519, 100.0))
    prof = eng.horizon(0.0, 0.0, z_obs=EYE)
    expected = math.degrees(math.atan((100.0 - EYE - curvature_drop(3500.0)) / 3500.0))
    assert prof.elevation_deg[I_EAST] == pytest.approx(expected, abs=1e-6)
    assert prof.distance_m[I_EAST] == pytest.approx(3500.0)
    assert prof.source[I_EAST] == "dem_1m"
    # handover distance per ray = where the ray leaves dem_1m's valid extent, at least to_m
    h = eng.handover_m(0.0, 0.0, az_deg=[0.0, 90.0, 270.0])
    assert h[1] == pytest.approx(4000.0)                       # east: the strip's last centre
    assert h[0] == h[2] == CFG["sampling"][0]["to_m"]          # leaves at once: the 2 km floor


def test_ctx_takes_over_after_the_dem_1m_edge():
    """Beyond the dem_1m edge (x 4000) the CTX wall at 4.5 km is the horizon, sampled on the
    20 m grid that starts at the handover."""
    eng = _strip_engine(fine_wall=(3500, 3519, 100.0), coarse_wall=(4500.0, 4560.0, 300.0))
    prof = eng.horizon(0.0, 0.0, z_obs=EYE)
    assert prof.source[I_EAST] == "ctx_20m"
    assert 4500.0 <= prof.distance_m[I_EAST] <= 4560.0
    assert (prof.distance_m[I_EAST] - 4000.0) % 20.0 == pytest.approx(0.0, abs=1e-6)


def test_dem_1m_wins_over_ctx_inside_its_coverage_beyond_2km():
    """CTX 50 m higher than dem_1m everywhere: along the east ray dem_1m (to 4 km) is used and
    the horizon comes from CTX only past dem_1m's edge."""
    fine = band_from_centers("dem_1m", np.zeros((41, 4001), dtype=np.float32), 0.0, 20.0, 1.0)
    coarse = plane_band("ctx_20m", 8_000.0, 20.0, z=50.0)
    eng = HorizonEngine([fine, coarse])
    el, dist, src = eng.horizons([0.0], [0.0], z_obs=EYE, az_step_deg=90.0)
    assert dist[0, 1] > 4000.0 and src[0, 1] == 1


def test_observer_outside_dem_1m_uses_it_where_the_ray_crosses_it():
    """From 1 km west of the strip, the east ray crosses dem_1m (1-5 km): its wall 2.5 km from
    the observer comes from dem_1m."""
    eng = _strip_engine(fine_wall=(1500, 1519, 100.0))
    prof = eng.horizon(-1000.0, 0.0, z_obs=EYE)
    assert prof.source[I_EAST] == "dem_1m"
    assert prof.distance_m[I_EAST] == pytest.approx(2500.0)
    assert eng.handover_m(-1000.0, 0.0, az_deg=[90.0])[0] == pytest.approx(5000.0)


def test_azimuth_is_clockwise_from_grid_north():
    z = np.zeros((401, 401), dtype=np.float32)
    z[100, 300] = 500.0  # tower at x = +100, y = +100 (observer at the centre)
    prof = HorizonEngine([band_from_centers("dem_1m", z, -200.0, 200.0, 1.0)]).horizon(0.0, 0.0)
    assert prof.az_deg[int(np.nanargmax(prof.elevation_deg))] == pytest.approx(45.0)


def test_min_dist_and_coarse_step_for_f22():
    z = np.zeros((41, 1101), dtype=np.float32)
    z[:, 200:210] = 100.0  # near wall at 200 m
    eng = HorizonEngine([band_from_centers("dem_1m", z, 0.0, 20.0, 1.0)])
    near = eng.horizon(0.0, 0.0, az_step_deg=CFG["az_step_coarse_deg"])
    assert len(near.az_deg) == 360
    far = eng.horizon(0.0, 0.0, az_step_deg=CFG["az_step_coarse_deg"], min_dist_m=500.0)
    assert near.distance_m[90] == pytest.approx(200.0)
    assert far.distance_m[90] >= 500.0


def test_batch_horizons_match_single(flat_engine):
    xs = np.array([0.0, 50.0, -120.0])
    ys = np.array([0.0, 30.0, 75.0])
    el, dist, src = flat_engine.horizons(xs, ys, az_step_deg=1.0)
    assert el.shape == (3, 360)
    for k in range(3):
        p = flat_engine.horizon(xs[k], ys[k], az_step_deg=1.0)
        np.testing.assert_allclose(el[k], p.elevation_deg)
        np.testing.assert_allclose(dist[k], p.distance_m)


def test_observer_off_dem_is_unknown(flat_engine):
    prof = flat_engine.horizon(1e6, 1e6)
    assert np.all(np.isnan(prof.elevation_deg))


def test_profile_interpolation_and_distance_class():
    az = np.arange(0, 360, 90.0)
    prof = HorizonProfile(
        az_deg=az, elevation_deg=np.array([0.0, 1.0, 2.0, 3.0]),
        distance_m=np.array([100.0, 1000.0, 5000.0, 400.0]), source=["dem_1m"] * 4,
        observer={"x": 0.0, "y": 0.0, "z": 0.0}, eye_height_m=EYE, az_step_deg=90.0,
    )
    assert prof.elevation_at(45.0) == pytest.approx(0.5)
    assert prof.elevation_at(315.0) == pytest.approx(1.5)  # wraps 270 -> 360
    assert list(prof.distance_class()) == ["near", "mid", "far", "near"]
    assert list(prof.distance_class(np.array([np.nan]))) == ["unknown"]


def test_horizon_json_roundtrip_and_contract(tmp_path, flat_engine):
    from pipeline.horizon.contracts import validate

    prof = flat_engine.horizon(0.0, 0.0)
    path = prof.write_json(tmp_path / "S1.json", observer_id="S1")
    import json

    validate(json.loads(path.read_text()), "horizon.schema.json")
    back = HorizonProfile.read_json(path)
    np.testing.assert_allclose(back.elevation_deg, prof.elevation_deg, atol=1e-6)
    assert back.source == prof.source


def test_lonlat_to_xy_uses_analysis_crs():
    from pipeline.horizon.geo import lonlat_to_xy, xy_to_lonlat

    x, y = lonlat_to_xy(137.39, -4.8)
    assert abs(x) < 1e-6 and y == pytest.approx(-4.8 * math.pi / 180 * R, rel=1e-9)
    # 0.01 deg of longitude at lat_ts -4.8 = R cos(4.8 deg) * 0.01 deg
    x2, _ = lonlat_to_xy(137.40, -4.8)
    assert x2 == pytest.approx(R * math.cos(math.radians(4.8)) * math.radians(0.01), rel=1e-9)
    lon, lat = xy_to_lonlat(x2, y)
    assert lon == pytest.approx(137.40) and lat == pytest.approx(-4.8)


# --------------------------------------------------------------------------------------------
# Sky detector (F13 V2, reused by F22)
# --------------------------------------------------------------------------------------------

SKY = CFG["sky_detector_params"]


def test_sky_detector_rule_known_answer():
    """horizon.yaml sky_detector: first pixel where the vertical gradient > 3x the median gradient
    of the top 10% rows (rule as written: no border, no smoothing)."""
    from pipeline.horizon.sky import detect_skyline

    assert SKY["grad_ratio"] == 3.0 and SKY["ref_top_frac"] == 0.10  # same as the prose rule
    img = np.full((100, 4), 200, dtype=np.uint8)
    img[60:, 0] = 100          # column 0: sharp boundary between rows 59 and 60
    img[60:, 1] = 198          # column 1: 2-DN step < 3 x one-count guard -> no detection
    img[::2, 2] = 202          # column 2: noisy sky (median grad 2) ...
    img[70:, 2] = 150          # ... a step of ~50 at row 70 still fires
    det = detect_skyline(img, border_px=0, smooth_sigma_px=0)
    assert det.rows[0] == pytest.approx(59.5)
    assert math.isnan(det.rows[1])
    assert det.rows[2] == pytest.approx(69.5)
    assert math.isnan(det.rows[3])          # uniform sky: unknown, not a fake skyline
    assert det.ref_median[2] == pytest.approx(2.0)
    assert not det.in_ref_band.any()


def test_sky_detector_flags_skyline_inside_reference_band():
    from pipeline.horizon.sky import detect_skyline

    img = np.full((100, 1), 200, dtype=np.uint8)
    img[5:, 0] = 80
    det = detect_skyline(img, border_px=0, smooth_sigma_px=0)
    assert det.rows[0] == pytest.approx(4.5)
    assert det.in_ref_band[0]


def test_sky_detector_ignores_artefact_border():
    from pipeline.horizon.sky import detect_skyline

    b = SKY["border_px"]
    img = np.full((100, 20), 200, dtype=np.uint8)
    img[60:, :] = 100        # true boundary between rows 59 and 60
    img[0, :] = 254          # bright artefact row (as on the fresh Navcam JPEGs)
    img[:, 0] = 5            # dark artefact column
    raw = detect_skyline(img, border_px=0, smooth_sigma_px=0)
    assert raw.in_ref_band[1:].all()          # without the exclusion the artefact row fires
    det = detect_skyline(img, smooth_sigma_px=0)
    assert np.isnan(det.rows[:b]).all() and np.isnan(det.rows[-b:]).all()
    assert det.rows[b:-b] == pytest.approx(np.full(20 - 2 * b, 59.5))
    assert not det.in_ref_band.any()


def test_sky_detector_presmoothing_keeps_edge_position():
    from pipeline.horizon.sky import detect_skyline

    assert SKY["presmooth_sigma_px"] > 0
    rng = np.random.default_rng(3)
    img = np.clip(np.where(np.arange(200)[:, None] >= 120, 90.0, 180.0)
                  + rng.normal(0, 4.0, (200, 64)), 0, 255).astype(np.uint8)
    raw = detect_skyline(img, smooth_sigma_px=0)
    assert np.mean(np.abs(raw.rows - 119.5) <= 1.0) < 0.5   # the bare rule fires on noise
    det = detect_skyline(img)
    ok = np.isfinite(det.rows) & ~det.in_ref_band
    assert ok.mean() > 0.9
    assert np.all(np.abs(det.rows[ok] - 119.5) <= 1.0)   # no smoothing bias


# --------------------------------------------------------------------------------------------
# Far-field bands (bands.py)
# --------------------------------------------------------------------------------------------

def test_ctx_greedy_pick_known_answer():
    from shapely.geometry import box

    from pipeline.horizon.bands import pick_ctx_items

    def feat(i, x0, x1):
        return {"id": i, "geometry": {"type": "Polygon", "coordinates": [
            [[x0, -10], [x1, -10], [x1, 10], [x0, 10], [x0, -10]]]}}

    disc = box(0, -10, 10, 10)  # area 200 in "lon/lat" units with an identity transform
    feats = [feat("a", 0, 6), feat("b", 0, 5), feat("c", 5, 10), feat("d", 9, 10)]
    ident = lambda x, y: (x, y)  # noqa: E731
    got = pick_ctx_items(feats, disc, 3, 0.01, to_xy=ident)
    assert [g["id"] for g in got] == ["a", "c"]  # b and d add nothing after a + c
    assert got[0]["gain_pct"] == pytest.approx(60.0) and got[1]["cum_pct"] == pytest.approx(100)
    got = pick_ctx_items(feats, disc, 3, 0.01, to_xy=ident, exclude=["a"])
    assert [g["id"] for g in got] == ["b", "c"]


def test_band_target_grid_centred_on_pad():
    from pipeline.horizon.bands import _pad_xy, target_grid

    gt, w, h = target_grid(1000.0, 20.0)
    px, py = _pad_xy()
    assert w == h == 101
    assert gt[0] <= px - 1000 and gt[0] + w * gt[1] >= px + 1000
    assert gt[3] >= py + 1000 and gt[3] + h * gt[5] <= py - 1000
    assert gt[0] % 20 == 0 and gt[3] % 20 == 0


# --------------------------------------------------------------------------------------------
# Canonical bands (C decision 11:15), stations, pad, ring, landmarks, panorama, card fragments
# --------------------------------------------------------------------------------------------

def test_engine_reads_canonical_ws1_far_field_bands():
    """C decisions (STATUS Decision log 11:15, 14:13): the engine reads WS1's terrain/ bands;
    the canonical CTX band is ctx_20m_v2.tif (each item co-registered to dem_1m)."""
    from pipeline.horizon.bands import band_paths

    p = band_paths()
    assert p["ctx_20m"] == hcfg.REPO / "data/interim/terrain/ctx_20m_v2.tif"
    assert p["mola_hrsc_200m"] == hcfg.REPO / "data/interim/terrain/mola_hrsc_200m.tif"
    assert p["dem_1m"] == hcfg.REPO / "data/interim/terrain/dem_1m.tif"


def test_station_observer_access_cell_rule():
    """User decision 11:40: the observer stands at the access cell when WS2 publishes it; until
    then the science coordinate, marked provisional."""
    from pipeline.horizon.cards import observer_from_station

    s = {"id": "S1", "lon": 137.39, "lat": -4.81}
    o = observer_from_station(s)
    assert (o["lon"], o["lat"]) == (137.39, -4.81)
    assert o["position"] == "science_coordinate" and o["provisional"] is True
    for acc in ({"access_lon": 137.3905, "access_lat": -4.8102},
                {"access": {"lon": 137.3905, "lat": -4.8102, "walk_in_m": 21.0}}):
        o = observer_from_station({**s, **acc})
        assert (o["lon"], o["lat"]) == (137.3905, -4.8102)
        assert o["position"] == "access_cell" and o["provisional"] is False
        assert (o["science_lon"], o["science_lat"]) == (137.39, -4.81)
    # WS2 session 3 format: access_lon/lat null + access_reason = published, no access cell
    o = observer_from_station({**s, "access_lon": None, "access_lat": None,
                               "access_reason": "none walkable within 50 m",
                               "access": {"nom_104": {"lon": None, "lat": None}}})
    assert (o["lon"], o["lat"]) == (137.39, -4.81)
    assert o["position"] == "science_coordinate_no_access" and o["provisional"] is False
    assert "none walkable" in o["note"]


def test_pad_observer_is_the_d21_official_pad_never_the_proposal(tmp_path):
    """D21 (user 16:14): the pad horizon is at the official pad = WS2 pad.json's top-level pad
    when its `source` cites D21 and it is not marked as a proposal; the `proposal` block is never
    read. A pre-D21 file counts only when its top-level pad is pad_default (C 14:58); anything
    else falls back to site.yaml pad_default with a source_note."""
    import json

    from pipeline.horizon.cards import pad_observer

    eng, ter = tmp_path / "engine", tmp_path / "terrain"
    eng.mkdir()
    ter.mkdir()
    pad = hcfg.site()["pad_default"]
    (ter / "grid.json").write_text(json.dumps({"pad": {"lon": 137.383, "lat": -4.807}}))
    o = pad_observer(eng, ter)                                  # no pad.json
    assert (o["lon"], o["lat"]) == (pad["lon"], pad["lat"]) and "site.yaml" in o["source"]
    assert "source_note" not in o
    # D21 official pad elsewhere than pad_default, cited: used
    official = {"lon": 137.402443, "lat": -4.769028,
                "source": "WS2 D21 screening: most feasible EVAs (rank 1)"}
    alts = [{"lon": pad["lon"], "lat": pad["lat"], "role": "pad_default"}]
    (eng / "pad.json").write_text(json.dumps({"pad": official, "alternatives": alts}))
    o = pad_observer(eng, ter)
    assert (o["lon"], o["lat"]) == (official["lon"], official["lat"])
    assert "pad.json" in o["source"] and "D21" in o["source"] and "source_note" not in o
    # D21 not cited (e.g. "D210", or no source): a pad off pad_default is ignored
    for src in ({"source": "F8 siting result D210"}, {}):
        (eng / "pad.json").write_text(json.dumps({"pad": {"lon": official["lon"],
                                                          "lat": official["lat"], **src}}))
        o = pad_observer(eng, ter)
        assert (o["lon"], o["lat"]) == (pad["lon"], pad["lat"]) and "site.yaml" in o["source"]
        assert "ignored" in o["source_note"] and "D21" in o["source_note"]
    # a pre-D21 file with pad_default at the top level is still fine
    (eng / "pad.json").write_text(json.dumps({"pad": {"lon": pad["lon"] + 4e-7,
                                                      "lat": pad["lat"]},
                                              "proposal": {"pad": official}}))
    o = pad_observer(eng, ter)
    assert "pad.json" in o["source"] and "source_note" not in o
    assert o["lon"] == pytest.approx(pad["lon"]) and o["lat"] == pytest.approx(pad["lat"])
    # a top-level pad marked as a proposal is ignored even when it cites D21
    for mark in ({"proposal": True}, {"is_proposal": True}, {"role": "proposal"}):
        (eng / "pad.json").write_text(json.dumps({"pad": {**official, **mark}}))
        o = pad_observer(eng, ter)
        assert "site.yaml" in o["source"] and "marked as a proposal" in o["source_note"]
    # only a proposal block (no top-level pad): never read
    (eng / "pad.json").write_text(json.dumps({"proposal": {"pad": {**official}}}))
    o = pad_observer(eng, ter)
    assert (o["lon"], o["lat"]) == (pad["lon"], pad["lat"]) and "ignored" in o["source_note"]


IAU_CSV = hcfg.REPO / "data/raw/discovery/iau_mars.csv"
# docs/discovery.md 3.5: (distance km, bearing deg) from pad_default, great circle on R 3,396.19 km
DISCOVERY_LANDMARKS = {
    "Gediz Vallis": (4.3, 131.5), "Yellowknife": (13.8, 14.3), "Sakarya Vallis": (17.7, 190.0),
    "Aeolis Palus": (20.3, 6.6), "Aeolis Mons": (31.9, 121.0), "Peace Vallis": (36.7, 345.6),
    "Gale": (41.8, 142.7), "Dulce Vallis": (49.8, 269.1),
}


@pytest.mark.skipif(not IAU_CSV.exists(), reason="IAU gazetteer CSV not cached (discovery 3.5)")
def test_iau_landmarks_within_80km_match_discovery_table():
    from pipeline.horizon.cards import load_iau_landmarks
    from pipeline.horizon.geo import great_circle

    pad = hcfg.site()["pad_default"]
    lms = load_iau_landmarks(IAU_CSV, pad["lon"], pad["lat"])
    assert {lm["name"] for lm in lms} == set(DISCOVERY_LANDMARKS)
    for lm in lms:
        b, d = great_circle(pad["lon"], pad["lat"], lm["lon"], lm["lat"])
        want_d, want_b = DISCOVERY_LANDMARKS[lm["name"]]
        assert round(d / 1000, 1) == pytest.approx(want_d, abs=0.051)
        assert round(b, 1) == pytest.approx(want_b, abs=0.051)


@pytest.fixture(scope="module")
def cone_engine():
    """Flat plane (z 0) to 82 km with a 1,000 m cone (radius 5 km) whose apex is 30 km north."""
    res = 200.0
    n = int(round(2 * 82_000.0 / res)) + 1
    c = (np.arange(n) * res) - 82_000.0
    xx, yy = np.meshgrid(c, -c)
    r = np.hypot(xx, yy - 30_000.0)
    z = np.clip(1000.0 * (1.0 - r / 5000.0), 0.0, None)
    return HorizonEngine([band_from_centers("mola_hrsc_200m", z, -82_000.0, 82_000.0, res)])


def test_landmark_on_skyline_peak_is_visible_and_behind_it_is_hidden(cone_engine):
    from pipeline.horizon.cards import landmark_view

    prof = cone_engine.horizon(0.0, 0.0)
    obs = {"x": 0.0, "y": 0.0, "z": prof.observer["z"]}
    apex = landmark_view(obs, {"name": "apex", "x": 0.0, "y": 30_000.0}, cone_engine, prof)
    assert apex["bearing_deg"] == pytest.approx(0.0, abs=1e-6)
    assert apex["dist_km"] == pytest.approx(30.0)
    want = math.degrees(math.atan((1000.0 - EYE - curvature_drop(30_000.0)) / 30_000.0))
    assert apex["el_deg"] == pytest.approx(want, abs=1e-3)
    assert apex["above_skyline"] is True
    behind = landmark_view(obs, {"name": "behind", "x": 0.0, "y": 50_000.0}, cone_engine, prof)
    assert behind["above_skyline"] is False
    side = landmark_view(obs, {"name": "east", "x": 10_000.0, "y": 0.0}, cone_engine, prof)
    assert side["bearing_deg"] == pytest.approx(90.0)


def test_landmark_display_rule_d33():
    """landmarks.yaml rule + D33 (user 16:20): up to 6 landmarks above the skyline, nearest
    first, labelled; every landmark below the skyline (at any distance, 4.9 km too) is listed
    after them, nearest first, as a bearing-only tick (display bearing_tick, above_skyline false,
    no elevation). Fewer than 3 visible are reported in the note, never padded."""
    from pipeline.horizon.cards import classify_landmarks

    rule = CFG["landmark_rule"]
    hid = CFG["hidden_landmarks"]
    assert (rule["min_n"], rule["max_n"]) == (3, 6)
    assert (hid["display"], hid["visible_display"], hid["label"]) == \
        ("bearing_tick", "label", "below skyline")
    assert "D33" in hid["source"]

    def v(name, d, above):
        return {"name": name, "bearing_deg": 10.0 + d, "dist_km": d, "kind": "official",
                "el_deg": 1.0, "skyline_el_deg": 2.0, "above_skyline": above}

    views = [v("far_hidden", 40, False), v("near_hidden", 4.9, False), v("far_up", 30, True),
             v("mid_up", 12, True)] + [v(f"up{i}", 20 + i, True) for i in range(5)]
    items, note = classify_landmarks(views)
    names = [p["name"] for p in items]
    assert names == ["mid_up", "up0", "up1", "up2", "up3", "up4", "near_hidden", "far_hidden"]
    assert "far_up" not in names                                  # 7th visible: max_n 6
    assert all(p["display"] == "label" and p["above_skyline"] is True for p in items[:6])
    for p in items[6:]:
        assert p["display"] == "bearing_tick" and p["above_skyline"] is False
        assert set(p) == {"name", "kind", "bearing_deg", "dist_km", "above_skyline", "display"}
    assert items[6]["bearing_deg"] == 14.9 and items[6]["dist_km"] == 4.9
    assert note is None
    items, note = classify_landmarks([v("a", 40, False), v("b", 2, False), v("c", 9, True)])
    assert [(p["name"], p["display"]) for p in items] == \
        [("c", "label"), ("b", "bearing_tick"), ("a", "bearing_tick")]
    assert "1 landmark" in note and "fewer than 3" in note and "2" in note
    assert "below skyline" in note and "D33" in note
    items, note = classify_landmarks([])
    assert items == [] and "0 landmark" in note


def test_overlay_shows_only_landmarks_visible_from_the_photo_stop(cone_engine):
    """D33: the Navcam overlay marks only landmarks above the skyline seen from the frame's
    stop; a landmark hidden behind the cone gets no tick."""
    from pipeline.horizon.cards import overlay_items

    prof = cone_engine.horizon(0.0, 0.0)
    stop = {"x": 0.0, "y": 0.0, "z": prof.observer["z"]}
    lms = [{"name": "apex", "x": 0.0, "y": 30_000.0}, {"name": "behind", "x": 0.0, "y": 50_000.0}]
    items = overlay_items(stop, lms, cone_engine, prof)
    assert [i["name"] for i in items] == ["apex"]
    assert items[0]["bearing_deg"] == pytest.approx(0.0, abs=1e-6)


def test_panorama_rows_follow_profile_and_landmark_tick():
    from pipeline.horizon.cards import pano_xy, render_panorama

    az = np.arange(1440) * 0.25
    el = 2.0 + np.sin(np.radians(az))
    prof = HorizonProfile(az, el, np.full(az.size, 10_000.0), ["ctx_20m"] * az.size,
                          {"x": 0, "y": 0, "z": 0}, EYE, 0.25)
    img, meta = render_panorama(prof, [{"name": "Peak", "bearing_deg": 90.0, "dist_km": 10.0,
                                        "el_deg": 3.0}])
    pc = CFG["panorama"]
    a = np.asarray(img.convert("RGB")).astype(int)
    assert a.shape[1] == int(round(360 * pc["px_per_deg"]))
    for az_q in (0.0, 90.0, 270.0):
        x, y_want = pano_xy(meta, az_q, 2.0 + math.sin(math.radians(az_q)))
        col = a[:, int(round(x))]
        ground = np.nonzero(np.all(col == pc["ground_rgb"], axis=1))[0]
        assert abs(ground[0] - y_want) <= 2.0          # first ground pixel under the line
    x, y = pano_xy(meta, 90.0, 3.0)
    assert tuple(a[int(round(y)) - 4, int(round(x))]) == tuple(pc["tick_rgb"])


def test_panorama_hidden_landmark_is_a_bearing_only_tick_d33():
    """D33: a hidden landmark is drawn at its bearing only: a dashed line through the ground
    from the skyline down, and a bottom band (below the strip) with its tick and label. The
    strip above (sky, skyline, ground rows) is unchanged by it."""
    from pipeline.horizon.cards import pano_xy, render_panorama

    az = np.arange(1440) * 0.25
    el = 2.0 + np.sin(np.radians(az))
    prof = HorizonProfile(az, el, np.full(az.size, 10_000.0), ["ctx_20m"] * az.size,
                          {"x": 0, "y": 0, "z": 0}, EYE, 0.25)
    hidden = {"name": "Gale", "bearing_deg": 200.0, "dist_km": 41.3, "above_skyline": False,
              "display": "bearing_tick"}
    base, mb = render_panorama(prof, [])
    img, meta = render_panorama(prof, [hidden])
    ph = CFG["panorama_hidden"]
    a = np.asarray(img.convert("RGB")).astype(int)
    a0 = np.asarray(base.convert("RGB")).astype(int)
    assert meta["strip_height_px"] == mb["height"] and meta["height"] > mb["height"]
    assert a.shape[0] == meta["height"]
    x = int(round(pano_xy(meta, 200.0, 0.0)[0]))
    _, y_sky = pano_xy(meta, 200.0, 2.0 + math.sin(math.radians(200.0)))
    col = a[: meta["strip_height_px"], x]
    hits = np.nonzero(np.all(col == ph["tick_rgb"], axis=1))[0]
    assert hits.size > 0 and hits.min() >= y_sky - 1            # only below the skyline
    assert not np.any(np.all(a[: int(y_sky) - 2, x] == ph["tick_rgb"], axis=1))  # none in sky
    band = a[meta["strip_height_px"]:, x - 1: x + 2]
    assert np.any(np.all(band == ph["tick_rgb"], axis=2))      # tick in the bottom band
    assert np.any(np.all(a[meta["strip_height_px"]:] == ph["band_rgb"], axis=2))
    far = int(round(pano_xy(meta, 20.0, 0.0)[0]))               # away from the tick and label
    assert np.array_equal(a[: mb["height"], far], a0[:, far])
    # a visible landmark is still a labelled tick at its elevation, no bottom band
    img2, meta2 = render_panorama(prof, [{"name": "Peak", "bearing_deg": 90.0, "dist_km": 10.0,
                                          "el_deg": 3.0, "display": "label"}])
    assert meta2["height"] == meta2["strip_height_px"] == mb["height"]


def test_horizon_ring_beyond_min_range_and_consistent_points(cone_engine):
    from pipeline.horizon.cards import ring_doc

    obs = {"id": "pad", "lon": 137.0, "lat": -4.8, "x": 0.0, "y": 0.0}
    doc = ring_doc(cone_engine, obs, min_range_m=3700.0)
    n = int(round(360 / CFG["az_step_deg"]))
    assert len(doc["az_deg"]) == len(doc["elev_deg"]) == len(doc["dist_m"]) == n
    d = np.array(doc["dist_m"], dtype=float)
    assert np.nanmin(d) >= 3700.0
    assert doc["dist_m"][0] == pytest.approx(30_000.0, abs=200.0)      # cone apex due north
    assert doc["z_m"][0] == pytest.approx(1000.0, abs=1.0)
    south = n // 2
    assert doc["z_m"][south] == pytest.approx(0.0, abs=0.05)        # flat plane behind
    e, nn = doc["east_m"][n // 4], doc["north_m"][n // 4]
    assert e == pytest.approx(doc["dist_m"][n // 4], abs=0.5) and abs(nn) < 0.5
    from pipeline.horizon.contracts import validate

    validate(doc, "horizon_ring.schema.json")


def test_nearest_suitable_frame_skips_failed_and_manual_rejects():
    from pipeline.horizon.cards import nearest_suitable_frame

    frames = [{"image_id": "A", "x": 10.0, "y": 0.0}, {"image_id": "B", "x": 20.0, "y": 0.0},
              {"image_id": "C", "x": 30.0, "y": 0.0}, {"image_id": "D", "x": 40.0, "y": 0.0}]
    v2 = {"A": {"status": "failed"}, "B": {"status": "ok", "manual_ok": False},
          "C": {"status": "ok", "manual_ok": None}, "D": {"status": "ok", "manual_ok": True}}
    f, dist = nearest_suitable_frame((0.0, 0.0), frames, v2)
    assert f["image_id"] == "C" and dist == pytest.approx(30.0)
    assert nearest_suitable_frame((0.0, 0.0), frames[:2], v2) == (None, None)


def test_card_fragment_validates_against_card_contract_fields():
    from pipeline.horizon.cards import FRAGMENT_FIELDS, card_fragment
    from pipeline.horizon.contracts import validate

    frag = card_fragment(
        "S1", observer={"id": "S1", "position": "science_coordinate", "provisional": True},
        frame={"image_id": "NLB_X", "sol": 4834, "stop_id": "v121_0"}, frame_dist_m=522.0,
        frame_errors={"near": 0.1, "mid": None, "far": 4.2},
        landmarks=[{"name": "Gale", "bearing_deg": 142.7, "dist_km": 41.8, "el_deg": 1.0,
                    "above_skyline": True, "display": "label"},
                   {"name": "Aeolis Mons", "bearing_deg": 121.2, "dist_km": 31.3,
                    "kind": "official", "above_skyline": False, "display": "bearing_tick"}],
        landmarks_note=None)
    validate(frag, "card.schema.json", properties=FRAGMENT_FIELDS)
    # D33: the hidden landmark keeps kind, bearing, distance, above_skyline false, display hint
    assert frag["landmarks"][1] == {"name": "Aeolis Mons", "bearing_deg": 121.2, "dist_km": 31.3,
                                    "kind": "official", "above_skyline": False,
                                    "display": "bearing_tick"}
    assert frag["landmarks"][0]["display"] == "label" and "el_deg" not in frag["landmarks"][0]
    assert set(FRAGMENT_FIELDS) == {"navcam", "skyline_error_deg", "panorama_png", "landmarks"}
    assert frag["navcam"]["url_local"] == "cards/S1/navcam.png"
    assert frag["navcam"]["overlay_png"] == "cards/S1/overlay.png"
    assert frag["panorama_png"] == "cards/S1/panorama.png"
    assert frag["provisional"] is True
    none = card_fragment("S2", observer={"id": "S2", "provisional": False}, frame=None,
                         frame_dist_m=None, frame_errors=None, landmarks=[], landmarks_note="x")
    validate(none, "card.schema.json", properties=FRAGMENT_FIELDS)
    assert none["navcam"] == {"sol": None, "image_id": None, "url_local": None,
                              "overlay_png": None}
    assert none["skyline_error_deg"] == {"near": None, "mid": None, "far": None}


def test_tag_station_frames_for_ws9():
    """C request: the card frame of each station carries station = S in navcam_frames.json;
    re-runs clear old card tags, keep stop-rule tags, and a shared frame lists all stations."""
    from pipeline.horizon.cards import tag_station_frames

    doc = {"frames": [{"image_id": "A", "station": None}, {"image_id": "B", "station": "S4"},
                      {"image_id": "C", "station": None}]}
    tag_station_frames(doc, {"S1": {"image_id": "A", "dist_m": 522.04, "position": "x"},
                             "S2": {"image_id": "A", "dist_m": 900.0, "position": "y"}})
    a = doc["frames"][0]
    assert a["station"] == "S1" and a["stations"] == ["S1", "S2"]
    assert a["station_dist_m"] == {"S1": 522.0, "S2": 900.0}
    assert doc["frames"][1]["station"] == "S4" and "station_source" not in doc["frames"][1]
    tag_station_frames(doc, {"S2": {"image_id": "C", "dist_m": 10.0, "position": "z"}})
    assert doc["frames"][0]["station"] is None and "stations" not in doc["frames"][0]
    assert doc["frames"][2]["station"] == "S2" and doc["frames"][1]["station"] == "S4"
