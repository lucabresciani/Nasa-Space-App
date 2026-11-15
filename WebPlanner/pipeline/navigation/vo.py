"""WS10 X8: stereo visual odometry on Curiosity's 256 x 256 drive Navcam pairs (SPEC §2.4 X8).

D16 (fresh run, 2026-11-14 11:24 CET, user for N): go at 256² only; stop rule: cut X8 if VO is
not plausible by H8 (Sat 14 Nov 17:00 CET). "Plausible" (assumed, proposal for N): at least
``go_rule.min_drives`` (nav.yaml ``vo_probe.go_rule``, 2) drives pass the per-drive checks in
``plausible`` (drift %, heading drift, fraction of steps measured by VO, not bridged).

Method (brief WS10 step 2):
1. Per pose (one Navcam L/R pair taken during the drive, plus the pairs at the previous and the
   current drive end when they exist): SIFT features in both frames, L-R matching with a ratio
   test, triangulation with the frames' own CAHVOR models (rays from ``cahvor.unproject``,
   midpoint of closest approach), kept when both reprojections are within ``max_reproj_px``.
2. Frame to frame: left(k) features with a 3-D point matched to left(k+1); motion by PnP + RANSAC
   on a *linearised* left(k+1) camera: every CAHVOR ray is re-expressed as a pixel of a virtual
   pinhole (CAHV intrinsics, orthonormalised H/V/A axes), which is exact for ray directions, so
   PnP needs no distortion model; then Levenberg-Marquardt refinement on the inliers.
3. Accumulate the rover pose along the drive. A step that fails (too few inliers, implausible
   step) is *bridged* with the rover's own onboard relative pose (API ``xyz`` + ``attitude``)
   and counted as failed; bridged metres are reported. A missing end-of-drive pair is bridged
   the same way.
4. Compare the end pose with MMGIS: start from the MMGIS start position + attitude (yaw, pitch,
   roll), end error = horizontal distance to the MMGIS drive end, heading drift = VO yaw - MMGIS
   yaw. **MMGIS drive ends are Curiosity's own localisation** (onboard wheel + IMU + visual
   odometry, with ground updates), not independent truth; the onboard chain is reported
   alongside so the reader sees how close MMGIS and onboard are. Per pose, the VO pose is also
   compared with the rover's own per-pose attitude and position (heading RMS / max, position max).

Frames (``pipeline/horizon/cahvor.py``, discovery §3.3): CAHVOR in the rover frame (+X forward,
+Y right, +Z down); ``attitude`` (w, x, y, z) rotates rover vectors into the site frame
(N, E, D); ``xyz`` = rover position in the site frame (m).

Constants: proposed ``config/nav.yaml`` ``vo:`` block (WS9 owns nav.yaml). Until it lands they
come from ``PENDING_VO_CONFIG`` below; outputs say which source was used.

Usage: ``uv run --no-sync python -m pipeline.navigation.vo [--offline] [--sol 5069 ...]``
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

import numpy as np
import yaml
from jsonschema import Draft202012Validator

from pipeline.horizon.cahvor import (
    CameraModel,
    matrix_to_ypr,
    parse_cmod_string,
    quat_to_matrix,
    ypr_to_quat,
)
from pipeline.navigation import vo_probe as vp

REPO = Path(__file__).resolve().parents[2]
CONFIG = REPO / "config"
CONTRACT = REPO / "contracts" / "vo_drift.schema.json"
RAW_DIR = REPO / "data" / "raw" / "vo"
OUT_DIR = REPO / "data" / "interim" / "vo"
PROBE = OUT_DIR / "probe.json"
WEB_PATH = "vo/drift.json"  # path under web/public/data/ (make web copies it)

# PENDING: proposed nav.yaml block (owner WS9), written verbatim under STATUS.md WS10 "Blocked".
# All assumed; X8-internal (they never reach the F21 model directly).
PENDING_VO_CONFIG: dict = {
    "resolution": "downsampled",      # D16: the 256 x 256 drive frames
    "sequence_tag": "TRAV",           # imageid tag of Curiosity's drive (VO) frames
    "pointing_tol_deg": 5.0,          # drop pairs whose mast az/el differ from the run's median
    "sift_nfeatures": 0,              # 0 = OpenCV default (no cap)
    "ratio_test": 0.8,                # Lowe ratio, L-R and frame-to-frame
    "max_reproj_px": 1.0,             # stereo: both CAHVOR reprojections within this
    "min_range_m": 0.5,
    "max_range_m": 25.0,              # 256² depth error ~ Z^2/(f b) * 0.25 px = 0.8 m at 25 m
    "pnp_reproj_px": 1.5,             # RANSAC threshold on the linearised left(k+1) pixels
    "pnp_iterations": 2000,
    "pnp_confidence": 0.999,
    "min_inliers": 15,
    "max_step_m": 3.0,                # a VO step longer than this is rejected (poses ~1 m apart)
    "max_step_deg": 45.0,             # a VO step rotating more than this is rejected
    "plausible": {                    # stop-rule per-drive checks (D16), proposal for N
        "max_drift_pct": 10.0,        # MER/MSL VO design requirement: 10 % of distance
        "max_heading_drift_deg": 10.0,
        "min_vo_step_fraction": 0.8,  # at least 80 % of the steps measured by VO, not bridged
    },
}
STOP_RULE_DEADLINE_LOCAL = "2026-11-14 17:00 CET (H8)"
LABEL = "rover analogue: a rover is not an astronaut"


def load_vo_config(config_dir: Path = CONFIG) -> tuple[dict, str]:
    """nav.yaml ``vo`` if WS9 has added it, else the pending block above."""
    nav = yaml.safe_load((config_dir / "nav.yaml").read_text())
    if isinstance(nav.get("vo"), dict):
        return nav["vo"], "config/nav.yaml vo"
    return PENDING_VO_CONFIG, "pipeline/navigation/vo.py PENDING_VO_CONFIG (nav.yaml vo pending)"


def load_mars_radius(config_dir: Path = CONFIG) -> float:
    return float(yaml.safe_load((config_dir / "site.yaml").read_text())["crs"]["mars_radius_m"])


# ---------------------------------------------------------------------------------------------
# Rigid transforms (4 x 4): T_a_b maps b-frame coordinates into frame a
# ---------------------------------------------------------------------------------------------

def make_T(R, t) -> np.ndarray:
    T = np.eye(4)
    T[:3, :3] = np.asarray(R, dtype=float)
    T[:3, 3] = np.asarray(t, dtype=float)
    return T


def inv_T(T) -> np.ndarray:
    R, t = T[:3, :3], T[:3, 3]
    return make_T(R.T, -R.T @ t)


def rot_angle_deg(R) -> float:
    c = (np.trace(R) - 1.0) / 2.0
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def wrap_deg(a: float) -> float:
    return (a + 180.0) % 360.0 - 180.0


def rot_z_deg(deg: float) -> np.ndarray:
    a = math.radians(deg)
    return np.array([[math.cos(a), -math.sin(a), 0], [math.sin(a), math.cos(a), 0], [0, 0, 1]])


# ---------------------------------------------------------------------------------------------
# Camera geometry: CAHVOR stereo triangulation, linearised pinhole
# ---------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Pinhole:
    """Virtual pinhole sharing a CAHV(OR) camera's centre: x_c = Rc (P - C), px = K x_c / z."""
    K: np.ndarray
    Rc: np.ndarray
    C: np.ndarray


