"""WS10 known-answer tests (X8 data probe). Synthetic fixtures only; no network."""

from __future__ import annotations

import math

import pytest

from pipeline.navigation import vo_probe as vp

RULE_TEXT = ">= 2 drives with >= 10 consecutive stereo pairs at <= 2 m spacing, with camera models"
CMOD = (
    "(0.92,0.34,-1.88);(0.88,-0.003,0.47);(27.7,76.4,14.7);(-9.0,0.04,82.0);"
    "(0.88,-0.003,0.47);(0.0,0.0001,0.006)"
)


def _item(cam, sclk, drive, xyz, *, site=125, sample="downsampled", rect="(1,1,256,256)",
           cmod=CMOD, attitude="(0.28,-0.10,0.05,0.95)"):
    side = "L" if cam == "left" else "R"
    return {
        "imageid": f"N{side}B_{int(sclk)}EDR_D{site}{drive:04d}TRAV01529M_",
        "instrument": f"NAV_{cam.upper()}_B",
        "sol": 5070,
        "site": site,
        "drive": drive,
        "spacecraft_clock": float(sclk),
        "subframe_rect": rect,
        "scale_factor": 4,
        "camera_model_type": "CAHVOR" if cmod else None,
        "camera_model_component_list": cmod,
        "attitude": attitude,
        "xyz": f"({xyz[0]},{xyz[1]},{xyz[2]})",
        "camera_vector": "(0.87,0.007,0.49)",
        "https_url": f"https://example.invalid/{side}{int(sclk)}.JPG?api_key=SECRET",
        "extended": {"sample_type": sample},
    }


def _drive_items(n, spacing, *, start_drive=100, step=6, sclk0=1000.0, site=125, **kw):
    """n stereo poses along +x at a fixed spacing (m); returns (left, right)."""
    left, right = [], []
    for k in range(n):
        xyz = (k * spacing, 0.0, 0.0)
        d = start_drive + step * (k + 1)
        for cam, out in (("left", left), ("right", right)):
            out.append(_item(cam, sclk0 + 60 * k, d, xyz, site=site, **kw))
    return left, right


# --- go rule from config ---------------------------------------------------------------------

def test_parse_go_rule_from_config_text():
    r = vp.parse_go_rule(RULE_TEXT)
    assert r == vp.GoRule(min_drives=2, min_run_pairs=10, max_spacing_m=2.0,
                          need_camera_model=True)


def test_parse_go_rule_reads_real_config():
    cfg = vp.load_probe_config()
    assert cfg["drives"] == 5
    assert vp.parse_go_rule(cfg["go_rule"]).min_run_pairs == 10


def test_parse_go_rule_rejects_unknown_text():
    with pytest.raises(ValueError):
        vp.parse_go_rule("go if it looks fine")


# --- parsing helpers -------------------------------------------------------------------------

def test_camera_model_and_attitude_presence():
    assert vp.has_camera_model(_item("left", 1, 1, (0, 0, 0)))
    assert not vp.has_camera_model(_item("left", 1, 1, (0, 0, 0), cmod=None))
    assert not vp.has_camera_model(_item("left", 1, 1, (0, 0, 0), cmod="(1,2);(3)"))
    assert vp.has_attitude(_item("left", 1, 1, (0, 0, 0)))
    assert not vp.has_attitude(_item("left", 1, 1, (0, 0, 0), attitude=None))


def test_frame_px_from_subframe_rect():
    assert vp.frame_px(_item("left", 1, 1, (0, 0, 0))) == (256, 256)
    assert vp.frame_px(_item("left", 1, 1, (0, 0, 0), rect="(1,1,64,64)")) == (64, 64)


def test_strip_api_key():
    url = "https://mars.nasa.gov/api/v1/x/?a=1&api_key=SECRET&b=2"
    assert vp.strip_api_key(url) == "https://mars.nasa.gov/api/v1/x/?a=1&b=2"
    assert "SECRET" not in vp.strip_api_key("https://h/p.JPG?api_key=SECRET")


# --- during-drive selection and pairing ------------------------------------------------------

