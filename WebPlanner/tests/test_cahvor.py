"""WS3 camera KATs (SPEC §2.2 F12, §9; brief WS3 "Tests"): CAHV/CAHVOR/CAHVORE projection and the
site <-> rover attitude chain on synthetic cameras; the real-frame KATs (A-vector azimuth and rover
yaw within 1 deg of the image label on 3 frames) run on raw-image API records fetched after H0
(see the "Real frames" section).
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from pipeline.horizon import config as hcfg
from pipeline.horizon.cahvor import (
    CameraModel,
    cahv_from_intrinsics,
    enu_to_site,
    matrix_to_ypr,
    parse_cmod_string,
    pointing_az_el,
    quat_to_matrix,
    site_to_enu,
    ypr_to_quat,
)
from pipeline.horizon.rays import HorizonProfile

CFG = hcfg.load()

# A Navcam-like synthetic camera (1024 x 1024, 45 deg FOV) in the rover frame
# (MSL rover frame: +X forward, +Y right, +Z down).
W = H_IMG = 1024
F = 512.0 / math.tan(math.radians(22.5))
CX = CY = 511.5
C0 = np.array([0.8, 0.5, -1.9])


def rot_y(deg):  # pitch about the rover +Y axis (nose up positive in NED-like frames)
    a = math.radians(deg)
    return np.array([[math.cos(a), 0, math.sin(a)], [0, 1, 0], [-math.sin(a), 0, math.cos(a)]])


def base_cahv(pitch_deg=0.0):
    rot = rot_y(pitch_deg)
    a = rot @ np.array([1.0, 0, 0])
    h = rot @ np.array([0, 1.0, 0])   # image right = rover right
    v = rot @ np.array([0, 0, 1.0])   # image down = rover down
    return cahv_from_intrinsics(C0, a, h, v, F, F, CX, CY)


def cahvor(pitch_deg=-10.0, r=(1e-3, -0.08, 0.02)):
    m = base_cahv(pitch_deg)
    o = rot_y(0.5) @ m.A  # optical axis 0.5 deg off the pointing axis
    return CameraModel("CAHVOR", m.C, m.A, m.H, m.V, O=o / np.linalg.norm(o), R=np.array(r))


def grid_pixels(step=64):
    xs, ys = np.meshgrid(np.arange(0, W, step, dtype=float), np.arange(0, H_IMG, step, dtype=float))
    return np.column_stack([xs.ravel(), ys.ravel()])


# --------------------------------------------------------------------------------------------
# Projection KATs
# --------------------------------------------------------------------------------------------

def test_cahv_matches_pinhole_formula():
    m = base_cahv(0.0)
    p = np.array([[10.0, 2.0, -1.0], [5.0, -1.0, 0.3]])
    px = m.project(C0 + p)
    np.testing.assert_allclose(px[:, 0], CX + F * p[:, 1] / p[:, 0], atol=1e-9)
    np.testing.assert_allclose(px[:, 1], CY + F * p[:, 2] / p[:, 0], atol=1e-9)


def test_cahvor_radial_term_known_answer():
    # With O = A, a point at angle t off-axis lands at radius f t (1 + r0 + r1 t^2 + r2 t^4).
    r = np.array([1e-3, -0.08, 0.02])
    m0 = base_cahv(0.0)
    m = CameraModel("CAHVOR", m0.C, m0.A, m0.H, m0.V, O=m0.A.copy(), R=r)
    t = 0.3
    px = m.project(C0 + np.array([[1.0, t, 0.0]]))[0]
    mu = r[0] + r[1] * t**2 + r[2] * t**4
    assert px[0] - CX == pytest.approx(F * t * (1 + mu), abs=1e-9)
    assert px[1] == pytest.approx(CY, abs=1e-9)


def test_cahvor_round_trip_under_half_pixel():
    m = cahvor()
    px = grid_pixels()
    origin, d = m.unproject(px)
    back = m.project(origin + 30.0 * d)
    err = np.hypot(*(back - px).T)
    assert err.max() < 0.5
    assert err.max() < 1e-6  # in practice it is exact to numerical precision


def test_cahvor_point_round_trip_rays_hit_points():
    m = cahvor()
    rng = np.random.default_rng(0)
    pts = m.C + np.column_stack([rng.uniform(5, 50, 200), rng.uniform(-8, 8, 200),
                                 rng.uniform(-6, 6, 200)])
    px = m.project(pts)
    origin, d = m.unproject(px)
    v = pts - origin
    cosang = np.sum(v * d, axis=1) / np.linalg.norm(v, axis=1)
    assert np.all(cosang > math.cos(1e-7))


def test_points_behind_camera_are_nan():
    m = cahvor()
    px = m.project(np.array([m.C - 10.0 * m.A]))
    assert np.all(np.isnan(px))


def test_cahvore_perspective_without_entrance_shift_equals_cahvor():
    m = cahvor()
    e = CameraModel("CAHVORE", m.C, m.A, m.H, m.V, O=m.O, R=m.R, E=np.zeros(3), linearity=1.0)
    pts = m.C + np.array([[10.0, 2.0, -1.0], [5.0, -2.0, 1.5], [20.0, 0.0, 0.0]])
    np.testing.assert_allclose(e.project(pts), m.project(pts), atol=1e-6)


def test_cahvore_fisheye_equidistant_known_answer():
    # L = 0, E = 0, R = 0, O = A: radius = f * theta (equidistant fisheye).
    m0 = base_cahv(0.0)
    e = CameraModel("CAHVORE", m0.C, m0.A, m0.H, m0.V, O=m0.A.copy(), R=np.zeros(3),
                    E=np.zeros(3), linearity=0.0)
    theta = math.radians(40.0)
    px = e.project(C0 + np.array([[math.cos(theta), math.sin(theta), 0.0]]))[0]
    assert px[0] - CX == pytest.approx(F * theta, abs=1e-6)


@pytest.mark.parametrize("linearity", [1.0, 0.5, 0.0, -0.3])
def test_cahvore_round_trip_under_half_pixel(linearity):
    m = cahvor()
    e = CameraModel("CAHVORE", m.C, m.A, m.H, m.V, O=m.O, R=np.array([0.0, -0.02, 0.003]),
                    E=np.array([0.002, 0.01, -0.004]), linearity=linearity)
    px = grid_pixels()
    origin, d = e.unproject(px)
    back = e.project(origin + 25.0 * d)
    assert np.nanmax(np.hypot(*(back - px).T)) < 0.5


def test_parse_cmod_string():
    s = "(1.0,2.0,3.0);(0,0,1);(100,0,500);(0,100,500);(0,0,1);(0.1,0.2,0.3)"
    m = parse_cmod_string(s)
    assert m.kind == "CAHVOR"
    np.testing.assert_allclose(m.C, [1, 2, 3])
    np.testing.assert_allclose(m.R, [0.1, 0.2, 0.3])
    assert parse_cmod_string(";".join(s.split(";")[:4])).kind == "CAHV"


def test_intrinsics_recovered_from_cahv():
    m = base_cahv(-7.0)
    k = m.intrinsics()
    assert k["fx"] == pytest.approx(F)
    assert k["cx"] == pytest.approx(CX)
    assert k["cy"] == pytest.approx(CY)


# --------------------------------------------------------------------------------------------
# Attitude chain
# --------------------------------------------------------------------------------------------

def test_quaternion_identity_and_yaw():
    np.testing.assert_allclose(quat_to_matrix([1, 0, 0, 0]), np.eye(3), atol=1e-12)
    rm = quat_to_matrix(ypr_to_quat(30.0, 0.0, 0.0))
    np.testing.assert_allclose(rm @ [1, 0, 0], [math.cos(math.radians(30)),
                                                 math.sin(math.radians(30)), 0], atol=1e-12)


@pytest.mark.parametrize("ypr", [(30.0, 0.0, 0.0), (-150.0, 4.0, -3.0), (271.0, -12.0, 8.0)])
def test_ypr_round_trip(ypr):
    y, p, r = matrix_to_ypr(quat_to_matrix(ypr_to_quat(*ypr)))
    assert (y - ypr[0]) % 360.0 == pytest.approx(0.0, abs=1e-9) or \
        (y - ypr[0]) % 360.0 == pytest.approx(360.0, abs=1e-9)
    assert p == pytest.approx(ypr[1], abs=1e-9)
    assert r == pytest.approx(ypr[2], abs=1e-9)


def test_pointing_azimuth_follows_yaw_and_pitch():
    az, el = pointing_az_el(np.array([1.0, 0, 0]), ypr_to_quat(30.0, 5.0, 0.0))
    assert az == pytest.approx(30.0)
    assert el == pytest.approx(5.0)
    az, el = pointing_az_el(base_cahv(-10.0).A, ypr_to_quat(200.0, 0.0, 0.0))
    assert az == pytest.approx(200.0)
    assert el == pytest.approx(-10.0)


def test_enu_site_round_trip():
    v = np.array([[1.0, 2.0, 3.0]])
    np.testing.assert_allclose(enu_to_site(v), [[2.0, 1.0, -3.0]])
    np.testing.assert_allclose(site_to_enu(enu_to_site(v)), v)


def test_attitude_chain_round_trip_site_az_el_to_pixels_and_back():
    """Site-frame (az, el) -> rover frame -> CAHVOR pixel -> back to (az, el), tilted rover."""
    from pipeline.horizon.cahvor import pixels_to_az_el, project_az_el

    m = cahvor(pitch_deg=-5.0)
    q = ypr_to_quat(123.0, 7.0, -4.0)
    px = grid_pixels(128)
    az, el = pixels_to_az_el(m, q, px)
    back = project_az_el(m, q, az, el, 1e7)  # far points: the camera offset is negligible
    assert np.nanmax(np.hypot(*(back - px).T)) < 0.5


# --------------------------------------------------------------------------------------------
# Real frames (brief WS3: A-vector azimuth and rover yaw within 1 deg of the label on 3 frames)
# --------------------------------------------------------------------------------------------

# Three NAV_LEFT_B full frames from two drive ends, as returned by the raw-image API after H0
# (WS3 query of sol 4200 at 2026-11-14 ~10:10Z; sol 5073 from D0's raw response
# data/raw/discovery/rawapi_msl_sol5073_NAV_LEFT_B.json). Fields as in docs/discovery.md §3.3.
# Rover yaw/pitch/roll labels: MMGIS MSL_waypoints.json (D0 copy) for the same RMC.
REAL_ITEMS = [
    {"imageid": "NLB_770343787EDR_F1072484NCAM00255M_", "instrument": "NAV_LEFT_B", "sol": 4200,
     "site": 107, "drive": 2484, "camera_model_type": "CAHVOR",
     "camera_model_component_list":
         "(0.852289,0.319831,-1.88711);(0.861523,-0.272506,0.42837);(806.22,1029.51,217.423);"
         "(-67.7024,21.1742,1321.88);(0.861522,-0.272508,0.428371);(0.0,0.00011478,0.00639642)",
     "attitude": "(0.117987,0.110838,-0.0566556,-0.985182)", "subframe_rect": "(1,1,1024,1024)",
     "scale_factor": 1,
     "camera_vector": "(0.8594041342558667,-0.267705945464948,0.4356122826397835)",
     "xyz": "(-104.508,25.6997,-13.481)", "date_taken": "2024-05-30T13:23:48.000Z",
     "https_url": "https://mars.nasa.gov/msl-raw-images/proj/msl/redops/ods/surface/sol/04200/"
                  "opgs/edr/ncam/NLB_770343787EDR_F1072484NCAM00255M_.JPG",
     "extended": {"lmst": "Sol-04200M12:06:44.820", "mast_az": "342.672", "mast_el": "-25.801",
                  "sample_type": "full"}},
    {"imageid": "NLB_770345556EDR_F1072484NCAM00256M_", "instrument": "NAV_LEFT_B", "sol": 4200,
     "site": 107, "drive": 2484, "camera_model_type": "CAHVOR",
     "camera_model_component_list":
         "(0.560687,0.53582,-1.89878);(-0.376355,-0.862424,0.338476);(931.702,-927.043,172.534);"
         "(-24.0018,-52.6588,1322.48);(-0.376357,-0.862423,0.338476);(0.0,0.000112331,0.00639928)",
     "attitude": "(0.117987,0.110838,-0.0566556,-0.985182)", "subframe_rect": "(1,1,1024,1024)",
     "scale_factor": 1,
     "camera_vector": "(-0.37170472721888237,-0.8614290484531315,0.34608610235643483)",
     "xyz": "(-104.508,25.6997,-13.481)", "date_taken": "2024-05-30T13:53:17.000Z",
     "https_url": "https://mars.nasa.gov/msl-raw-images/proj/msl/redops/ods/surface/sol/04200/"
                  "opgs/edr/ncam/NLB_770345556EDR_F1072484NCAM00256M_.JPG",
     "extended": {"lmst": "Sol-04200M12:35:26.384", "mast_az": "246.635", "mast_el": "-20.2247",
                  "sample_type": "full"}},
    {"imageid": "NLB_847852920EDR_F1252490NCAM00282M_", "instrument": "NAV_LEFT_B", "sol": 5073,
     "site": 125, "drive": 2490, "camera_model_type": "CAHVOR",
     "camera_model_component_list":
         "(0.781275,0.802092,-1.93076);(-0.917103,0.391826,0.0733355);(-946.226,-927.548,36.1975);"
         "(-378.439,160.669,1258.38);(-0.917102,0.391828,0.073336);(0.0,0.000119405,0.00639103)",
     "attitude": "(0.0692464,0.105055,-0.0267776,-0.991691)", "subframe_rect": "(1,1,1024,1024)",
     "scale_factor": 1,
     "camera_vector": "(-0.9181436763864114,0.3878351267392882,0.08121640215353779)",
     "xyz": "(-82.2708,45.3949,-14.604)", "date_taken": "2026-11-13T15:55:03.000Z",
     "https_url": "https://mars.nasa.gov/msl-raw-images/proj/msl/redops/ods/surface/sol/05073/"
                  "opgs/edr/ncam/NLB_847852920EDR_F1252490NCAM00282M_.JPG",
     "extended": {"lmst": "Sol-05073M14:34:08.418", "mast_az": "157.077", "mast_el": "-4.63516",
                  "sample_type": "full"}},
]
MMGIS_YPR = {"107_2484": (-165.5, 11.83, 8.09), "125_2490": (-171.6, 11.81, 3.96)}
KAT_TOL_DEG = 1.0  # brief WS3 "Tests": within 1 deg of the image label


def _angdiff(a, b):
    return abs((a - b + 180.0) % 360.0 - 180.0)


def _check_label(rec, mmgis_ypr):
    from pipeline.horizon.navcam import a_vector_rover_az_el, rover_ypr

    a_az, a_el = a_vector_rover_az_el(rec)
    assert _angdiff(a_az, rec["mast_az_deg"]) < KAT_TOL_DEG, rec["image_id"]
    assert abs(a_el - rec["mast_el_deg"]) < KAT_TOL_DEG, rec["image_id"]
    yaw, pitch, roll = rover_ypr(rec)
    assert _angdiff(yaw, mmgis_ypr[0]) < KAT_TOL_DEG, rec["image_id"]
    assert abs(pitch - mmgis_ypr[1]) < KAT_TOL_DEG, rec["image_id"]
    assert abs(roll - mmgis_ypr[2]) < KAT_TOL_DEG, rec["image_id"]


def test_a_vector_azimuth_and_yaw_match_label_on_3_real_frames():
    from pipeline.horizon.navcam import parse_item

    for it in REAL_ITEMS:
        rec = parse_item(it)
        _check_label(rec, MMGIS_YPR[f"{rec['site']}_{rec['drive']}"])


def test_navcam_c_height_on_real_frames_within_discovery_range():
    """Navcam C-vector height above the rover-frame origin (discovery §3.4 range)."""
    from pipeline.horizon.navcam import camera_offset_site, parse_item

    rng = CFG["navcam_api"]["c_height_above_rover_origin_m"]
    for it in REAL_ITEMS:
        h = -camera_offset_site(parse_item(it))[2]
        assert rng["min"] <= h <= rng["max"], it["imageid"]


def test_a_vector_and_yaw_on_3_cached_frames_from_different_stops():
    import json

    path = hcfg.REPO / "data" / "interim" / "horizon" / "navcam_frames.json"
    if not path.exists():
        pytest.skip("navcam cache not present (pipeline host only)")
    frames = json.loads(path.read_text())["frames"]
    by_stop = {}
    for f in frames:
        by_stop.setdefault(f["rmc"], f)
    picks = [by_stop[k] for k in sorted(by_stop)[:3]]
    assert len(picks) == 3
    for f in picks:
        _check_label(f, f["mmgis_yaw_pitch_roll_deg"])


# --------------------------------------------------------------------------------------------
# Raw-image API parsing and frame selection (navcam.py)
# --------------------------------------------------------------------------------------------

def test_parse_item_fields_and_conventions():
    from pipeline.horizon.navcam import parse_item, parse_lmst

    rec = parse_item(REAL_ITEMS[0])
    assert rec["camera_model"]["type"] == "CAHVOR"
    assert rec["camera_model"]["C"] == [0.852289, 0.319831, -1.88711]
    assert rec["attitude_quaternion"][0] == pytest.approx(0.117987)  # w first (discovery §3.3a)
    assert (rec["width"], rec["height"]) == (1024, 1024)
    assert rec["utc"] == "2024-05-30T13:23:48.000Z"
    lm = parse_lmst(rec["lmst"])
    assert lm["sol"] == 4200
    assert lm["hours"] == pytest.approx(12 + 6 / 60 + 44.820 / 3600)
    assert parse_lmst("12:00") is None


def test_parse_item_downsampled_size_and_strict_numbers():
    from pipeline.horizon.navcam import parse_item, parse_tuple, strip_key

    it = dict(REAL_ITEMS[0], scale_factor=4)
    assert (parse_item(it)["width"], parse_item(it)["height"]) == (256, 256)
    with pytest.raises(ValueError):
        parse_tuple("(1.0,2.0);import os")
    bad = dict(REAL_ITEMS[0])
    bad["camera_model_component_list"] = ";".join(bad["camera_model_component_list"]
                                                  .split(";")[:5])
    with pytest.raises(ValueError):
        parse_item(bad)
    with pytest.raises(ValueError):
        parse_item(dict(REAL_ITEMS[0], https_url="https://evil.example/x.JPG"))
    assert "SECRET" not in strip_key("https://api.nasa.gov/x?a=1&api_key=SECRET&b=2")
    assert "SECRET" not in strip_key("https://api.nasa.gov/x?a=1&API_KEY=SECRET")


def test_sky_geometry_known_answer_on_synthetic_camera():
    from pipeline.horizon.navcam import sky_geometry, sky_test

    m = base_cahv(-10.0)  # boresight 10 deg below level, rover level and facing north
    rec = {"camera_model": {"type": "CAHV", "C": m.C.tolist(), "A": m.A.tolist(),
                            "H": m.H.tolist(), "V": m.V.tolist()},
           "attitude_quaternion": [1.0, 0.0, 0.0, 0.0], "width": W, "height": H_IMG,
           "subframe": [1, 1, W, H_IMG]}
    g = sky_geometry(rec)
    half = math.degrees(math.atan(CY / F))
    assert g["el_centre_deg"] == pytest.approx(-10.0, abs=0.01)
    assert g["el_top_deg"] == pytest.approx(-10.0 + half, abs=0.01)
    assert g["el_bottom_deg"] == pytest.approx(-10.0 - half, abs=0.01)
    assert g["az_centre_deg"] == pytest.approx(0.0, abs=1e-6)
    sel = CFG["navcam_selection"]
    ok, _, _ = sky_test(rec, sel)
    assert ok == (g["el_top_deg"] >= sel["top_row_min_el_deg"]
                  and g["el_bottom_deg"] <= sel["bottom_row_max_el_deg"])
    ok, why, _ = sky_test({**rec, "subframe": [257, 1, 512, 512]}, sel)
    assert not ok and "unverified" in why


def test_spread_pick_takes_widest_azimuth_spread():
    from pipeline.horizon.navcam import spread_pick

    cands = [{"image_id": f"f{az}", "geometry": {"az_centre_deg": float(az),
                                                 "el_top_deg": 20.0 if az == 10 else 15.0}}
             for az in (0, 10, 20, 100, 190, 200, 280)]
    got = [c["image_id"] for c in spread_pick(cands, 4)]
    assert got[0] == "f10" and got[1] == "f190"
    assert set(got[2:]) == {"f100", "f280"}
    assert spread_pick([], 4) == []


def test_order_stops_station_first_by_sol_rule_and_spacing():
    from pipeline.horizon.geo import lonlat_to_xy
    from pipeline.horizon.navcam import nearest_sol_rmc, order_stops

    des = [{"rmc": f"1_{i}", "site": 1, "drive": i, "sol": 100 + i // 2,
            "lon": 137.39 + 1e-4 * i, "lat": -4.8} for i in range(10)]  # ~5.9 m apart
    assert nearest_sol_rmc(des, 103) == "1_7"  # two drive ends on sol 103: the last one
    order = order_stops(des, [{"station": "S4", "nearest_sol": 101}], 20.0)
    assert order[0]["rmc"] == "1_3" and order[0]["station"] == "S4"
    assert order[1]["rmc"] == "1_9"  # farthest from 1_3
    assert len(order) == len({o["rmc"] for o in order})
    xy = [lonlat_to_xy(o["lon"], o["lat"]) for o in order]
    for i in range(len(xy)):
        for j in range(i):
            assert math.dist(xy[i], xy[j]) >= 20.0


def test_s4_first_stop_is_the_discovery_drive_end():
    """stations.yaml S4 rule on MMGIS -> 107_2484 (docs/discovery.md §3.2)."""
    from pipeline.horizon.navcam import WAYPOINTS_D0, load_drive_ends, nearest_sol_rmc

    if not WAYPOINTS_D0.exists():
        pytest.skip("D0 MMGIS copy not present (pipeline host only)")
    s4 = CFG["navcam_selection"]["first_stops"][0]
    assert s4["station"] == "S4"
    assert nearest_sol_rmc(load_drive_ends(), s4["nearest_sol"]) == "107_2484"


# --------------------------------------------------------------------------------------------
# Skyline in the image: overlay, sky detector, V2 comparison
# --------------------------------------------------------------------------------------------

def wavy_profile(base=2.0, amp=1.5, dist=5_000.0):
    az = np.arange(0.0, 360.0, CFG["az_step_deg"])
    el = base + amp * np.sin(np.radians(3 * az))
    return HorizonProfile(az_deg=az, elevation_deg=el, distance_m=np.full(az.size, dist),
                          source=["ctx_20m"] * az.size, observer={"x": 0.0, "y": 0.0, "z": 0.0},
                          eye_height_m=CFG["navcam_height_m"], az_step_deg=CFG["az_step_deg"])


def test_skyline_projects_to_expected_row():
    from pipeline.horizon.overlay import skyline_pixels

    m = base_cahv(0.0)
    q = ypr_to_quat(90.0, 0.0, 0.0)  # rover faces east
    flat = wavy_profile(amp=0.0)
    lines = skyline_pixels(flat, m, q, (W, H_IMG))
    pts = np.vstack(lines)
    centre = pts[np.argmin(np.abs(pts[:, 0] - CX))]
    assert centre[1] == pytest.approx(CY - F * math.tan(math.radians(2.0)), abs=0.5)
    assert np.all((pts[:, 0] >= -1) & (pts[:, 0] <= W))


def test_overlay_is_transparent_except_on_the_skyline(tmp_path):
    from pipeline.horizon.overlay import render_overlay, skyline_pixels

    m = base_cahv(0.0)
    q = ypr_to_quat(90.0, 0.0, 0.0)
    lines = skyline_pixels(wavy_profile(amp=0.0), m, q, (W, H_IMG))
    img = render_overlay((W, H_IMG), lines, ticks=[{"x": CX, "label": "S1"}])
    path = tmp_path / "overlay.png"
    img.save(path)
    a = np.asarray(img)
    assert a.shape == (H_IMG, W, 4)
    row = int(round(CY - F * math.tan(math.radians(2.0))))
    assert a[row, 300, 3] > 0
    assert a[row + 40, 300, 3] == 0
    assert tuple(a[row, 300]) == tuple(CFG["overlay"]["line_rgba"])


def synth_frame(m, q, prof, seed=1):
    """Smooth sky above the projected skyline, textured terrain below (uint8)."""
    from pipeline.horizon.overlay import skyline_rows

    rows = skyline_rows(prof, m, q, (W, H_IMG))  # continuous row per column (NaN if none)
    rng = np.random.default_rng(seed)
    yy = np.arange(H_IMG, dtype=float)[:, None]
    sky = 200.0 - 20.0 * yy / H_IMG + rng.normal(0.0, 0.3, (H_IMG, W))
    ground = 100.0 + rng.uniform(-25.0, 25.0, (H_IMG, W))
    img = np.where(yy >= rows[None, :], ground, sky)
    return np.clip(np.round(img), 0, 255).astype(np.uint8), rows


def test_sky_detector_recovers_synthetic_skyline():
    from pipeline.horizon.sky import detect_skyline

    m = cahvor(pitch_deg=0.0)
    q = ypr_to_quat(10.0, 1.0, -2.0)
    img, truth = synth_frame(m, q, wavy_profile())
    det = detect_skyline(img)
    ok = ~np.isnan(truth)
    err = np.abs(det.rows[ok] - truth[ok])
    assert np.mean(err <= 1.0) >= 0.98


def test_v2_comparison_recovers_angles_and_summary():
    from pipeline.horizon.sky import detect_skyline
    from pipeline.validation.v2_skyline import compare_columns, summarise

    m = cahvor(pitch_deg=0.0)
    q = ypr_to_quat(10.0, 1.0, -2.0)
    prof = wavy_profile()
    img, _ = synth_frame(m, q, prof)
    det = detect_skyline(img)
    rec = compare_columns(m, q, prof, det.rows)
    assert len(rec["column"]) > 0.9 * W
    err = np.asarray(rec["error_deg"])
    # one pixel is ~0.046 deg for this camera
    assert np.median(np.abs(err)) < 0.05
    s = summarise([rec])
    assert s["far"]["n"] == len(err) and s["near"]["n"] == 0
    assert s["far"]["p90_abs_deg"] < 0.1


# --------------------------------------------------------------------------------------------
# validation/v2.json writer (contract v2.schema.json)
# --------------------------------------------------------------------------------------------

def _synthetic_frame(i, station=None):
    m = cahvor(pitch_deg=0.0)
    q = ypr_to_quat(10.0 + 30.0 * i, 1.0, -2.0)
    rec = {"image_id": f"SYN_{i:03d}", "sol": 4000 + i, "station": station,
           "stop_id": f"v1_{i}", "attitude_quaternion": q.tolist(),
           "camera_model": {"type": "CAHVOR", "C": m.C.tolist(), "A": m.A.tolist(),
                            "H": m.H.tolist(), "V": m.V.tolist(), "O": m.O.tolist(),
                            "R": m.R.tolist()}}
    return rec, m, q


def test_v2_writer_on_synthetic_frames(tmp_path, monkeypatch):
    import json

    from pipeline.validation.v2_skyline import build_v2, evaluate_frame, write_v2

    monkeypatch.setenv("HOMELINE_MANIFEST_DIR", str(tmp_path / "manifest"))
    n_ok = CFG["v2"]["min_stops"]
    prof = wavy_profile()
    entries = []
    for i in range(n_ok):
        rec, m, q = _synthetic_frame(i, station="S4" if i == 0 else None)
        img, _ = synth_frame(m, q, prof, seed=i)
        entries.append(evaluate_frame(rec, prof, img))
    rec, m, q = _synthetic_frame(98)
    entries.append(evaluate_frame(rec, None, synth_frame(m, q, prof)[0]))   # no horizon
    entries.append(evaluate_frame(_synthetic_frame(99)[0], prof, None))    # no image
    flat = np.full((H_IMG, W), 128, dtype=np.uint8)
    entries.append(evaluate_frame(_synthetic_frame(97)[0], prof, flat))    # no sky boundary
    terrain = np.full((H_IMG, W), 200, dtype=np.uint8)
    terrain[30:, :] = 90                                                   # edge in the ref band
    entries.append(evaluate_frame(_synthetic_frame(96)[0], prof, terrain))
    doc = build_v2(entries)
    assert doc["available"] is True and doc["method"] == "automatic"
    assert doc["n_stops"] == n_ok and doc["n_frames_tried"] == n_ok + 4
    failed = [f for f in doc["frames"] if f["status"] == "failed"]
    assert len(failed) == 4 and all(f["failure"] for f in failed)   # reported, not dropped
    assert any("reference band" in f["failure"] for f in failed)
    assert doc["summary"]["far"]["n"] > 0.9 * W * n_ok
    assert doc["summary"]["far"]["median_abs_deg"] < 0.05
    assert doc["summary"]["near"]["n"] == 0 and doc["summary"]["near"]["median_deg"] is None
    assert sum(f["manual_check"] for f in doc["frames"]) == \
        math.ceil(CFG["v2"]["manual_check_frac"] * len(entries))
    path = write_v2(doc, tmp_path / "v2.json")
    from pipeline.horizon.contracts import validate

    validate(json.loads(path.read_text()), "v2.schema.json")
    frag = {}
    for p in (tmp_path / "manifest").rglob("*.json"):
        frag.update(json.loads(p.read_text()))
    assert frag["v2.far.n"]["value"] == doc["summary"]["far"]["n"]
    assert frag["v2.far.median_abs_deg"]["units"] == "deg"
    # card keys skyline_error_deg.{S}.* are recorded by pipeline/horizon/cards.py (card file)
    assert not any(k.startswith("skyline_error_deg.") for k in frag)
    assert frag["v2.n_stops"]["value"] == n_ok


def test_v2_hand_aligned_and_too_few_stops_are_not_available():
    from pipeline.validation.v2_skyline import build_v2, evaluate_frame

    prof = wavy_profile()
    rec, m, q = _synthetic_frame(0)
    e = evaluate_frame(rec, prof, synth_frame(m, q, prof)[0])
    doc = build_v2([e])  # 1 stop < v2.min_stops
    assert doc["available"] is False and doc["summary"]["far"]["median_abs_deg"] is None
    doc = build_v2([e], hand_aligned=True)
    assert doc["available"] is False and doc["method"] == "hand-aligned"
    doc = build_v2([e], manual={rec["image_id"]: False})
    assert doc["method"] == "automatic+manual_check" and doc["n_stops"] == 0


def test_predicted_skyline_frac_known_answer():
    """Level camera facing east, flat skyline at +2 deg: testable in every column; pitched up
    so the skyline lands in the detector's top reference band: testable in none."""
    from pipeline.horizon.navcam import predicted_skyline_frac

    def rec(pitch):
        m = base_cahv(pitch)
        return {"camera_model": {"type": "CAHV", "C": m.C.tolist(), "A": m.A.tolist(),
                                 "H": m.H.tolist(), "V": m.V.tolist()},
                "attitude_quaternion": ypr_to_quat(90.0, 0.0, 0.0).tolist(),
                "width": W, "height": H_IMG}

    prof = wavy_profile(amp=0.0)
    assert predicted_skyline_frac(rec(0.0), prof) > 0.99
    # skyline row = CY - F tan(2 deg - pitch) < top band (~10 % of rows) for pitch -19 deg
    assert predicted_skyline_frac(rec(-19.0), prof) == 0.0