def linearise(model: CameraModel) -> Pinhole:
    i = model.intrinsics()
    a = model.A / np.linalg.norm(model.A)
    h = (model.H - i["cx"] * a) / i["fx"]
    h = h - (h @ a) * a
    h /= np.linalg.norm(h)
    v = np.cross(a, h)  # image-down completes a right-handed (h, v, a) basis
    if v @ (model.V - i["cy"] * a) < 0:
        v = -v
    K = np.array([[i["fx"], 0, i["cx"]], [0, i["fy"], i["cy"]], [0, 0, 1.0]])
    return Pinhole(K, np.vstack([h, v, a]), np.asarray(model.C, dtype=float))


def rays_to_linear_px(model: CameraModel, pin: Pinhole, px) -> np.ndarray:
    """CAHVOR pixels -> pixels of the virtual pinhole along the same rays (N, 2)."""
    _, d = model.unproject(px)
    xc = d @ pin.Rc.T
    return (xc[:, :2] / xc[:, 2:3]) * [pin.K[0, 0], pin.K[1, 1]] + [pin.K[0, 2], pin.K[1, 2]]


def triangulate(mL: CameraModel, mR: CameraModel, pxL, pxR) -> tuple[np.ndarray, np.ndarray]:
    """Midpoint triangulation of CAHVOR rays -> (points (N, 3), max reprojection error (N,))."""
    oL, dL = mL.unproject(pxL)
    oR, dR = mR.unproject(pxR)
    w = oL - oR
    b = np.sum(dL * dR, axis=1)
    d_ = np.sum(dL * w, axis=1)
    e = np.sum(dR * w, axis=1)
    den = 1.0 - b * b
    with np.errstate(divide="ignore", invalid="ignore"):
        s = (b * e - d_) / den
        u = (e - b * d_) / den
    P = 0.5 * ((oL + s[:, None] * dL) + (oR + u[:, None] * dR))
    bad = ~(den > 1e-12) | ~(s > 0) | ~(u > 0)
    P[bad] = np.nan
    eL = np.linalg.norm(mL.project(P) - np.atleast_2d(pxL), axis=1)
    eR = np.linalg.norm(mR.project(P) - np.atleast_2d(pxR), axis=1)
    err = np.fmax(eL, eR)
    err[bad | ~np.isfinite(err)] = np.inf
    return P, err


# ---------------------------------------------------------------------------------------------
# Features and per-step motion
# ---------------------------------------------------------------------------------------------

def _cv2():
    import cv2

    return cv2


def detect(img: np.ndarray, cfg: dict):
    cv2 = _cv2()
    sift = cv2.SIFT_create(nfeatures=int(cfg["sift_nfeatures"]))
    kp, des = sift.detectAndCompute(img, None)
    pts = np.float64([k.pt for k in kp]).reshape(-1, 2)
    return pts, des