def test_during_drive_is_strictly_between_drive_ends():
    items = [_item("left", k, d, (0, 0, 0)) for k, d in enumerate([100, 101, 150, 199, 200])]
    got = vp.during_drive(items, prev=(125, 100), end=(125, 200))
    assert [i["drive"] for i in got] == [101, 150, 199]


def test_during_drive_across_site_change():
    a = [_item("left", 1, d, (0, 0, 0), site=124) for d in (2800, 2866, 2900)]
    b = [_item("left", 2, d, (0, 0, 0), site=125) for d in (0, 5, 36)]
    got = vp.during_drive(a + b, prev=(124, 2866), end=(125, 36))
    assert [(i["site"], i["drive"]) for i in got] == [(124, 2900), (125, 0), (125, 5)]


def test_pairing_needs_same_sclk_and_size():
    left, right = _drive_items(3, 1.0)
    right[1]["subframe_rect"] = "(1,1,64,64)"  # same time, different product
    left.append(_item("left", 9999, 999, (9, 9, 9)))  # no right partner
    pairs = vp.pair_frames(left, right)
    assert len(pairs) == 2
    assert all(p.left["spacecraft_clock"] == p.right["spacecraft_clock"] for p in pairs)


def test_resolution_class_uses_api_sample_type():
    th = _item("left", 1, 1, (0, 0, 0), sample="thumbnail", rect="(1,1,64,64)")
    assert vp.resolution_class(th) == "thumbnail"
    assert vp.resolution_class(_item("left", 1, 1, (0, 0, 0))) == "downsampled"


# --- spacing and runs ------------------------------------------------------------------------

def test_spacing_and_median():
    left, right = _drive_items(5, 0.95)
    poses = vp.poses(vp.pair_frames(left, right))
    sp = vp.spacings(poses)
    assert sp == pytest.approx([0.95] * 4)
    assert vp.median_or_none(sp) == pytest.approx(0.95)
    assert vp.median_or_none([]) is None


def test_spacing_is_3d_distance():
    a = vp.Pose(sclk=0, site=1, drive=1, xyz=(0.0, 0.0, 0.0), pairs=[])
    b = vp.Pose(sclk=1, site=1, drive=2, xyz=(1.0, 2.0, 2.0), pairs=[])
    assert vp.spacings([a, b]) == pytest.approx([3.0])


def test_spacing_across_site_change_is_unknown():
    a = vp.Pose(sclk=0, site=124, drive=9, xyz=(0.0, 0.0, 0.0), pairs=[])
    b = vp.Pose(sclk=1, site=125, drive=0, xyz=(0.0, 0.0, 0.0), pairs=[])
    sp = vp.spacings([a, b])
    assert len(sp) == 1 and math.isnan(sp[0])


def test_longest_run_counts_pairs_not_steps():
    assert vp.longest_run([1.0] * 9, 2.0) == 10            # 10 poses, 9 steps
    assert vp.longest_run([1.0, 3.0, 1.0, 1.0], 2.0) == 3   # break at the 3 m step
    assert vp.longest_run([1.0, float("nan"), 1.0], 2.0) == 2
    assert vp.longest_run([], 2.0) == 1                     # one pose is a run of one
    assert vp.longest_run([2.0], 2.0) == 2                  # <= is inclusive


def test_pose_without_camera_model_breaks_run():
    left, right = _drive_items(12, 1.0)
    for it in (left[5], right[5]):
        it["camera_model_component_list"] = None
        it["camera_model_type"] = None
    rule = vp.parse_go_rule(RULE_TEXT)
    s = vp.summarise_class(vp.pair_frames(left, right), rule)
    assert s["pairs"] == 12 and s["pairs_with_camera_model"] == 11
    assert s["longest_run_pairs"] == 6  # poses 6..11


# --- drive summary and decision --------------------------------------------------------------

def _drive(n, spacing, sample="downsampled", rect="(1,1,256,256)"):
    left, right = _drive_items(n, spacing, sample=sample, rect=rect)
    return vp.summarise_drive(left, right, prev=(125, 100), end=(125, 100 + 6 * (n + 1)),
                              sol=5070, rule=vp.parse_go_rule(RULE_TEXT))


