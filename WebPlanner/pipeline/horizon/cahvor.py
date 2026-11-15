"""CAHV / CAHVOR / CAHVORE camera models and the site -> rover attitude chain (F12; SPEC §2.2).

Projection (SPEC F12 step 3): x = (P-C).H / (P-C).A, y = (P-C).V / (P-C).A, after the radial
(R) correction about the optical axis O (CAHVOR, Gennery 2001):
    zeta = (P-C).O,  lambda = (P-C) - zeta O,  tau = |lambda|^2 / zeta^2,
    mu = r0 + r1 tau + r2 tau^2,  P' - C = (P-C) + mu lambda.
CAHVORE (Gennery 2006) adds a moving entrance pupil C' = C + s(theta) O,
s = e0 + e1 theta^2 + e2 theta^4, and a linearity L that maps the off-axis angle theta to
chi = tan(L theta)/L (L > 0), sin(L theta)/L (L < 0) or theta (L = 0); the radial term then uses
chi in place of sqrt(tau). L = 1, E = 0 reduces exactly to CAHVOR.

Pixel convention (assumed, JPL): (0, 0) is the centre of the upper-left pixel; x = column (right),
y = row (down) of the full-frame model image.

Frames (MSL; assumed, to be confirmed by the A-vector / yaw KAT on real frames):
    rover frame  +X forward, +Y right, +Z down;
    site frame   +X north,   +Y east,  +Z down (local level);
    attitude q = (w, x, y, z), Hamilton, rotating rover-frame vectors into the site frame:
    v_site = R(q) v_rover.
Horizon directions come from the ray engine in analysis-CRS ENU (x east, y grid north, z up).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

import numpy as np

# Numerical-method settings (solver internals, not physical constants).
_NEWTON_MAX_ITER = 100
_NEWTON_TOL = 1e-13
_SMALL_ANGLE = 1e-8
_LIN_EPS = 1e-15


def _unit(v):
    v = np.asarray(v, dtype=float)
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


def _dot(a, b):
    return np.sum(a * b, axis=-1)


@dataclass
class CameraModel:
    kind: str  # "CAHV" | "CAHVOR" | "CAHVORE"
    C: np.ndarray
    A: np.ndarray
    H: np.ndarray
    V: np.ndarray
    O: np.ndarray | None = None  # noqa: E741 (CAHVOR symbol)
    R: np.ndarray | None = None
    E: np.ndarray | None = None
    linearity: float | None = None

    def __post_init__(self):
        for k in ("C", "A", "H", "V", "O", "R", "E"):
            v = getattr(self, k)
            if v is not None:
                setattr(self, k, np.asarray(v, dtype=float))
        if self.kind not in ("CAHV", "CAHVOR", "CAHVORE"):
            raise ValueError(f"unknown camera model kind {self.kind}")
        if self.kind == "CAHV":
            self.O = self.A.copy()
            self.R = np.zeros(3)
        if self.kind in ("CAHV", "CAHVOR"):
            self.E = np.zeros(3)
            self.linearity = 1.0
        if self.kind == "CAHVORE" and (self.E is None or self.linearity is None):
            raise ValueError("CAHVORE needs E and linearity")

    # ------------------------------------------------------------------ helpers
    def intrinsics(self) -> dict:
        """Focal lengths and principal point (px) of the CAHV part (A assumed unit)."""
        a = _unit(self.A)
        return {"fx": float(np.linalg.norm(np.cross(a, self.H))), "cx": float(a @ self.H),
                "fy": float(np.linalg.norm(np.cross(a, self.V))), "cy": float(a @ self.V)}

    def _cahv(self, ri):
        den = _dot(ri, self.A)
        with np.errstate(divide="ignore", invalid="ignore"):
            x = _dot(ri, self.H) / den
            y = _dot(ri, self.V) / den
        bad = ~(den > 0)
        x[bad] = np.nan
        y[bad] = np.nan
        return np.column_stack([x, y])

    # ------------------------------------------------------------------ 3D -> 2D
    def project(self, points) -> np.ndarray:
        """World points (N, 3) in the model's frame -> pixels (N, 2); NaN when not imageable."""
        p = np.atleast_2d(np.asarray(points, dtype=float)) - self.C
        if self.kind == "CAHV":
            return self._cahv(p)
        if self.kind == "CAHVOR":
            zeta = _dot(p, self.O)
            lam = p - zeta[:, None] * self.O
            with np.errstate(divide="ignore", invalid="ignore"):
                tau = _dot(lam, lam) / zeta**2
            r0, r1, r2 = self.R
            mu = r0 + r1 * tau + r2 * tau**2
            out = self._cahv(p + mu[:, None] * lam)
            out[~(zeta > 0)] = np.nan
            return out
        return self._project_cahvore(p)

    def _project_cahvore(self, p):
        o = self.O
        e0, e1, e2 = self.E
        r0, r1, r2 = self.R
        lin = float(self.linearity)
        zetap = _dot(p, o)
        lam3 = p - zetap[:, None] * o
        lamp = np.linalg.norm(lam3, axis=1)
        theta = np.arctan2(lamp, zetap)
        for _ in range(_NEWTON_MAX_ITER):
            t2 = theta * theta
            s = e0 + e1 * t2 + e2 * t2 * t2
            ds = 2.0 * e1 * theta + 4.0 * e2 * theta * t2
            sn, cs = np.sin(theta), np.cos(theta)
            f = (zetap - s) * sn - lamp * cs
            fp = (zetap - s) * cs - ds * sn + lamp * sn
            step = f / fp
            theta = theta - step
            if np.all(np.abs(step) < _NEWTON_TOL):
                break
        small = theta < _SMALL_ANGLE
        lt = lin * theta
        with np.errstate(divide="ignore", invalid="ignore"):
            if lin > _LIN_EPS:
                chi = np.tan(lt) / lin
                valid = lt < math.pi / 2
            elif lin < -_LIN_EPS:
                chi = np.sin(lt) / lin
                valid = np.ones_like(theta, dtype=bool)
            else:
                chi = theta.copy()
                valid = np.ones_like(theta, dtype=bool)
            zeta_v = np.where(small, zetap, lamp / chi)
        mu = r0 + r1 * chi**2 + r2 * chi**4
        ri = zeta_v[:, None] * o + (1.0 + np.where(small, 0.0, mu))[:, None] * lam3
        out = self._cahv(ri)
        out[~valid | ~(theta < math.pi) | (small & ~(zetap > 0))] = np.nan
        return out

    # ------------------------------------------------------------------ 2D -> 3D
    def unproject(self, pixels):
        """Pixels (N, 2) -> (origins (N, 3), unit ray directions (N, 3))."""
        px = np.atleast_2d(np.asarray(pixels, dtype=float))
        x, y = px[:, 0:1], px[:, 1:2]
        f = self.V[None, :] - y * self.A[None, :]
        g = self.H[None, :] - x * self.A[None, :]
        rr = _unit(np.cross(f, g))
        rr[_dot(rr, self.A) < 0] *= -1.0
        if self.kind == "CAHV":
            return np.broadcast_to(self.C, rr.shape).copy(), rr
        o = self.O
        zeta = _dot(rr, o)
        lam = rr - zeta[:, None] * o
        lmag = np.linalg.norm(lam, axis=1)
        with np.errstate(divide="ignore", invalid="ignore"):
            chi_d = lmag / zeta  # distorted tangent
        r0, r1, r2 = self.R
        chi = chi_d.copy()
        for _ in range(_NEWTON_MAX_ITER):
            c2 = chi * chi
            g_ = chi * (1.0 + r0 + r1 * c2 + r2 * c2 * c2) - chi_d
            gp = 1.0 + r0 + 3.0 * r1 * c2 + 5.0 * r2 * c2 * c2
            step = g_ / gp
            chi = chi - step
            if np.all(np.abs(step[np.isfinite(step)]) < _NEWTON_TOL):
                break
        lin = float(self.linearity)
        with np.errstate(divide="ignore", invalid="ignore"):
            if lin > _LIN_EPS:
                theta = np.arctan(lin * chi) / lin
            elif lin < -_LIN_EPS:
                theta = np.arcsin(lin * chi) / lin
            else:
                theta = chi
            u = lam / lmag[:, None]
        small = lmag < _SMALL_ANGLE
        u[small] = 0.0
        d = np.cos(theta)[:, None] * o + np.sin(theta)[:, None] * u
        d[small] = o
        e0, e1, e2 = self.E
        t2 = theta * theta
        s = np.where(small, e0, e0 + e1 * t2 + e2 * t2 * t2)
        origin = self.C + s[:, None] * o
        return origin, _unit(d)