def ratio_match(da, db, ratio: float) -> list[tuple[int, int]]:
    """Mutual nearest neighbours that pass Lowe's ratio test (both directions)."""
    if da is None or db is None or len(da) < 2 or len(db) < 2:
        return []
    cv2 = _cv2()
    bf = cv2.BFMatcher(cv2.NORM_L2)
    fwd = {m[0].queryIdx: m[0].trainIdx for m in bf.knnMatch(da, db, k=2)
           if len(m) == 2 and m[0].distance < ratio * m[1].distance}
    bwd = {m[0].queryIdx: m[0].trainIdx for m in bf.knnMatch(db, da, k=2)
           if len(m) == 2 and m[0].distance < ratio * m[1].distance}
    return [(a, b) for a, b in fwd.items() if bwd.get(b) == a]


@dataclass
class StereoFrame:
    """One pose: left features, their 3-D points (rover frame, NaN if none), models."""
    pts: np.ndarray
    des: np.ndarray | None
    X: np.ndarray
    mL: CameraModel
    mR: CameraModel
    n_stereo: int


def stereo_frame(imgL, imgR, mL: CameraModel, mR: CameraModel, cfg: dict) -> StereoFrame:
    pL, dL = detect(imgL, cfg)
    pR, dR = detect(imgR, cfg)
    X = np.full((len(pL), 3), np.nan)
    m = ratio_match(dL, dR, float(cfg["ratio_test"]))
    if m:
        ia, ib = np.array(m).T
        P, err = triangulate(mL, mR, pL[ia], pR[ib])
        rng = np.linalg.norm(P - mL.C, axis=1)
        ok = (err <= float(cfg["max_reproj_px"])) & (rng >= float(cfg["min_range_m"])) & (
            rng <= float(cfg["max_range_m"]))
        X[ia[ok]] = P[ok]
    return StereoFrame(pL, dL, X, mL, mR, int(np.isfinite(X[:, 0]).sum()))


@dataclass
class Motion:
    ok: bool
    T_next_prev: np.ndarray | None  # maps rover(k) coordinates into rover(k+1)
    n_matches: int
    n_inliers: int
    reason: str = ""


def motion_from_points(X, px_next, model_next: CameraModel, cfg: dict,
                       seed: int = 0) -> Motion:
    """PnP + RANSAC on the linearised next-left camera; X in rover(k), px in left(k+1)."""
    cv2 = _cv2()
    X = np.asarray(X, dtype=float)
    n = len(X)
    if n < max(6, int(cfg["min_inliers"])):
        return Motion(False, None, n, 0, f"only {n} 3-D/2-D matches")
    pin = linearise(model_next)
    u = rays_to_linear_px(model_next, pin, px_next)
    good = np.all(np.isfinite(u), axis=1)
    X, u = X[good], u[good]
    cv2.setRNGSeed(seed)
    ok, rvec, tvec, inl = cv2.solvePnPRansac(
        X.astype(np.float64), u.astype(np.float64), pin.K, None,
        iterationsCount=int(cfg["pnp_iterations"]),
        reprojectionError=float(cfg["pnp_reproj_px"]),
        confidence=float(cfg["pnp_confidence"]), flags=cv2.SOLVEPNP_EPNP)
    if not ok or inl is None or len(inl) < int(cfg["min_inliers"]):
        return Motion(False, None, n, 0 if inl is None else len(inl), "PnP RANSAC: too few inliers")
    inl = inl.ravel()
    rvec, tvec = cv2.solvePnPRefineLM(X[inl], u[inl], pin.K, None, rvec, tvec)
    # Re-select inliers with the refined pose and refine once more.
    proj, _ = cv2.projectPoints(X, rvec, tvec, pin.K, None)
    res = np.linalg.norm(proj.reshape(-1, 2) - u, axis=1)
    inl = np.flatnonzero(res <= float(cfg["pnp_reproj_px"]))
    if len(inl) < int(cfg["min_inliers"]):
        return Motion(False, None, n, len(inl), "too few inliers after refinement")
    rvec, tvec = cv2.solvePnPRefineLM(X[inl], u[inl], pin.K, None, rvec, tvec)
    R, _ = cv2.Rodrigues(rvec)
    # x_c = R X + t;  X_next = Rc^T x_c + C
    T = make_T(pin.Rc.T @ R, pin.Rc.T @ tvec.ravel() + pin.C)
    step_m = float(np.linalg.norm(inv_T(T)[:3, 3]))
    step_deg = rot_angle_deg(T[:3, :3])
    if step_m > float(cfg["max_step_m"]) or step_deg > float(cfg["max_step_deg"]):
        return Motion(False, None, n, len(inl),
                      f"implausible step {step_m:.2f} m / {step_deg:.1f} deg")
    return Motion(True, T, n, len(inl))