def test_drive_summary_contract_fields():
    d = _drive(12, 0.95)
    assert d["stereo_pairs"] == 12
    assert d["median_spacing_m"] == pytest.approx(0.95)
    assert d["has_camera_model"] is True
    assert d["meets_go_rule"] is True
    assert d["by_resolution"]["downsampled"]["frame_px"] == [256, 256]


def test_short_or_sparse_drives_fail():
    assert _drive(9, 0.95)["meets_go_rule"] is False   # 9 pairs < 10
    assert _drive(12, 2.5)["meets_go_rule"] is False   # spacing > 2 m


def test_thumbnails_do_not_count():
    d = _drive(20, 0.95, sample="thumbnail", rect="(1,1,64,64)")
    assert d["stereo_pairs"] == 0
    assert d["median_spacing_m"] is None
    assert d["has_camera_model"] is False
    assert d["meets_go_rule"] is False
    assert d["by_resolution"]["thumbnail"]["longest_run_pairs"] == 20


def test_no_frames_gives_unknown_not_zero_spacing():
    d = vp.summarise_drive([], [], prev=(125, 0), end=(125, 50), sol=5000,
                           rule=vp.parse_go_rule(RULE_TEXT))
    assert d["stereo_pairs"] == 0 and d["median_spacing_m"] is None
    assert d["meets_go_rule"] is False


def test_decision_needs_min_drives():
    rule = vp.parse_go_rule(RULE_TEXT)
    ok, bad = _drive(12, 0.95), _drive(5, 0.95)
    assert vp.decide([ok, bad, bad], rule) == "no-go"
    assert vp.decide([ok, ok, bad], rule) == "go"
    assert vp.decide([], rule) == "no-go"


def test_probe_document_validates_against_contract():
    rule = vp.parse_go_rule(RULE_TEXT)
    doc = vp.build_probe([_drive(12, 0.95), _drive(12, 0.95)], rule, RULE_TEXT, meta={})
    vp.validate_probe(doc)
    assert doc["decision"] == "go"
    assert doc["drives"][0]["drive"] == 100 + 6 * 13




# --- go rule boundaries (nav.yaml vo_probe.go_rule), fresh-run KATs ---------------------------

def test_rule_boundary_exactly_ten_pairs_at_exactly_two_metres_meets():
    assert _drive(10, 2.0)["meets_go_rule"] is True


def test_rule_one_step_over_two_metres_splits_the_run():
    left, right = _drive_items(12, 1.0)
    # Move poses 5.. by +1.01 m: step 4->5 becomes 2.01 m, runs are 5 and 7 poses.
    for it in left[5:] + right[5:]:
        x = float(it["xyz"].strip("()").split(",")[0]) + 1.01
        it["xyz"] = f"({x},0.0,0.0)"
    d = vp.summarise_drive(left, right, prev=(125, 100), end=(125, 100 + 6 * 13), sol=5070,
                           rule=vp.parse_go_rule(RULE_TEXT))
    assert d["by_resolution"]["downsampled"]["longest_run_pairs"] == 7
    assert d["meets_go_rule"] is False


def test_rule_needs_camera_models():
    left, right = _drive_items(12, 0.95, cmod=None)
    d = vp.summarise_drive(left, right, prev=(125, 100), end=(125, 100 + 6 * 13), sol=5070,
                           rule=vp.parse_go_rule(RULE_TEXT))
    assert d["has_camera_model"] is False and d["meets_go_rule"] is False


def test_full_res_pairs_alone_do_not_meet_rule():
    """Discovery: 1-2 full-resolution pairs per drive; far below a 10-pair run."""
    d = _drive(2, 0.95, sample="full", rect="(1,1,1024,1024)")
    assert d["stereo_pairs"] == 2 and d["meets_go_rule"] is False


def test_decision_counts_drives_meeting_the_rule_from_real_config():
    rule = vp.parse_go_rule(vp.load_probe_config()["go_rule"])
    ok, bad = _drive(12, 0.95), _drive(12, 2.5)
    assert vp.decide([ok, bad, bad, bad, bad], rule) == "no-go"
    assert vp.decide([ok, ok, bad, bad, bad], rule) == "go"
    assert vp.decide([ok] * 5, rule) == "go"