# --------------------------------------------------------------------------------------------
# D7 preparation: manual-check sheet (does not decide D7)
# --------------------------------------------------------------------------------------------

def _v2_frame(i, status="ok", far=None, sample=False):
    f = {"image_id": f"F{i}", "sol": 4000 + i, "stop_id": f"v1_{i}", "station": None,
         "status": status, "failure": None if status == "ok" else "no clear sky",
         "manual_check": sample, "manual_ok": None}
    if status == "ok":
        f["summary"] = {c: {"n": 0, "median_deg": None, "median_abs_deg": None,
                            "p90_abs_deg": None} for c in ("near", "mid")}
        f["summary"]["far"] = {"n": 100, "median_deg": far, "median_abs_deg": abs(far),
                               "p90_abs_deg": abs(far) + 1}
        f["columns"] = {"el_predicted_deg": [1.0, 1.2], "el_detected_deg": [1.0 + far, 1.2 + far],
                        "distance_class": ["far", "far"], "distance_m": [40000.0, 41000.0],
                        "az_deg": [350.0, 351.0], "error_deg": [far, far]}
    return f


def test_manual_check_rows_cover_sample_and_far_failures():
    from pipeline.validation.v2_skyline import manual_check_rows

    lim = CFG["manual_check_sheet"]["far_fail_abs_deg"]
    doc = {"frames": [_v2_frame(0, far=0.1, sample=True), _v2_frame(1, far=-(lim + 1.0)),
                      _v2_frame(2, far=0.2), _v2_frame(3, status="failed"),
                      _v2_frame(4, far=-(lim + 2.0), sample=True)]}
    rows = manual_check_rows(doc)
    by = {r["image_id"]: r for r in rows}
    assert set(by) == {"F0", "F1", "F3", "F4"}           # F2: ok, not sampled, far fine
    assert by["F0"]["why"] == "sample_20pct"
    assert by["F1"]["why"] == "far_fail"
    assert by["F4"]["why"] == "sample_20pct+far_fail"
    assert by["F3"]["why"] == "frame_failed"
    assert by["F1"]["far_err_median_deg"] == pytest.approx(-(lim + 1.0))
    assert by["F1"]["far_pred_el_median_deg"] == pytest.approx(1.1)
    assert by["F1"]["far_det_el_median_deg"] == pytest.approx(1.1 - (lim + 1.0))
    assert all(r["verdict"] == "" for r in rows)