def vo_step(prev: StereoFrame, nxt: StereoFrame, cfg: dict, seed: int = 0) -> Motion:
    has3d = np.flatnonzero(np.isfinite(prev.X[:, 0]))
    if len(has3d) == 0 or nxt.des is None:
        return Motion(False, None, 0, 0, "no stereo points")
    m = ratio_match(prev.des[has3d], nxt.des, float(cfg["ratio_test"]))
    if not m:
        return Motion(False, None, 0, 0, "no frame-to-frame matches")
    ia, ib = np.array(m).T
    return motion_from_points(prev.X[has3d[ia]], nxt.pts[ib], nxt.mL, cfg, seed)


# ---------------------------------------------------------------------------------------------
# Truth frames: MMGIS lat/lon -> local north/east/down metres
# ---------------------------------------------------------------------------------------------

def local_ned(lat0, lon0, h0, lat, lon, h, radius_m: float) -> np.ndarray:
    """Sphere: north = R dlat, east = R cos(lat_mid) dlon, down = -(h - h0)."""
    lat_mid = math.radians((lat0 + lat) / 2.0)
    return np.array([radius_m * math.radians(lat - lat0),
                     radius_m * math.cos(lat_mid) * math.radians(lon - lon0),
                     -(h - h0)])


def mmgis_T(end: dict, origin: dict, radius_m: float) -> np.ndarray:
    """Pose of an MMGIS drive end in the local NED frame centred on ``origin``."""
    R = quat_to_matrix(ypr_to_quat(end["yaw"], end["pitch"], end["roll"]))
    t = local_ned(origin["lat"], origin["lon"], origin["elev_geoid"], end["lat"], end["lon"],
                  end["elev_geoid"], radius_m)
    return make_T(R, t)


def onboard_T(item: dict) -> np.ndarray | None:
    """Rover pose in the site frame from the API (attitude rover->site, xyz)."""
    q, p = vp._floats(item.get("attitude")), vp.xyz(item)
    if not q or len(q) != 4 or p is None:
        return None
    return make_T(quat_to_matrix(q), p)


# ---------------------------------------------------------------------------------------------
# Drive assembly: which pairs, in which order
# ---------------------------------------------------------------------------------------------

def _pointing(it: dict) -> tuple[float, float] | None:
    e = it.get("extended") or {}
    try:
        return float(e["mast_az"]), float(e["mast_el"])
    except (KeyError, TypeError, ValueError):
        return None


def _ang_diff(a: float, b: float) -> float:
    return abs(wrap_deg(a - b))


def drive_poses(left: list[dict], right: list[dict], prev: tuple[int, int],
                end: tuple[int, int], cfg: dict) -> tuple[list[vp.Pair], dict]:
    """One VO pair per pose from the previous drive end to this drive end (inclusive).

    Pairs: resolution class ``cfg.resolution``, imageid containing ``cfg.sequence_tag``, CAHVOR
    on both frames, pointing within ``pointing_tol_deg`` of the median. At the start pose the
    *last* pair (just before driving), elsewhere the first.
    """
    (ps, pd), (es, ed) = prev, end

    def inside(it):
        s, d = it.get("site"), it.get("drive")
        if ps == es:
            return s == ps and pd <= d <= ed
        return (s == ps and d >= pd) or (s == es and d <= ed)

    lt = [it for it in left if inside(it)]
    rt = [it for it in right if inside(it)]
    pairs = [p for p in vp.pair_frames(lt, rt)
             if vp.resolution_class(p.left) == cfg["resolution"]
             and cfg["sequence_tag"] in p.left.get("imageid", "") and p.has_camera_model]
    stats = {"candidate_pairs": len(pairs)}
    pts = [_pointing(p.left) for p in pairs]
    if pairs and all(pts):
        maz = statistics.median(p[0] for p in pts)
        mel = statistics.median(p[1] for p in pts)
        tol = float(cfg["pointing_tol_deg"])
        keep = [_ang_diff(a, maz) <= tol and abs(e - mel) <= tol for a, e in pts]
        stats["dropped_pointing"] = int(len(pairs) - sum(keep))
        pairs = [p for p, k in zip(pairs, keep, strict=True) if k]
    by: dict[tuple[int, int], list[vp.Pair]] = {}
    for p in pairs:
        by.setdefault((p.left["site"], p.left["drive"]), []).append(p)
    chosen = []
    for key, ps_ in by.items():
        ps_.sort(key=lambda p: p.sclk)
        chosen.append(ps_[-1] if key == prev else ps_[0])
    chosen.sort(key=lambda p: p.sclk)
    stats["poses"] = len(chosen)
    stats["has_start_pair"] = prev in by
    stats["has_end_pair"] = end in by
    return chosen, stats


def onboard_pose_at(items: list[dict], site: int, drive: int) -> np.ndarray | None:
    for it in items:
        if it.get("site") == site and it.get("drive") == drive:
            T = onboard_T(it)
            if T is not None:
                return T
    return None


# ---------------------------------------------------------------------------------------------
# Frames on disk
# ---------------------------------------------------------------------------------------------

def frame_path(raw_dir: Path, sol: int, item: dict) -> Path:
    url = vp.strip_api_key(item.get("https_url") or item["url"])
    return raw_dir / "frames" / f"sol{sol:05d}" / Path(urlsplit(url).path).name