# =============================================================================================
# X8 visual odometry (vo.py, brief step 2) — synthetic known-answer tests, no network
# =============================================================================================

import json  # noqa: E402

import numpy as np  # noqa: E402

from pipeline.horizon.cahvor import (  # noqa: E402
    CameraModel,
    cahv_from_intrinsics,
    matrix_to_ypr,
    quat_to_matrix,
    ypr_to_quat,
)
from pipeline.navigation import vo  # noqa: E402

CFG = dict(vo.PENDING_VO_CONFIG)
F_PX, C_PX, N_PX = 305.0, 127.5, 256          # Navcam at 256²: ~45° field of view
EL = np.radians(29.0)                          # mast el -29°, az 90° (looks right and down)
A_DIR = np.array([0.0, np.cos(EL), np.sin(EL)])
H_DIR = np.array([-1.0, 0.0, 0.0])
V_DIR = np.cross(A_DIR, H_DIR)
BASELINE = 0.42


def _rig(r=(0.0, 0.0, 0.0)):
    """Synthetic Navcam stereo pair in the rover frame (left forward of right, 0.42 m)."""
    out = []
    for x in (1.02, 1.02 - BASELINE):
        m = cahv_from_intrinsics([x, 0.675, -1.88], A_DIR, H_DIR, V_DIR, F_PX, F_PX, C_PX, C_PX)
        if any(r):
            m = CameraModel("CAHVOR", m.C, m.A, m.H, m.V, m.A.copy(), np.array(r))
        out.append(m)
    return out


def _points(n=200, seed=1):
    """Random rover-frame points seen by the rig, 2-15 m from the left camera."""
    rng = np.random.default_rng(seed)
    mL, _ = _rig()
    px = rng.uniform(10, N_PX - 10, size=(n, 2))
    o, d = mL.unproject(px)
    return o + rng.uniform(2, 15, size=(n, 1)) * d


def _T(yaw_deg, t):
    return vo.make_T(vo.rot_z_deg(yaw_deg), t)


def test_triangulation_recovers_points_cahv_and_cahvor():
    for r in ((0, 0, 0), (0.0, 0.0001, 0.006)):
        mL, mR = _rig(r)
        X = _points()
        P, err = vo.triangulate(mL, mR, mL.project(X), mR.project(X))
        assert np.max(np.linalg.norm(P - X, axis=1)) < 1e-6
        assert np.max(err) < 1e-6


def test_known_baseline_reproduces_depth():
    """Parallel rig: depth along the boresight = f * b / disparity (scale from stereo)."""
    mL, mR = _rig()
    for z in (2.0, 5.0, 12.0):
        X = mL.C + z * A_DIR + 0.3 * V_DIR
        xl, xr = mL.project(X)[0], mR.project(X)[0]
        disparity = abs(xl[0] - xr[0])
        assert abs(xl[1] - xr[1]) < 1e-9
        assert disparity == pytest.approx(F_PX * BASELINE / z, rel=1e-9)
        P, _ = vo.triangulate(mL, mR, xl[None], xr[None])
        assert (P[0] - mL.C) @ A_DIR == pytest.approx(z, rel=1e-9)


def test_linearised_pinhole_is_exact_for_rays():
    mL, _ = _rig((0.0, 0.0001, 0.006))
    pin = vo.linearise(mL)
    X = _points()
    u = vo.rays_to_linear_px(mL, pin, mL.project(X))
    xc = (X - pin.C) @ pin.Rc.T
    expect = (pin.K @ (xc / xc[:, 2:3]).T).T[:, :2]
    assert np.max(np.abs(u - expect)) < 1e-6
    mC, _ = _rig()  # CAHV: linearised pixels = pixels
    assert np.max(np.abs(vo.rays_to_linear_px(mC, vo.linearise(mC), mC.project(X))
                         - mC.project(X))) < 1e-6


def _observe(X, T_next_prev, model):
    Xn = (T_next_prev[:3, :3] @ X.T).T + T_next_prev[:3, 3]
    return model.project(Xn)