def _far_note_doc():
    """F1, F2, F4, F5 far-fail (F4 faces east), F0 fine, F3 failed, F6 far-fail but rejected."""
    lim = CFG["manual_check_sheet"]["far_fail_abs_deg"]
    frames = [_v2_frame(0, far=0.1), _v2_frame(1, far=-(lim + 1.0)),
              _v2_frame(2, far=-(lim + 3.0)), _v2_frame(3, status="failed"),
              _v2_frame(4, far=-(lim + 0.5)), _v2_frame(5, far=lim + 0.2),
              _v2_frame(6, far=-(lim + 4.0))]
    frames[2]["columns"]["distance_m"] = [52000.0, 56000.0, 60000.0]   # median 56 km
    frames[2]["columns"]["distance_class"] = ["far", "far", "far"]
    frames[4]["columns"]["distance_m"] = [30000.0, 900.0]              # mid column ignored
    frames[4]["columns"]["distance_class"] = ["far", "mid"]
    frames[6]["manual_ok"] = False
    az = {"F0": 0.0, "F1": 355.0, "F2": 10.0, "F3": 0.0, "F4": 90.0, "F5": None, "F6": 0.0}
    by_id = {k: {"pointing_site": {"az_centre_deg": v}} for k, v in az.items()}
    return {"frames": frames}, by_id