def fetch_frame(sess, budget, raw_dir: Path, sol: int, item: dict, offline: bool) -> Path:
    path = frame_path(raw_dir, sol, item)
    if not path.exists():
        if offline:
            raise FileNotFoundError(path)
        url = vp.strip_api_key(item.get("https_url") or item["url"])
        r = vp._get(sess, url, budget)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(r.content)
        vp._index_add(raw_dir, {"file": str(path.relative_to(raw_dir)), "url": url,
                                "bytes": len(r.content), "fetched_utc": vp._utcnow()})
    return path


def read_gray(path: Path) -> np.ndarray | None:
    cv2 = _cv2()
    return cv2.imdecode(np.frombuffer(path.read_bytes(), np.uint8), cv2.IMREAD_GRAYSCALE)


def model_of(item: dict) -> CameraModel:
    return parse_cmod_string(item["camera_model_component_list"])


# ---------------------------------------------------------------------------------------------
# One drive
# ---------------------------------------------------------------------------------------------

def chain(frames: list[StereoFrame | None], onboard: list[np.ndarray | None], cfg: dict
          ) -> tuple[list[np.ndarray], list[dict]]:
    """Relative steps T_{k+1<-k}: VO where it works, else the onboard relative pose."""
    steps, log = [], []
    for k in range(len(frames) - 1):
        a, b = frames[k], frames[k + 1]
        mo = vo_step(a, b, cfg, seed=k) if (a is not None and b is not None) else Motion(
            False, None, 0, 0, "frame missing")
        rec = {"k": k, "vo": mo.ok, "matches": mo.n_matches, "inliers": mo.n_inliers}
        if mo.ok:
            T = mo.T_next_prev
        else:
            rec["reason"] = mo.reason
            if onboard[k] is None or onboard[k + 1] is None:
                raise RuntimeError(f"step {k}: VO failed ({mo.reason}) and no onboard pose")
            T = inv_T(onboard[k + 1]) @ onboard[k]
        rec["step_m"] = round(float(np.linalg.norm(inv_T(T)[:3, 3])), 4)
        if onboard[k] is not None and onboard[k + 1] is not None:
            Tob = inv_T(onboard[k + 1]) @ onboard[k]
            rec["onboard_step_m"] = round(float(np.linalg.norm(inv_T(Tob)[:3, 3])), 4)
        steps.append(T)
        log.append(rec)
    return steps, log


def per_pose_vs_onboard(poses_rel: list[np.ndarray], onboard: list[np.ndarray | None]) -> dict:
    """VO poses (relative to the first pose) vs the rover's own per-pose attitude and position.

    Both chains are expressed in the start-rover frame; heading = yaw of the relative rotation.
    """
    if not onboard or onboard[0] is None:
        return {"n_poses": 0, "heading_rms_deg": None, "heading_max_abs_deg": None,
                "position_max_m": None}
    T0inv = inv_T(onboard[0])
    dh, dp = [], []
    for T_vo, T_ob in zip(poses_rel, onboard, strict=True):
        if T_ob is None:
            continue
        rel_ob = T0inv @ T_ob
        dh.append(wrap_deg(matrix_to_ypr(T_vo[:3, :3])[0] - matrix_to_ypr(rel_ob[:3, :3])[0]))
        dp.append(float(np.linalg.norm(T_vo[:3, 3] - rel_ob[:3, 3])))
    return {"n_poses": len(dh),
            "heading_rms_deg": round(math.sqrt(statistics.fmean(x * x for x in dh)), 4),
            "heading_max_abs_deg": round(max(abs(x) for x in dh), 4),
            "position_max_m": round(max(dp), 4)}


def accumulate(T0: np.ndarray, steps: list[np.ndarray]) -> list[np.ndarray]:
    """World poses T_w_k from T_w_0 and steps T_{k+1<-k}."""
    out = [T0]
    for S in steps:
        out.append(out[-1] @ inv_T(S))
    return out


def endpoint_metrics(T_est: np.ndarray, T_true: np.ndarray, length_m: float) -> dict:
    d = T_est[:3, 3] - T_true[:3, 3]
    horiz = float(math.hypot(d[0], d[1]))
    yaw_e = matrix_to_ypr(T_est[:3, :3])[0]
    yaw_t = matrix_to_ypr(T_true[:3, :3])[0]
    return {
        "endpoint_error_m": round(horiz, 3),
        "endpoint_error_vertical_m": round(float(-d[2]), 3),
        "drift_pct": round(100.0 * horiz / length_m, 3) if length_m > 0 else None,
        "heading_drift_deg": round(wrap_deg(yaw_e - yaw_t), 3),
    }