def test_zero_motion_from_same_pose():
    mL, _ = _rig((0.0, 0.0001, 0.006))
    X = _points()
    mo = vo.motion_from_points(X, mL.project(X), mL, CFG)
    assert mo.ok
    assert np.linalg.norm(mo.T_next_prev[:3, 3]) < 1e-6
    assert vo.rot_angle_deg(mo.T_next_prev[:3, :3]) < 1e-6


def test_known_motion_recovered_with_outliers_and_noise():
    """1 m forward, 4° yaw: exact without noise; RANSAC rejects 30 % gross outliers."""
    mL, _ = _rig((0.0, 0.0001, 0.006))
    X = _points(300)
    T_world_next = _T(4.0, [1.0, 0.05, 0.0])          # rover(k+1) in rover(k)
    T = vo.inv_T(T_world_next)                         # maps rover(k) -> rover(k+1)
    px = _observe(X, T, mL)
    rng = np.random.default_rng(7)
    out = rng.random(len(px)) < 0.3
    px[out] += rng.uniform(-60, 60, size=(out.sum(), 2))
    px[~out] += rng.normal(0, 0.2, size=((~out).sum(), 2))
    mo = vo.motion_from_points(X, px, mL, CFG)
    assert mo.ok
    est = vo.inv_T(mo.T_next_prev)
    assert np.linalg.norm(est[:3, 3] - T_world_next[:3, 3]) < 0.02
    assert vo.rot_angle_deg(est[:3, :3].T @ T_world_next[:3, :3]) < 0.2
    assert mo.n_inliers <= (~out).sum() + 5


def test_motion_scale_comes_from_stereo():
    """Stereo-triangulated (noisy) points give metric translation, not up-to-scale."""
    mL, mR = _rig()
    X = _points(300, seed=3)
    rng = np.random.default_rng(3)
    pl = mL.project(X) + rng.normal(0, 0.15, (len(X), 2))
    pr = mR.project(X) + rng.normal(0, 0.15, (len(X), 2))
    P, err = vo.triangulate(mL, mR, pl, pr)
    keep = err < CFG["max_reproj_px"]
    T_world_next = _T(0.0, [1.0, 0.0, 0.0])
    px = _observe(X[keep], vo.inv_T(T_world_next), mL) + rng.normal(0, 0.15, (keep.sum(), 2))
    mo = vo.motion_from_points(P[keep], px, mL, CFG)
    assert mo.ok
    assert np.linalg.norm(vo.inv_T(mo.T_next_prev)[:3, 3]) == pytest.approx(1.0, abs=0.03)


def test_too_few_points_fails_cleanly():
    mL, _ = _rig()
    X = _points(5)
    mo = vo.motion_from_points(X, mL.project(X), mL, CFG)
    assert not mo.ok and mo.T_next_prev is None and "matches" in mo.reason


def test_implausible_step_is_rejected():
    mL, _ = _rig()
    X = _points(200)
    T_world_next = _T(0.0, [CFG["max_step_m"] + 1.0, 0.0, 0.0])
    X = X + [CFG["max_step_m"] + 6.0, 0, 0]   # keep the points in view after the jump
    mo = vo.motion_from_points(X, _observe(X, vo.inv_T(T_world_next), mL), mL, CFG)
    assert not mo.ok and "implausible" in mo.reason


# --- image level: rendered textured ground -------------------------------------------------

_TEX_RES = 0.01   # m per texture pixel
_TEX_ORIGIN = np.array([-12.0, -4.0])


def _texture(seed=11, n=2600):
    import cv2

    rng = np.random.default_rng(seed)
    tex = np.zeros((n, n), np.float32)
    for sigma, w in ((1.5, 0.6), (4, 1.0), (12, 1.5), (40, 1.5)):
        tex += w * cv2.GaussianBlur(rng.normal(0, 1, (n, n)).astype(np.float32), (0, 0), sigma)
    tex = (tex - tex.min()) / (tex.max() - tex.min())
    return tex * 255.0