def test_d7_far_note_known_answer():
    """D7 (user 15:01): far-fail count, north-facing count (wrap-around at 0 deg, unknown
    azimuth not counted as north), rim range from per-frame far-column medians, and the
    best-cut evidence counts (<= match_range_km; within match_tol_deg)."""
    from pipeline.validation.v2_skyline import far_note

    nc = CFG["d7_far_note"]
    assert nc["match_range_km"] == 2 and nc["north_half_width_deg"] == 45
    doc, by_id = _far_note_doc()
    cuts = {"F1": (2.0, -0.1), "F2": (2.0, -1.5), "F4": (20.0, 0.05), "F0": (2.0, 0.0)}
    n = far_note(doc, by_id, cuts)
    assert n["status"] == "not_validated" and n["decision"] == nc["decision"]
    assert n["frames"] == ["F1", "F2", "F4", "F5"]       # F0 fine, F3 failed, F6 rejected
    assert n["n_far_fail"] == 4
    assert n["n_far_fail_north"] == 2                    # F1 (355), F2 (10); F4 east; F5 unknown
    assert n["n_far_fail_az_unknown"] == 1
    assert n["rim_dist_km_min"] == pytest.approx(30.0)   # F4's far column only
    assert n["rim_dist_km_max"] == pytest.approx(56.0)   # F2's median
    assert n["n_match_near_terrain"] == 2                # F1, F2 best cut 2 km
    assert n["n_match_near_terrain_within_tol"] == 1     # F1 |-0.1| <= 0.3
    assert n["n_best_cut_unknown"] == 1                  # F5 has no cut result
    assert n["best_cut_range_km_counts"] == {"2": 2, "20": 1}
    for k in ("far_fail_abs_deg", "north_half_width_deg", "match_range_km", "match_tol_deg"):
        assert n[k] == pytest.approx(CFG["manual_check_sheet" if k == "far_fail_abs_deg"
                                         else "d7_far_note"][k])
    empty = far_note({"frames": [_v2_frame(0, far=0.1)]}, by_id, {})
    assert empty["n_far_fail"] == 0 and empty["rim_dist_km_min"] is None