def run_drive(spec: dict, left: list[dict], right: list[dict], mmgis_prev: dict,
              mmgis_end: dict, load_img, cfg: dict, radius_m: float) -> dict:
    """Full X8 record for one drive. ``load_img(item) -> gray image or None``."""
    prev, end = spec["prev"], spec["end"]
    rec = {"sol": spec["sol"], "drive": end[1], "site": end[0],
           "prev_site_drive": f"{prev[0]}_{prev[1]}", "end_site_drive": f"{end[0]}_{end[1]}",
           "length_m": float(mmgis_end["dist_m"]), "endpoint_error_m": None,
           "drift_pct": None, "heading_drift_deg": None}
    pairs, st = drive_poses(left, right, prev, end, cfg)
    rec["poses"] = st
    if len(pairs) < 2:
        rec.update(status="no_data", reason=f"{len(pairs)} usable {cfg['resolution']} "
                                             f"{cfg['sequence_tag']} pairs")
        return rec
    allitems = left + right
    T_ob_start = onboard_pose_at(allitems, *prev)
    T_ob_end = onboard_pose_at(allitems, *end)
    if T_ob_start is None or T_ob_end is None:
        rec.update(status="failed", reason="no onboard pose at a drive end")
        return rec
    frames, onboard = [], []
    for p in pairs:
        iL, iR = load_img(p.left), load_img(p.right)
        if iL is None or iR is None:
            frames.append(None)
        else:
            frames.append(stereo_frame(iL, iR, model_of(p.left), model_of(p.right), cfg))
        onboard.append(onboard_T(p.left))
    # Bridge the drive ends when their pair is missing (onboard relative pose).
    if not st["has_start_pair"]:
        frames.insert(0, None)
        onboard.insert(0, T_ob_start)
    if not st["has_end_pair"]:
        frames.append(None)
        onboard.append(T_ob_end)
    steps, log = chain(frames, onboard, cfg)
    n_vo = sum(s["vo"] for s in log)
    bridged = sum(s["step_m"] for s in log if not s["vo"])
    T0 = mmgis_T(mmgis_prev, mmgis_prev, radius_m)
    T_true = mmgis_T(mmgis_end, mmgis_prev, radius_m)
    poses = accumulate(T0, steps)
    m = endpoint_metrics(poses[-1], T_true, rec["length_m"])
    # Same chain from the onboard relative poses only (the rover's own estimate).
    T_ob_rel = inv_T(T_ob_start) @ T_ob_end
    m_ob = endpoint_metrics(T0 @ T_ob_rel, T_true, rec["length_m"])
    # VO vs onboard at the end, in the rover-start frame (independent of MMGIS).
    T_vo_rel = inv_T(T0) @ poses[-1]
    d_rel = T_vo_rel[:3, 3] - T_ob_rel[:3, 3]
    poses_rel = [inv_T(T0) @ T for T in poses]
    rec.update(
        status="ok",
        per_pose_vs_onboard=per_pose_vs_onboard(poses_rel, onboard),
        endpoint_error_m=m["endpoint_error_m"], drift_pct=m["drift_pct"],
        heading_drift_deg=m["heading_drift_deg"],
        endpoint_error_vertical_m=m["endpoint_error_vertical_m"],
        n_pairs=len(pairs), n_steps=len(log), n_steps_vo=n_vo, n_steps_failed=len(log) - n_vo,
        vo_step_fraction=round(n_vo / len(log), 3) if log else None,
        bridged_m=round(bridged, 3),
        vo_path_m=round(sum(s["step_m"] for s in log), 3),
        onboard_path_m=round(sum(s.get("onboard_step_m", 0.0) for s in log), 3),
        straight_line_m=round(float(np.hypot(*T_true[:2, 3])), 3),
        onboard_vs_mmgis={k: m_ob[k] for k in ("endpoint_error_m", "drift_pct",
                                                 "heading_drift_deg")},
        vo_vs_onboard={"endpoint_error_m": round(float(np.hypot(d_rel[0], d_rel[1])), 3),
                       "heading_drift_deg": round(wrap_deg(
                           matrix_to_ypr(T_vo_rel[:3, :3])[0]
                           - matrix_to_ypr(T_ob_rel[:3, :3])[0]), 3)},
        median_stereo_points=int(statistics.median(f.n_stereo for f in frames if f))
        if any(frames) else None,
        median_inliers=int(statistics.median(s["inliers"] for s in log if s["vo"]))
        if n_vo else None,
        failures=[{"k": s["k"], "reason": s["reason"]} for s in log if not s["vo"]],
        track_ne_m=[[round(float(T[0, 3]), 3), round(float(T[1, 3]), 3)] for T in poses],
        duration_h=round((pairs[-1].sclk - pairs[0].sclk) / 3600.0, 4),
        scale_error=round(scale_error(poses[-1][:2, 3], T_true[:2, 3]), 5),
    )
    return rec


# ---------------------------------------------------------------------------------------------
# Plausibility (D16 stop rule) and the calibrated set
# ---------------------------------------------------------------------------------------------