def _render(model, T_world_rover, tex):
    """Ground plane z = 0 (world NED, rover origin on the ground) seen by ``model``."""
    import cv2

    u, v = np.meshgrid(np.arange(N_PX, dtype=float), np.arange(N_PX, dtype=float))
    o, d = model.unproject(np.column_stack([u.ravel(), v.ravel()]))
    R, t = T_world_rover[:3, :3], T_world_rover[:3, 3]
    ow, dw = o @ R.T + t, d @ R.T
    s = -ow[:, 2] / dw[:, 2]
    P = ow + s[:, None] * dw
    mx = ((P[:, 1] - _TEX_ORIGIN[1]) / _TEX_RES).reshape(N_PX, N_PX).astype(np.float32)
    my = ((P[:, 0] - _TEX_ORIGIN[0]) / _TEX_RES).reshape(N_PX, N_PX).astype(np.float32)
    img = cv2.remap(tex, mx, my, cv2.INTER_LINEAR, borderValue=0)
    return np.clip(img, 0, 255).astype(np.uint8)


@pytest.fixture(scope="module")
def tex():
    return _texture()


def _stereo(T_world_rover, tex):
    mL, mR = _rig((0.0, 0.0001, 0.006))
    return vo.stereo_frame(_render(mL, T_world_rover, tex), _render(mR, T_world_rover, tex),
                           mL, mR, CFG)


def test_images_same_pose_give_zero_motion(tex):
    a = _stereo(np.eye(4), tex)
    assert a.n_stereo > 50
    mo = vo.vo_step(a, a, CFG)
    assert mo.ok
    assert np.linalg.norm(mo.T_next_prev[:3, 3]) < 0.005
    assert vo.rot_angle_deg(mo.T_next_prev[:3, :3]) < 0.05


def test_images_known_step_recovered(tex):
    """Rendered 256² stereo: 0.95 m forward + 3° yaw (the drive's median spacing)."""
    T1 = _T(3.0, [0.95, 0.0, 0.0])
    a, b = _stereo(np.eye(4), tex), _stereo(T1, tex)
    mo = vo.vo_step(a, b, CFG)
    assert mo.ok, mo.reason
    est = vo.inv_T(mo.T_next_prev)
    assert np.linalg.norm(est[:3, 3] - T1[:3, 3]) < 0.03
    assert abs(vo.wrap_deg(matrix_to_ypr(est[:3, :3])[0] - 3.0)) < 0.3


# --- chain, truth frame, drive record --------------------------------------------------------

def test_accumulate_and_endpoint_metrics():
    steps = [vo.inv_T(_T(90.0, [1.0, 0.0, 0.0])), vo.inv_T(_T(0.0, [1.0, 0.0, 0.0]))]
    poses = vo.accumulate(np.eye(4), steps)
    assert np.allclose(poses[-1][:3, 3], [1.0, 1.0, 0.0])
    m = vo.endpoint_metrics(poses[-1], _T(80.0, [1.0, 1.0, 0.0]), 2.0)
    assert m["endpoint_error_m"] == pytest.approx(0.0, abs=1e-9)
    assert m["heading_drift_deg"] == pytest.approx(10.0)
    assert vo.wrap_deg(350.0 - 10.0) == pytest.approx(-20.0)


def test_local_ned_on_the_sphere():
    r = 3396190.0
    n = vo.local_ned(-4.8, 137.39, 0.0, -4.8 + 1e-3, 137.39, 2.0, r)
    assert n[0] == pytest.approx(r * np.radians(1e-3)) and n[1] == 0 and n[2] == -2.0
    e = vo.local_ned(0.0, 137.0, 0.0, 0.0, 137.0 + 1e-3, 0.0, r)
    assert e[1] == pytest.approx(r * np.radians(1e-3))


def test_scale_error():
    assert vo.scale_error([10.3, 0.0], [10.0, 0.0]) == pytest.approx(0.03)
    assert vo.scale_error([10.0, 5.0], [10.0, 0.0]) == pytest.approx(0.0)


def _q_str(yaw):
    return "({},{},{},{})".format(*ypr_to_quat(yaw, 0.0, 0.0))