def test_v2_far_note_and_frame_count_keys(tmp_path, monkeypatch):
    """WS5: v2.json carries far_note (validates, open schema) and every number in it, plus
    n_frames_tried / n_frames_ok, has a manifest key."""
    import json

    from pipeline.horizon.contracts import validate
    from pipeline.validation.v2_skyline import far_note, write_v2

    monkeypatch.setenv("HOMELINE_MANIFEST_DIR", str(tmp_path / "manifest"))
    doc, by_id = _far_note_doc()
    doc.update({"summary": {c: {"n": 0, "median_deg": None, "median_abs_deg": None,
                                "p90_abs_deg": None} for c in ("near", "mid", "far")},
                "n_stops": 5, "n_frames_tried": 7, "n_frames_ok": 5})
    doc["far_note"] = far_note(doc, by_id, {"F1": (2.0, -0.1)})
    validate(doc, "v2.schema.json")
    write_v2(doc, tmp_path / "v2.json")
    frag = {}
    for p in (tmp_path / "manifest").rglob("*.json"):
        frag.update(json.loads(p.read_text()))
    assert frag["v2.n_frames_tried"]["value"] == 7 and frag["v2.n_frames_ok"]["value"] == 5
    fn = doc["far_note"]
    for k, units in (("n_far_fail", "1"), ("n_far_fail_north", "1"), ("rim_dist_km_min", "km"),
                     ("rim_dist_km_max", "km"), ("n_match_near_terrain", "1"),
                     ("n_match_near_terrain_within_tol", "1"), ("match_range_km", "km"),
                     ("match_tol_deg", "deg"), ("north_half_width_deg", "deg"),
                     ("far_fail_abs_deg", "deg")):
        e = frag[f"v2.far_note.{k}"]
        assert e["value"] == fn[k] and e["units"] == units and e["file"] == "validation/v2.json"
    assert frag["v2.far_note.best_cut_range_km_counts.2"]["value"] == 1
    assert json.loads((tmp_path / "v2.json").read_text())["far_note"] == fn