def drive_checks(rec: dict | None, cfg: dict) -> dict:
    """Per-drive plausibility checks (thresholds ``cfg.plausible``, assumed)."""
    th = cfg["plausible"]
    if not rec or rec.get("status") != "ok":
        return {"pass": False, "checks": {},
                "reason": (rec or {}).get("reason") or "VO did not run on this drive"}
    checks = {
        "drift_pct": [rec["drift_pct"], "<=", th["max_drift_pct"],
                      rec["drift_pct"] <= th["max_drift_pct"]],
        "heading_drift_deg": [abs(rec["heading_drift_deg"]), "<=",
                              th["max_heading_drift_deg"],
                              abs(rec["heading_drift_deg"]) <= th["max_heading_drift_deg"]],
        "vo_step_fraction": [rec["vo_step_fraction"], ">=", th["min_vo_step_fraction"],
                             rec["vo_step_fraction"] >= th["min_vo_step_fraction"]],
    }
    return {"pass": all(c[3] for c in checks.values()), "checks": checks}


def stop_rule(recs: list[dict], cfg: dict, min_drives: int) -> dict:
    """D16 stop rule: plausible if >= ``min_drives`` drives pass ``drive_checks``."""
    per = [{"sol": r.get("sol"), "drive": r.get("drive"), **drive_checks(r, cfg)} for r in recs]
    n = sum(p["pass"] for p in per)
    return {"verdict": "plausible" if n >= min_drives else "cut X8",
            "rule": f">= {min_drives} drives pass the per-drive checks {cfg['plausible']}",
            "deadline": STOP_RULE_DEADLINE_LOCAL,
            "drives_tried": len(recs), "drives_passing": n, "per_drive": per}


def calibrated_set(recs: list[dict]) -> dict:
    """Curiosity-calibrated F21 parameters from drives with VO ("rover analogue").

    sigma_s: RMS of the along-track scale error (VO end displacement projected on the true
    displacement, divided by its length, minus 1). sigma_b: RMS heading drift per hour of
    driving (deg/h). psi0 and slip are *not* measurable by VO (psi0 is an initialisation error;
    slip is part of what VO removes) and stay null.
    """
    rows = [r for r in recs if r.get("status") == "ok" and r.get("duration_h")]
    if not rows:
        return {"label": LABEL, "n_drives": 0,
                "sigma_s": None, "sigma_b_deg_h": None, "psi0_deg": None, "slip": None}
    sc = [r["scale_error"] for r in rows if r.get("scale_error") is not None]
    hb = [r["heading_drift_deg"] / r["duration_h"] for r in rows]
    return {
        "label": LABEL,
        "n_drives": len(rows),
        "sigma_s": round(math.sqrt(statistics.fmean(x * x for x in sc)), 5) if sc else None,
        "sigma_b_deg_h": round(math.sqrt(statistics.fmean(x * x for x in hb)), 3),
        "psi0_deg": None,
        "slip": None,
        "method": calibrated_set.__doc__.split("\n\n")[0].strip() if calibrated_set.__doc__
        else "",
        "note": "psi0 and slip are not measured by VO; WS9 keeps its assumed values for them",
    }


def scale_error(est_ne, true_ne) -> float | None:
    """Along-track scale error: estimate projected on the true displacement, / |true|^2 - 1."""
    t, e = np.asarray(true_ne, dtype=float), np.asarray(est_ne, dtype=float)
    L2 = float(t @ t)
    return float(e @ t / L2 - 1.0) if L2 > 0 else None


# ---------------------------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------------------------

CONTRACT_FIELDS = ("sol", "drive", "length_m", "endpoint_error_m", "drift_pct",
                   "heading_drift_deg")
EXTRA_FIELDS = ("site", "prev_site_drive", "end_site_drive", "status", "reason", "n_pairs",
                "n_steps", "n_steps_vo", "n_steps_failed", "bridged_m", "vo_path_m",
                "straight_line_m", "onboard_vs_mmgis", "truth")


def drift_rows(recs: list[dict]) -> list[dict]:
    rows = []
    for r in recs:
        row = {k: r.get(k) for k in CONTRACT_FIELDS}
        row["label"] = LABEL
        row.update({k: r[k] for k in EXTRA_FIELDS if k in r})
        rows.append(row)
    return rows


def validate_drift(rows: list[dict]) -> None:
    Draft202012Validator(json.loads(CONTRACT.read_text())).validate(rows)


def record_manifest(rows: list[dict], path: Path, script: str) -> None:
    from pipeline.provenance.manifest import record

    for i, r in enumerate(rows):
        for k, u in (("length_m", "m"), ("endpoint_error_m", "m"), ("drift_pct", "%"),
                     ("heading_drift_deg", "deg")):
            record(f"vo.drift.{i}.{k}", r[k], u, WEB_PATH, script)
        record(f"vo.drift.{i}.sol", r["sol"], None, WEB_PATH, script)
    record(f"file.{WEB_PATH}", hashlib.sha256(path.read_bytes()).hexdigest(), "sha256",
           WEB_PATH, script)


# ---------------------------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------------------------