def _vo_items(n, step=1.0, yaw=30.0, site=125, d0=100):
    """n poses along heading ``yaw`` (site frame), TRAV 256² pairs with camera models."""
    mL, mR = _rig()
    cm = {k: ";".join("({},{},{})".format(*getattr(m, x)) for x in "CAHV")
          for k, m in (("L", mL), ("R", mR))}
    h = np.radians(yaw)
    left, right = [], []
    for k in range(n):
        p = (k * step * np.cos(h), k * step * np.sin(h), 0.0)
        for side, out in (("L", left), ("R", right)):
            out.append({
                "imageid": f"N{side}B_{1000 + k}EDR_D{site}{d0 + 6 * k:04d}TRAV01528M_",
                "site": site, "drive": d0 + 6 * k, "spacecraft_clock": 1000.0 + 60 * k,
                "subframe_rect": "(1,1,256,256)", "scale_factor": 4,
                "camera_model_type": "CAHV", "camera_model_component_list": cm[side],
                "attitude": _q_str(yaw), "xyz": "({},{},{})".format(*p),
                "extended": {"sample_type": "downsampled", "mast_az": "90.0",
                             "mast_el": "-28.7"},
                "https_url": f"https://example.invalid/{side}{k}.JPG"})
    return left, right


def _mmgis(n, step, yaw, r=3396190.0):
    lat0, lon0 = -4.8, 137.39
    d = (n - 1) * step
    dn, de = d * np.cos(np.radians(yaw)), d * np.sin(np.radians(yaw))
    prev = {"lat": lat0, "lon": lon0, "elev_geoid": -3480.0, "yaw": yaw, "pitch": 0.0,
            "roll": 0.0, "dist_m": 5.0}
    end = {"lat": lat0 + np.degrees(dn / r),
           "lon": lon0 + np.degrees(de / (r * np.cos(np.radians(lat0)))),
           "elev_geoid": -3480.0, "yaw": yaw, "pitch": 0.0, "roll": 0.0, "dist_m": d}
    return prev, end


def test_failed_vo_steps_are_bridged_and_counted():
    """No images -> every step bridged with the onboard pose; nothing is invented."""
    left, right = _vo_items(12, 1.0, 30.0)
    prev, end = _mmgis(12, 1.0, 30.0)
    spec = {"sol": 5069, "prev": (125, 100), "end": (125, 100 + 6 * 11)}
    rec = vo.run_drive(spec, left, right, prev, end, lambda it: None, CFG, 3396190.0)
    assert rec["status"] == "ok"
    assert rec["n_steps"] == 11 and rec["n_steps_vo"] == 0 and rec["n_steps_failed"] == 11
    assert rec["bridged_m"] == pytest.approx(11.0, abs=1e-6)
    assert rec["endpoint_error_m"] == pytest.approx(0.0, abs=0.01)
    assert rec["heading_drift_deg"] == pytest.approx(0.0, abs=1e-6)
    assert len(rec["failures"]) == 11
    assert vo.drive_checks(rec, CFG)["pass"] is False   # bridged steps are not VO


def test_off_pointing_and_non_trav_pairs_are_dropped():
    left, right = _vo_items(5)
    left[2]["extended"] = dict(left[2]["extended"], mast_az="200.0")
    right[2]["extended"] = dict(right[2]["extended"], mast_az="200.0")
    left[3]["imageid"] = left[3]["imageid"].replace("TRAV", "NCAM")
    pairs, st = vo.drive_poses(left, right, (125, 100), (125, 124), CFG)
    assert st["dropped_pointing"] == 1 and st["poses"] == 3
    assert st["has_start_pair"] and st["has_end_pair"]


def test_drive_without_pairs_is_listed_with_nulls():
    left, right = _vo_items(3)
    for it in left + right:
        it["extended"]["sample_type"] = "thumbnail"
    prev, end = _mmgis(3, 1.0, 30.0)
    spec = {"sol": 5073, "prev": (125, 100), "end": (125, 112)}
    rec = vo.run_drive(spec, left, right, prev, end, lambda it: None, CFG, 3396190.0)
    assert rec["status"] == "no_data"
    assert rec["endpoint_error_m"] is None and rec["drift_pct"] is None
    rows = vo.drift_rows([rec, {**rec, "sol": 5069, "status": "ok", "endpoint_error_m": 1.0,
                                "drift_pct": 1.0, "heading_drift_deg": 0.5}])
    assert [r["sol"] for r in rows] == [5073, 5069]     # every drive tried is listed
    assert all(r["label"] == "rover analogue: a rover is not an astronaut" for r in rows)
    vo.validate_drift(rows)
    json.dumps(rows)