def test_card_scope_says_far_not_validated_per_d7():
    from pipeline.horizon.cards import card_fragment

    frag = card_fragment("S4", observer={"id": "S4", "provisional": False},
                         frame={"image_id": "NLB_X", "sol": 4164, "stop_id": "v1_0"},
                         frame_dist_m=128.0, frame_errors={"near": None, "mid": None, "far": 6.5},
                         landmarks=[], landmarks_note=None)
    s = frag["skyline_error_scope"]
    assert "pending" not in s and "manual check" not in s
    assert "far class not validated" in s and "haze" in s


def test_manual_verdicts_import(tmp_path):
    import csv

    from pipeline.validation.v2_skyline import read_manual_verdicts

    p = tmp_path / "sheet.csv"
    with p.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["image_id", "verdict", "note"])
        w.writeheader()
        w.writerows([{"image_id": "A", "verdict": "ok", "note": ""},
                     {"image_id": "B", "verdict": "rim_not_visible", "note": "haze"},
                     {"image_id": "C", "verdict": "", "note": ""}])
    assert read_manual_verdicts(p) == {"A": True, "B": False}
    with p.open("a", newline="") as fh:
        fh.write("D,maybe,\n")
    with pytest.raises(ValueError):
        read_manual_verdicts(p)


def _filled_sheet(path, verdicts, *, delimiter=",", encoding="utf-8"):
    """A synthetic filled manual-check sheet with the real sheet's header (SHEET_FIELDS)."""
    import csv

    from pipeline.validation.v2_skyline import SHEET_FIELDS

    with open(path, "w", newline="", encoding=encoding) as fh:
        w = csv.DictWriter(fh, fieldnames=SHEET_FIELDS, delimiter=delimiter)
        w.writeheader()
        for iid, (verdict, note) in verdicts.items():
            w.writerow({**{k: "" for k in SHEET_FIELDS}, "image_id": iid, "why": "far_fail",
                        "v2_status": "ok", "verdict": verdict, "note": note})
    return path