def cahv_from_intrinsics(c, a, h_hat, v_hat, fx, fy, cx, cy) -> CameraModel:
    """CAHV from a pinhole: boresight a, image-right h_hat, image-down v_hat (all unit)."""
    a = _unit(a)
    return CameraModel("CAHV", np.asarray(c, dtype=float), a,
                       fx * _unit(h_hat) + cx * a, fy * _unit(v_hat) + cy * a)


_NUM_GROUP = re.compile(r"\(([^()]*)\)|([-+0-9.eE]+)")


def parse_cmod_string(s: str, linearity: float | None = None) -> CameraModel:
    """Parse '(Cx,Cy,Cz);(Ax,..);(H..);(V..)[;(O..);(R..)[;(E..)[;T[;P]]]]'.

    CAHVORE type T: 1 perspective (L = 1), 2 fisheye (L = 0), 3 general (L = P); or pass
    ``linearity`` directly. Field layouts in API metadata must be confirmed in discovery.md.
    """
    groups = []
    for part in s.strip().split(";"):
        part = part.strip().strip("()")
        if part:
            groups.append([float(v) for v in part.split(",")])
    vecs = [np.array(g) for g in groups if len(g) == 3]
    scal = [g[0] for g in groups if len(g) == 1]
    if len(vecs) == 4:
        return CameraModel("CAHV", *vecs)
    if len(vecs) == 6:
        return CameraModel("CAHVOR", *vecs)
    if len(vecs) == 7:
        if linearity is None:
            if not scal:
                raise ValueError("CAHVORE without type/linearity")
            t = int(scal[0])
            linearity = {1: 1.0, 2: 0.0}.get(t, scal[1] if len(scal) > 1 else None)
            if linearity is None:
                raise ValueError("CAHVORE type 3 needs the P (linearity) parameter")
        return CameraModel("CAHVORE", *vecs, linearity=float(linearity))
    raise ValueError(f"cannot parse camera model with {len(vecs)} vectors")