def test_drive_checks_thresholds():
    ok = {"status": "ok", "drift_pct": 2.0, "heading_drift_deg": -1.0, "vo_step_fraction": 0.95}
    assert vo.drive_checks(ok, CFG)["pass"] is True
    assert vo.drive_checks({**ok, "drift_pct": 25.0}, CFG)["pass"] is False
    assert vo.drive_checks({**ok, "heading_drift_deg": -25.0}, CFG)["pass"] is False
    assert vo.drive_checks({**ok, "vo_step_fraction": 0.5}, CFG)["pass"] is False
    assert vo.drive_checks({"status": "failed"}, CFG)["pass"] is False


def test_stop_rule_needs_min_drives_passing():
    ok = {"status": "ok", "drift_pct": 2.0, "heading_drift_deg": -1.0, "vo_step_fraction": 0.95}
    bad = {**ok, "drift_pct": 40.0}
    assert vo.stop_rule([ok, ok, bad], CFG, min_drives=2)["verdict"] == "plausible"
    assert vo.stop_rule([ok, bad, bad], CFG, min_drives=2)["verdict"] == "cut X8"
    assert vo.stop_rule([], CFG, min_drives=2)["verdict"] == "cut X8"
    r = vo.stop_rule([ok, bad], CFG, min_drives=1)
    assert r["drives_passing"] == 1 and r["drives_tried"] == 2


def test_per_pose_attitude_comparison():
    """VO chain identical to the onboard chain -> zero per-pose heading / position errors."""
    ob = [_T(10.0 * k, [float(k), 0.5 * k, 0.0]) for k in range(5)]
    vo_poses = [vo.inv_T(ob[0]) @ T for T in ob]
    c = vo.per_pose_vs_onboard(vo_poses, ob)
    assert c["heading_rms_deg"] == pytest.approx(0.0, abs=1e-9)
    assert c["position_max_m"] == pytest.approx(0.0, abs=1e-9)
    bent = [T @ vo.make_T(vo.rot_z_deg(2.0), [0, 0, 0]) for T in vo_poses]
    c = vo.per_pose_vs_onboard(bent, ob)
    assert c["heading_max_abs_deg"] == pytest.approx(2.0, abs=1e-6)
    assert c["n_poses"] == 5


def test_calibrated_set_from_drives():
    recs = [{"status": "ok", "duration_h": 2.0, "heading_drift_deg": 2.0, "scale_error": 0.03},
            {"status": "ok", "duration_h": 1.0, "heading_drift_deg": -1.0, "scale_error": -0.04},
            {"status": "no_data"}]
    cs = vo.calibrated_set(recs)
    assert cs["n_drives"] == 2
    assert cs["sigma_s"] == pytest.approx(np.sqrt((0.03**2 + 0.04**2) / 2), abs=1e-4)
    assert cs["sigma_b_deg_h"] == pytest.approx(1.0)
    assert cs["psi0_deg"] is None and "rover is not an astronaut" in cs["label"]


def test_vo_config_falls_back_to_pending(tmp_path):
    (tmp_path / "nav.yaml").write_text("vo_probe: {drives: 5}\n")
    cfg, src = vo.load_vo_config(tmp_path)
    assert cfg is vo.PENDING_VO_CONFIG and "pending" in src
    (tmp_path / "nav.yaml").write_text("vo: {ratio_test: 0.7}\n")
    cfg, src = vo.load_vo_config(tmp_path)
    assert cfg == {"ratio_test": 0.7} and src == "config/nav.yaml vo"


def test_quat_helpers_agree_with_cahvor():
    R = quat_to_matrix(ypr_to_quat(30.0, 2.0, -1.0))
    assert matrix_to_ypr(R)[0] == pytest.approx(30.0)