def test_import_manual_cli_end_to_end(tmp_path, monkeypatch):
    """D7: ``--import-manual <csv>`` on a filled sheet writes manual_checks.json; the next V2 build
    leaves the frames judged other than ok out of the summary (reported, not dropped)."""
    import json

    from pipeline.validation import v2_skyline as v2

    out = tmp_path / "manual_checks.json"
    monkeypatch.setattr(v2, "MANUAL_CHECKS", out)
    sheet = _filled_sheet(tmp_path / "filled.csv", {
        "SYN_000": ("ok", ""), "SYN_001": ("rim_not_visible", "haze, rim hidden"),
        "SYN_002": ("detector_wrong", "caught a near ridge"), "SYN_003": ("unsure", ""),
        "SYN_004": ("", "")})
    assert v2.main(["--import-manual", str(sheet)]) == 0
    verdicts = json.loads(out.read_text())
    assert verdicts == {"SYN_000": True, "SYN_001": False, "SYN_002": False}
    prof = wavy_profile()
    entries = []
    for i in range(CFG["v2"]["min_stops"] + 2):
        rec, m, q = _synthetic_frame(i)
        entries.append(v2.evaluate_frame(rec, prof, synth_frame(m, q, prof, seed=i)[0]))
    doc = v2.build_v2(entries, manual=verdicts)
    by = {f["image_id"]: f for f in doc["frames"]}
    assert doc["method"] == "automatic+manual_check"
    assert doc["n_frames_tried"] == len(entries)                      # nothing dropped
    assert doc["n_frames_ok"] == len(entries) - 2                     # SYN_001, SYN_002 out
    assert by["SYN_001"]["manual_ok"] is False and by["SYN_000"]["manual_ok"] is True
    assert by["SYN_003"]["manual_ok"] is None and by["SYN_004"]["manual_ok"] is None