# ---------------------------------------------------------------------------------------------
# Attitude
# ---------------------------------------------------------------------------------------------

def quat_to_matrix(q) -> np.ndarray:
    """(w, x, y, z) -> R with v_site = R v_rover."""
    w, x, y, z = np.asarray(q, dtype=float) / np.linalg.norm(q)
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ])


def ypr_to_quat(yaw_deg, pitch_deg, roll_deg) -> np.ndarray:
    """Z-Y-X Euler (yaw about down, from north toward east; pitch nose-up; roll right-down)."""
    y, p, r = (math.radians(v) / 2 for v in (yaw_deg, pitch_deg, roll_deg))
    cy, sy, cp, sp, cr, sr = (math.cos(y), math.sin(y), math.cos(p), math.sin(p),
                              math.cos(r), math.sin(r))
    return np.array([cy * cp * cr + sy * sp * sr, cy * cp * sr - sy * sp * cr,
                     cy * sp * cr + sy * cp * sr, sy * cp * cr - cy * sp * sr])


def matrix_to_ypr(rm) -> tuple[float, float, float]:
    rm = np.asarray(rm)
    yaw = math.degrees(math.atan2(rm[1, 0], rm[0, 0])) % 360.0
    pitch = math.degrees(math.asin(max(-1.0, min(1.0, -rm[2, 0]))))
    roll = math.degrees(math.atan2(rm[2, 1], rm[2, 2]))
    return yaw, pitch, roll


def enu_to_site(v) -> np.ndarray:
    v = np.atleast_2d(np.asarray(v, dtype=float))
    return np.column_stack([v[:, 1], v[:, 0], -v[:, 2]])


def site_to_enu(v) -> np.ndarray:
    v = np.atleast_2d(np.asarray(v, dtype=float))
    return np.column_stack([v[:, 1], v[:, 0], -v[:, 2]])


def site_az_el(v_site) -> tuple[np.ndarray, np.ndarray]:
    v = np.atleast_2d(np.asarray(v_site, dtype=float))
    az = np.degrees(np.arctan2(v[:, 1], v[:, 0])) % 360.0
    el = np.degrees(np.arctan2(-v[:, 2], np.hypot(v[:, 0], v[:, 1])))
    return az, el


def pointing_az_el(v_rover, q) -> tuple[float, float]:
    """Azimuth (deg from north, clockwise) and elevation of a rover-frame vector (e.g. A)."""
    az, el = site_az_el(quat_to_matrix(q) @ np.asarray(v_rover, dtype=float))
    return float(az[0]), float(el[0])


def az_el_to_enu(az_deg, el_deg) -> np.ndarray:
    az, el = np.radians(az_deg), np.radians(el_deg)
    return np.column_stack([np.cos(el) * np.sin(az), np.cos(el) * np.cos(az), np.sin(el)])


def project_az_el(model: CameraModel, q, az_deg, el_deg, range_m) -> np.ndarray:
    """Directions (az, el in the site frame, from the camera) at range_m -> pixels (N, 2)."""
    d_site = enu_to_site(az_el_to_enu(az_deg, el_deg))
    d_rover = d_site @ quat_to_matrix(q)  # R^T applied row-wise
    rng = np.broadcast_to(np.asarray(range_m, dtype=float), (d_rover.shape[0],))
    return model.project(model.C + rng[:, None] * d_rover)


def pixels_to_az_el(model: CameraModel, q, pixels) -> tuple[np.ndarray, np.ndarray]:
    """Pixels -> (az, el) of their rays in the site frame (deg)."""
    _, d = model.unproject(pixels)
    return site_az_el(d @ quat_to_matrix(q).T)