def drive_specs(probe: dict) -> list[dict]:
    """Every drive the probe looked at (decision set + focus set), most recent first."""
    out = []
    for d in probe["drives"] + probe.get("focus_check", {}).get("drives", []):
        ps, pd = map(int, d["prev_site_drive"].split("_"))
        es, ed = map(int, d["end_site_drive"].split("_"))
        out.append({"sol": int(d["sol"]), "prev": (ps, pd), "end": (es, ed),
                    "in_decision_set": d in probe["drives"]})
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--offline", action="store_true", help="use the cache only")
    ap.add_argument("--sol", type=int, action="append", help="limit to these sols")
    ap.add_argument("--max-mb", type=float, default=100.0, help="download budget (operational)")
    ap.add_argument("--out-dir", type=Path, default=OUT_DIR)
    ap.add_argument("--no-manifest", action="store_true")
    a = ap.parse_args(argv)
    if "web/public" in str(a.out_dir.resolve()):
        ap.error("vo writes to data/interim only")
    t0 = time.time()
    cfg, cfg_src = load_vo_config()
    radius = load_mars_radius()
    probe = json.loads(PROBE.read_text())
    budget = vp.Budget(int(a.max_mb * 1e6))
    sess = None if a.offline else vp._session()
    ends = vp.drive_ends(vp.fetch_mmgis(sess, budget, RAW_DIR, True))
    by_key = {(e["site"], e["drive"]): e for e in ends}
    specs = [s for s in drive_specs(probe) if not a.sol or s["sol"] in a.sol]
    recs = []
    for spec in specs:
        sol = spec["sol"]
        print(f"sol {sol} {spec['prev']} -> {spec['end']} ...", flush=True)
        try:
            left = vp.fetch_items(sess, budget, RAW_DIR, sol, vp.CAMERAS[0], a.offline)
            right = vp.fetch_items(sess, budget, RAW_DIR, sol, vp.CAMERAS[1], a.offline)

            def load(it, sol=sol):
                return read_gray(fetch_frame(sess, budget, RAW_DIR, sol, it, a.offline))

            rec = run_drive(spec, left, right, by_key[spec["prev"]], by_key[spec["end"]], load,
                            cfg, radius)
        except Exception as exc:  # report, never paper over (AGENTS rule 7)
            rec = {"sol": sol, "drive": spec["end"][1], "site": spec["end"][0],
                   "prev_site_drive": "{}_{}".format(*spec["prev"]),
                   "end_site_drive": "{}_{}".format(*spec["end"]),
                   "length_m": float(by_key[spec["end"]]["dist_m"]), "endpoint_error_m": None,
                   "drift_pct": None, "heading_drift_deg": None, "status": "failed",
                   "reason": f"{type(exc).__name__}: {exc}"}
        rec["truth"] = ("MMGIS drive ends (Curiosity's own localisation: onboard odometry + "
                        "ground updates), not independent truth")
        rec["in_decision_set"] = spec["in_decision_set"]
        recs.append(rec)
        print(_line(rec), flush=True)
    rows = drift_rows(recs)
    validate_drift(rows)
    a.out_dir.mkdir(parents=True, exist_ok=True)
    out = a.out_dir / "drift.json"
    out.write_text(json.dumps(rows, indent=1))
    min_drives = vp.parse_go_rule(vp.load_probe_config()["go_rule"]).min_drives
    report = {
        "generated_utc": vp._utcnow(),
        "script": "pipeline/navigation/vo.py",
        "config_source": cfg_src,
        "config": cfg,
        "label": LABEL,
        "d16": "go at 256² only (2026-11-14 11:24 CET); stop rule: cut X8 if VO isn't plausible "
               "by H8 (Sat 14 Nov 17:00 CET)",
        "stop_rule": stop_rule(recs, cfg, min_drives),
        "calibrated_set": calibrated_set(recs),
        "truth_note": "MMGIS drive ends are Curiosity's own localisation (onboard wheel + IMU + "
                      "visual odometry, ground-updated), not independent truth. 'onboard_vs_"
                      "mmgis' shows how close they are.",
        "downloaded_mb_this_run": round(budget.used / 1e6, 2),
        "raw_cache_mb": vp._cache_mb(RAW_DIR),
        "drives": [{k: v for k, v in r.items() if not k.startswith("_")} for r in recs],
    }
    (a.out_dir / "vo_report.json").write_text(json.dumps(report, indent=1))
    if not a.no_manifest and not a.sol:
        record_manifest(rows, out, __file__)
    print(f"wrote {out} and vo_report.json in {time.time() - t0:.0f} s, "
          f"{budget.used / 1e6:.1f} MB downloaded")
    sr = report["stop_rule"]
    print(f"stop rule: {sr['verdict']} ({sr['drives_passing']}/{sr['drives_tried']} drives pass)")
    print(f"calibrated set: {report['calibrated_set']}")
    return 0


def _line(r: dict) -> str:
    if r.get("status") != "ok":
        return f"  -> {r.get('status')}: {r.get('reason')}"
    return (f"  -> {r['n_steps_vo']}/{r['n_steps']} VO steps, bridged {r['bridged_m']} m; "
            f"end error {r['endpoint_error_m']} m = {r['drift_pct']} % of {r['length_m']} m; "
            f"heading {r['heading_drift_deg']} deg; onboard vs MMGIS "
            f"{r['onboard_vs_mmgis']['endpoint_error_m']} m; VO vs onboard "
            f"{r['vo_vs_onboard']['endpoint_error_m']} m")


if __name__ == "__main__":
    sys.exit(main())