def test_import_manual_accepts_spreadsheet_exports(tmp_path, monkeypatch):
    """A sheet saved by a spreadsheet app: UTF-8 BOM, ';' delimiter, padded / capitalised
    verdicts. Same verdicts as the plain CSV."""
    import json

    from pipeline.validation import v2_skyline as v2

    monkeypatch.setattr(v2, "MANUAL_CHECKS", tmp_path / "manual_checks.json")
    sheet = _filled_sheet(tmp_path / "excel.csv",
                          {"A": (" OK ", ""), "B": ("Rim_Not_Visible", "x; y"), "C": ("", "")},
                          delimiter=";", encoding="utf-8-sig")
    assert v2.main(["--import-manual", str(sheet)]) == 0
    assert json.loads((tmp_path / "manual_checks.json").read_text()) == {"A": True, "B": False}


def test_import_manual_rejects_bad_sheets_without_writing(tmp_path, monkeypatch, capsys):
    """An unknown verdict, a conflicting duplicate row or a missing column stops the import with
    a message (exit 2) and leaves any previous manual_checks.json untouched."""
    from pipeline.validation import v2_skyline as v2

    out = tmp_path / "manual_checks.json"
    out.write_text('{"OLD": true}')
    monkeypatch.setattr(v2, "MANUAL_CHECKS", out)
    bad = _filled_sheet(tmp_path / "bad.csv", {"A": ("ok", ""), "B": ("maybe", "")})
    assert v2.main(["--import-manual", str(bad)]) == 2
    assert "maybe" in capsys.readouterr().err
    dup = tmp_path / "dup.csv"
    dup.write_text("image_id,verdict,note\nA,ok,\nA,model_wrong,\n")
    assert v2.main(["--import-manual", str(dup)]) == 2
    nocol = tmp_path / "nocol.csv"
    nocol.write_text("image_id,note\nA,\n")
    assert v2.main(["--import-manual", str(nocol)]) == 2
    assert out.read_text() == '{"OLD": true}'


def test_sheet_rewrite_keeps_filled_verdicts(tmp_path):
    """Re-running V2 rewrites the sheet; verdicts and notes already filled in are carried over by
    image_id, and the filled CSV is backed up outside the rewritten folder first."""
    import csv
    import json

    from pipeline.validation.v2_skyline import write_manual_check_sheet

    lim = CFG["manual_check_sheet"]["far_fail_abs_deg"]
    doc = {"frames": [_v2_frame(1, far=-(lim + 1.0)), _v2_frame(3, status="failed")]}
    frames_json = tmp_path / "navcam_frames.json"
    frames_json.write_text(json.dumps({"frames": []}))
    sheet_dir = tmp_path / "manual_check"
    sheet_dir.mkdir()
    _filled_sheet(sheet_dir / "manual_check.csv",
                  {"F1": ("rim_not_visible", "haze"), "F9": ("ok", "gone from the new run")})
    rows = write_manual_check_sheet(doc, frames_json=frames_json, horizons_dir=tmp_path,
                                    out_dir=sheet_dir, engine="unused")
    by = {r["image_id"]: r for r in rows}
    assert by["F1"]["verdict"] == "rim_not_visible" and by["F1"]["note"] == "haze"
    assert by["F3"]["verdict"] == ""
    with (sheet_dir / "manual_check.csv").open(newline="") as fh:
        assert {r["image_id"]: r["verdict"] for r in csv.DictReader(fh)} == \
            {"F1": "rim_not_visible", "F3": ""}
    backups = list((tmp_path / "manual_check_backups").glob("manual_check_*.csv"))
    assert len(backups) == 1 and "F9" in backups[0].read_text()


def test_cut_engine_truncates_sampling_and_cut_error_known_answer():
    from pipeline.horizon.rays import DemBand, HorizonEngine, HorizonProfile
    from pipeline.validation.v2_skyline import best_cut, cut_engine, cut_error

    def plane(src, half, res, z=0.0, wall=None):
        n = int(round(2 * half / res)) + 1
        zz = np.full((n, n), z)
        if wall is not None:  # wall of height wall[1] from x = wall[0] eastwards
            xs = np.arange(n) * res - half
            zz[:, xs >= wall[0]] = wall[1]
        return DemBand.from_transform(src, zz, (-half - res / 2, res, 0, half + res / 2, 0, -res))

    eng = HorizonEngine([plane("ctx_20m", 40_000.0, 20.0, wall=(25_000.0, 2000.0)),
                         plane("mola_hrsc_200m", 90_000.0, 200.0)])
    c = cut_engine(eng, 5000.0)
    assert [s_["to_m"] for s_ in c.cfg["sampling"]] == [2000.0, 5000.0, 5000.0]
    d = np.array(c.horizon(0.0, 0.0, z_obs=1.9).distance_m)
    assert np.nanmax(d) <= 5000.0                # nothing sampled beyond the cut
    # wall at 25 km east: seen with the 30 km cut, not with the 20 km cut
    obs = {"x": 0.0, "y": 0.0, "z": 1.9}
    p30 = cut_engine(eng, 30_000.0).horizon(0.0, 0.0, z_obs=1.9)
    p20 = cut_engine(eng, 20_000.0).horizon(0.0, 0.0, z_obs=1.9)
    i = int(round(90 / CFG["az_step_deg"]))
    assert p30.elevation_deg[i] > 4.0 and p20.elevation_deg[i] < 0.0
    entry = {"columns": {"az_deg": [89.0, 90.0, 91.0],
                         "el_detected_deg": [float(p20.elevation_deg[i])] * 3,
                         "distance_class": ["far"] * 3}}
    km, err, _ = best_cut(entry, eng, obs, 0.25)
    assert km in (2.0, 5.0, 10.0, 20.0) and abs(err) < 0.01
    az = np.arange(1440) * 0.25
    prof = HorizonProfile(az, np.full(1440, 1.0), np.full(1440, 9000.0), ["x"] * 1440,
                          {"x": 0, "y": 0, "z": 0}, 1.9, 0.25)
    entry = {"columns": {"az_deg": [10.0, 20.0, 30.0], "el_detected_deg": [1.5, 1.4, 9.0],
                         "distance_class": ["far", "far", "near"]}}
    assert cut_error(entry, prof) == pytest.approx(0.45)
    assert cut_error({"columns": {}}, prof) is None
